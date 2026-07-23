# CI/CD Workflows

This directory contains GitHub Actions workflows for the elizaOS project (v2.0.0).

## Workflow Overview

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yaml` | Push/PR to main | Main-specific CI - typecheck, tests, lint, build, dev startup |
| `develop-pr.yml` | PR to develop | Lightweight lint, typecheck, build, and deterministic lane-integrity checks |
| `develop-pr-gate.yml` | PR target to develop, manual canaries | Stable fail-closed aggregate over the nine lightweight required contexts |
| `test.yml` | Push to develop, manual, schedule | Broader post-merge develop tests; live jobs are separate |
| `quality.yml` | PR to main, push main/develop, manual | Extended format, homepage, secret, UI-determinism, and lint checks |
| `scenario-pr.yml` | PR to main, push develop, manual/schedule | Secret-free deterministic scenario/browser E2E gate |
| `pr.yaml` | PR opened/edited | PR title validation |
| `release-orchestrator.yml` | Manual on protected `develop` | Sole full-cohort npm/GitHub Release entry; exact-SHA gate before distribution fan-out |
| `release.yaml` | Reusable call only | Exact-SHA transactional npm, tag, and GitHub release |
| `release-candidate-pr.yml` | PRs changing release authority | Credential-free candidate plus real local transport receipts |
| `elizaos-os-full-release.yml` | Release created, manual | Configured automatic OS artifact/manifest path; currently startup-invalid |
| `update-os-release-manifest.yml` | Manual only | SHA- and exact-asset-bound OS manifest recovery through a draft pull request |
| `claude.yml` | @claude mentions | Interactive Claude assistance |
| `claude-code-review.yml` | PR opened | Automated code review |
| `claude-security-review.yml` | PR opened | Security-focused review |
| `docs-ci.yml` | PR (docs paths), Manual | Documentation quality checks |
| `build-agent-image.yml` | Push develop/main, Release, Manual | Docker image builds (`:develop`, `:stable`, `:latest`, release tags) |
| `build-llama-ffi-android.yml` | Native-source push to develop, tag, manual, reusable | Canonical fused Android producer: arm64-v8a Vulkan and x86_64 CPU artifacts |
| `build-android.yml` | Manual | Android app build; finds an input-compatible native producer run through the Actions API |
| `mobile-build-smoke.yml` | Main PR, nightly, manual, reusable | Canonical iOS and Android simulator build/smoke authority |
| `apple-store-release.yml` | Manual, reusable | Canonical signed iOS/macOS store build and publish authority |
| `tee-build-deploy.yml` | Push to main, Manual | TEE deployment to Phala Cloud |
| `weekly-maintenance.yml` | Weekly, Manual | Dependency/security audits |
| `jsdoc-automation.yml` | Manual | JSDoc generation |

## Release Workflows

The retained automated graph has three distinct responsibilities:
`release-orchestrator.yml` is the sole full-cohort entry point,
`release.yaml` performs the transactional npm/tag/GitHub Release operation,
and `elizaos-os-full-release.yml` is the only configured automatic OS
artifact/manifest path. The manual
`update-os-release-manifest.yml` recovery workflow is intentionally outside
that graph: it can only propose a SHA-bound checksum repair through a pull
request. Do not add another automatic aggregate or direct protected-branch
manifest writer.

The orchestrator waits for complete npm registry, annotated tag, and GitHub
Release readback before passing those exact outputs to enabled downstream
distributions. A tag push, an existing GitHub Release, or the retired automatic
develop beta watcher never starts npm publication.

### Alpha Tags

Alpha version tags are tags only. They do not publish NPM packages, run packaging
CI, or create GitHub Release entries.

### Public Release Orchestration (`release-orchestrator.yml` and `release.yaml`)

Publishes one explicitly prepared, immutable TypeScript/JavaScript cohort to
npm, verifies the entire cohort, then creates the exact Git tag and GitHub
Release.

**Triggers:**

- Manual `release-orchestrator.yml` dispatch from protected `develop` with
  `source_sha`, canonical `source_ref`, `version`, `channel`, and the
  expected npm publisher username
- One relative reusable-workflow call into `release.yaml`; a real-tree
  contract rejects every other call or shell dispatch
- Optional `candidate_run_id` resumes a prior immutable candidate without
  rebuilding or repacking it

**Packages:** The reviewed allowlist in
`packages/scripts/release-cohort.json`, including its complete runtime
workspace dependency closure.

### Cross-platform distribution (`release-orchestrator.yml`)

Coordinates npm, Android, Apple, desktop, Homebrew, and homepage release jobs.
Every enabled distribution requires the transactional npm result; homepage
publication additionally waits for every enabled distribution to succeed.

### OS artifact manifest (`elizaos-os-full-release.yml`)

This is intended to build and verify Linux OS artifacts, populate their release
manifest, generate canonical checksums, validate publishability, and upload the
result. It is the only automatic workflow configured to do so, but its recorded
runs are startup failures, so it is not a working release authority. Its
reusable-workflow permissions and end-to-end repair remain in #16279.

### Manual OS manifest recovery (`update-os-release-manifest.yml`)

This manual-only workflow preserves the separate recovery operation needed when
release assets already exist. Operators must provide the current full
`origin/develop` SHA and the release tag's full commit SHA. The workflow refuses
stale or mismatched identities, captures every stable asset database/node ID,
filename, size, and available GitHub SHA-256, then downloads each asset by its
captured database ID. It rejects missing or extra files, size/digest mismatches,
asset replacements, and any
pre/post API inventory drift before regenerating publishable checksums. The only
output is a dedicated draft pull request containing all seven evidence rows and
the exact base, tag, asset, downloaded-byte, and workflow-log receipts. It has no
`release`, `push`, or `workflow_call` trigger and never pushes to `develop`
directly.

## Test Workflows

### Linux Runner Policy

The heavy post-merge develop **test lanes** in `test.yml` run on the self-hosted
`self-hosted, hetzner-robot` pool (GitHub-hosted minutes are billing-frozen for
this org, #13481). Everything the pre-merge **Develop PR Gate** depends on is
the lightweight PR surface and remains independent of the exhaustive fleet:

- **Path classifiers** (`Classify changed paths`) across `test.yml`,
  `scenario-pr.yml`, `dev-smoke.yml`, `docker-ci-smoke.yml`,
  `mobile-build-smoke.yml`, `windows-dev-smoke.yml`, and
  `windows-desktop-preload-smoke.yml` run on `ubuntu-24.04`. They are git-diff +
  node scripts with no self-hosted needs; pinning them to the fleet (#8501) once
  left every downstream job queued indefinitely and gridlocked develop.
- **`Develop PR Gate`** runs on `ubuntu-24.04` and only observes check metadata
  from the nine lightweight component contexts. It never waits for post-merge,
  scheduled, device, aesthetic, or exhaustive suites.
- **`ci-ok`**, `plugin-tests-status`, and `merge-quality-gate` remain hosted
  roll-ups inside the post-merge `test.yml` orchestrator. They report branch
  health after a develop push; they are not the pre-merge required context.

The aggregate contract runs directly under Node in
`packages/scripts/develop-pr-aggregate.self-test.mjs`; the changed-file gate
loads the same assertions through
`packages/scripts/develop-pr-aggregate.test.mjs` so the implementation also
produces enforced per-file coverage.

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
2. **Post-merge quality parity.** `merge-quality-gate` runs the same read-only lint /
   `format:check` / repo-wide `typecheck` / gitleaks secret scan that guard
   `main`, and `ci-ok` needs it on develop `push`. The pre-merge
   `develop-pr.yml` lint job runs `format:check`, and the stable aggregate waits
   for that exact job, so formatting is refused before merge even when a busy
   push wave supersedes post-merge quality runs (#15959).

GPU / KVM / macOS jobs (labels `gpu-cuda-12.6`, `kvm`, `eliza-e2e-macos`) are a
separate purpose-built fleet and are unaffected by this policy.

The retired `gpu-bench-nightly.yml` scaffold never ran substantive work on its
schedule: both jobs required an opt-in manual dispatch and invoked removed
`packages/inference` paths. Do not restore that scaffold as a green scheduled
placeholder.

`cuda-continuity.yml` is the candidate single authority for real local-inference
CUDA proof. Its inventory (`scripts/cuda-continuity-inventory.json`) maps both
retired contexts to the exact-head GPU probe, native CUDA fixtures, and a
model-backed runtime graph smoke. The run fails closed on a missing GPU/toolkit,
CPU fallback, skipped graph/kernels, OOM/corruption, incomplete artifacts, or an
artifact upload error. Because the current native builder no longer exposes a
Linux CUDA target, dispatch requires a prebuilt binary directory; its recorded
fork commit must equal the exact workflow head's native-source gitlink or the run
fails. The resulting manifest records device, driver/toolkit, model, build
capabilities/provenance, native logs, hashes, and the dispatched commit.

Migration is intentionally two-phase: keep the existing opt-in CUDA leg in
`local-inference-matrix.yml` until a credentialed `cuda-continuity.yml` run at
the exact candidate head passes and a maintainer manually reviews the downloaded
artifacts. Only then may the old leg be retired and the inventory's
`migrationState` changed. A code-only/non-GPU contract pass is not hardware
proof and must not close #16449.

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

The broader `test.yml` orchestrator runs after pushes to `develop` to avoid
duplicating the main-branch CI gate on every PR. The lightweight develop PR
surface is owned by `develop-pr.yml` and aggregated by `develop-pr-gate.yml`;
`test.yml` keeps the broader develop push, manual, and scheduled coverage.

### Live E2E

PR E2E does not require `CEREBRAS_API_KEY`, `OPENAI_API_KEY`, or any other paid
provider key. Live/provider-key coverage belongs to the dedicated live jobs and
workflows (`cloud-live-e2e`, `provider-live-e2e`, `live-scenarios.yml`, and
connector-specific live workflows) where missing-key behavior is documented per
lane. Trustworthy all-shard credential coverage is tracked in #16448.

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

1. Prepare a clean protected-`develop` commit whose allowlisted manifests
   contain the exact release version, public access metadata, and published
   internal semver ranges.
2. Dispatch `release-orchestrator.yml` at that exact full SHA with
   `source_ref=refs/heads/develop`, the same semver, either `beta` or
   `latest`, and the npm username represented by the protected environment
   token.
3. If interrupted after candidate creation and the protected `develop` tip has
   not moved, retry with the identical release identity and original
   `candidate_run_id`. The called workflow verifies the recorded tarballs
   instead of rebuilding or repacking them. A moved tip requires a new candidate.
4. Review the finalized artifact and public readback. Its state must show npm
   staging, full integrity verification, channel promotion, exact annotated tag
   publication, and GitHub Release readback in order.

Release failures are fail-closed. Do not create the tag or GitHub Release first,
publish directly with Lerna, or add a parallel coordinator. Manifest recovery
may only use the manual PR boundary documented above.

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

`NPM_TOKEN` is a least-privilege granular token stored in the
`npm-public-release` environment, not a repository secret. That environment
requires an independent reviewer, forbids admin bypass, and accepts only the
selected `develop` branch. The credentialed jobs independently require the
caller workflow/ref/SHA, requested source ref/SHA, and
`github.workflow_sha` to equal the live protected tip before checking out
trusted tooling by that immutable SHA.

## Package dependencies

`release.yaml` never discovers its publish set from Lerna. The allowlist in
`packages/scripts/release-cohort.json` is explicit and source-reviewed; the
candidate resolver proves every runtime workspace dependency is present and
orders the cohort before any registry mutation.

### Immutable npm candidate primitives

`packages/scripts/release-candidate.mjs` is the fail-closed boundary for the
transactional release workflow. Candidate creation requires an explicit JSON
allowlist (`{"schemaVersion":1,"packages":[...]}`), canonical repository,
branch, registry, and publisher identities, a clean source SHA, exact
semver/channel values, and one explicit build command. It proves the remote
branch resolves to the checked-out SHA immediately before and after packing,
runs that build once, and invokes `npm pack --ignore-scripts` once per package.
An existing output directory is never overwritten or repacked.

Each candidate directory contains `release-plan.json`, `release-state.json`,
and the immutable `tarballs/*.tgz` cohort. The plan records package directories,
hard-dependency ordering and ranges, entrypoint metadata, manifest integrity,
and both hexadecimal SHA-512 and npm SRI integrity for every tarball. Cohort and
plan digests bind the complete release identity, and every mutation command must
present that plan digest. The state can advance only through this sequence:

```
planned -> built-packed -> candidate-recorded -> registry-bound
        -> registry-staged -> registry-verified -> channel-promoted
        -> git-bound -> git-tagged -> release-published -> version-sync-pr
```

Registry publication first proves `/-/whoami` equals the planned publisher,
then stages only missing versions under a cohort-derived candidate tag. A retry
accepts an existing version only when its `dist.integrity`, `_npmUser`, and
`gitHead` match the plan. The workflow verifies the full cohort, promotes the
requested channel, removes staging tags, and performs a credential-free final
read before Git advances. Only HTTP 404 is absence; auth, throttling, transport,
server, redirect, provenance, and parse failures abort.

Finalization pushes only the canonical annotated `refs/tags/v<version>`; it
never pushes a branch, rebases, or uses `--follow-tags`. The fixed tagger,
source timestamp, repository, source, cohort digest, and plan digest determine
the tag object. A same-commit lightweight or differently annotated tag is a
conflict. The GitHub Release must then read back with the exact repository, tag,
target commit, and prerelease identity. Candidate state writes use an exclusive
owner lock; a dead local owner or expired cross-runner lease is recoverable
without treating a live writer as stale. `v2.0.3-beta.8`, `.9`, and `.10`
are permanently reserved.

## Troubleshooting

### CI Failures

1. Check if tests pass locally: `bun run test`
2. Check formatting: `bun run format:check`
3. Check linting without rewriting the checkout: `bun run lint:check`

### Release Failures

1. Check the exact retained workflow's logs and artifacts.
2. Treat missing credentials, artifacts, registry responses, or completion
   evidence as failures rather than skipped success.
3. Route npm failures to #16277 and coordinator failures to #16279; do not
   bypass them with a second publisher.

### Claude Workflow Issues

1. Verify `ANTHROPIC_API_KEY` is set
2. Check rate limits on Anthropic API
3. Review Claude's output in workflow logs
