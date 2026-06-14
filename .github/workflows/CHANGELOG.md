# CI Workflow Changelog

This changelog tracks meaningful CI policy and workflow-architecture changes.
It is intentionally scoped to `.github/workflows` so product/package changelogs
do not have to carry CI-only history.

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

### Preserved

- Push, scheduled, and manual runs keep broad/default behavior.

  Why: those runs protect branch health, release readiness, and periodic
  confidence. PR path gates optimize contributor feedback, not the repository's
  deeper safety net.

- The split E2E jobs keep the previous substantive commands.

  Why: this change is a CI ergonomics and parallelism improvement, not a
  reduction in coverage.
