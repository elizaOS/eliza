# Issue #13840 - UI determinism baseline drift

## Scope

- Changed `packages/scripts/audit-ui-determinism.mjs` baseline matching from exact `L<line> <kind>` strings to file + finding-kind occurrence counts.
- Kept line numbers in `ui-determinism-baseline.json` as human review context.
- Refreshed the checked-in baseline from current `origin/develop` after verifying the only remaining mismatch under count-based matching was the `HeartbeatForm.tsx` -> `TriggerForm.tsx` file move for the same `new Date()` finding.

## Before

- `node packages/scripts/audit-ui-determinism.mjs --json`
  - Failed on untouched `origin/develop`.
  - Reported 40 false regressions from line drift across current UI files.

## After

- `node packages/scripts/audit-ui-determinism.mjs`
  - PASS: `render-time=46 deferred=136 module=246 (baseline 31 files)`
  - PASS: `OK audit-ui-determinism PASSED (no new render-time nondeterminism)`
- `node packages/scripts/audit-ui-determinism.mjs --json`
  - PASS: `regressionCount: 0`
- `node packages/scripts/audit-ui-determinism.mjs --self-test`
  - PASS: existing classifier cases plus new line-drift, count-increase, and new-kind baseline cases.
- `bunx @biomejs/biome check --write packages/scripts/audit-ui-determinism.mjs packages/scripts/ui-determinism-baseline.json`
  - PASS: formatted baseline JSON.
- `git diff --check`
  - PASS.

## Manual Review

- The refreshed baseline now records only current render-time backlog: 46 occurrences across 31 files.
- Removed baseline entries are stale findings no longer reported by the audit.
- Line changes are now diagnostic only; a same-file added occurrence of an existing kind still fails by count.
