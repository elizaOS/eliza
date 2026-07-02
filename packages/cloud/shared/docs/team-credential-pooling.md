# Team credential pooling — Phase 1 (org API-key pool)

Issue: elizaOS/eliza#11332. Design doc: "Team Credential-Pooling for Eliza
Cloud" (Phase 1). This file records the WHY behind the implementation choices
in `src/lib/services/team-credential-pool/` and the two follow-up seams.

## What it is

Any org member contributes provider API keys (Anthropic / OpenAI / Cerebras /
DeepSeek / Z.ai / Moonshot console keys) to the org's pool. Dedicated-agent
provisioning rotates across them with the exact selection/health behavior of
the self-host `AccountPool`.

## Architecture (reuse map)

| Piece | Source |
|---|---|
| Rotation/health brain | `AccountPool` from `@elizaos/app-core/account-pool`, **unchanged** — cloud supplies `DrizzleAccountPoolDeps` |
| Ciphertext store | existing `secrets` vault (AES-256-GCM envelope, audit log). `pooled_credentials.secret_id` → `secrets.id` |
| Metadata columns | mirror `LinkedAccountConfig` / `LinkedAccountHealthDetail` / `LinkedAccountUsage` from `@elizaos/contracts` 1:1 |
| Pre-pool validation | `probePooledApiKey`, patterned on `packages/agent/src/auth/direct-api-probe.ts` (#11033) — kept local so the Worker bundle never pulls `@elizaos/agent` |
| Per-org isolation | `TeamPoolRegistry` `Map<orgId, AccountPool>` with LRU eviction. The self-host globalThis bridges are never used (single-tenant plumbing) |
| IDOR guard | `assertOrgMembership` on the `:credentialId` routes |
| Usage attribution | `pooled_credential_usage` daily rollup (org, credential, user, day, calls) — replaces the self-host JSONL log |

`readAccounts` in `AccountPoolDeps` is synchronous by contract, so
`DrizzleAccountPoolDeps` serves a snapshot refreshed from the DB (15s TTL on
acquire). `writeAccount` is a row-level UPDATE of pool-metadata columns only —
never a blob rewrite — which removes the self-host read-modify-write hazard.

## Injection points

1. **Dedicated containers (implemented).** `createRuntimeAgent`
   (`eliza-sandbox.ts`) merges pooled keys into the in-memory bootstrap env
   right after `decryptAgentEnvVars`, only for providers the agent has no key
   of its own. The payload flows through `buildRuntimeBootstrapAgent` into
   character `settings.secrets`. Pooled keys are **never** persisted into
   `environment_vars`. Strict fallback: any pool failure yields the env
   unchanged (exactly today's behavior).
2. **Worker shared-runtime inference (documented seam, NOT implemented).**
   `getProviderKeys` (`lib/providers/provider-env.ts`) is synchronous and has
   no organization in scope; consulting the org pool there requires an async
   org-context refactor of every call site plus a node-side broker for
   decryption. Rather than half-build it, the follow-up contract is: before
   the platform-env fallback, call
   `getTeamPoolRegistry().selectCredential({ organizationId, providerId })`
   with a **strict fallback to platform env on any pool miss**, and record
   provider outcomes back through the org pool — 401 →
   `pool.markNeedsReauth`, 429 → `pool.markRateLimited` — exactly as
   `credential-store.ts` does for self-host chat. (That writeback surface
   ships with the wiring; Phase 1 deliberately adds no caller-less API.)
   Until then, key revocation is detected by the keep-alive sweep, which
   re-probes healthy credentials on a 6h cadence and flags 401/403s.

## Who can see what

- Plaintext is **never returned** — not even in the POST response (the
  contributor just typed the key; echoing it back would only re-expose it in
  transit, on screen, and in client state). The contribution response is the
  same masked summary as every read.
- Every read (GET) is masked: label, provider, last4, health, usage,
  contributor, per-day calls. Owner/admin can disable/re-prioritize/delete but
  never reveal. Contributors can delete their own key.
- Decryption happens only server-side at use time (`SecretsService`), and every
  decrypt lands in `secret_audit_log`.

## Billing — zero-rated (deliberate)

Pooled-key usage does **not** decrement org `credit_balance` and carries **no
platform fee**: the org already pays the provider directly on its own console
account, and cloud infra cost for the pool is negligible (a DB read per
provision).

### Future monetization (documented, NOT implemented)

If pooled-key usage should later contribute to cloud revenue, the metering
point is already in place — `TeamPoolRegistry.recordUse` fires once per
selection with (org, credential, user). Options, in increasing coupling:

1. **Platform fee per pooled call** — emit a `credit_transactions` debit from
   `recordUse` at a flat per-call or per-day rate.
2. **Metered credits** — extend `recordUse` with token counts from the
   inference layer and charge a discounted `ai_billing_records` rate
   (BYO-key tier) instead of the full markup.
3. **Seat-gated feature** — leave usage free but gate pool size (N keys per
   org) behind the subscription plan, enforced at `contributePooledCredential`.

All three are additive at the two named call sites; none require schema
changes (usage rollup already attributes per member per day).

## Phase 2 (not in this change)

Subscription-seat pooling (Claude Max / Codex) stays rejected at the API layer
(`isSubscriptionProviderId`). The Phase 2 design (flag + org allowlist +
tokens confined to first-party CLIs in single-tenant containers via
CredentialTunnelService) is in the design doc; nothing here builds it.
