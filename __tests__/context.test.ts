import {describe, expect, it} from 'vite-plus/test';
import {expandHome, parseCacheSave, parseMaxGb, resolveCache, splitArgs} from '../src/context';

describe('expandHome', () => {
  it('expands ~ and ~/ only', () => {
    expect(expandHome('~', '/home/runner')).toBe('/home/runner');
    expect(expandHome('~/.naspeed', '/home/runner')).toBe('/home/runner/.naspeed');
    expect(expandHome('/mnt/store', '/home/runner')).toBe('/mnt/store');
    expect(expandHome('~other/x', '/home/runner')).toBe('~other/x');
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

describe('resolveCache', () => {
  it('auto uses the Actions cache on GitHub-hosted runners only', () => {
    expect(resolveCache('auto', 'github-hosted')).toBe(true);
    expect(resolveCache('', undefined)).toBe(true);
    expect(resolveCache('auto', 'self-hosted')).toBe(false);
  });

  it('true and false override the runner', () => {
    expect(resolveCache('true', 'self-hosted')).toBe(true);
    expect(resolveCache('false', 'github-hosted')).toBe(false);
    expect(() => resolveCache('yes', undefined)).toThrow(/auto, true or false/);
  });
});
