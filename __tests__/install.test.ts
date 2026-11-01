import {describe, expect, it} from 'vite-plus/test';
import {archiveExt, archiveStem, binaryName, parseSha256, pickTag, releaseUrl, targetFor} from '../src/install';

describe('targetFor', () => {
  it('maps runners to release targets', () => {
    expect(targetFor('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(targetFor('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
    expect(targetFor('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(targetFor('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(targetFor('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(targetFor('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
  });

  it('rejects platforms without a build', () => {
    expect(() => targetFor('freebsd', 'x64')).toThrow(/no build for freebsd-x64/);
    expect(() => targetFor('win32', 'ia32')).toThrow(/no build for win32-ia32/);
  });
});

describe('release assets', () => {
  it('match the names of the release-binaries workflow', () => {
    const stem = archiveStem('v0.1.0', 'aarch64-apple-darwin');
    expect(stem).toBe('naspeed-v0.1.0-aarch64-apple-darwin');
    expect(releaseUrl('v0.1.0', `${stem}.tar.gz`)).toBe(
      'https://github.com/dacsang97/naspeed/releases/download/v0.1.0/naspeed-v0.1.0-aarch64-apple-darwin.tar.gz'
    );
  });

  it('are zips holding naspeed.exe on Windows', () => {
    expect(archiveExt('x86_64-pc-windows-msvc')).toBe('zip');
    expect(binaryName('aarch64-pc-windows-msvc')).toBe('naspeed.exe');
    expect(archiveExt('x86_64-unknown-linux-musl')).toBe('tar.gz');
    expect(binaryName('aarch64-apple-darwin')).toBe('naspeed');
  });
});

describe('parseSha256', () => {
  const hash = '5fc3d370ef6061a5a66b8d5a1827533bcfadf85bc74d76a2959a60ab458e7c40';

  it('reads shasum output', () => {
    expect(parseSha256(`${hash}  naspeed-v0.1.0-aarch64-apple-darwin.tar.gz\n`)).toBe(hash);
    expect(parseSha256(hash.toUpperCase())).toBe(hash);
  });

  it('rejects anything else', () => {
    expect(() => parseSha256('Not Found')).toThrow(/not a sha256/);
    expect(() => parseSha256('')).toThrow(/not a sha256/);
  });
});

describe('pickTag', () => {
  const releases = [
    {tag_name: 'v0.1.0'},
    {tag_name: 'v0.1.3'},
    {tag_name: 'v0.2.0'},
    {tag_name: 'v0.2.1-rc.1', prerelease: true},
    {tag_name: 'v0.3.0', draft: true}
  ];

  it('picks the highest published release in range', () => {
    expect(pickTag(releases, '~0.1')).toBe('v0.1.3');
    expect(pickTag(releases, '^0.2')).toBe('v0.2.0');
    expect(pickTag(releases, '>=0.1')).toBe('v0.2.0');
  });

  it('returns undefined when nothing matches', () => {
    expect(pickTag(releases, '^1')).toBeUndefined();
  });
});
