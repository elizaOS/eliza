# Issue #12259 - phantom Turbo override guard

## Change

- Extended `packages/scripts/audit-turbo-build-deps.mjs` to fail on any `pkg#task` override whose owner package is missing or does not define that script.
- Extended the dependency-edge audit to scan named `#build` dependencies from all `pkg#task` overrides, including `#typecheck` overrides.
- Removed 22 dead named `#build` edges from typecheck overrides in `turbo.json`.
- Added `packages/scripts/audit-turbo-build-deps.self-test.mjs` with a synthetic workspace that fails on missing owner scripts/packages and passes after fixing the fixture.

## Verification

Run on 2026-07-04:

- `node --check packages/scripts/audit-turbo-build-deps.mjs`
- `node --check packages/scripts/audit-turbo-build-deps.self-test.mjs`
- `node packages/scripts/audit-turbo-build-deps.self-test.mjs`
- `node packages/scripts/audit-turbo-build-deps.mjs`
- `node -e "JSON.parse(require('fs').readFileSync('turbo.json','utf8'));"`
- `git diff --check`
- `git diff --check origin/develop..HEAD`

Real audit result:

- No phantom `#build` dependency edges.
- No phantom `pkg#task` overrides.
- Residual non-failing output:
  - 3 undeclared dependency-edge warnings.
  - 9 redundant override info entries.

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/Turbo auditor and config cleanup with no user interface.
