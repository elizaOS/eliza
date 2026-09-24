# GitHub Actions

Validation follows the full E2E policy in
[the implementation plan](../../WORKFLOW_SIMPLIFICATION_PLAN.md). Unit,
mock-backed, fixture-only, smoke, and self-test jobs are retired. Deterministic
model and voice responses belong at the provider boundary; retained E2E tests
exercise real application behavior and assert resulting state.

## Validation authorities

- `pr-static-smoke.yml` remains the PR and merge-queue entry point. Its existing
  filename and `All Tests Passed` status remain stable for branch protection.
  It checks mergeability, workflow syntax, affected builds, lint and types, and
  runs the shared `run-full-e2e` action using the same dependency installation.
  The aggregate rejects failed, skipped, or cancelled validation.
- `develop-full.yml` validates pushes to develop, staging and main. It delegates
  to `ci.yml` and records the exact source manifest before reconciliation.
- `ci.yml` owns repository source verification, the production frontend build,
  and the same `run-full-e2e` action used for PRs, in one installed workspace.
- `e2e.yml` exposes that action for standalone and exact-source release runs
  without inherited provider secrets. Browser
  authentication exercises Chromium, the SDK, the actual API, and the database.
  Broader app/provider integration is tracked in the implementation plan and
  must pass before this migration is considered complete.

The separate app-live, live-smoke, voice-live, and paid ASR benchmark workflows
are retired. Their ordinary runtime and voice checks move to the deterministic
E2E entry point. This suite does not certify acoustic model quality or physical
device behavior.

Release, deployment, native-device qualification, and operational workflows
remain separate because they have different artifacts, permissions, and
execution environments. Their test commands are part of the E2E migration;
manual-only status does not exempt a unit or smoke suite from retirement.

## Source and deployment authority

Develop Full retains its exact-input evidence manifest and fails if a required
surface has no current successful result. Only successful exact-source
validation hands off to `develop-reconcile.yml`. Cancellation of an older source
must never certify a newer source or copy deployment evidence between commits.

Reconciliation records effects in GitHub Deployments and opens promotion PRs.
It does not grant permission to bypass review, change branch rules, or merge
promotion PRs. Staging and main validate their own merged commits before effects
run. Environment restrictions, certificate checks, deployment locks, and
protected release gates remain authoritative.

## Maintenance

Use pinned Node 24.15.0 and Bun 1.3.14. Keep third-party actions pinned to commit
SHAs. Run actionlint across the complete workflow graph after removing or
renaming reusable workflows. Update `.github/develop-surface-graph.json` in the
same change as its delegated workflow set.

Keep test output useful on failure and fail on empty test selection. Do not add
separate jobs for runner self-tests or duplicate static checks already owned by
canonical verification. Retain only one dependency installation per compatible
E2E execution environment, adding shards only when measured runtime requires it.
