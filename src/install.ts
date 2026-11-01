import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as httpm from '@actions/http-client';
import * as tc from '@actions/tool-cache';
import * as semver from 'semver';
import * as ui from './ui';

/** Repository whose GitHub releases carry the naspeed archives. */
export const RELEASE_REPO = 'dacsang97/naspeed';

/**
 * Release target for a runner, matching the archives built by naspeed's
 * release-binaries workflow (static musl builds on Linux, MSVC on Windows).
 */
export const targetFor = (platform: string, arch: string): string => {
  const key = `${platform}-${arch}`;
  switch (key) {
    case 'linux-x64':
      return 'x86_64-unknown-linux-musl';
    case 'linux-arm64':
      return 'aarch64-unknown-linux-musl';
    case 'darwin-x64':
      return 'x86_64-apple-darwin';
    case 'darwin-arm64':
      return 'aarch64-apple-darwin';
    case 'win32-x64':
      return 'x86_64-pc-windows-msvc';
    case 'win32-arm64':
      return 'aarch64-pc-windows-msvc';
    default:
      throw new Error(`naspeed has no build for ${key} (supported: Linux, macOS and Windows, x64 and arm64)`);
  }
};

const isWindows = (target: string): boolean => target.includes('-windows-');

/** Archive extension: zip for Windows targets, tar.gz elsewhere. */
export const archiveExt = (target: string): string => (isWindows(target) ? 'zip' : 'tar.gz');

/** File name of the naspeed binary for a target. */
export const binaryName = (target: string): string => (isWindows(target) ? 'naspeed.exe' : 'naspeed');

/** `naspeed-v0.1.0-aarch64-apple-darwin`: archive stem and its top-level dir. */
export const archiveStem = (tag: string, target: string): string => `naspeed-${tag}-${target}`;

export const releaseUrl = (tag: string, file: string): string =>
  `https://github.com/${RELEASE_REPO}/releases/download/${tag}/${file}`;

/** First field of a `shasum -a 256` line: "<hash>  <file>". */
export const parseSha256 = (content: string): string => {
  const hash = content.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    throw new Error(`not a sha256 checksum file: "${content.trim().slice(0, 80)}"`);
  }
  return hash.toLowerCase();
};

interface Release {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}

/** Highest release tag satisfying `range`, ignoring drafts and prereleases. */
export const pickTag = (releases: Release[], range: string): string | undefined => {
  const byVersion = new Map<string, string>();
  for (const r of releases) {
    const v = semver.clean(r.tag_name);
    if (v && !r.draft && !r.prerelease) byVersion.set(v, r.tag_name);
  }
  const best = semver.maxSatisfying([...byVersion.keys()], range);
  return best ? byVersion.get(best) : undefined;
};

async function getJson<T>(url: string, token: string): Promise<T> {
  const http = new httpm.HttpClient('naspeed-action');
  const headers: Record<string, string> = {Accept: 'application/vnd.github+json'};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await http.getJson<T>(url, headers);
  if (res.statusCode !== 200 || !res.result) {
    throw new Error(`GET ${url} returned ${res.statusCode}`);
  }
  return res.result;
}

/** Resolves `latest`, an exact version or a semver range to a release tag. */
export async function resolveTag(version: string, token: string): Promise<string> {
  const api = `https://api.github.com/repos/${RELEASE_REPO}/releases`;
  const v = version.trim();
  if (v === 'latest') {
    return (await getJson<Release>(`${api}/latest`, token)).tag_name;
  }
  const exact = semver.valid(semver.clean(v) ?? '');
  if (exact) return `v${exact}`;
  if (!semver.validRange(v)) {
    throw new Error(`version must be latest, a version or a semver range (got "${version}")`);
  }
  const tag = pickTag(await getJson<Release[]>(`${api}?per_page=100`, token), v);
  if (!tag) throw new Error(`no naspeed release satisfies "${version}"`);
  return tag;
}

/** Downloads, verifies and caches naspeed; returns the binary's path. */
export async function install(tag: string, target: string): Promise<string> {
  const version = tag.replace(/^v/, '');
  const bin = binaryName(target);
  const cached = tc.find('naspeed', version, target);
  if (cached) {
    ui.info('found in the runner tool cache', {path: cached});
    return path.join(cached, bin);
  }

  const stem = archiveStem(tag, target);
  const file = `${stem}.${archiveExt(target)}`;
  const archiveUrl = releaseUrl(tag, file);
  ui.info('downloading', {url: archiveUrl});
  const archive = await tc.downloadTool(archiveUrl);
  const sums = await tc.downloadTool(`${archiveUrl}.sha256`);

  const expected = parseSha256(fs.readFileSync(sums, 'utf8'));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  ui.info('checksum verified', {sha256: actual.slice(0, 12)});

  const extracted = archiveExt(target) === 'zip' ? await tc.extractZip(archive) : await tc.extractTar(archive);
  const dir = path.join(extracted, stem);
  if (!fs.existsSync(path.join(dir, bin))) {
    throw new Error(`${file} has no ${stem}/${bin}`);
  }
  const cachedDir = await tc.cacheDir(dir, 'naspeed', version, target);
  return path.join(cachedDir, bin);
}
