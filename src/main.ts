import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import * as context from './context';
import * as installer from './install';
import * as report from './report';
import {runNaspeed, runNaspeedOrThrow} from './run-naspeed';
import * as storeCache from './store-cache';
import * as ui from './ui';

// The same bundle runs as `main` and as `post`; main leaves this state behind.
const IS_POST = 'isPost';
const SAVE = 'save';
const REPORT = 'report';

interface SaveState {
  naspeed: string;
  store: string;
  dir: string;
  key: string;
  maxGb: number;
}

/** Everything the job summary needs besides the closing counters. */
interface ReportState extends Omit<report.ReportData, 'counters' | 'save'> {
  naspeed: string;
  before: report.Counters;
  /** Why the store is not saved, when that is known in main. */
  skipped?: string;
}

async function install(inputs: context.Inputs): Promise<{tag: string; target: string; bin: string}> {
  const start = Date.now();
  const target = installer.targetFor(os.platform(), os.arch());
  ui.info('installing naspeed', {version: inputs.version, target});
  const result = await ui.nested(async () => {
    const tag = await installer.resolveTag(inputs.version, inputs.token);
    if (tag.replace(/^v/, '') !== inputs.version.replace(/^v/, '')) ui.info('resolved', {version: tag});
    return {tag, target, bin: await installer.install(tag, target)};
  });
  ui.took(start);
  return result;
}

/** Restores the store; returns the restored key ('' when cold) and the save plan. */
async function restore(
  inputs: context.Inputs,
  naspeed: string
): Promise<{restored: string; scope: string; save?: SaveState; skipped?: string}> {
  const start = Date.now();
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const scope =
    inputs.cacheKey ||
    storeCache.autoScope(process.env.GITHUB_WORKFLOW || 'workflow', process.env.GITHUB_JOB || 'job', {
      args: inputs.args,
      setupArgs: inputs.setupArgs,
      workdir: path.relative(workspace, inputs.workdir) || '.'
    });
  const keys = storeCache.cacheKeys(
    {
      scope,
      os: process.env.RUNNER_OS || os.platform(),
      arch: process.env.RUNNER_ARCH || os.arch(),
      rustc: await storeCache.rustcVersion(workspace),
      lockHash: await storeCache.lockHash()
    },
    {
      id: process.env.GITHUB_RUN_ID || '0',
      attempt: process.env.GITHUB_RUN_ATTEMPT || '1'
    },
    !inputs.cacheKey
  );
  const dir = storeCache.transferDir();
  ui.info('restoring store', {prefix: keys.restoreKeys[0]});
  const matched = await ui.nested(() => storeCache.restore(naspeed, inputs.store, dir, keys));
  ui.took(start);
  core.setOutput('cache-hit', matched ? 'true' : 'false');
  core.setOutput('cache-matched-key', matched || '');

  const event = process.env.GITHUB_EVENT_NAME || '';
  const save = storeCache.shouldSave(inputs.cacheSave, {
    name: event,
    ref: process.env.GITHUB_REF || '',
    defaultBranch: storeCache.defaultBranch()
  });
  if (!save) {
    ui.info('this run will not save the store', {cache_save: inputs.cacheSave, event});
    return {
      restored: matched || '',
      scope,
      skipped: `${event || 'this event'}; cache-save: ${inputs.cacheSave}`
    };
  }
  return {
    restored: matched || '',
    scope,
    save: {naspeed, store: inputs.store, dir, key: keys.key, maxGb: inputs.cacheMaxGb}
  };
}

/**
 * Runs `naspeed <args>` in `workdir` and returns the exit code. naspeed logs
 * its own steps and timings, so the action adds no lines around them.
 */
function runArgs(bin: string, inputs: context.Inputs): Promise<number> {
  return runNaspeed(bin, inputs.args, 0, inputs.workdir);
}

async function writeReport(state: ReportState, save: report.SaveOutcome): Promise<void> {
  const after = await report.snapshot(state.naspeed);
  const {naspeed: _naspeed, before, skipped: _skipped, ...data} = state;
  await report.writeReport({...data, counters: after ? report.diff(before, after) : before, save});
}

