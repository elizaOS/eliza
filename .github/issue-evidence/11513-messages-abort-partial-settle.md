# Issue #11513 Evidence: /v1/messages Abort Partial Settlement

Date: 2026-07-02

## Scope

Fixes #11513: `/api/v1/messages` streaming client abort no longer calls
`settleReservation(0)` (full refund) after output has already been delivered.
The route now settles the reservation against the prompt estimate plus
delivered text-delta tokens — the same mechanism #11455/#11472 shipped for
`/api/v1/chat/completions` — on both the `onAbort` callback path and the
stream-catch backstop (request signal aborted). Provider-error paths still
release the hold to `0`, and the terminal settlement is single-flighted so
racing abort paths cannot double-bill or double-record.

## Verification

- Red (route at `origin/develop` + test seam only), proving the leak:
  - `bun test __tests__/messages-abort-partial-settle.test.ts`
  - 2 pass, 3 fail — all three abort tests fail with
    `expect(ledger.actualCosts[0]).toBeGreaterThan(0)` receiving `0` and
    `billUsage` never called: the aborted stream refunded the full hold and
    billed nothing.
- Green (with the fix):
  - `bun test __tests__/messages-abort-partial-settle.test.ts`
  - 5 pass, 0 fail, 31 assertions. Covers onAbort partial settlement,
    request-signal abort on the catch path, onAbort + catch single-flight,
    fullStream provider error full refund, and onError provider full refund.
    The credit-reservation settler (`createCreditReservationSettler`) is REAL
    and driven against a ledger-backed reservation; only the AI SDK
    `streamText` and the `billUsage`/`recordUsageAnalytics` boundary are
    mocked.
- Related suites (unchanged behavior stays green):
  - `bun test __tests__/messages-iac-fast-path.test.ts` — 3 pass, 0 fail.
  - `bun test __tests__/chat-completions-streaming-credit-leak.test.ts` — 9 pass, 0 fail.
  - `bun test __tests__/chat-stream-credit-leak.test.ts` — 6 pass, 0 fail.
  - `bun test __tests__/chat-completions-optimistic-billing.test.ts` — 5 pass, 0 fail.
- `bun run --cwd packages/cloud/api typecheck` — pass.
- `bunx @biomejs/biome check packages/cloud/api/v1/messages/route.ts
  packages/cloud/api/__tests__/messages-abort-partial-settle.test.ts
  packages/cloud/api/__tests__/messages-iac-fast-path.test.ts` — pass, no fixes.
- `bun run --cwd packages/cloud/api codegen` — idempotent, no router changes.

## Delivered-cost measure on abort

The AI SDK emits no `finish` part (and therefore no exact usage) when a stream
aborts, so the delivered output is billed from the accumulated `text-delta`
text via `estimateTokens`, floored by any finished-step usage the SDK did
report (`summarizeFinishedStepUsage`). This is the identical best-available
measure `/v1/chat/completions` uses (#11455).

## N/A

- UI screenshots/video: N/A - backend billing/stream settlement route only.
- Native/mobile capture: N/A - no native surface changed.
- Live LLM trajectory: N/A - no prompt/model behavior changed; the regression
  is reservation settlement on client abort. The provider boundary is mocked
  in the focused unit test and the credit reservation settler is real.
