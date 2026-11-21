import * as crypto from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import {runNaspeedOrThrow} from './run-naspeed';
import * as ui from './ui';
import type {CacheSave} from './context';
import type {SaveOutcome} from './report';

/**
 * Where the exported store travels between runs, the same directory the
 * workflows from `ns ci init` use. The store itself stays in `store`.
 */
export const transferDir = (home: string = os.homedir()): string => path.join(home, '.naspeed-ci');

export interface KeyParts {
  /** The job's own slot: `cache-key` when set, otherwise `autoScope`. */
  scope: string;
  os: string;
  arch: string;
  /** Toolchain identity (`rustc-1.98.0`, `go-1.25.4`, or `none`). */
  toolchain: string;
  /** Hash of dependency lock files understood by the selected ecosystem. */
  lockHash: string;
}

/** Lowercase `[a-z0-9-]`, at most `max` chars: safe inside a cache key. */
const slug = (s: string, max: number): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'job';

/**
 * A slot per kind of job without naming one: the workflow and job ids, plus
 * a short hash of what the step runs, so matrix legs that run different
 * commands (features, targets) keep their stores apart too.
 */
export const autoScope = (
  workflow: string,
  job: string,
  step: {args: string[]; setupArgs: string[]; workdir: string}
): string => {
  const what = crypto
    .createHash('sha256')
    .update(JSON.stringify([step.args, step.setupArgs, step.workdir]))
    .digest('hex')
    .slice(0, 8);
  return `${slug(workflow, 40)}-${slug(job, 40)}-${what}`;
};

/**
 * Cache keys: OS, arch and compiler keep incompatible artifacts apart, the
 * scope keeps each kind of job in its own slot and the dependency-file hash
 * narrows to the same dependency set. Keys are immutable, so every save adds
 * the run to the key. Restore takes the newest entry of the same job and
 * dependency set, then the same job with any dependency set. An automatic
 * scope then falls back to any job for the same toolchain; an explicit
 * `cache-key` asks to stay apart, so it never does.
 */
export const cacheKeys = (
  p: KeyParts,
  run: {id: string; attempt: string},
  shareAcrossJobs: boolean
): {key: string; restoreKeys: string[]} => {
  const compiler = `naspeed-${p.os}-${p.arch}-${p.toolchain}-`;
  const job = `${compiler}${p.scope}-`;
  const base = `${job}${p.lockHash}-`;
  const restoreKeys = shareAcrossJobs ? [base, job, compiler] : [base, job];
  return {key: `${base}${run.id}-${run.attempt}`, restoreKeys};
};

/**
 * `auto` saves only on pushes to the default branch: pull requests (forks
 * included) can read the cache but never write what main builds restore.
 */
export const shouldSave = (
  mode: CacheSave,
  event: {name: string; ref: string; defaultBranch: string | undefined}
): boolean => {
  if (mode !== 'auto') return mode === 'true';
  return (
    event.name === 'push' && event.defaultBranch !== undefined && event.ref === `refs/heads/${event.defaultBranch}`
  );
};

/** True when the store already holds cache entries (not just its empty layout). */
export const storeIsWarm = (store: string): boolean => {
  try {
    return fs.readdirSync(path.join(store, 'entries')).length > 0;
  } catch {
    return false;
  }
};

export const defaultBranch = (): string | undefined => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8'))?.repository?.default_branch;
  } catch {
    return undefined;
  }
};

/** Project toolchain identity for cache compatibility. */
export async function toolchainVersion(cwd: string): Promise<string> {
  const goOnly = fs.existsSync(path.join(cwd, 'go.mod')) && !fs.existsSync(path.join(cwd, 'Cargo.toml'));
  if (goOnly) {
    const go = await exec.getExecOutput('go', ['version'], {cwd, ignoreReturnCode: true, silent: true});
    const version = go.exitCode === 0 ? go.stdout.match(/\bgo(\d+(?:\.\d+)+)\b/)?.[1] : undefined;
    if (version) return `go-${version}`;
  } else {
    const rust = await exec.getExecOutput('rustc', ['--version'], {cwd, ignoreReturnCode: true, silent: true});
    const version = rust.exitCode === 0 ? rust.stdout.trim().split(/\s+/)[1] : undefined;
    if (version) return `rustc-${version}`;
  }
  core.warning(`${goOnly ? 'go' : 'rustc'} did not report a version; using a generic naspeed cache key`);
  return 'none';
}

