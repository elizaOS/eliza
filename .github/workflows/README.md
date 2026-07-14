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
| `release-orchestrator.yml` | Manual on protected `develop` | Sole full-cohort npm/GitHub Release entry; exact-SHA gate before distribution fan-out |
| `release.yaml` | Reusable call only | Exact-SHA transactional npm, tag, and GitHub release |
| `release-candidate-pr.yml` | PRs changing release authority | Credential-free candidate plus real local transport receipts |
| `claude.yml` | @claude mentions | Interactive Claude assistance |
| `claude-code-review.yml` | PR opened | Automated code review |
| `claude-security-review.yml` | PR opened | Security-focused review |
| `codeql.yml` | Push/PR to main, Weekly | Static security analysis |
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

### Alpha Tags

Alpha version tags are tags only. They do not publish NPM packages, run packaging
CI, or create GitHub Release entries.

### Public Release Orchestration (`release-orchestrator.yml` and `release.yaml`)

`release-orchestrator.yml` is the only full-cohort npm and GitHub Release
dispatch surface. It calls
`release.yaml` with one explicitly prepared, immutable TypeScript/JavaScript
package cohort, waits for the complete registry/tag/GitHub Release readback,
and passes those exact outputs to every enabled distribution. A tag push, an
existing GitHub Release, or the removed develop-staging beta watcher never
starts npm publication.

**Triggers:**

- Manual `release-orchestrator.yml` dispatch from protected `develop` with
  `source_sha`, canonical `source_ref`, `version`, `channel`, and the expected
  npm publisher username
- One relative reusable-workflow call from that protected orchestrator into
  `release.yaml`; a real-tree contract rejects every other call or shell
  dispatch
- Optional `candidate_run_id` resumes a prior candidate artifact without
  rebuilding or repacking it

**Packages:** The reviewed allowlist in
`packages/scripts/release-cohort.json`, including its complete runtime
workspace dependency closure.

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

1. Prepare a clean commit whose allowlisted manifests already contain the
   exact release version, public access metadata, and published internal semver
   ranges.
2. Dispatch `release-orchestrator.yml` **at protected `develop`** with that
   commit's full SHA, the canonical branch ref that currently resolves to it,
   the same exact semver, either `beta` or `latest`, and the npm username
   represented by the protected environment token. Beta requires prerelease
   semver; latest requires stable semver.
3. If a run is interrupted after candidate creation, dispatch the orchestrator
   with the same identity and the original `candidate_run_id`. The called npm
   workflow downloads and verifies the recorded tarballs instead of rebuilding
   or repacking them.
4. Review the finalized candidate artifact. Its state must show npm staging,
   full integrity verification, public-channel promotion, exact tag
   publication, and GitHub Release readback in order.

Do not create the tag or GitHub Release first, and do not use Lerna/manual npm
publication as a recovery path. A retry resumes only exact recorded integrity.

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

`NPM_TOKEN` is an npm granular access token stored as an environment secret,
not a repository secret. Because the cohort exceeds npm's 50-entry limit for
individual package restrictions, give it read/write package permission only
for the `@elizaos` scope and the exact unscoped `elizaos` package. Give it no
npm organization-management permission, enable the noninteractive 2FA bypass,
and use the shortest practical expiry with an owner-visible rotation reminder.
GitHub-hosted runner egress is not stable enough for an IP allowlist. The npm
user represented by the token must have publish rights to every cohort member.

The `npm-public-release` environment requires a reviewer other than the
dispatcher, forbids admin bypass, and accepts only the selected `develop`
branch. The credentialed jobs also query `refs/heads/develop` at runtime,
require the caller workflow/ref/SHA, requested source ref/SHA, and
`github.workflow_sha` to equal that protected tip, and check out release tooling
by the resulting immutable SHA.

For the one-time migration from the repository-scoped token:

1. A maintainer copies the existing value directly into the
   `npm-public-release` environment as `NPM_TOKEN`; never print or round-trip it
   through workflow output.
2. The maintainer verifies the environment readback shows required reviewers,
   `prevent_self_review: true`, `can_admins_bypass: false`, and the selected
   `develop` branch policy. Because self-review is forbidden, a different
   listed reviewer must approve both protected publish and finalize jobs.
3. From a protected `develop` commit whose entire cohort already has one fresh
   beta version, dispatch the real npm-only canary below. `publish-npm` is
   unconditional; `publish_packages=false` disables only the separate PyPI,
   Snap, Flatpak, and APT workflow. The other false flags prevent unrelated
   public distributions from changing during the token canary.
4. Download and review the exact candidate artifact, then run the built-in
   public registry readback against all cohort members. The canary is not a
   credential preflight: it publishes a new public npm version, promotes
   `beta`, creates the canonical annotated tag, and creates the GitHub Release.
5. After that canary authenticates the planned npm username and completes its
   registry readback, the maintainer deletes the repository-level `NPM_TOKEN`.
   Until deletion, a branch-authored workflow could still name the broader
   secret, so the release workflow must not be treated as enabled.

```bash
REPOSITORY=elizaOS/eliza
VERSION='<fresh-uniform-beta-version>'
NPM_PUBLISHER='<exact-npm-username>'
SOURCE_SHA="$(gh api "repos/$REPOSITORY/git/ref/heads/develop" --jq .object.sha)"

gh workflow run release-orchestrator.yml --repo "$REPOSITORY" --ref develop \
  -f source_sha="$SOURCE_SHA" \
  -f source_ref=refs/heads/develop \
  -f version="$VERSION" \
  -f channel=beta \
  -f npm_publisher="$NPM_PUBLISHER" \
  -f candidate_run_id=0 \
  -f publish_packages=false \
  -f publish_android=false \
  -f publish_apple=false \
  -f publish_desktop=false \
  -f update_homebrew=false \
  -f deploy_homepage=false
```

