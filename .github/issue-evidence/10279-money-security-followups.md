# #10279 — #3 wallet-provision squatting: correct fix (proof-of-control) + #10382 regression revert

Items **1 & 2** (Stripe payout idempotency) shipped in #10327. Item **#4** (anon
free-message over-run) shipped in **#10382** and is correct — this branch keeps it as-is.

This branch corrects **#3** (server-wallet provision squatting). #10382 also attempted #3 but
its approach is a **regression**; this replaces it with the issue's option 1 (proof-of-control).

---

## Why #10382's #3 is a regression

#10382 dropped the global-unique on `client_address`, added a composite
`UNIQUE(organization_id, client_address, chain_type)`, and **org-scoped the RPC lookup to
`authenticatedUser.organization_id`**. That breaks every legitimate RPC call:

- **provision** stores the row under the **API-key owner's org** (`requireUserOrApiKey`).
- **RPC** authenticates by wallet signature → `findOrCreateUserByWalletAddress` resolves a
  **separate, wallet-derived `wallet-${address}` org**.
- These orgs are structurally different (the agent's `clientAddress` is a freshly generated key,
  not the human's login wallet), so `executeServerWalletRpc`'s
  `where client_address = X AND organization_id = <wallet-org>` matches nothing →
  `ServerWalletNotFoundError` (404) on every real call.
- #10382's test only asserts the WHERE clause *contains* `organization_id` and mocks `findFirst`
  to return a wallet regardless — so it cannot catch the bug. (Its `containsValue` helper is also
  fooled by the column→table back-reference, so even the "contains" assertion is vacuous.)

Also: #10382's migration `0153_agent_server_wallets_org_scoped_client_address.sql` was **never
registered in `_journal.json`** (orphan), so it never applied — the DB still has the global-unique
from migration 0038. So #10382's schema (composite) already drifts from the real DB (global).

#10382 is on **develop (staging) only**, not main/prod.

## The correct fix — proof-of-control at provision (issue option 1)

`client_address` is a **global capability key by design** (the elizacloud client's `bridge-client.ts`
documents that RPC "verifies the signature against the `client_address` registered at provision
time" — org-agnostic; the agent holds the key). So the fix keeps the global unique + global RPC
lookup and adds the one thing missing: **proof the provisioner controls the key.**

- **Revert #10382:** delete the orphan migration, restore `client_address` global-unique in the
  schema (matches the un-migrated DB — no new migration needed), revert `executeServerWalletRpc` +
  `rpc/route.ts` to the global lookup by `client_address`. Remove dead
  `getOrganizationIdForClientAddress`.
- **Wire contract:** `@elizaos/cloud-sdk` `buildWalletProvisionChallenge` — the exact string the
  client signs and the server rebuilds (single source of truth).
- **Server gate** (`cloud-shared` `server-wallets.ts`): `provisionServerWallet` verifies a signature
  over the challenge with the `clientAddress` key (real `viem.verifyMessage`) **before** any Steward
  / DB work — freshness window + nonce replay (degrades gracefully on cache outage since re-provision
  is idempotent). Errors map to 400 (expired) / 401 (invalid) / 409 (replay).
- **Provision route:** `controlProof` is a required, validated body field; `clientAddress` is
  EVM-validated regardless of `chainType` (it is always the agent's EVM key).
- **Client** (`plugin-elizacloud` `cloud-wallet.ts` / `bridge-client.ts`): signs the challenge with
  the local client key and sends `controlProof`; aborts if the local key ≠ requested address.

### Why proof-of-control closes the issue

A squatter can no longer claim an address it does not control, so the global-unique row always
belongs to the true key-holder: the DoS and the cross-tenant RPC mis-resolution are both gone, and
the RPC lookup stays an unambiguous global lookup (works across the provision-org/RPC-org split).

---

## Tests (real, not mocked at the seam under test)

`bun --conditions=eliza-source test` — 11/11:

```
wallet-provision-challenge.test.ts (golden, 4) — pins the exact wire bytes both sides depend on.
server-wallets-provision-proof.test.ts (6) — REAL viem keypairs/signatures; only Steward/DB/cache doubled:
  ✓ accepts a valid proof and proceeds to provision
  ✓ rejects a proof signed by a DIFFERENT key (the squatting case)  → ProvisionProofInvalidError, no Steward/DB
  ✓ rejects an expired proof / a far-future proof                   → ProvisionProofExpiredError
  ✓ rejects a replayed proof (same nonce twice)                     → ProvisionProofReplayError
  ✓ rejects when signed chainType ≠ requested                       → ProvisionProofInvalidError
server-wallets.test.ts (RPC lookup, 1) — rewritten to render the WHERE to SQL (the old object-walk
  was vacuous): asserts the lookup is GLOBAL by client_address and NOT org-scoped.
```

Gated live e2e (`group-b-account-billing.test.ts`, `RUN_STEWARD_WALLET_E2E=1`): happy path now sends
a real signed proof; added "proof required → 400" and "proof not signed by clientAddress → 401".

develop's #4 suites (`chat-stream-credit-leak.test.ts`, `anonymous-sessions.test.ts`) pass unchanged
on this branch.

## Verification

- Typecheck (`tsgo`): `cloud-sdk`, `cloud-shared`, `cloud-api`, `plugin-elizacloud` — **0 errors**.
- Lint (`biome`): clean across all changed files.
- Migration: none added — the DB is already global-unique (0038); the orphan composite migration is
  deleted and the schema reverted to match.

## Screenshots

N/A — cloud-backend money/security change with no UI surface. Evidence is the real-crypto proof-gate
test, the SQL-rendered RPC-lookup assertion, and the wire-format golden above.

## Breaking change (intentional, security control)

Provisioning now **requires** a control-proof. Agents on a `plugin-elizacloud` build predating this
cannot provision **new** wallets until they upgrade (already-provisioned wallets and all RPC are
unaffected). A security control that is optional is no control, so the proof is required.