export async function lockHash(): Promise<string> {
  return (await glob.hashFiles('**/Cargo.lock\n**/go.sum\n**/go.work.sum')) || 'nolock';
}

/** Restores the exported store and merges it into `store`. */
export async function restore(
  naspeed: string,
  store: string,
  dir: string,
  keys: {key: string; restoreKeys: string[]}
): Promise<string | undefined> {
  if (!cache.isFeatureAvailable()) {
    core.warning('The GitHub Actions cache is not available on this runner; naspeed starts cold');
    return undefined;
  }
  const matched = await cache.restoreCache([dir], keys.key, keys.restoreKeys);
  if (!matched) {
    ui.info('no saved store; starting cold');
    return undefined;
  }
  ui.info('restored', {key: matched});
  if (fs.existsSync(path.join(dir, 'entries'))) {
    await runNaspeedOrThrow(naspeed, ['cache', 'import', dir, '--store', store], 0);
  }
  return matched;
}

/** The `.naspeed/export-summary.json` a recent `naspeed cache export` writes. */
export interface ExportSummary {
  version: number;
  /** Bytes the export actually copied; ~0 when the store is unchanged since the restore. */
  bytes_new: number;
  total_bytes: number;
}

/**
 * The export summary written into the transfer dir, or undefined when it is
 * absent or malformed (an older naspeed never wrote one — then the save
 * decision keeps the old always-save behavior).
 */
export async function readExportSummary(dir: string): Promise<ExportSummary | undefined> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, '.naspeed', 'export-summary.json'), 'utf8'));
    if (typeof parsed?.bytes_new === 'number' && typeof parsed?.total_bytes === 'number') return parsed;
  } catch {
    /* absent or malformed: not a summary we can act on */
  }
  return undefined;
}

/**
 * Whether an exported store is different enough from the restored cache to be
 * worth a new ~600 MB upload. GitHub cache keys are immutable, so every save
 * pays the full payload; skipping near-unchanged saves stops the quota churn.
 */
export function plannedSave(summary: ExportSummary | undefined, minDeltaMb: number): {skip: boolean; reason: string} {
  if (!summary) return {skip: false, reason: ''};
  const deltaMb = summary.bytes_new / (1024 * 1024);
  if (deltaMb >= minDeltaMb) return {skip: false, reason: ''};
  return {
    skip: true,
    reason: `store nearly unchanged since restore: ${deltaMb.toFixed(1)} MB new < ${minDeltaMb} MB threshold`
  };
}

/** Exports recently used store entries and saves them under `key`. */
export async function save(
  naspeed: string,
  store: string,
  dir: string,
  key: string,
  maxGb: number,
  minDeltaMb: number
): Promise<SaveOutcome> {
  if (!cache.isFeatureAvailable()) {
    core.warning('The GitHub Actions cache is not available on this runner; naspeed store not saved');
    return {status: 'failed', reason: 'the Actions cache is not available on this runner'};
  }
  // Export reuses objects the restore left in `dir` and prunes the rest.
  await runNaspeedOrThrow(naspeed, ['cache', 'export', dir, '--max-gb', String(maxGb), '--store', store], 0);
  const decision = plannedSave(await readExportSummary(dir), minDeltaMb);
  if (decision.skip) {
    ui.info(`skip save: ${decision.reason}`, {key});
    return {status: 'skipped', reason: decision.reason};
  }
  try {
    await cache.saveCache([dir], key);
    ui.info('saved', {key});
    return {status: 'saved', key};
  } catch (error) {
    // Another job of the same run (a matrix sharing this key) saved first.
    const reason = (error as Error).message;
    core.warning(`naspeed store not saved: ${reason}`);
    return {status: 'failed', reason};
  }
}
