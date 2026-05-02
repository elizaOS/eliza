# Running CI locally with `act`

`nektos/act` runs `.github/workflows/*.yml` against a local Docker daemon so you can iterate on workflow YAML without a push-trigger-wait loop.

## Install

```bash
# macOS
brew install act

# Linux (or any platform with the install script)
curl -s https://raw.githubusercontent.com/nektos/act/master/install.sh | sudo bash
```

Requires Docker Desktop (or any local Docker daemon). The first run downloads runner images (~1–2 GB).

## First-run config

Create `~/.actrc` (or `./.actrc` for repo-local) to pin the runner image. The medium image matches `ubuntu-24.04` closely enough for our CI:

```
-P ubuntu-24.04=catthehacker/ubuntu:act-latest
-P ubuntu-latest=catthehacker/ubuntu:act-latest
--container-architecture linux/amd64
```

The `--container-architecture` flag is required on Apple Silicon — without it `act` runs `arm64` containers and most setup actions break.

## Common commands

```bash
# List jobs that would run for the default event (push)
act -l

# Run a specific workflow + job
act -j lint -W .github/workflows/ci.yml

# Run on the pull_request event
act pull_request -W .github/workflows/test.yml -j unit-tests

# Pass a secret (won't read from the GitHub UI)
act -j build -s GITHUB_TOKEN="$(gh auth token)"

# Pass a whole .env file of secrets
act -j publish -W .github/workflows/publish-npm.yml --secret-file .secrets.local
```

## Caveats specific to this repo

1. **Submodules.** Workflows here check out with `submodules: false` and restore via `scripts/restore-local-eliza-workspace.mjs`. `act` runs against your existing working tree, so make sure your submodules are already initialized (`git submodule update --init --recursive`) before invoking.

2. **Bun version pin.** Workflows pin `BUN_VERSION` and use `oven-sh/setup-bun@v2`. The `catthehacker` images include bun, but the version differs. Use `--env BUN_VERSION=1.3.11` if a step is sensitive.

3. **GitHub Actions cache.** `actions/cache@v4` is a no-op under `act` by default. Pass `--use-action-cache` to enable a host-side cache, or accept that local runs will always be cold.

4. **Skipping heavy jobs.** Many of our workflows have docker, mobile, or signing steps that won't run locally. Use `act -j <single-job-id>` to target the one you actually want to test.

5. **Secrets.** Never commit `.secrets.local`. Add it to `.gitignore` if you create one.

6. **Limitations.** `act` cannot replicate macOS or Windows runners — those workflows (`release-electrobun.yml`, `windows-*-smoke.yml`, `apple-store-release.yml`) must be tested via `workflow_dispatch` on a branch.

## When `act` is the right tool

- Iterating on a new job's setup steps before the first push.
- Reproducing a CI failure locally that doesn't reproduce in `bun run verify`.
- Validating workflow YAML changes (path filters, matrix definitions, conditionals) without spamming branches.

## When it isn't

- Anything that hits real GitHub APIs that require live tokens (PR comments, deployment APIs).
- macOS/Windows-only steps.
- Behavior that depends on the actual GitHub-hosted runner image (rare, but happens with native binaries).

## See also

- Upstream docs: <https://nektosact.com/>
- Source: <https://github.com/nektos/act>
- Existing pre-push gate: `bun run pre-review:local` (see `.github/workflows/ci.yml` `pre-review` job)
