# Issue #9943 feed skip inventory evidence

## Scope

- Added `packages/feed/scripts/testing-skip-inventory.mjs`.
- Added `bun run --cwd packages/feed test:skip-inventory`.
- The command emits a line-level inventory of Feed test skip markers in text or JSON form, grouped by reason bucket.
- `--fail-on-undocumented-unconditional` exits nonzero if a bare unconditional skip lacks nearby rationale, making future Feed skip triage enforceable.

## Current inventory

Generated on the branch with `bun run --cwd packages/feed test:skip-inventory --format=json`:

- Skip markers: 249
- Files with skip markers: 67
- Reason buckets:
  - documented-inline: 110
  - server-gated: 96
  - live-LLM-gated: 30
  - auth-or-session-gated: 3
  - seed-or-external-state-gated: 3
  - conditional-undocumented: 3
  - database-gated: 2
  - documented-nearby: 1
  - local-optional: 1
  - undocumented-unconditional: 0

## Validation

- `bun run --cwd packages/feed test:skip-inventory --format=json`
  - Passed and produced the inventory above.
- `bun run --cwd packages/feed test:skip-inventory --fail-on-undocumented-unconditional`
  - Passed with exit status 0.
- `node --check packages/feed/scripts/testing-skip-inventory.mjs`
  - Passed.
- `bun run --cwd packages/feed lint`
  - Passed for Feed's existing lint scope.
- `git diff --check`
  - Passed.
- `bun run --cwd packages/feed typecheck`
  - Blocked by existing `packages/feed/packages/db/src/db.ts` errors at lines 737 and 923: Drizzle query casts from `Record<string, never>` to the generated schema query type fail with TS2352.
  - The command fails in the `packages/db` package before reaching this branch's script/package changes.

## Evidence notes

- Real LLM trajectory: N/A. This is deterministic test-inventory tooling.
- Screenshots/video/audio: N/A. No app UI, mobile, or audio surface changed.
- Full Feed unit/e2e suites were not run for this tooling-only slice; the command does not execute Feed tests, start services, or require credentials.
