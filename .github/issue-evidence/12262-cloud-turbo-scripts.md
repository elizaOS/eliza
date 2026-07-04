# Issue #12262 - cloud scripts folded into Turbo

## Change

- Replaced serial root `typecheck:cloud` package wrappers with a Turbo-filtered typecheck command.
- Replaced root `verify:cloud` with a Turbo-filtered `lint:check typecheck` command.

## Verification

Run on 2026-07-04:

- Static root script assertion:
  - `typecheck:cloud` is `node packages/scripts/run-turbo.mjs run typecheck --filter='./packages/cloud/**'`
  - `verify:cloud` is `node packages/scripts/run-turbo.mjs run lint:check typecheck --filter='./packages/cloud/**'`
- Turbo dry runs with a temporary `node_modules` symlink:
  - `node packages/scripts/run-turbo.mjs run typecheck --filter='./packages/cloud/**' --dry=json`
  - `node packages/scripts/run-turbo.mjs run lint --filter='./packages/cloud/**' --dry=json`
  - `node packages/scripts/run-turbo.mjs run lint:check --filter='./packages/cloud/**' --dry=json`
- Dry-run task counts:
  - `typecheck`: 77 total tasks including dependency builds
  - `lint`: 14 cloud lint tasks
  - `lint:check`: 14 cloud lint-check tasks
- `git diff --check`
- `git diff --check origin/develop..HEAD`

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/Turbo script-surface change with no user interface.
