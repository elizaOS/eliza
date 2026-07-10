# CI/CD Workflows

This directory contains GitHub Actions workflows for the elizaOS project (v2.0.0).

## Workflow Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yaml` | Push/PR to main | Main-specific CI - typecheck, tests, lint, build, dev startup |
| `test.yml` | Push/PR to develop, manual, schedule | Broader develop tests plus required zero-key deterministic E2E; live jobs are separate |
| `quality.yml` | Push/PR to main/develop, manual | Develop/main quality gates: format, type-safety ratchet, prompt-secret scan, UI determinism, lint |
| `scenario-pr.yml` | PR to main/develop, manual | Secret-free deterministic scenario/browser E2E gate |
| `scenario-matrix.yml` | Develop/manual opt-in | Real-service scenario matrix; not a PR gate |
| `pr.yaml` | PR opened/edited | PR title validation |
| `release.yaml` | Push to main, Release | NPM beta/production package releases |
| `claude.yml` | @claude mentions | Interactive Claude assistance |
| `claude-code-review.yml` | PR opened | Automated code review |
| `claude-security-review.yml` | PR opened | Security-focused review |
| `codeql.yml` | Push/PR to main, Weekly | Static security analysis |
| `docs-ci.yml` | PR (docs paths), Manual | Documentation quality checks |
| `build-agent-image.yml` | Push develop/main, Release, Manual | Docker image builds (`:develop`, `:stable`, `:latest`, release tags) |
| `tee-build-deploy.yml` | Push to main, Manual | TEE deployment to Phala Cloud |
| `weekly-maintenance.yml` | Weekly, Manual | Dependency/security audits |
| `jsdoc-automation.yml` | Manual | JSDoc generation |

## Release Workflows

### Alpha Tags

Alpha version tags are tags only. They do not publish NPM packages, run packaging
CI, or create GitHub Release entries.

### NPM Beta/Production Packages (`release.yaml`)

Publishes TypeScript/JavaScript packages to NPM.

**Triggers:**

- Push to `main` → Beta release (`@beta` tag)
- GitHub Release created → Production release (`@latest` tag)

**Packages:** All `@elizaos/*` packages in the monorepo

## Test Workflows

### Linux Runner Policy

