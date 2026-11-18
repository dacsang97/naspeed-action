import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';

export interface PrivateGoOptions {
  token: string;
  username: string;
  proxyToken: string;
  proxyUsername: string;
  goPrivate: string;
  goNoSumDb: string;
  goProxy: string;
}

export interface PrivateGoState {
  dir: string;
}

const parsedProxyUrls = (value: string): URL[] => {
  const urls: URL[] = [];
  for (const candidate of value.split(/[,|]/).map(entry => entry.trim())) {
    if (!candidate || candidate === 'direct' || candidate === 'off') continue;
    try {
      urls.push(new URL(candidate));
    } catch {
      // Go validates non-URL proxy entries.
    }
  }
  return urls;
};

const mask = (secret: string): void => {
  if (!secret) return;
  core.setSecret(secret);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) core.setSecret(encoded);
};

const rejectInputCredentials = (value: string): void => {
  if (parsedProxyUrls(value).some(url => url.username || url.password)) {
    throw new Error('goproxy must not contain credentials; use goproxy-token and goproxy-username');
  }
};

const maskExistingProxyCredentials = (value: string): void => {
  for (const url of parsedProxyUrls(value)) {
    if (url.username) mask(url.username);
    if (url.password) mask(url.password);
    if (url.username || url.password) mask(`${url.username}:${url.password}`);
  }
};
const validateSingleLine = (name: string, value: string): void => {
  if (/[\r\n\0]/.test(value)) throw new Error(`${name} must be a single-line value without NUL`);
};

const validateCredentialFields = (options: PrivateGoOptions): void => {
  validateSingleLine('goprivate', options.goPrivate);
  validateSingleLine('gonosumdb', options.goNoSumDb);
  validateSingleLine('goproxy', options.goProxy);
  if (options.token) {
    validateSingleLine('private-token', options.token);
    validateSingleLine('private-username', options.username);
  }
  if (options.proxyToken) {
    if (!options.proxyUsername || /\s|\0/.test(options.proxyUsername)) {
      throw new Error('goproxy-username must be a non-empty netrc-safe token without whitespace');
    }
    if (/\s|\0/.test(options.proxyToken)) {
      throw new Error('goproxy-token must be a non-empty netrc-safe token without whitespace');
    }
  }
};

const authenticatedProxyHosts = (value: string): Set<string> => {
  const hosts = new Set<string>();
  for (const candidate of value.split(/[,|]/).map(entry => entry.trim())) {
    if (!candidate || candidate === 'direct' || candidate === 'off') continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error('goproxy-token requires every proxy entry to be a valid https:// URL');
    }
    if (url.protocol !== 'https:' || !url.hostname) {
      throw new Error('goproxy-token requires every proxy entry to be a valid https:// URL');
    }
    hosts.add(url.host);
  }
  if (hosts.size === 0) throw new Error('goproxy-token requires at least one https:// proxy host');
  return hosts;
};

const ensureTrailingNewline = (file: string): void => {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return;
  const fd = fs.openSync(file, 'r');
  try {
    const byte = Buffer.allocUnsafe(1);
    fs.readSync(fd, byte, 0, 1, fs.statSync(file).size - 1);
    if (byte[0] !== 0x0a) fs.appendFileSync(file, '\n');
  } finally {
    fs.closeSync(fd);
  }
};
const gitConfigCount = (): number => {
  const raw = process.env.GIT_CONFIG_COUNT;
  if (raw === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error('GIT_CONFIG_COUNT must be a non-negative decimal integer');
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count > Number.MAX_SAFE_INTEGER - 3) {
    throw new Error('GIT_CONFIG_COUNT is too large to append private Git configuration');
  }
  return count;
};

const appendGitHubCredentialConfig = (helper: string): void => {
  const start = gitConfigCount();
  const entries = [
    ['credential.https://github.com.helper', ''],
    ['credential.https://github.com.helper', `!"${process.execPath}" "${helper}"`],
    ['credential.https://github.com.useHttpPath', 'false']
  ];
  entries.forEach(([key, value], offset) => {
    core.exportVariable(`GIT_CONFIG_KEY_${start + offset}`, key);
    core.exportVariable(`GIT_CONFIG_VALUE_${start + offset}`, value);
  });
  core.exportVariable('GIT_CONFIG_COUNT', String(start + entries.length));
};

const credentialHelperSource = `const fs = require('node:fs');
const path = require('node:path');
let host = '';
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  for (const line of input.split(/\\r?\\n/)) {
    const split = line.indexOf('=');
    if (split >= 0 && line.slice(0, split) === 'host') host = line.slice(split + 1);
  }
  if (process.argv[2] !== 'get' || host !== 'github.com') return;
  const dir = path.dirname(__filename);
  process.stdout.write('username=' + fs.readFileSync(path.join(dir, 'github-username'), 'utf8') + '\\n');
  process.stdout.write('password=' + fs.readFileSync(path.join(dir, 'github-token'), 'utf8') + '\\n');
});
`;

/** Configure private Go access using job-scoped environment and credential files. */
export function configure(options: PrivateGoOptions): PrivateGoState | undefined {
  mask(options.token);
  mask(options.proxyToken);
  validateCredentialFields(options);
  rejectInputCredentials(options.goProxy);
  if (process.env.GOPROXY) maskExistingProxyCredentials(process.env.GOPROXY);
  const proxyHosts = options.proxyToken ? authenticatedProxyHosts(process.env.GOPROXY || options.goProxy) : undefined;
  if (options.token) gitConfigCount();
  if (!process.env.GOPRIVATE && options.goPrivate) core.exportVariable('GOPRIVATE', options.goPrivate);
  if (!process.env.GONOSUMDB && options.goNoSumDb) core.exportVariable('GONOSUMDB', options.goNoSumDb);
  if (!process.env.GOPROXY && options.goProxy) core.exportVariable('GOPROXY', options.goProxy);

  if (!options.token && !options.proxyToken) return undefined;

  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'naspeed-go-'));
  try {
    fs.chmodSync(dir, 0o700);

    if (options.token) {
      const helper = path.join(dir, 'github-credential-helper.cjs');
      const tokenFile = path.join(dir, 'github-token');
      const usernameFile = path.join(dir, 'github-username');
      fs.writeFileSync(helper, credentialHelperSource, {mode: 0o700});
      fs.writeFileSync(tokenFile, options.token, {mode: 0o600});
      fs.writeFileSync(usernameFile, options.username || 'x-access-token', {mode: 0o600});

      appendGitHubCredentialConfig(helper);
    }

    if (options.proxyToken) {
      const hosts = proxyHosts!;
      const netrc = path.join(dir, 'netrc');
      if (process.env.NETRC && fs.existsSync(process.env.NETRC)) {
        fs.copyFileSync(process.env.NETRC, netrc);
        ensureTrailingNewline(netrc);
      }
      const body = [...hosts]
        .map(host => `machine ${host}\nlogin ${options.proxyUsername}\npassword ${options.proxyToken}\n`)
        .join('');
      fs.appendFileSync(netrc, body, {mode: 0o600});
      fs.chmodSync(netrc, 0o600);
      core.exportVariable('NETRC', netrc);
    }

    return {dir};
  } catch (error) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw error;
  }
}

export function cleanup(state: PrivateGoState | undefined): void {
  if (!state?.dir) return;
  fs.rmSync(state.dir, {recursive: true, force: true});
}
