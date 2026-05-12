# Repo Cleanup Audit - 2026-05-11

This folder contains the repo cleanup dry-run manifests, validation notes,
follow-up specialist reports, and consolidated implementation ledger.

The original wave reports were non-destructive. Later follow-up passes started
a small validated cleanup batch and recorded the rest as TODOs for review before
larger deletion or refactor work.

## Wave Reports

- `SUMMARY.md` - compiled approval summary and implementation dependencies.
- `wave-01-search-pollution-generated-artifacts.md` - search pollution, generated files, ignored artifacts.
- `wave-02-lifeops-health-contracts.md` - LifeOps and plugin-health contracts.
- `wave-03-backend-route-ownership.md` - backend routes, duplicate handlers, barrels, shared types.
- `wave-04-frontend-state-ui.md` - frontend state, UI hierarchy, reload behavior, design clutter.
- `wave-05-test-cleanup.md` - test inventory, deletion/conversion criteria, CI lanes.
- `wave-06-assets-docs-artifacts.md` - tracked assets, data, binaries, docs, archives.
- `wave-07-naming-text-cleanup.md` - AI slop, comments, legacy/shim/fallback naming, canonical names.
- `wave-08-final-validation-signoff.md` - final gates, signoff, rollback, PR strategy.
- `VALIDATION_STATUS.md` - latest command results, blockers, and current dirty-file status.

## Follow-up Reports

- `phase-2-validation/` - validation results and targeted triage from the second pass.
- `phase-3-backend-types-routes-duplication.md` - backend/type/route duplication scan.
- `phase-3-generated-artifacts-and-binaries.md` - generated artifacts and binary scan.
- `phase-3-naming-shims-reexports.md` - naming, shim, and re-export scan.
- `phase-3-test-quality-and-speed.md` - test quality and speed scan.
- `phase-4-markdown-wipe-candidates.md` - markdown deletion candidates.
- `phase-4-json-data-generated-artifacts.md` - JSON, data, generated, training, and benchmark artifacts.
- `phase-4-shims-legacy-reexports-removal.md` - shims, legacy code, re-exports, stubs, and fallbacks.
- `phase-4-package-boundaries.md` - workspace package boundary audit.
- `phase-4-ignores-suppressions-quality.md` - ignores, suppressions, and low-quality code audit.
- `phase-4-package-family-core.md` - core package-family audit.
- `phase-4-package-family-lifeops-apps.md` - LifeOps and app package-family audit.
- `phase-4-package-family-plugins.md` - plugin package-family audit.
- `phase-4-package-family-examples-benchmarks-inference-cloud.md` - examples, benchmarks, inference, and cloud audit.
- `phase-4-package-by-package-matrix.md` - package-by-package cleanup matrix.
- `phase-4-consolidated-todo-ledger.md` - consolidated TODO ledger and implementation order.

## Dry-run Rules

- Do not delete files during dry run.
- Do not rename files during dry run.
- Do not modify source, config, tests, package manifests, assets, or generated outputs during dry run.
- Only write markdown reports under this folder.
- Every proposed change must include validation or an explicit owner decision.

These rules applied to the original dry-run waves and specialist research. They
do not describe the later limited implementation batch.

## Current Validation Note

The current cleanup state includes validated LifeOps and app-core dead-stub
deletions, generated-output ignore rules, and removal of ignored untracked
inference outputs. A prior validation pass intentionally fixed the app-core
DFlash test fixture and left additional tracked deltas that need review before
batching.
See `VALIDATION_STATUS.md` and `phase-4-consolidated-todo-ledger.md` before
reviewing or implementing the cleanup plan.
