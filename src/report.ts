import * as core from '@actions/core';
import * as exec from '@actions/exec';
import {formatDuration} from './ui';

/** The counters `naspeed stats --json` reports per store. */
export interface Counters {
  hits: number;
  misses: number;
  saved_ms: number;
  test_hits: number;
  test_runs: number;
  test_saved_ms: number;
}

const KEYS: (keyof Counters)[] = ['hits', 'misses', 'saved_ms', 'test_hits', 'test_runs', 'test_saved_ms'];

const zero = (): Counters => ({hits: 0, misses: 0, saved_ms: 0, test_hits: 0, test_runs: 0, test_saved_ms: 0});

/** Sums `naspeed stats --json` over every store. */
export function sumStores(json: unknown): Counters {
  const total = zero();
  for (const store of Array.isArray(json) ? json : []) {
    for (const k of KEYS) total[k] += Number(store?.[k]) || 0;
  }
  return total;
}

/** What happened between two snapshots of the same stores. */
export function diff(before: Counters, after: Counters): Counters {
  const d = zero();
  for (const k of KEYS) d[k] = Math.max(after[k] - before[k], 0);
  return d;
}

/**
 * Counters of the last two days: a job that crosses midnight still diffs the
 * same window. Undefined when naspeed cannot report them.
 */
export async function snapshot(naspeed: string): Promise<Counters | undefined> {
  const out = await exec.getExecOutput(naspeed, ['stats', '--json', '--days', '2'], {
    ignoreReturnCode: true,
    silent: true
  });
  if (out.exitCode !== 0) return undefined;
  try {
    return sumStores(JSON.parse(out.stdout));
  } catch {
    return undefined;
  }
}

export type SaveOutcome =
  | {status: 'saved'; key: string}
  | {status: 'skipped'; reason: string}
  | {status: 'failed'; reason: string}
  | {status: 'off'};

export interface ReportData {
  version: string;
  target: string;
  cacheKey: string;
  counters: Counters;
  /** Key of the restored entry, '' for a cold start, undefined with cache off. */
  restored?: string;
  save: SaveOutcome;
  command?: {cmd: string; exitCode: number};
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function renderReport(d: ReportData): string {
  const c = d.counters;
  const lines = ['## naspeed Report', '', '### Summary', ''];
  if (d.command) {
    const ok = d.command.exitCode === 0;
    lines.push(
      `- **Command:** ${ok ? '✅' : '❌'} \`${d.command.cmd}\`${ok ? '' : ` · exit code ${d.command.exitCode}`}`
    );
  }
  const calls = c.hits + c.misses;
  lines.push(
    calls === 0
      ? '- **Build:** no rustc calls went through naspeed'
      : `- **Build:** ✅ **${plural(c.hits, 'hit', 'hits')}** · ${plural(c.misses, 'miss', 'misses')} · ` +
          `${((100 * c.hits) / calls).toFixed(1)}% hit rate · saved ${formatDuration(c.saved_ms)}`
  );
  const tests = c.test_hits + c.test_runs;
  lines.push(
    tests === 0
      ? '- **Tests:** no test binaries ran through `ns test`'
      : `- **Tests:** ✅ **${c.test_hits} replayed** · ${c.test_runs} ran · saved ${formatDuration(c.test_saved_ms)}`
  );
  if (d.restored === undefined) lines.push('- **Store:** cache off');
  else if (d.restored) lines.push(`- **Store:** ♻️ restored \`${d.restored}\``);
  else lines.push('- **Store:** 🧊 cold start, no saved store yet');
  switch (d.save.status) {
    case 'saved':
      lines.push(`- **Saved:** 💾 \`${d.save.key}\``);
      break;
    case 'skipped':
      lines.push(`- **Saved:** ⏭️ not saved (${d.save.reason})`);
      break;
    case 'failed':
      lines.push(`- **Saved:** ⚠️ not saved: ${d.save.reason}`);
      break;
    case 'off':
      break;
  }
  const slot = d.cacheKey ? ` · cache scope \`${d.cacheKey}\`` : '';
  lines.push('', `<sub>naspeed v${d.version} · ${d.target}${slot}</sub>`, '');
  return lines.join('\n');
}

/** Appends the report to the job summary; a no-op outside GitHub Actions. */
export async function writeReport(d: ReportData): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await core.summary.addRaw(renderReport(d)).write();
}