async function run(): Promise<void> {
  const inputs = context.getInputs();
  core.saveState(IS_POST, 'true');

  const {tag, target, bin} = await install(inputs);
  const version = tag.replace(/^v/, '');
  core.addPath(path.dirname(bin));
  core.setOutput('version', version);
  core.setOutput('path', bin);

  if (inputs.installOnly) {
    if (inputs.args.length > 0) {
      const code = await runArgs(bin, inputs);
      if (code !== 0) throw new Error(`naspeed ${inputs.args.join(' ')} failed with exit code ${code}`);
    }
    return;
  }

  // `setup` installs naspeed and the `ns` alias into $CARGO_HOME/bin and
  // points build.rustc-wrapper in $CARGO_HOME/config.toml at it.
  const cargoBin = path.join(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin');
  core.addPath(cargoBin);
  await runNaspeedOrThrow(bin, ['setup', '--store', inputs.store, ...inputs.setupArgs], 0);
  const naspeed = path.join(cargoBin, 'naspeed');

  let restored: string | undefined;
  let skipped: string | undefined;
  let scope = inputs.cacheKey;
  const runnerEnvironment = process.env.RUNNER_ENVIRONMENT;
  const storeWarm = storeCache.storeIsWarm(inputs.store);
  const cache = context.useActionsCache(inputs.cache, runnerEnvironment, storeWarm);
  if (!cache && inputs.cache === 'auto') {
    ui.info('self-hosted runner with a warm store: Actions cache not used', {store: inputs.store});
  }
  if (cache) {
    const r = await restore(inputs, naspeed);
    restored = r.restored;
    skipped = r.skipped;
    scope = r.scope;
    if (r.save) core.saveState(SAVE, JSON.stringify(r.save));
  }

  const before = inputs.summary ? await report.snapshot(naspeed) : undefined;
  const state: ReportState | undefined = before && {
    naspeed,
    before,
    version,
    target,
    cacheKey: scope,
    restored,
    skipped
  };
  if (state) core.saveState(REPORT, JSON.stringify(state));

  if (inputs.args.length > 0) {
    const code = await runArgs(naspeed, inputs);
    const cmd = ['naspeed', ...inputs.args].join(' ');
    if (state) {
      state.command = {cmd, exitCode: code};
      core.saveState(REPORT, JSON.stringify(state));
    }
    if (code !== 0) {
      // The post step only runs for a successful job: report now.
      if (state) {
        await writeReport(state, cache ? {status: 'skipped', reason: 'the job failed'} : {status: 'off'});
        // Reported: a post step that still runs (continue-on-error) must not repeat it.
        core.saveState(REPORT, '');
      }
      throw new Error(`${cmd} failed with exit code ${code}`);
    }
  }
}

async function post(): Promise<void> {
  const saveText = core.getState(SAVE);
  const reportText = core.getState(REPORT);
  let outcome: report.SaveOutcome = {status: 'off'};
  if (saveText) {
    const {naspeed, store, dir, key, maxGb}: SaveState = JSON.parse(saveText);
    const start = Date.now();
    ui.info('saving store', {key});
    try {
      outcome = await ui.nested(() => storeCache.save(naspeed, store, dir, key, maxGb));
    } catch (error) {
      // A failed save only costs the next run its warm start: warn, never fail.
      const reason = (error as Error).message;
      core.warning(`naspeed store not saved: ${reason}`);
      outcome = {status: 'failed', reason};
    }
    ui.took(start);
  }
  if (reportText) {
    const state: ReportState = JSON.parse(reportText);
    if (!saveText && state.skipped) outcome = {status: 'skipped', reason: state.skipped};
    await writeReport(state, outcome);
  }
}

if (core.getState(IS_POST) === 'true') {
  post().catch(error => core.warning(`naspeed post step: ${(error as Error).message}`));
} else {
  run().catch(error => core.setFailed((error as Error).message));
}
