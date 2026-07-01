# Issue #9943 feed skip inventory evidence

## Scope

- Added `packages/feed/scripts/testing-skip-inventory.mjs`.
- Added `bun run --cwd packages/feed test:skip-inventory`.
- The command emits a line-level inventory of Feed test skip markers in text or JSON form, grouped by reason bucket.
- `--fail-on-undocumented-unconditional` exits nonzero if a bare unconditional skip lacks nearby rationale, making future Feed skip triage enforceable.
- Fixed four Feed typecheck strictness blockers discovered while validating this
  slice:
  - `packages/feed/packages/db/src/db.ts` explicit proxy casts for Drizzle table repositories.
  - `packages/feed/packages/engine/src/GameGenerator.ts` grouped-question spread cast.
  - `packages/feed/packages/engine/src/actors-loader.ts` typed legacy `postExample` compatibility.
  - `packages/feed/packages/engine/src/game-tick.ts` DAG trace result cast.

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
  - Passed after adding `scripts/testing-skip-inventory.mjs` to Feed's explicit lint scope.
- `git diff --check`
  - Passed.
- `bun run --cwd packages/feed typecheck`
  - `packages/db`, `packages/core`, `packages/engine`, and `packages/sim` now typecheck after the strictness fixes above.
  - Still blocked in `packages/agents` by existing Feed agent compatibility drift with current `@elizaos/core` types: handler return type mismatches, `ActionParameter[]` vs object-shaped parameter literals, and remaining unrelated TS2352 casts.
  - Before rerunning this check, `bun run --cwd packages/core build` was needed in this worktree so Feed's `@elizaos/core` import resolves to generated declarations.

## Evidence notes

- Real LLM trajectory: N/A. This is deterministic test-inventory tooling.
- Screenshots/video/audio: N/A. No app UI, mobile, or audio surface changed.
- Full Feed unit/e2e suites were not run for this tooling-only slice; the command does not execute Feed tests, start services, or require credentials.
