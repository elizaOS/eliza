# CI Workflow Changelog

This changelog tracks meaningful CI policy and workflow-architecture changes.
It is intentionally scoped to `.github/workflows` so product/package changelogs
do not have to carry CI-only history.

## 2026-07-04

### Changed

- Migrated the whole repo off the Vercel SaaS Turbo remote cache onto the
  GitHub-native cache (#12341, epic #12191 phase 4). Removed every
  `TURBO_TOKEN` / `TURBO_TEAM` / `TURBO_CACHE: remote:rw` env from all
  workflows (108 lines across 11 files) and routed `setup-bun-workspace`'s
  Turbo cache through the pinned `turbo-cache-github` shim, whose single
  per-hash key replaces the former per-job-name key that fragmented the cache
  across ~30 job names.

  Why: project guidance is GitHub-native caching only; the SaaS env was
  redundant with the `.turbo` `actions/cache` layer that already ran in the
  shared setup action. `ci-workflow-dedup-contract.mjs` now **forbids** the
  SaaS env anywhere and **requires** the GitHub-native cache on the publish
  paths (nightly/release) — the inverse of its previous assertion, which
  pinned the SaaS wiring.

- PR-lane `typecheck` (`ci.yaml`) and `lint` (`quality.yml`) now run through
  `turbo --affected` scoped to the PR merge base (`TURBO_SCM_BASE`), with full
  history fetched so scoping resolves; `push`/`merge_group` still run the full
  graph. A shallow clone degrades to running everything, so scoping never
  under-checks.

### Added

- `develop-exhaustive.yml` (#12342, epic #12191 phase 5): an un-cancellable
  scheduled orchestrator (06:00/18:00 UTC, dedicated concurrency group) that
  invokes every platform lane test.yml's schedule does not cover — Windows,
  mobile, scenario, the three UI gates, keyless harness, docker, dev
  onboarding, electrobun/desktop — via `workflow_call`, then runs the matrix
  proof. A skipped or failed reusable lane fails the run (a coverage gap is not
  a pass). Added a bare `workflow_call:` trigger to each of those 10 workflows
  so they are reusable.

  Why: the scheduled exhaustive lane is the "prove develop runs the full
  matrix" DoD. `ci-full-matrix-proof.mjs` + `ci-lane-manifest.json` gained a
  `reusableWorkflows` check so dropping a lane's `uses:` or a workflow's
  `workflow_call` trigger fails the proof statically, before the run.

## 2026-06-29

### Changed

- Split automatic branch ownership between `ci.yaml` and `test.yml`:
  `ci.yaml` remains the main-branch gate, while `test.yml` now runs
  automatically on develop plus manual/scheduled invocations.

  Why: both workflows were auto-running overlapping build/test work on `main`.
  The zero-key PR gate for main remains covered by `scenario-pr.yml`, and
  develop keeps the broader `Tests` orchestrator.

- Switched the root `test:plugins` script from a direct Turbo sweep to the
  shard-aware cross-package test runner at concurrency 3.

  Why: `TEST_SHARD` is implemented in `run-all-tests.mjs`. Routing the plugin
  lane through that runner makes the matrix real instead of cosmetic, while
  preserving the existing bounded concurrency policy.

### Added

- Added `packages/scripts/ci-workflow-dedup-contract.mjs`.

  Why: this locks the branch-trigger split and verifies nightly/release keep the
  Turbo remote-cache environment required by #10096.

- Added develop/main quality gates for the prompt-secret scan, UI determinism
  audit, and build-enabled lint.

  Why: `ci.yaml` still runs only for `main`, while the default PR target is
  `develop`. These checks now run through `quality.yml`, which already covers
  develop PRs.

- Split the plugin test lane into a four-way `TEST_SHARD` matrix with a stable
  aggregate `Plugin Tests` check.

  Why: the cross-package runner already had deterministic shard membership, but
  no workflow used it. The plugin lane is the long pole in `test.yml`; sharding
  it cuts wall-clock without reducing package coverage.

## 2026-06-14

### Added

- Added `packages/scripts/ci-path-gate.mjs` as the shared PR path classifier for
  expensive workflows.

  Why: repeated inline shell classifiers made it too easy for workflows to drift
  apart, and reviewers could not see a consistent explanation for why a lane ran
  or skipped.

- Added path-gate summaries to show changed files, selected lanes, and the path
  or label reason for each lane.

  Why: fast CI is only useful if contributors and maintainers trust the skip
  decision. The summary turns the decision into reviewable evidence.

- Added force labels including `ci:full`, `ci:e2e`, `ci:zero-key`,
  `ci:server`, `ci:client`, `ci:plugins`, `ci:cloud`, `ci:docker`,
  `ci:mobile`, `ci:ios`, `ci:android`, `ci:desktop`, `ci:windows`, and
  `ci:dev-smoke`.

  Why: maintainers need a no-code way to request broader coverage when a change
  is risky, cross-cutting, or ambiguous.

- Added `packages/scripts/ci-path-gate.self-test.mjs` and run it before the
  `Tests` workflow consumes classifier outputs.

  Why: the classifier is now part of the quality gate. Testing it in CI prevents
  a future edit from silently skipping coverage that should have run.

### Changed

- Replaced inline path filters in `test.yml` and `scenario-pr.yml` with the
  shared classifier.

  Why: one implementation is easier to audit, document, and extend than several
  workflow-local shell snippets.

- Added classifier jobs to Docker, mobile, dev smoke, Windows dev smoke, and
  Windows desktop preload smoke workflows.

  Why: these lanes are valuable but expensive. Running them only for relevant
  PRs keeps feedback fast while still preserving push/manual coverage.

- Split deterministic zero-key E2E work into named parallel slices while keeping
  the visible `Zero-Key Deterministic E2E` aggregate check.

  Why: a single serial E2E log made failures slow to reach and hard to triage.
  Parallel slices shorten wall-clock time and make the failing surface obvious
  without removing the aggregate gate reviewers already understand.

- Moved `coverage-gate` dependency setup behind changed-test detection and
  switched it to the shared Bun workspace setup.

  Why: the coverage gate is advisory for changed Bun-native tests. Docs-only and
  no-test PRs should not install the whole workspace or fail on unrelated
  registry/install noise, while test-bearing PRs should use the same
  lockfile-validating setup path as the rest of CI.

### Preserved

- Push, scheduled, and manual runs keep broad/default behavior.

  Why: those runs protect branch health, release readiness, and periodic
  confidence. PR path gates optimize contributor feedback, not the repository's
  deeper safety net.

- The split E2E jobs keep the previous substantive commands.

  Why: this change is a CI ergonomics and parallelism improvement, not a
  reduction in coverage.
