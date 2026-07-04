# Issue #12276 - Feed world-state read failures

## Scope

This chunk fixes the feed engine slop called out in issue #12276:

- `WorldStateSnapshotService` no longer returns `[]` when prediction-market, perp-market, world-event, insider-assignment, or organization-state reads fail. It throws `DatabaseError` with the failing operation and original error message.
- `gameService.getQuestionOutcome()` still returns `null` for a reachable unresolved/missing question, but throws `DatabaseError` when the query itself fails.
- `getNpcGameContext()` no longer fabricates `true` when a question outcome lookup is missing or broken. Missing outcome skips that market intuition; query failures propagate.

## Verification

Run on July 4, 2026 from branch `codex/fix-12276-feed-world-state-errors`.

```bash
bun test ./packages/engine/src/__tests__/world-state-errors.test.ts
```

Result: passed, 1 file / 3 tests.

```bash
bunx @biomejs/biome check --config-path ../../biome.json \
  --files-ignore-unknown=true \
  --no-errors-on-unmatched \
  packages/engine/src/services/world-state-snapshot-service.ts \
  packages/engine/src/game-service.ts \
  packages/engine/src/__tests__/world-state-errors.test.ts \
  packages/agents/src/plugins/feed/providers/npc-game-context.ts
```

Result: passed with one pre-existing warning: `packages/engine/src/services/world-state-snapshot-service.ts` is a static-only class.

```bash
bun run audit:error-policy-ratchet
```

Result: passed with no new fallback slop.

## Known Typecheck Blockers

```bash
bun run --cwd packages/feed/packages/engine typecheck
```

Result: failed on existing feed workspace type/build-output issues, including missing built declaration outputs for `@feed/db`, `@feed/shared`, `@feed/core`, and `@feed/pack-default`, plus pre-existing implicit `any`/strictness errors across engine files.

```bash
bun run --cwd packages/feed/packages/agents typecheck
```

Result: failed on existing missing built declaration outputs for `@feed/db`, `@feed/engine`, `@feed/api`, `@feed/shared`, and `@feed/a2a`, plus pre-existing implicit `any`/strictness errors across agents files.

## Root Verify

`bun run verify` was last run during the preceding #12272 chunk and failed in unrelated `@elizaos/cloud-ui#lint` import/export ordering and formatting findings under `packages/cloud-ui/src/approvals/*` and `packages/cloud-ui/src/index.ts`. Those files are outside this branch's touched files.

## Evidence Matrix

- Backend logs: N/A - this chunk is covered by direct feed engine tests that force DB read failures at the package boundary and assert typed `DatabaseError`.
- Frontend screenshots/video: N/A - no UI surface changed.
- Real stopped-DB run: N/A for this small chunk - the test proves the engine no longer fabricates empty world state from failed DB reads; no DB schema or runtime tick wiring changed.
- Real-LLM trajectories: N/A - no prompt/action/provider/model behavior changed.
- Domain artifact: `packages/feed/packages/engine/src/__tests__/world-state-errors.test.ts` asserts failed `questions` reads throw `DatabaseError`, snapshot insert is not called, reachable unresolved outcomes stay `null`, and failed outcome reads throw.
