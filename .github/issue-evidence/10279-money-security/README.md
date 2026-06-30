# Issue 10279 money/security follow-ups

## Scope

- Items 1 and 2 are already present on `origin/develop` via PR #10327: Stripe
  Connect payout transfer debits are idempotent by `idempotency_key`, fail
  closed if the locked balance is insufficient, and only re-credit on definitive
  Stripe rejection. Ambiguous transfer failures hold the debit and return
  `needsReconciliation`.
- Item 3: server-wallet provision no longer globally reserves `client_address`.
  The schema and migration use `UNIQUE(organization_id, client_address,
  chain_type)`, and RPC lookup is scoped to the authenticated wallet user's
  organization.
- Item 4: anonymous `/api/v1/chat` reserves a free-message slot before
  streaming with a conditional atomic update and refunds the reservation on
  abort or pre-stream failure.

## Verification

```bash
bunx biome check --write packages/cloud/api/v1/chat/route.ts packages/cloud/api/v1/user/wallets/rpc/route.ts packages/cloud/shared/src/db/repositories/anonymous-sessions.ts packages/cloud/shared/src/db/schemas/agent-server-wallets.ts packages/cloud/shared/src/lib/auth-anonymous.ts packages/cloud/shared/src/lib/services/anonymous-sessions.ts packages/cloud/shared/src/lib/services/server-wallets.ts packages/cloud/shared/src/db/repositories/anonymous-sessions.test.ts packages/cloud/shared/src/lib/services/__tests__/server-wallets.test.ts
bun run --cwd packages/cloud/shared typecheck
bun run --cwd packages/cloud/api typecheck
bun --config .github/issue-evidence/10279-money-security/bunfig.no-coverage.toml test packages/cloud/api/__tests__/stripe-connect-transfer-route.test.ts
bun --config .github/issue-evidence/10279-money-security/bunfig.no-coverage.toml test packages/cloud/shared/src/db/repositories/anonymous-sessions.test.ts
bun --config .github/issue-evidence/10279-money-security/bunfig.no-coverage.toml test packages/cloud/shared/src/lib/services/__tests__/server-wallets.test.ts
```

All commands passed locally on 2026-06-30.
