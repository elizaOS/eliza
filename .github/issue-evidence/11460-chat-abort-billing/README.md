# #11460 Chat Abort Billing Evidence

Captured on Windows 11 in worktree
`C:\Users\Administrator\.codex\worktrees\4a18\eliza-11460-chat-billing` on
2026-07-02.

## What Changed

- `handleStreamingRequest` now single-flights all streaming settlement outcomes
  (`onFinish`, `onAbort`, `onError`, and the `ReadableStream` catch path) so an
  aborted request can run `billUsage` at most once.
- The stream catch path treats a partial-settle abort as a client abort only
  when `req.signal.aborted === true`; an AbortError-shaped provider failure now
  refunds instead of charging partial usage.
- Partial abort billing now writes usage analytics and an `aiBillingRecords`
  audit record, matching the successful streaming/non-streaming billing paths.
- Affiliate earnings source IDs in `billUsage` / `billFlatUsage` are
  deterministic when `BillingContext.requestId` is present, so
  `dedupeBySourceId` can suppress duplicate cashable earnings.

## Commands Run

```bash
bunx @biomejs/biome@2.5.2 check packages/cloud/api/v1/chat/completions/route.ts packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts packages/cloud/shared/src/lib/services/ai-billing.ts packages/cloud/shared/src/lib/services/__tests__/ai-billing-anon-affiliate.test.ts
bun run --cwd packages/cloud/api test chat-completions-streaming-credit-leak
bun run --cwd packages/cloud/shared test src/lib/services/__tests__/ai-billing-anon-affiliate.test.ts
git diff --check
```

## Results

- Focused Biome check: passed on all four touched files.
- `chat-completions-streaming-credit-leak`: 9 passed, 0 failed, 68 assertions.
  New coverage proves:
  - `onAbort` plus cancelled-controller catch settles once and calls `billUsage`
    once.
  - AbortError-shaped provider failure without request abort refunds to zero and
    does not call `billUsage`.
  - Request-signal abort still bills delivered partial output and writes usage +
    audit records.
- `ai-billing-anon-affiliate`: 3 passed, 0 failed, 12 assertions. New coverage
  proves repeated paying-org calls with the same `requestId` use the same
  affiliate `sourceId` with `dedupeBySourceId: true`.
- `git diff --check`: passed.

## Limitations / N/A

- Screenshots and screen recording are N/A: this is a backend billing race fix
  with no UI surface.
- Full package typecheck was attempted from this sparse Windows worktree, but it
  is not a clean signal here: `packages/cloud/shared typecheck` fails before the
  touched files on missing sparse workspace sources/generated artifacts such as
  `@elizaos/plugin-cloud-apps`, `@elizaos/prompts`, `@elizaos/contracts`, and
  validation keyword data. The focused tests above exercise the changed runtime
  paths directly.
