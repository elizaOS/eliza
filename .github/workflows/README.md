# GitHub Actions

The repository intentionally keeps a small workflow surface. Product behavior
belongs in package scripts; workflow YAML supplies triggers, credentials,
runners, environments, and a concise job graph.

## Required validation

`ci.yml` is the canonical required pull-request workflow for both `develop` and
`main`. It classifies changed paths, runs repository quality checks, affected
tests, deterministic smoke tests, a path-scoped Android release AAB audit, and a
diff-scoped secret scan. The stable `CI / Required` job is the only status
intended for branch protection. Individual jobs remain visible for diagnosis
but are not separately wired into protection rules.

`nightly.yml` calls the same CI workflow once per day and adds macOS and Windows
core smoke tests. It never publishes packages or creates releases.

## Specialized pull-request checks

Several branch-scoped and path-scoped workflows run alongside the canonical CI
gate for specific surfaces. This list is non-exhaustive; other specialized
gates such as `gitleaks.yml`, `cloud-tests.yml`, `chat-shell-gestures.yml`, and
the `pr.yaml` title check cover narrower contracts. None replaces the
`CI / Required` status. Representative examples:

- `develop-pr.yml` runs lint, typecheck, build, and changed-plugin tests for
  `develop`-targeted PRs. `actionlint` reaches merge-critical workflows through
  the pinned installer in `install-workflow-linters.sh`.
- `quality.yml` supplies the extended homepage build and workspace format gate
  for `main`-targeted PRs and post-merge pushes.
- `scenario-pr.yml` supplies the opt-in scenario-runner and browser matrix for
  `main`-targeted PRs carrying the `ci:full` label.
- `ui-e2e-gate.yml` and `ui-fixture-e2e.yml` run the packages/ui Chromium and
  WebKit fixture gates when `packages/ui/src/**` changes.

### Outside contributors

Untrusted pull requests—forks and same-repository Dependabot heads—run the
canonical `ci.yml` workflow on ephemeral GitHub-hosted runners with read-only
permissions. Cloud integration/E2E, UI fixture, and PR-policy workflows remain
enabled because they add coverage that canonical CI does not provide. The jobs
in `develop-pr.yml` and the standalone `gitleaks.yml` job are skipped for these
PRs because canonical CI already supplies their lint, format, typecheck,
plugin-test, build-core, and diff-scoped secret-scan contracts; running both
copies only delays feedback and consumes capacity. Their `pull_request`
triggers still create workflow runs, whose guarded jobs settle as skipped.

Repository variables are not an authorization boundary for fork events. Any
fork-capable workflow with optional Hetzner placement must default to hosted
when `HETZNER_FLEET_ONLINE` is unavailable, using the fail-safe `!= 'true'`
test. GitHub's outside-collaborator approval remains an abuse/cost-control
policy, not the mechanism that protects secrets or persistent runners.

## Manual operations

- `live-smoke.yml` is the general credential-backed dispatcher. Its input
  selects `app`, `scenarios`, `cloud`, `voice`, `dedicated`, or `all`. The
  `dedicated` suite owns the managed dedicated staging canary and exact
  stale-canary recovery. Specialized app and voice evidence also flows through
  `app-live-e2e.yml` and `voice-live-e2e.yml`, which run on schedule or
  dispatch.
- `release.yaml` is the npm, canonical Git tag, and GitHub Release authority.
  It creates the release as the final step of its npm/version transaction.
  The stable tag then triggers `release-electrobun.yml`, which resolves and
  checks out the peeled tag commit, verifies the existing release is bound to
  that commit, and uploads signed desktop assets without creating or replacing
  the release. `snap-publish.yml` owns Snap Store publication.
- `infra.yml` is the only Terraform plan, apply, and state-edit entry point.
- `voice-code-bench.yml` retains the bounded real-ASR benchmark.

These workflows use `workflow_dispatch` and never run for pull requests.

## Deployments

Path-scoped deployment workflows may run after changes land on `develop` or
`main`. They do not create pull-request checks. GitHub environments own
production approvals and credentials.

## Maintenance and assistance

`weekly-maintenance.yml` provides the single scheduled dependency/security
maintenance signal. `claude.yml` remains opt-in through mentions and is not a
required check.

When adding automation, prefer extending an existing package script and one of
these workflows. A new workflow requires a distinct trigger, credential, runner,
or environment boundary that cannot be represented as another job or dispatch
choice.
