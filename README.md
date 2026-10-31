# naspeed-action

GitHub Action for [naspeed](https://github.com/dacsang97/naspeed), the
transparent `RUSTC_WRAPPER` build cache. One step:

1. downloads the naspeed release for the runner (Linux and macOS, x64 and
   arm64), verifies its checksum and keeps it in the runner tool cache;
2. runs `naspeed setup`, so every later `cargo` call in the job goes through
   naspeed (`ns` is on `PATH` too);
3. restores the naspeed store from the GitHub Actions cache and, at the end of
   a successful job, exports it and saves it again;
4. optionally runs `naspeed <args>`;
5. writes a **naspeed Report** to the job summary: rustc hits and misses,
   test binaries replayed, time saved, and what happened to the cache.

The log is a tree; the action's steps and naspeed's own lines share one format:

```text
• installing naspeed                    version=latest target=x86_64-unknown-linux-musl
  • resolved                            version=v0.1.2
  • checksum verified                   sha256=5fc3d370ef60
• setting up naspeed
  • binary installed                    path=/home/runner/.cargo/bin/naspeed
  • store ready                         path=/home/runner/.naspeed clones=no
• restoring store                       prefix=test-Linux-X64-1.99.1-ab12…-
  • restored                            key=test-Linux-X64-1.99.1-ab12…-41-1-test
  • importing store                     dir=/home/runner/.naspeed-ci
    • imported 347 entries              objects_copied=812 size=1.2 GiB
• running cargo test                    args=--locked
  (cargo test output)
• cargo test passed
  • rustc                               hits=346 misses=2
  • tests                               replayed=1 ran=1
    • took: 41s
```

The lines of `args` are naspeed's own: the action adds none around the command.

## Usage

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable # install Rust first
      - uses: dacsang97/naspeed-action@v1
        with:
          args: test --locked # `ns test`: cargo test + test result cache
```

Leave `args` empty to only install and set up; later `run:` steps that call
`cargo` or `ns` still go through naspeed, and the report counts them too:

```yaml
- uses: dacsang97/naspeed-action@v1
- run: ns check --locked # rustfmt --check, then clippy -D warnings
```

By default the store is saved only by pushes to the default branch. Pull
requests, forks included, restore it but never write it, so a pull request
cannot plant artifacts that `main` builds would pick up later.

There is no cache key to name. Each step gets its own slot from the workflow,
the job and what the step runs (`args`, `setup-args`, `workdir`), so a release
build never evicts the store a test job relies on, and matrix legs running
different commands stay apart. A self-hosted runner whose store already
holds entries skips the GitHub Actions cache (`cache: auto`): the store persists
on its disk. An ephemeral runner, or a persistent one on its first run, starts
empty and restores and saves like a GitHub-hosted runner.

```yaml
- uses: dacsang97/naspeed-action@v1
  with:
    setup-args: --cross --install-targets
    args: release --target x86_64-unknown-linux-musl
```

Only put naspeed on `PATH`, without touching cargo's config or the cache:

```yaml
- uses: dacsang97/naspeed-action@v1
  with:
    install-only: true
```

## Inputs

| Name           | Default               | Description                                                                                           |
| -------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `version`      | `latest`              | `latest`, an exact version (`0.1.0` or `v0.1.0`) or a semver range (`~0.1`)                           |
| `args`         |                       | Arguments for naspeed, run after setup and restore, e.g. `test --locked`; quotes work like in a shell |
| `workdir`      | `.`                   | Working directory for `args`, relative to the repository root                                         |
| `summary`      | `true`                | Write the naspeed report to the job summary                                                           |
| `store`        | `~/.naspeed`          | naspeed store directory                                                                               |
| `setup-args`   |                       | Extra arguments for `naspeed setup`, e.g. `--cross --install-targets`                                 |
| `install-only` | `false`               | Only install naspeed; no `naspeed setup`, no cache                                                    |
| `cache`        | `auto`                | `auto` (skipped only on a self-hosted runner whose store is already warm), `true` or `false`          |
| `cache-key`    |                       | Override the automatic cache slot (workflow, job and step); rarely needed                             |
| `cache-save`   | `auto`                | `auto` (pushes to the default branch only), `true` or `false`                                         |
| `cache-max-gb` | `3`                   | Size cap of the exported store (GitHub allows 10 GB per repository)                                   |
| `token`        | `${{ github.token }}` | Token used to look up naspeed releases                                                                |

## Outputs

| Name                | Description                            |
| ------------------- | -------------------------------------- |
| `version`           | Installed naspeed version              |
| `path`              | Path of the naspeed binary             |
| `cache-hit`         | `true` when a saved store was restored |
| `cache-matched-key` | Key of the restored cache entry        |

## Report

With `summary: true` (the default) the job summary gets a report like:

> ## naspeed Report
>
> ### Summary
>
> - **Command:** ✅ `naspeed test --locked`
> - **Build:** ✅ **346 hits** · 2 misses · 99.4% hit rate · saved 4m01s
> - **Tests:** ✅ **1 replayed** · 1 ran · saved 4s
> - **Store:** ♻️ restored `test-Linux-X64-1.99.1-ab12…-41-1-test`
> - **Saved:** 💾 `test-Linux-X64-1.99.1-ab12…-42-1-test`

The numbers are the difference of `naspeed stats --json` between the end of
the action's main step and its post step, so they cover every `cargo` and `ns`
call of the job after the action. When `args` fails, the report is written at
that point, since the post step only runs for successful jobs.

## Cache keys

Entries are saved as
`naspeed-<os>-<arch>-<rustc version>-<slot>-<hash of **/Cargo.lock>-<run id>-<attempt>`,
where the slot is `cache-key` when set, otherwise
`<workflow>-<job>-<hash of args, setup-args and workdir>`. Keys are immutable,
so every saved run is a new entry. A restore takes the newest entry of the same
slot and lockfile, then the same slot with any lockfile. An automatic slot
then falls back to any slot for the same compiler, since a warm store from
another job beats a cold one; an explicit `cache-key` stays within its own slot. GitHub evicts the
least recently used entries past 10 GB.

The exported store travels in `~/.naspeed-ci`, the same directory the
workflows from `ns ci init` use.

## Development

The toolchain is [Vite+](https://viteplus.dev/) (`vp`); its settings live in
`vite.config.ts`.

```sh
vp install
vp check           # format (Oxfmt), lint (Oxlint) and type check; --fix to apply
vp test
vp pack            # rebuilds dist/index.js; commit it with the sources
```

Releases are tagged `v1.x.y`; the `release major tag` workflow moves `v1`.

## License

Apache-2.0
