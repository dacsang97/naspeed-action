import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';

export type CacheSave = 'auto' | 'true' | 'false';

export interface Inputs {
  version: string;
  store: string;
  setupArgs: string[];
  args: string[];
  workdir: string;
  installOnly: boolean;
  summary: boolean;
  cache: CacheMode;
  cacheKey: string;
  cacheSave: CacheSave;
  cacheMaxGb: number;
  token: string;
}

/** `~` and `~/…` expand to the runner's home directory. */
export const expandHome = (p: string, home: string = os.homedir()): string => {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
};

/**
 * Splits a command line like a POSIX shell would for words: whitespace
 * separates, single quotes keep text literally, double quotes and a
 * backslash keep spaces. No expansion: `$X` and `*` stay as written.
 */
export function splitArgs(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in "${line}"`);
  if (inWord) words.push(word);
  return words;
}

export const parseCacheSave = (value: string): CacheSave => {
  const v = (value || 'auto').trim().toLowerCase();
  if (v === 'auto' || v === 'true' || v === 'false') return v;
  throw new Error(`cache-save must be auto, true or false (got "${value}")`);
};

export const parseMaxGb = (value: string): number => {
  const gb = Number(value || '3');
  if (!Number.isFinite(gb) || gb <= 0) {
    throw new Error(`cache-max-gb must be a positive number (got "${value}")`);
  }
  return gb;
};

export type CacheMode = 'auto' | 'true' | 'false';

export function parseCacheMode(input: string): CacheMode {
  const v = (input || 'auto').trim().toLowerCase();
  if (v === 'auto' || v === 'true' || v === 'false') return v;
  throw new Error(`cache must be auto, true or false, got ${JSON.stringify(input)}`);
}

/**
 * Whether to carry the store through the GitHub Actions cache. `auto` does
 * so unless the runner is self-hosted and its store already holds entries:
 * a persistent machine keeps `~/.naspeed` between runs, while an ephemeral
 * runner (or a persistent one on its first run) starts with an empty store
 * and needs the restore, and the save, like a GitHub-hosted runner.
 */
export function useActionsCache(mode: CacheMode, runnerEnvironment: string | undefined, storeWarm: boolean): boolean {
  if (mode !== 'auto') return mode === 'true';
  return runnerEnvironment !== 'self-hosted' || !storeWarm;
}

export function getInputs(): Inputs {
  return {
    version: core.getInput('version') || 'latest',
    store: expandHome(core.getInput('store') || '~/.naspeed'),
    setupArgs: splitArgs(core.getInput('setup-args')),
    args: splitArgs(core.getInput('args')),
    workdir: path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), core.getInput('workdir') || '.'),
    installOnly: core.getBooleanInput('install-only'),
    summary: core.getBooleanInput('summary'),
    cache: parseCacheMode(core.getInput('cache')),
    // Empty: one slot per workflow job, derived automatically.
    cacheKey: core.getInput('cache-key'),
    cacheSave: parseCacheSave(core.getInput('cache-save')),
    cacheMaxGb: parseMaxGb(core.getInput('cache-max-gb')),
    token: core.getInput('token')
  };
}
