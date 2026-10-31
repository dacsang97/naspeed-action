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
  cache: boolean;
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

/**
 * `auto` (default): carry the store in the GitHub Actions cache on
 * GitHub-hosted runners, which start empty, and not on self-hosted ones,
 * where `~/.naspeed` already persists between jobs and runs.
 */
export function resolveCache(input: string, runnerEnvironment: string | undefined): boolean {
  const v = (input || 'auto').trim().toLowerCase();
  if (v === 'auto') return runnerEnvironment !== 'self-hosted';
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`cache must be auto, true or false, got ${JSON.stringify(input)}`);
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
    cache: resolveCache(core.getInput('cache'), process.env.RUNNER_ENVIRONMENT),
    // Empty: one slot per workflow job, derived automatically.
    cacheKey: core.getInput('cache-key'),
    cacheSave: parseCacheSave(core.getInput('cache-save')),
    cacheMaxGb: parseMaxGb(core.getInput('cache-max-gb')),
    token: core.getInput('token')
  };
}
