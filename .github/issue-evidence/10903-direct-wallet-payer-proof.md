# Issue 10903 - Direct Wallet Payer Proof

## Summary

`POST /api/crypto/direct-payments` now returns a payer-wallet proof challenge bound to the payment id, organization, user, network, payer address, receive address, token, expected units, and expiry. The browser signs that challenge before sending funds, then sends the signature to both `attach-tx` and `confirm`.

The server verifies EVM signatures with `viem.verifyMessage` and Solana signatures with `tweetnacl` Ed25519 verification before it accepts a transaction hash or credits a payment. Stored verified proof metadata lets the cron recovery path confirm already-attached broadcast transactions without asking the browser for the signature again.

## Verification

- `bunx biome check packages/cloud/shared/src/lib/services/direct-wallet-payments.ts packages/cloud/shared/src/lib/services/direct-wallet-payer-proof.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payments.integration.test.ts packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts packages/ui/src/cloud/billing/components/direct-crypto-credit-card.tsx 'packages/cloud/api/crypto/direct-payments/[id]/attach-tx/route.ts' 'packages/cloud/api/crypto/direct-payments/[id]/confirm/route.ts'`
  - Passed.
- `bun test packages/cloud/shared/src/lib/services/__tests__/direct-wallet-payer-proof.test.ts`
  - Passed: 3 tests, 8 assertions.
- `REQUIRE_E2E_SERVER=0 bun test packages/cloud/api/test/e2e/group-m-direct-crypto.test.ts`
  - Passed in no-server skip mode: 5 tests loaded and skipped live calls because `http://localhost:8787` was not running.

## Blocked / N/A

- `bun run --cwd packages/cloud/api typecheck`
  - Blocked by missing generated i18n keyword data outside this change:
    `core/src/i18n/generated/validation-keyword-data.ts` and
    `shared/src/i18n/generated/validation-keyword-data.js`.
- Full live payment trajectory, screenshots, video, and frontend/backend logs are N/A for this draft PR because no funded live treasury/testnet payment flow or local Worker server was available in this worktree.