Do not dispatch until the fresh version is present in every allowlisted
manifest, absent from every corresponding npm package, the environment secret
exists, and an independent listed reviewer has agreed to approve both protected
jobs. The successful run summary names the exact candidate artifact. Download
it as `CANDIDATE_DIRECTORY`, read its plan, state, and tarballs, then perform a
credential-free full-cohort readback:

```bash
PLAN_INTEGRITY="$(jq -r .planIntegrity "$CANDIDATE_DIRECTORY/release-state.json")"
bun packages/scripts/release-candidate.mjs verify-promoted \
  --candidate "$CANDIDATE_DIRECTORY" \
  --repository elizaOS/eliza \
  --source-ref refs/heads/develop \
  --source-sha "$SOURCE_SHA" \
  --registry https://registry.npmjs.org/ \
  --publisher "$NPM_PUBLISHER" \
  --version "$VERSION" \
  --channel beta \
  --plan-integrity "$PLAN_INTEGRITY" \
  --allow-public-registry
gh release view "v$VERSION" --repo "$REPOSITORY" \
  --json tagName,targetCommitish,isPrerelease,url
```

The following preflight fails closed if the credential remains broad or the
environment copy is absent:

```bash
gh secret list --repo elizaOS/eliza --env npm-public-release | grep '^NPM_TOKEN'
if gh secret list --repo elizaOS/eliza | grep -q '^NPM_TOKEN'; then
  echo 'repository-scoped NPM_TOKEN must be deleted after the canary' >&2
  exit 1
fi
gh api repos/elizaOS/eliza/environments/npm-public-release
gh api repos/elizaOS/eliza/environments/npm-public-release/deployment-branch-policies
```

## Package dependencies

`release.yaml` never discovers its publish set from Lerna. The allowlist in
`packages/scripts/release-cohort.json` is explicit and source-reviewed; the
candidate resolver proves every runtime workspace dependency is present and
orders the cohort before any registry mutation. A private, missing, wrong-
version, or incompatible runtime target fails candidate creation.

### Immutable npm candidate primitives

`packages/scripts/release-candidate.mjs` is the fail-closed boundary for the
transactional release workflow. Candidate creation requires an explicit JSON
allowlist (`{"schemaVersion":1,"packages":[...]}`), canonical repository and
branch-ref identities, a clean source SHA, the same expected commit, the exact
registry and publisher, exact semver/channel values, and one explicit build
command. The workflow proves the remote branch resolves to the checked-out SHA
immediately before and after packing. It runs that build once and invokes
`npm pack --ignore-scripts` once per package. An existing output directory is
never overwritten or repacked.

Each candidate directory contains `release-plan.json`, `release-state.json`,
and the immutable `tarballs/*.tgz` cohort. The plan records package directories,
hard-dependency ordering and ranges, entrypoint metadata, manifest integrity,
and both hexadecimal SHA-512 and npm SRI integrity for every tarball. A cohort
digest binds those package subjects and their dependency graph to the source,
repository, registry, and publisher; the candidate staging tag derives from
that digest. The complete canonical plan has a second digest that every later
job must present before it can mutate npm, Git, or GitHub. The state can advance
only through this sequence:

```
planned -> built-packed -> candidate-recorded -> registry-bound
        -> registry-staged -> registry-verified -> channel-promoted
        -> git-bound -> git-tagged -> release-published -> version-sync-pr
```

Registry publication first proves the token's `/-/whoami` identity equals the
planned publisher, then stages missing versions under a candidate-specific
tag. A retry accepts an existing version only when its `dist.integrity` exactly
matches the plan. npmjs metadata must also bind `_npmUser` and `gitHead` to the
planned publisher and source SHA; local registry fixtures that do not emit
those npmjs fields bind provenance through authenticated publisher identity
plus the exact candidate bytes. The workflow verifies the full cohort,
promotes the requested channel, and removes the staging tags. Only HTTP 404 is
absence; auth, throttling, transport, server, redirect, provenance, and parse
failures abort. A credential-free final read verifies every version, public
channel, provenance field, and removed candidate tag again before Git advances.
The normalized registry and resolved Git push destination are recorded before
their first external mutation, so an interrupted run cannot be resumed against
a different target. Git publication uses explicitly named refs, never
`--follow-tags`, and binds the resolved push destination before mutation.
The credential-bearing jobs execute release tooling checked out from the live
protected `develop` ref after independently verifying its exact SHA and the
protected orchestrator caller identity. The candidate source is a separate
checkout used only as verified data and as the exact Git repository for the
final tag. Selecting a different source SHA therefore cannot replace the script
that receives the npm or GitHub token. Candidate state writes use an exclusive
owner lock; a dead local owner or an expired cross-runner lease is recoverable
without treating a live writer as stale.

Finalization pushes only `refs/tags/v<exact-version>`; it never pushes a branch,
uses `--follow-tags`, rebases, or resolves conflicts automatically. The named
Git remote must resolve to the planned GitHub repository, and the planned
source commit must remain reachable from the planned branch. New annotated
tags use the fixed GitHub Actions bot identity, the source commit timestamp in
UTC, and a canonical message recording the source, cohort, and plan digests.
Idempotence requires the exact annotated tag object ID and peeled commit; a
same-commit lightweight tag or differently annotated tag is a conflict. The
GitHub Release is then created or read back with the candidate's exact
repository, tag, target commit, and prerelease identity. The orchestrator calls
this path directly and consumes its outputs, so no downstream publisher relies
on a `release/published` event suppressed by `GITHUB_TOKEN`. Fixed workflow
concurrency groups serialize all versions and channels.
`v2.0.3-beta.8`, `.9`, and `.10` are permanently reserved.

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
