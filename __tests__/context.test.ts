import {describe, expect, it} from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultStore,
  expandHome,
  parseCacheSave,
  parseMaxGb,
  parseMinDeltaMb,
  parseCacheMode,
  parseSetupMode,
  shouldSetup,
  splitArgs,
  useActionsCache
} from '../src/context';

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/home/runner')).toBe('/home/runner');
    expect(expandHome('~/.naspeed', '/home/runner')).toBe('/home/runner/.naspeed');
    expect(expandHome('/mnt/store', '/home/runner')).toBe('/mnt/store');
    expect(expandHome('~other/x', '/home/runner')).toBe('~other/x');
  });
});

describe('defaultStore', () => {
  it('is ~/.naspeed off Windows', () => {
    expect(defaultStore('linux', '/home/runner', '/home/runner/work/r/r')).toBe('/home/runner/.naspeed');
    expect(defaultStore('darwin', '/Users/runner', '/Users/runner/work/r/r')).toBe('/Users/runner/.naspeed');
  });

  it('follows the workspace drive on Windows', () => {
    expect(defaultStore('win32', 'C:\\Users\\runneradmin', 'D:\\a\\r\\r')).toBe('D:\\.naspeed');
    expect(defaultStore('win32', 'C:\\Users\\me', 'c:\\src\\app')).toBe('C:\\Users\\me\\.naspeed');
  });
});

describe('splitArgs', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('  --cross\n --install-targets ')).toEqual(['--cross', '--install-targets']);
  });

  it('keeps quoted and escaped spaces like a shell', () => {
    expect(splitArgs('test --locked -- --skip "slow test"')).toEqual(['test', '--locked', '--', '--skip', 'slow test']);
    expect(splitArgs(`release --notes 'a "b" c' x\\ y ""`)).toEqual(['release', '--notes', 'a "b" c', 'x y', '']);
    expect(splitArgs('build --features "a b"c')).toEqual(['build', '--features', 'a bc']);
    expect(splitArgs('echo $HOME *')).toEqual(['echo', '$HOME', '*']);
  });

  it('rejects an unclosed quote', () => {
    expect(() => splitArgs('test "oops')).toThrow(/unclosed "/);
  });
});

describe('parseCacheSave', () => {
  it('accepts auto, true and false', () => {
    expect(parseCacheSave('')).toBe('auto');
    expect(parseCacheSave('TRUE')).toBe('true');
    expect(parseCacheSave('false')).toBe('false');
    expect(() => parseCacheSave('always')).toThrow(/auto, true or false/);
  });
});

describe('parseMaxGb', () => {
  it('needs a positive number', () => {
    expect(parseMaxGb('')).toBe(3);
    expect(parseMaxGb('2.5')).toBe(2.5);
    expect(() => parseMaxGb('0')).toThrow();
    expect(() => parseMaxGb('lots')).toThrow();
  });
});

describe('useActionsCache', () => {
  it('auto uses it on GitHub-hosted runners and on self-hosted ones with an empty store', () => {
    expect(useActionsCache('auto', 'github-hosted', true)).toBe(true);
    expect(useActionsCache('auto', undefined, false)).toBe(true);
    expect(useActionsCache('auto', 'self-hosted', false)).toBe(true);
    expect(useActionsCache('auto', 'self-hosted', true)).toBe(false);
  });

  it('true and false override the runner', () => {
    expect(useActionsCache('true', 'self-hosted', true)).toBe(true);
    expect(useActionsCache('false', 'github-hosted', false)).toBe(false);
  });

  it('rejects other values', () => {
    expect(parseCacheMode('')).toBe('auto');
    expect(parseCacheMode(' TRUE ')).toBe('true');
    expect(() => parseCacheMode('yes')).toThrow(/auto, true or false/);
  });
});

describe('setup mode', () => {
  it('auto configures Cargo projects but not Go-only projects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-action-'));
    expect(shouldSetup('auto', root)).toBe(false);
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/app\n');
    expect(shouldSetup('auto', root)).toBe(false);
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname="app"\n');
    expect(shouldSetup('auto', root)).toBe(true);
    expect(shouldSetup('false', root)).toBe(false);
    expect(shouldSetup('true', root)).toBe(true);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('validates the mode', () => {
    expect(parseSetupMode('')).toBe('auto');
    expect(parseSetupMode(' TRUE ')).toBe('true');
    expect(() => parseSetupMode('go')).toThrow(/auto, true or false/);
  });
});

describe('parseMinDeltaMb', () => {
  it('defaults to 50 and accepts 0 (always save)', () => {
    expect(parseMinDeltaMb('')).toBe(50);
    expect(parseMinDeltaMb('0')).toBe(0);
    expect(parseMinDeltaMb('120')).toBe(120);
  });

  it('rejects non-numbers and negatives', () => {
    expect(() => parseMinDeltaMb('abc')).toThrow(/non-negative number/);
    expect(() => parseMinDeltaMb('-1')).toThrow(/non-negative number/);
  });
});
