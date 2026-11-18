import {afterEach, describe, expect, it, vi} from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {spawnSync} from 'node:child_process';

const actions = vi.hoisted(() => ({
  exportVariable: vi.fn((name: string, value: unknown) => {
    process.env[name] = String(value);
  }),
  setSecret: vi.fn()
}));
vi.mock('@actions/core', () => actions);

import {cleanup, configure, type PrivateGoOptions} from '../src/private-go';

const originalEnv = {...process.env};
const options = (overrides: Partial<PrivateGoOptions> = {}): PrivateGoOptions => ({
  token: '',
  username: 'x-access-token',
  proxyToken: '',
  proxyUsername: 'token',
  goPrivate: '',
  goNoSumDb: '',
  goProxy: '',
  ...overrides
});

afterEach(() => {
  process.env = {...originalEnv};
  vi.clearAllMocks();
});

describe('private Go configuration', () => {
  it('preserves existing Go settings and masks credential-bearing existing GOPROXY', () => {
    process.env.GOPRIVATE = 'existing/private';
    process.env.GONOSUMDB = 'existing/nosum';
    process.env.GOPROXY = 'https://proxy-user:proxy-pass@existing.invalid|direct';

    expect(
      configure(
        options({
          goPrivate: 'new/private',
          goNoSumDb: 'new/nosum',
          goProxy: 'https://new.invalid'
        })
      )
    ).toBeUndefined();
    expect(actions.exportVariable).not.toHaveBeenCalled();
    expect(process.env.GOPROXY).toBe('https://proxy-user:proxy-pass@existing.invalid|direct');
    expect(actions.setSecret).toHaveBeenCalledWith('proxy-user');
    expect(actions.setSecret).toHaveBeenCalledWith('proxy-pass');
  });

  it('preserves global and counted Git config while appending secret-free scoped helpers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
    process.env.RUNNER_TEMP = root;
    process.env.HOME = root;
    delete process.env.GIT_CONFIG_GLOBAL;
    delete process.env.GOPROXY;
    fs.writeFileSync(path.join(root, '.gitconfig'), '[review]\n\tmarker = global-still-active\n');
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'user.existing';
    process.env.GIT_CONFIG_VALUE_0 = 'counted-still-active';

    const first = configure(
      options({
        token: 'github-placeholder',
        username: 'github-user',
        proxyToken: 'proxy-placeholder',
        proxyUsername: 'proxy-user',
        goProxy: 'https://proxy.invalid:8443|https://two.example.invalid,direct'
      })
    );

    expect(first).toBeDefined();
    expect(process.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(process.env.GIT_CONFIG_COUNT).toBe('4');
    const exportedConfig = actions.exportVariable.mock.calls
      .filter(([name]) => String(name).startsWith('GIT_CONFIG_'))
      .flat()
      .join(' ');
    expect(exportedConfig).not.toContain('github-placeholder');
    expect(JSON.stringify(first)).not.toContain('placeholder');
    expect(
      spawnSync('git', ['config', '--global', '--get', 'review.marker'], {
        env: process.env,
        encoding: 'utf8'
      }).stdout.trim()
    ).toBe('global-still-active');
    expect(
      spawnSync('git', ['config', '--get', 'user.existing'], {env: process.env, encoding: 'utf8'}).stdout.trim()
    ).toBe('counted-still-active');

    const helper = path.join(first!.dir, 'github-credential-helper.cjs');
    const netrc = fs.readFileSync(process.env.NETRC!, 'utf8');
    expect(fs.readFileSync(helper, 'utf8')).not.toContain('github-placeholder');
    expect(netrc).not.toContain('github-placeholder');
    expect(netrc).toContain('password proxy-placeholder');
    expect(netrc).toContain('machine proxy.invalid:8443');
    expect(netrc).toContain('machine two.example.invalid');
    expect(fs.statSync(process.env.NETRC!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(first!.dir, 'github-token')).mode & 0o777).toBe(0o600);

    const credential = spawnSync('git', ['credential', 'fill'], {
      env: process.env,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    });
    expect(credential.stdout).toContain('username=github-user');
    expect(credential.stdout).toContain('password=github-placeholder');

    const second = configure(options({token: 'second-placeholder', username: 'second-user'}));
    expect(process.env.GIT_CONFIG_COUNT).toBe('7');
    expect(actions.exportVariable.mock.calls.flat().join(' ')).not.toContain('second-placeholder');

    cleanup(first);
    cleanup(second);
    expect(fs.existsSync(first!.dir)).toBe(false);
    expect(fs.existsSync(second!.dir)).toBe(false);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('adds a newline before extending a copied netrc', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
    const originalNetrc = path.join(root, 'original-netrc');
    fs.writeFileSync(originalNetrc, 'machine existing.invalid login existing password existing', {mode: 0o600});
    process.env.RUNNER_TEMP = root;
    process.env.NETRC = originalNetrc;
    delete process.env.GOPROXY;

    const state = configure(
      options({proxyToken: 'proxy-token', proxyUsername: 'proxy-user', goProxy: 'https://proxy.invalid'})
    );
    expect(fs.readFileSync(process.env.NETRC!, 'utf8')).toContain(
      'password existing\nmachine proxy.invalid\nlogin proxy-user'
    );

    cleanup(state);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('rejects credential-bearing input before creating temporary files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
    process.env.RUNNER_TEMP = root;

    expect(() =>
      configure(options({proxyToken: 'separate-token', goProxy: 'https://user:password@proxy.invalid|direct'}))
    ).toThrow(/must not contain credentials/);
    expect(fs.readdirSync(root)).toEqual([]);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('removes its temporary directory when setup throws', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
    process.env.RUNNER_TEMP = root;
    process.env.NETRC = root;
    delete process.env.GOPROXY;

    expect(() =>
      configure(options({proxyToken: 'proxy-token', proxyUsername: 'proxy-user', goProxy: 'https://proxy.invalid'}))
    ).toThrow();
    expect(fs.readdirSync(root).filter(name => name.startsWith('naspeed-go-'))).toEqual([]);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it.each(['', '-1', '1.5', 'abc', '9007199254740991'])(
    'rejects malformed GIT_CONFIG_COUNT %j before creating temporary files',
    count => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
      process.env.RUNNER_TEMP = root;
      process.env.GIT_CONFIG_COUNT = count;

      expect(() => configure(options({token: 'github-token'}))).toThrow(/GIT_CONFIG_COUNT/);
      expect(fs.readdirSync(root)).toEqual([]);
      fs.rmSync(root, {recursive: true, force: true});
    }
  );
  it.each([
    ['HTTP proxy', options({proxyToken: 'proxy-token', goProxy: 'http://proxy.invalid'})],
    ['invalid proxy', options({proxyToken: 'proxy-token', goProxy: 'not a url'})],
    ['direct-only proxy', options({proxyToken: 'proxy-token', goProxy: 'direct'})],
    ['Git username newline', options({token: 'github-token', username: 'user\ninjected'})],
    ['Git token NUL', options({token: 'github\0token'})],
    [
      'proxy username whitespace',
      options({proxyToken: 'proxy-token', proxyUsername: 'proxy user', goProxy: 'https://proxy.invalid'})
    ],
    [
      'proxy token whitespace',
      options({proxyToken: 'proxy token', proxyUsername: 'proxy-user', goProxy: 'https://proxy.invalid'})
    ],
    ['multiline goprivate', options({goPrivate: 'github.com/acme/*\ninjected'})],
    ['multiline gonosumdb', options({goNoSumDb: 'github.com/acme/*\rinjected'})],
    ['multiline goproxy', options({goProxy: 'https://proxy.invalid\ninjected'})]
  ])('fails closed for %s without leaking a temporary directory', (_name, invalid) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naspeed-private-go-test-'));
    process.env.RUNNER_TEMP = root;
    delete process.env.GOPROXY;

    expect(() => configure(invalid)).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('exports only missing optional Go settings without credentials', () => {
    delete process.env.GOPRIVATE;
    delete process.env.GONOSUMDB;
    delete process.env.GOPROXY;

    configure(options({goPrivate: 'github.com/acme/*'}));

    expect(actions.exportVariable).toHaveBeenCalledOnce();
    expect(actions.exportVariable).toHaveBeenCalledWith('GOPRIVATE', 'github.com/acme/*');
  });
});
