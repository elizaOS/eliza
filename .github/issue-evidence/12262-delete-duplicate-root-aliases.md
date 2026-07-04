# Issue #12262 - delete duplicate root aliases

## Change

- Removed root `test:ci`; use `bun run test`.
- Removed root `lint:all`; use `bun run verify`.
- Removed root `build:typescript`; use `node packages/scripts/run-turbo.mjs run build`.
- Added a root `CLAUDE.md` / `AGENTS.md` migration table.
- Removed `lint:all` from the script-audit exact allowlist.

## Verification

Run on 2026-07-04:

- Static root script assertion confirmed `test:ci`, `lint:all`, and `build:typescript` are absent.
- Reference sweep:
  - `git grep -n "test:ci\\|lint:all\\|build:typescript" -- . ':!package.json' ':!.github/issue-evidence'`
  - No blocking root alias references. The remaining `build:typescript` reference is package-local under `packages/prompts`, invoked with `--cwd` by `packages/app-core/scripts/setup-upstreams.mjs`.
- `node scripts/assert-agents-claude-identical.mjs`
- `node packages/scripts/audit-scripts.mjs`
- `git diff --check`
- `git diff --check origin/develop..HEAD`

## Evidence notes

Screenshots and recordings are N/A: this is a root CLI/docs script-surface change with no user interface.
