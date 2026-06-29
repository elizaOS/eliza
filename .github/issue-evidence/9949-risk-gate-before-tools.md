# #9949 should-respond risk gate before planner tools

Date: 2026-06-29 UTC
Branch: `codex/fix/should-respond-risk-gate-before-tools`

## Change

- Moved the v5 should-respond injection/social-engineering gate into `runV5MessageRuntimeStage1` immediately after Stage 1 parses `RESPOND`, before facts/addressed-to/topic side effects, early replies, planner execution, or action handlers can run.
- Cached completed adjudications on the message metadata so the existing outer gate remains as a safety net without issuing a second `TEXT_LARGE` adjudication for the same text and role.
- Added a planner regression test that queues only Stage 1 and `TEXT_LARGE` adjudication responses and asserts the `WEB_SEARCH` action handler is never called when the adjudicator blocks.

## Local validation

Passed:

```powershell
bunx @biomejs/biome check packages/core/src/services/message.ts packages/core/src/features/trust/should-respond-risk-gate.ts packages/core/src/features/trust/__tests__/should-respond-risk-gate.test.ts packages/core/src/__tests__/planner-happy-path.test.ts
```

Biome exited 0. It still reports two pre-existing warnings in `should-respond-risk-gate.ts` (`NON_ASCII_RE` control-character regex and optional-chain suggestion).

```powershell
bunx vitest run --config packages/core/vitest.config.ts packages/core/src/features/trust/__tests__/should-respond-risk-gate.test.ts
```

Result: 1 file passed, 24 tests passed.

```powershell
git diff --check
```

Result: passed.

Partial / blocked:

```powershell
bunx vitest run --config packages/core/vitest.config.ts packages/core/src/__tests__/planner-happy-path.test.ts
```

Blocked by this Windows worktree's incomplete install. Initial failure was missing `@elizaos/logger` dist; after locally generating ignored `packages/logger/dist` and installing ignored logger runtime deps, the next missing package was:

```text
Cannot find package 'handlebars' imported from packages/core/src/utils.ts
```

```powershell
bunx tsgo --noEmit -p packages/core/tsconfig.json 2>&1 | Select-String -Pattern "should-respond-risk-gate|planner-happy-path|services/message"
```

Result: `tsgo` exited 1 from the wider incomplete workspace, with no diagnostics matching the touched files.

## Evidence status

- Backend logs: covered by unit assertions on structured `[ShouldRespondRiskGate]` logger calls; full runtime logs require a complete install.
- Real-LLM trajectory: not captured in this local slice; requires live model credentials and a working scenario-runner install.
- Screenshots/video/audio: N/A for this runtime-only gate.
