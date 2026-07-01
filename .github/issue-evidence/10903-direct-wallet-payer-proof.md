# Issue 10903 - Direct Wallet Payer Proof

## Summary

`POST /api/crypto/direct-payments` now returns a payer-wallet proof challenge bound to the payment id, organization, user, network, payer address, receive address, token, expected units, nonce, and expiry. The browser signs that challenge before sending funds, then sends the signature to both `attach-tx` and `confirm`.

The server verifies EVM signatures as EIP-712 typed data through `publicClient.verifyTypedData`, so smart-contract wallets can pass via EIP-1271. Solana signatures still use the canonical message plus `tweetnacl` Ed25519 verification. Stored verified proof metadata lets the cron recovery path confirm already-attached broadcast transactions without asking the browser for the signature again, and the raw signature is not persisted.

## Verification

- `bunx biome check packages/cloud/shared/src/lib/services/direct-wallet-payments.ts packages/cloud/shared/src/lib/services/direct-wallet-payer-proof.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx 'packages/cloud/api/crypto/direct-payments/[id]/attach-tx/route.ts' 'packages/cloud/api/crypto/direct-payments/[id]/confirm/route.ts'`
  - Passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts`
  - Passed: 3 tests, 9 assertions.
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
