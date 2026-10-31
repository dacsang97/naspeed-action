import {describe, expect, it} from 'vite-plus/test';
import {autoScope, cacheKeys, shouldSave, transferDir} from '../src/store-cache';

describe('cacheKeys', () => {
  const {key, restoreKeys} = cacheKeys(
    {scope: 'ci-test-1a2b3c4d', os: 'Linux', arch: 'X64', rustc: '1.98.0', lockHash: 'abc'},
    {id: '42', attempt: '1'}
  );

  it('makes every save a new key', () => {
    expect(key).toBe('naspeed-Linux-X64-1.98.0-ci-test-1a2b3c4d-abc-42-1');
  });

  it('restores the same job and lockfile, then the same job, then any job for the compiler', () => {
    expect(restoreKeys).toEqual([
      'naspeed-Linux-X64-1.98.0-ci-test-1a2b3c4d-abc-',
      'naspeed-Linux-X64-1.98.0-ci-test-1a2b3c4d-',
      'naspeed-Linux-X64-1.98.0-'
    ]);
    for (const prefix of restoreKeys) expect(key.startsWith(prefix)).toBe(true);
  });
});

describe('autoScope', () => {
  const step = {args: ['test', '--locked'], setupArgs: [], workdir: '.'};

  it('names the slot after the workflow and job, safe for a cache key', () => {
    expect(autoScope('CI / Rust', 'test', step)).toMatch(/^ci-rust-test-[0-9a-f]{8}$/);
  });

  it('separates steps that run different commands in the same job', () => {
    expect(autoScope('ci', 'test', step)).toBe(autoScope('ci', 'test', {...step}));
    expect(autoScope('ci', 'test', step)).not.toBe(
      autoScope('ci', 'test', {...step, args: ['test', '--features', 'x']})
    );
    expect(autoScope('ci', 'clippy', step)).not.toBe(autoScope('ci', 'test', step));
  });
});

describe('shouldSave', () => {
  const push = {name: 'push', ref: 'refs/heads/main', defaultBranch: 'main'};

  it('auto saves only pushes to the default branch', () => {
    expect(shouldSave('auto', push)).toBe(true);
    expect(shouldSave('auto', {...push, ref: 'refs/heads/feature'})).toBe(false);
    expect(shouldSave('auto', {...push, name: 'pull_request', ref: 'refs/pull/1/merge'})).toBe(false);
    expect(shouldSave('auto', {...push, defaultBranch: undefined})).toBe(false);
  });

  it('true and false override the event', () => {
    expect(shouldSave('true', {...push, name: 'pull_request'})).toBe(true);
    expect(shouldSave('false', push)).toBe(false);
  });
});

describe('transferDir', () => {
  it('is the ns ci init cache directory', () => {
    expect(transferDir('/home/runner')).toBe('/home/runner/.naspeed-ci');
  });
});
