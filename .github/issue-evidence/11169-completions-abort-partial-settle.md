# Issue #11169 Part 4 Evidence: Chat Completions Abort Partial Settlement

Date: 2026-07-02

## Scope

Fixes the LOW residual in #11169: `/api/v1/chat/completions` streaming client
abort no longer calls `settleReservation(0)` after text has already been sent.
The route now settles the reservation against the prompt estimate plus delivered
text-delta tokens, while provider-error paths still release the hold to `0`.

## Verification

- `bun test --conditions eliza-source --pass-with-no-tests __tests__/chat-completions-streaming-credit-leak.test.ts`
  - 7 pass, 0 fail, 51 assertions.
  - Covers provider 400/429/503 full refund, fullStream provider error full refund,
    client abort after text deltas partial settlement, abort-like stream failure
    partial settlement, and idempotent no-double-refund.
- `bun test --conditions eliza-source --pass-with-no-tests __tests__/chat-stream-credit-leak.test.ts`
  - 6 pass, 0 fail, 19 assertions.
- `bun test --conditions eliza-source --pass-with-no-tests __tests__/chat-completions-optimistic-billing.test.ts`
  - 5 pass, 0 fail, 13 assertions.
- `bun test --conditions eliza-source --pass-with-no-tests __tests__/chat-completions-tool-choice.test.ts`
  - 18 pass, 0 fail, 26 assertions.
- `bun run --cwd packages/cloud/api typecheck`
  - pass.
- `bun run --cwd packages/cloud/api build`
  - pass.
- `bunx @biomejs/biome check --write packages/cloud/api/v1/chat/completions/route.ts packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts`
  - pass, no fixes after final edit.
- `git diff --check`
  - pass.
- `bun run verify`
  - pass after rebasing onto latest `origin/develop`.

## Root Verify

`bun run verify` completed successfully after the final rebase. The run included
the type-safety ratchet, Turbo typecheck/lint, build-model and build-deps audits,
secret/script/test-realness audits, and dist-path consumer typechecks.

## N/A

- UI screenshots/video: N/A - backend billing/stream settlement route only.
- Native/mobile capture: N/A - no native surface changed.
- Live LLM trajectory: N/A - no prompt/model behavior changed; the regression is
  reservation settlement on client abort. The provider boundary is mocked in the
  focused unit test and the credit reservation settler is real.