The heavy develop **test lanes** in `test.yml` run on the self-hosted
`self-hosted, hetzner-robot` pool (GitHub-hosted minutes are billing-frozen for
this org, #13481). Everything the **merge gate** depends on to *reach a
conclusion* stays GitHub-hosted so a drained fleet can never wedge develop:

- **Path classifiers** (`Classify changed paths`) across `test.yml`,
  `scenario-pr.yml`, `dev-smoke.yml`, `docker-ci-smoke.yml`,
  `mobile-build-smoke.yml`, `windows-dev-smoke.yml`, and
  `windows-desktop-preload-smoke.yml` run on `ubuntu-24.04`. They are git-diff +
  node scripts with no self-hosted needs; pinning them to the fleet (#8501) once
  left every downstream job queued indefinitely and gridlocked develop.
- **`ci-ok`** (the merge queue's sole required context), its
  `plugin-tests-status` roll-up, and the hosted **`merge-quality-gate`** all run
  on `ubuntu-24.04`.

Two SPOF guards, enforced by `packages/scripts/ci-merge-gate-contract.mjs` (run
in the `changes` job, #13617):

1. **Fleet-drain toggle.** Every self-hosted lane in `test.yml` reads
   `runs-on: ${{ fromJSON(vars.HETZNER_FLEET_ONLINE == 'false' && '["ubuntu-24.04"]' || '["self-hosted","hetzner-robot"]') }}`.
   Unset/anything-but-`false` keeps the current self-hosted placement; there is
   no way to probe fleet health from a `runs-on:` expression, so during an
   outage an admin sets repo **variable** `HETZNER_FLEET_ONLINE=false` once and
   the whole workflow falls back to hosted — one flip unblocks the entire queue
   instead of per-PR admin-bypass. Keep the runner-agnostic step hardening (no
   `sudo`-only install/cleanup) so lanes run on either runner type.
2. **Hosted quality parity.** `merge-quality-gate` runs the same lint /
   `format:check` / repo-wide `typecheck` / gitleaks secret scan that guard
   `main`, and `ci-ok` needs it — so a lint, type, format, or committed-secret
   regression is refused by the merge queue on develop, not just on `main`. It
   runs on `merge_group` + develop `push`. The lightweight `develop-pr.yml`
   lint job also runs `format:check`, so formatting fails on the PR even when a
   busy push wave supersedes post-merge quality runs (#15959).

CodeQL is a separate exception: trusted push, scheduled, and manual CodeQL runs
use `self-hosted, Linux, X64, hetzner-robot` because full JavaScript analysis is
disk-bound and has exhausted GitHub-hosted runners during the `PolynomialReDoS`
dataflow query. Pull-request CodeQL remains GitHub-hosted so forked code never
executes on self-hosted machines. Keep the full CodeQL query surface intact;
move capacity around rather than weakening security coverage. The CodeQL config
may ignore deliberately invalid negative-test fixtures, but not real source
files; those fixtures should stay covered by their owning tests.

GPU / KVM / macOS jobs (labels `gpu-cuda-12.6`, `kvm`, `eliza-e2e-macos`) are a
separate purpose-built fleet and are unaffected by this policy.

### PR Path Gates

PR workflows use `packages/scripts/ci-path-gate.mjs` to keep expensive lanes
targeted. Each classifier job writes a GitHub step summary showing:

- which files changed
- which lanes will run
- which path or label caused each lane to run

Maintainers can force specific lanes with labels:

| Label | Effect |
|-------|--------|
| `ci:full` | Run every path-gated lane in workflows that honor the shared gate |
| `ci:e2e` / `ci:zero-key` | Run deterministic zero-key E2E lanes |
| `ci:scenario` | Run `scenario-pr.yml` deterministic scenario/browser E2E |
| `ci:server` | Run server tests |
| `ci:client` | Run client tests |
| `ci:plugins` | Run plugin tests |
| `ci:cloud` | Run cloud live E2E where secrets are configured |
| `ci:docker` | Run Docker CI smoke |
| `ci:mobile` / `ci:ios` / `ci:android` | Run mobile smoke, or one mobile platform |
| `ci:desktop` / `ci:windows` | Run desktop and Windows smoke lanes |
| `ci:dev-smoke` | Run the `bun run dev` onboarding smoke |

Push, scheduled, and manual runs keep their broader/default behavior; the path
gate mainly keeps PR feedback fast and explainable.

Why this exists:

- OSS contributors should get useful feedback quickly without waiting on
  unrelated mobile, Docker, desktop, Windows, or browser-heavy lanes.
- Maintainers should be able to see why a lane ran or skipped from the job
  summary, without reverse-engineering shell conditionals.
- The quality gate should stay equivalent for affected code. Path gates decide
  which surface is relevant; they do not replace the tests for that surface.
- Push, scheduled, and manual runs remain broad because they protect branch
  health, release readiness, and nightly confidence rather than one PR diff.

Quality contract:

- Any path-gated lane must be forced by `ci:full`.
- Every expensive lane needs a matching force label so maintainers can request
  coverage without pushing a no-op commit.
- Workflow, shared setup, toolchain, lockfile, and classifier changes should run
  the affected expensive lanes because they can change CI behavior even when
  product code did not move.
- The `Tests` workflow runs the classifier self-test before consuming classifier
  outputs. That self-test covers representative path matches and label forcing
  so a future edit cannot silently weaken the broadest PR test gate.
- When splitting a long lane, keep the same substantive commands unless the PR
  explicitly documents the safety reason for removing one.

Long deterministic E2E gates are split into named parallel slices for unit/UI
coverage, browser coverage, diagnostics, and scenario execution. The visible
`Zero-Key Deterministic E2E` check is an aggregate status over those slices, so
reviewers can see the failing surface without opening one giant serial log.

Plugin tests are also split across `TEST_SHARD=1/4` through `4/4` in the
`Tests` workflow. The root `test:plugins` script uses the cross-package runner
so shard membership is deterministic by package path, while the visible
`Plugin Tests` check remains an aggregate over the shard matrix.

Why the aggregate stays:

- Branch protection and reviewer muscle memory can keep using one stable check.
- The underlying slices can run in parallel and fail with precise names.
- Manual review becomes easier because a browser failure, diagnostics failure,
  or scenario-runner failure points at the relevant log immediately.

Related CI docs:

- `CHANGELOG.md` records workflow policy changes and the reason they happened.
- `ROADMAP.md` tracks future CI performance work that should preserve gate
  quality.

### Main CI (`ci.yaml`)

Runs on PRs and pushes to main:

- Typecheck + core/plugin tests
- Linting and formatting checks
- Build verification
- Dev startup + HMR propagation
- Interop TypeScript tests (`packages/interop`)

The broader `test.yml` orchestrator runs automatically on `develop` only to
avoid duplicating the main-branch CI gate. Secret-free deterministic zero-key
coverage for PRs to either protected branch is handled by `scenario-pr.yml`;
`test.yml` keeps the broader develop push/PR, manual, and scheduled coverage.

### Live E2E

PR E2E does not require `CEREBRAS_API_KEY`, `OPENAI_API_KEY`, or any other paid
provider key. Live/provider-key coverage belongs to the dedicated live jobs and
workflows (`cloud-live-e2e`, `provider-live-e2e`, `live-scenarios.yml`,
`scenario-matrix.yml`) where missing-key behavior is documented per lane.

## Code Review Workflows

### Claude Code Review (`claude-code-review.yml`)

Automated PR review using Claude. Checks for:

- Security issues (hardcoded keys, SQL injection, XSS)
- Test coverage
- TypeScript types (no `any`)
- Correct tooling (bun, vitest)

### Claude Security Review (`claude-security-review.yml`)

Dedicated security-focused review for code changes.

### Claude Interactive (`claude.yml`)

Responds to `@claude` mentions in issues and PRs.

## Documentation Workflows

### Docs CI (`docs-ci.yml`)

Documentation quality workflow:

- **Dead Link Checking:** Scans for broken internal/external links
- **Quality Checks:** Double headers, missing frontmatter, heading hierarchy

Automatically creates PRs with fixes when issues are found.

### JSDoc Automation (`jsdoc-automation.yml`)

Manual workflow for generating JSDoc documentation.

## Manual Release Process

### 1. Create a GitHub Release

1. Go to Releases → Create new release
2. Create a new tag: `v2.0.0` (follows semver)
3. Add release notes
4. Publish release

### 2. Automated Publishing

The release will trigger:

- `release.yaml` → NPM packages

### 3. Manual publishing

Use `bunx lerna publish` from the repo root when automation is not sufficient (see `release.yaml`).

## Setting Up Secrets

### Required Secrets

| Secret | Purpose | How to Get |
|--------|---------|------------|
| `NPM_TOKEN` | NPM publishing | [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens) |
| `ANTHROPIC_API_KEY` | Claude workflows | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | Opt-in live/provider-key lanes | [platform.openai.com](https://platform.openai.com) |

### Optional Secrets

| Secret | Purpose |
|--------|---------|
| `PHALA_CLOUD_API_KEY` | TEE deployment |
| `GH_PAT` | Cross-repo operations |

Turbo caching is GitHub-native (`.github/actions/turbo-cache-github` via
`setup-bun-workspace`) — no Vercel SaaS remote cache, so `TURBO_TOKEN` /
`TURBO_TEAM` are no longer used and are banned by
`ci-workflow-dedup-contract.mjs` (#12341).

## Package dependencies

NPM packages are ordered by the monorepo graph; `release.yaml` / Lerna handle publish ordering for `@elizaos/*` packages.

## Troubleshooting

### CI Failures

1. Check if tests pass locally: `bun run test`
2. Check formatting: `bun run format:check`
3. Check linting: `bun run lint`

### Release Failures

1. Verify secrets are configured
2. Check workflow logs for specific errors
3. For NPM: ensure package versions are unique

### Claude Workflow Issues

1. Verify `ANTHROPIC_API_KEY` is set
2. Check rate limits on Anthropic API
3. Review Claude's output in workflow logs
