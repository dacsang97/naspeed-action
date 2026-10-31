import {describe, expect, it} from 'vite-plus/test';
import {diff, renderReport, sumStores} from '../src/report';
import type {ReportData} from '../src/report';

const counters = {hits: 346, misses: 2, saved_ms: 241_000, test_hits: 1, test_runs: 1, test_saved_ms: 4_200};

const base: ReportData = {
  version: '0.1.1',
  target: 'x86_64-unknown-linux-musl',
  cacheKey: 'test',
  counters,
  restored: 'test-Linux-X64-1.99.1-abc-41-1-test',
  save: {status: 'saved', key: 'test-Linux-X64-1.99.1-abc-42-1-test'},
  command: {cmd: 'naspeed test --locked', exitCode: 0}
};

describe('sumStores / diff', () => {
  it('sums stores and diffs snapshots without going negative', () => {
    const before = sumStores([
      {hits: 10, misses: 5, saved_ms: 100, test_hits: 0, test_runs: 2, test_saved_ms: 0},
      {hits: 1, misses: 0, saved_ms: 5, test_hits: 1, test_runs: 0, test_saved_ms: 9}
    ]);
    expect(before).toEqual({hits: 11, misses: 5, saved_ms: 105, test_hits: 1, test_runs: 2, test_saved_ms: 9});
    const after = {...before, hits: 20, misses: 4};
    expect(diff(before, after)).toEqual({
      hits: 9,
      misses: 0,
      saved_ms: 0,
      test_hits: 0,
      test_runs: 0,
      test_saved_ms: 0
    });
    expect(sumStores('not json')).toEqual(diff(before, before));
  });
});

describe('renderReport', () => {
  it('renders a Vitest-like summary', () => {
    expect(renderReport(base)).toBe(
      [
        '## naspeed Report',
        '',
        '### Summary',
        '',
        '- **Command:** ✅ `naspeed test --locked`',
        '- **Build:** ✅ **346 hits** · 2 misses · 99.4% hit rate · saved 4m01s',
        '- **Tests:** ✅ **1 replayed** · 1 ran · saved 4s',
        '- **Store:** ♻️ restored `test-Linux-X64-1.99.1-abc-41-1-test`',
        '- **Saved:** 💾 `test-Linux-X64-1.99.1-abc-42-1-test`',
        '',
        '<sub>naspeed v0.1.1 · x86_64-unknown-linux-musl · cache scope `test`</sub>',
        ''
      ].join('\n')
    );
  });

  it('covers failures, cold starts, skipped saves and idle jobs', () => {
    const text = renderReport({
      ...base,
      counters: {hits: 0, misses: 0, saved_ms: 0, test_hits: 0, test_runs: 0, test_saved_ms: 0},
      restored: '',
      save: {status: 'skipped', reason: 'pull_request; cache-save: auto'},
      command: {cmd: 'naspeed test', exitCode: 101}
    });
    expect(text).toContain('- **Command:** ❌ `naspeed test` · exit code 101');
    expect(text).toContain('- **Build:** no rustc calls went through naspeed');
    expect(text).toContain('- **Tests:** no test binaries ran through `ns test`');
    expect(text).toContain('- **Store:** 🧊 cold start, no saved store yet');
    expect(text).toContain('- **Saved:** ⏭️ not saved (pull_request; cache-save: auto)');
    const off = renderReport({...base, restored: undefined, save: {status: 'off'}, command: undefined});
    expect(off).toContain('- **Store:** cache off');
    expect(off).not.toContain('**Saved:**');
    expect(off).not.toContain('**Command:**');
    expect(renderReport({...base, counters: {...counters, hits: 1, misses: 1}})).toContain('**1 hit** · 1 miss');
  });
});
