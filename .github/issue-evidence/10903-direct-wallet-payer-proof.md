# Issue 10903 - Direct Wallet Payer Proof

## Summary

`POST /api/crypto/direct-payments` now returns a payer-wallet proof challenge bound to the payment id, organization, user, network, payer address, receive address, token, expected units, nonce, and expiry. The browser signs that challenge before sending funds, then sends the signature to both `attach-tx` and `confirm`.

The server verifies EVM signatures as EIP-712 typed data through `publicClient.verifyTypedData`, so smart-contract wallets can pass via EIP-1271. Solana signatures still use the canonical message plus `tweetnacl` Ed25519 verification. Stored verified proof metadata lets the cron recovery path confirm already-attached broadcast transactions without asking the browser for the signature again, and the raw signature is not persisted.

## On-chain payer binding (review round 2)

- **EVM native (BNB):** `tx.from` must equal the proven payer wallet. Without this, a valid self-signed proof could claim someone else's native deposit of matching value (the re-opened #10903 theft found in adversarial review). Consequence, fail-closed by design: contract-wallet native transfers (Safe/4337 — `tx.from` is a relayer/bundler) and CEX withdrawals are rejected with a clear error telling the user to pay with a token instead.
- **EVM token (USDT/USDC/$U):** the Transfer event is the authoritative binding — the configured token contract must emit `Transfer(provenPayer → treasury)` for at least the expected units. The redundant `tx.from == payer` / `tx.to == tokenAddress` checks were removed so contract-wallet payers (relayed txs) can pay via tokens; the event's `from` is the account whose balance decreased, regardless of who carried the transaction.
- **Solana:** unchanged — pre/post token-balance deltas bind the payer.

## Deploy caveat: legacy rows

Payments created before this deploy lack `payer_proof_message` / `payer_proof_typed_data` in metadata and can never pass verification. Attach/confirm fail closed with a distinct, greppable code — `LEGACY_PAYMENT_MISSING_PAYER_PROOF` (exported const) — plus a structured `logger.error` with the redacted payment id, network, and which artifact is missing, so ops can identify orphaned legacy deposits and reconcile them manually.

## Verification

- `bunx biome check packages/cloud/shared/src/lib/services/direct-wallet-payments.ts packages/cloud/shared/src/lib/services/direct-wallet-payer-proof.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx 'packages/cloud/api/crypto/direct-payments/[id]/attach-tx/route.ts' 'packages/cloud/api/crypto/direct-payments/[id]/confirm/route.ts'`
  - Passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts`
  - Passed: 5 tests (adds verifyEvmTypedData/ERC-1271 injection + fail-closed tests).
- `bunx vitest run packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts --config vitest.config.ts`
  - Passed: 33 tests against in-memory PGlite. Includes the real-verify-path suite (no
    `trustPayerProof` shortcut): attach missing/wrong-wallet/tampered/expired-challenge
    rejections, confirm missing/wrong-wallet/expired rejections,
    `LEGACY_PAYMENT_MISSING_PAYER_PROOF` fail-closed on both endpoints (plus the
    personal-sign-era row shape), the native `tx.from != proven payer` theft rejection,
    the native happy path, and the contract-wallet-shaped token payment (relayer
    `tx.from`, Transfer-event payer binding).
  - Note: this file previously could not parse under vitest (the guarded
    `vi.mock`/`vi.hoisted` layout broke vitest's mock-hoisting transform), so the whole
    suite had silently never run — under bun it skips by design, under vitest it was a
    parse error. Fixed by bracing the guards and dropping `vi.hoisted`; under `bun test`
    the file still skips cleanly as designed.
- `bun run --cwd packages/cloud/shared typecheck`
  - Passed.
- `bun run --cwd packages/cloud/api typecheck`
  - Passed before rebase and passed again after rebasing onto `origin/develop`.
- `bun run --cwd packages/ui typecheck`
  - Passed.
- `bunx biome check packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts packages/cloud/api/src/stubs/elizaos-core.ts`
  - Passed after the rebase cleanup.
- `bun test packages/cloud/api/__tests__/chat-completions-streaming-credit-leak.test.ts`
  - Passed: 4 tests, 30 assertions.
- `REQUIRE_E2E_SERVER=0 bun test packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts`
  - Passed in no-server skip mode: 5 tests loaded and skipped live calls because `http://localhost:8787` was not running.
- `ELIZA_NODE_PATH=/Users/shawwalters/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node bun run --cwd packages/app audit:app`
  - Passed before rebase: 349 Playwright checks, `broken=0`, `needs-work=0`, `minimalism-budget-failures=0`.
  - Post-rebase rerun generated `packages/app/aesthetic-audit-output/report.json` with 348 views, `broken=0`, `needs-work=0`, `minimalism-budget-failures=0`; the wrapper later hung in a `build:web` subprocess and was terminated.

## Blocked / N/A

- Full live payment trajectory, screenshots, video, and frontend/backend logs are N/A for this PR because no funded live treasury/testnet payment flow or local Worker server was available in this worktree.
