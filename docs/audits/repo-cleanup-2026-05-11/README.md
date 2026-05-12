# Repo Cleanup Dry Run - 2026-05-11

This folder contains the non-destructive dry-run manifests for the repo cleanup program.

No source, config, test, asset, route, package, or documentation deletion is performed by these reports. Each wave records proposed deletions, renames, refactors, validation gates, owner questions, and implementation checklists for later approval.

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

## Non-Destructive Rules

- Do not delete files during dry run.
- Do not rename files during dry run.
- Do not modify source, config, tests, package manifests, assets, or generated outputs during dry run.
- Only write markdown reports under this folder.
- Every proposed change must include validation or an explicit owner decision.
