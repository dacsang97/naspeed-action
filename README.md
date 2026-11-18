# naspeed-action

GitHub Action for [naspeed](https://github.com/dacsang97/naspeed), the
build/release tool and transparent `RUSTC_WRAPPER` cache. One step:

1. downloads the naspeed release for the runner (Linux, macOS and Windows,
   x64 and arm64), verifies its checksum and keeps it in the runner tool cache;
2. runs `naspeed setup` for Cargo projects (Go-only projects skip the
   Cargo-specific setup);
3. restores the naspeed store from the GitHub Actions cache and, at the end of
   a successful job, exports it and saves it again;
4. optionally runs `naspeed <args>`, including release and image commands;
5. writes a **naspeed Report** to the job summary: rustc cache hits and misses,
   tests replayed, time saved, and what happened to the cache.

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

### Go releases and images

`args` maps directly to the naspeed CLI; the action does not translate or
silently add release flags. Configure the native Go release and image in
`ns.toml`:

```toml
[release]
toolchain = "go"
bins = ["lineart_api_svc"]
go_main = "./cmd"
go_ldflags = ["-s", "-w"]
go_cgo = false
targets = ["linux/amd64"]
sbom = "none"
before = ["go mod tidy", "go generate ./..."]

[image]
name = "docker.io/acme/ght-lineart-api-svc"
platforms = ["linux/amd64"]
dockerfile = "build/Dockerfile"
extra_files = ["configs/casbin/rbac_model.conf", "assets"]
tags = ["{version}", "latest"]
```

`image.name` is a literal repository (naspeed does not expand
`DOCKER_USERNAME` there), and Dockerfile mode currently requires exactly one
platform.

```yaml
- uses: actions/setup-go@v6
  with:
    go-version: stable
    cache: true
- uses: dacsang97/naspeed-action@v1
  with:
    args: release --snapshot
    cache-key: release
```

For a tag release, fetch the full history and give the job write permission:

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
      persist-credentials: false
  - uses: actions/setup-go@v6
    with:
      go-version: stable
      cache: true
  - uses: dacsang97/naspeed-action@v1
    with:
      args: release --publish
    env:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Build and push the configured Dockerfile image in a following step. Both
actions share the job-local store; the release step's post hook saves it after
the image build, including the compiled Go build cache and image build cache.

```yaml
- uses: docker/login-action@v4
  with:
    username: ${{ secrets.DOCKERHUB_USERNAME }}
    password: ${{ secrets.DOCKERHUB_TOKEN }}
- uses: dacsang97/naspeed-action@v1
  with:
    args: image --push
    cache: 'false'
```

`ns release` writes `dist/metadata.json`; `ns image` consumes it, stages the
selected binary and `extra_files`, and runs the configured Dockerfile. The
action exports the selected `store` as `NASPEED_STORE`, so the compiled Go
build cache and image build cache share the same default or custom store that
the action restores and saves. Dependency downloads remain cached by the
`actions/setup-go` step shown above.

### Private Go dependencies

The action can prepare private module access before it invokes naspeed. Existing
`GOPRIVATE`, `GONOSUMDB`, and `GOPROXY` job environment values always win; the
matching inputs are fallbacks for jobs that do not already set them.

```yaml
- uses: dacsang97/naspeed-action@v1
  with:
    args: release --snapshot
    goprivate: github.com/acme/*
    gonosumdb: github.com/acme/*
    goproxy: https://proxy.example.com|direct
    private-username: x-access-token
    private-token: ${{ secrets.PRIVATE_GO_TOKEN }}
    goproxy-username: proxy-user
    goproxy-token: ${{ secrets.PRIVATE_PROXY_TOKEN }}
```

The two credentials are independent and are never reused for each other.
`private-token` is served only for `github.com` by an ephemeral Git credential
helper. Job-scoped `GIT_CONFIG_COUNT` entries clear inherited helpers only for
the exact GitHub HTTPS credential section, add the helper, and disable
path-specific matching. Existing counted entries are preserved, and normal
global Git configuration remains active. Neither the exported config values nor
the helper contains the token. `goproxy-token` is written only to a job-scoped
`NETRC` file for HTTPS hosts listed in `GOPROXY`. Comma and pipe fallback
separators are supported.
Credential-bearing `goproxy` input URLs are rejected; provide proxy credentials
through the dedicated inputs instead. With `goproxy-token`, every proxy entry
must be a valid `https://` URL (apart from `direct`/`off` fallbacks), and at
least one HTTPS host is required. Existing `GOPROXY` values are preserved, and
any URL userinfo they contain is registered for log masking.

Credential files live under the runner temporary directory with restrictive
permissions. The action's post step removes them even when the job fails. The
tokens are not included in action state, cache keys, reports, or build output.

The native Go commands inherit the standard `GOPRIVATE`, `GONOSUMDB`,
`GOPROXY`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, and
`NETRC` environment variables. No private-dependency command-line flags are
added.

Only put naspeed on `PATH`, without touching cargo's config or the cache:

```yaml
- uses: dacsang97/naspeed-action@v1
  with:
    install-only: true
```

## Inputs

| Name               | Default               | Description                                                                                                   |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `version`          | `latest`              | `latest`, an exact version (`0.1.0` or `v0.1.0`) or a semver range (`~0.1`)                                   |
| `args`             |                       | Arguments for naspeed, run after setup and restore, e.g. `release --snapshot`; quotes work like in a shell    |
| `workdir`          | `.`                   | Working directory for `args`, relative to the repository root                                                 |
| `summary`          | `true`                | Write the naspeed report to the job summary                                                                   |
| `store`            | `~/.naspeed`          | naspeed store directory; on Windows the default follows the workspace drive (`D:\.naspeed` on hosted runners) |
| `setup`            | `auto`                | `auto` runs Cargo setup only when `Cargo.toml` exists; `true` or `false` override detection                   |
| `setup-args`       |                       | Extra arguments for `naspeed setup`, e.g. `--cross --install-targets`; only used when setup runs              |
| `install-only`     | `false`               | Only install naspeed; no setup or cache                                                                       |
| `cache`            | `auto`                | `auto` (skipped only on a self-hosted runner whose store is already warm), `true` or `false`                  |
| `cache-key`        |                       | Override the automatic cache slot (workflow, job and step); rarely needed                                     |
| `cache-save`       | `auto`                | `auto` (pushes to the default branch only), `true` or `false`                                                 |
| `cache-max-gb`     | `3`                   | Size cap of the exported store (GitHub allows 10 GB per repository)                                           |
| `token`            | `${{ github.token }}` | Token used to look up naspeed releases                                                                        |
| `private-token`    |                       | Masked token served only to `github.com` for private Go modules                                               |
| `private-username` | `x-access-token`      | Username paired with `private-token`                                                                          |
| `goproxy-token`    |                       | Separate masked token for authenticated HTTPS GOPROXY hosts                                                   |
| `goproxy-username` | `token`               | Username paired with `goproxy-token`                                                                          |
| `goprivate`        |                       | `GOPRIVATE` fallback; an existing job environment value is preserved                                          |
| `gonosumdb`        |                       | `GONOSUMDB` fallback; an existing job environment value is preserved                                          |
| `goproxy`          |                       | Credential-free `GOPROXY` fallback; comma and pipe separators are supported                                   |

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
that point; the post step still runs to clean temporary credentials.

## Cache keys

Entries are saved as
`naspeed-<os>-<arch>-<toolchain>-<slot>-<dependency hash>-<run id>-<attempt>`.
For a `go.mod`-only workdir the toolchain is `go-<version>`; for Cargo
projects and other workdirs it is `rustc-<version>`. Dependency inputs are
every `Cargo.lock`, `go.sum`, and `go.work.sum`. The slot is `cache-key` when
set, otherwise
`<workflow>-<job>-<hash of args, setup-args and workdir>`. Keys are immutable,
so every saved run is a new entry. A restore takes the newest entry of the same
slot and dependency set, then the same slot with any dependency set. An
automatic slot then falls back to any slot for the same toolchain, since a warm
store from another job beats a cold one; an explicit `cache-key` stays within
its own slot. GitHub evicts the least recently used entries past 10 GB.

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
