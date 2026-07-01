# Issue #10827 - PII Reply Boundary Evidence

Date: 2026-07-01
Branch: `fix/10827-pii-reply-boundary`

## Change Verified

- `develop` already contains the merged #10943 final-response fix in `restorePiiInUserReplyText` / `createV5ReplyStrategyResult`.
- This branch adds the missing response-handler early-reply egress restore, so the visible early callback receives real values too.
- This branch adds higher-level Stage 1/planner regressions proving direct reply, terminal `messageToUser`, terminal `REPLY`, and early-reply behavior through `runV5MessageRuntimeStage1`.
- The regressions leave Stage 1/planner internals redacted: `messageHandler.plan.reply` and the planner model context contain the surrogate, not `Dana Whitfield`.

## Manual Review

I inspected the focused regression assertions in `packages/core/src/__tests__/message-runtime-stage1.test.ts`:

- Direct/simple reply returns `I can email Dana Whitfield at Acme Robotics.` while the message-handler plan keeps the surrogate reply.
- Terminal planner `messageToUser` returns `Dana Whitfield is available for the renewal call.` while the planner context contains the surrogate and does not contain `Dana Whitfield`.
- Terminal planner `REPLY` tool-call text returns `I can follow up with Dana Whitfield.`
- Early response-handler reply callback receives `I'll check Dana Whitfield's status.`, while planner context still receives the surrogate early-reply text.

## Commands Run

```bash
bun run --cwd packages/core test message-runtime-stage1.test.ts pii-swap-reply-egress.test.ts pii-swap-egress.test.ts pii-swap-use-model.test.ts
```

Result: 4 test files passed, 90 tests passed.

```bash
bunx @biomejs/biome@2.5.1 check packages/core/src/services/message.ts packages/core/src/__tests__/message-runtime-stage1.test.ts
```

Result: checked 2 files, no fixes applied.

Note: I also tried including the already-merged `packages/core/src/runtime/__tests__/pii-swap-reply-egress.test.ts` in the Biome command. Biome reported an import-order issue in that pre-existing `develop` file, so the clean Biome evidence above is scoped to this branch's changed files.

```bash
bun run --cwd packages/core typecheck
```

Result: `tsgo --noEmit -p ./tsconfig.json` completed successfully.

```bash
git diff --check
```

Result: no whitespace errors.

## Screenshots / Recordings

N/A for this patch: the changed surface is a core backend privacy boundary with no UI files touched. The user-facing artifact is the returned reply content, covered by the focused regressions above. A live chat capture against a running app/model remains useful PR evidence if the branch is taken all the way to a PR, but it was not required to validate the code path changed here.
