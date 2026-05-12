---
title: Secrets + Payments + Identity — Implementation plan (parallel waves)
date: 2026-05-10
status: plan
related:
  - reports/2026-05-10-secrets-payments-e2e-research.md
  - specs/2026-05-10-action-primitives-secrets-payments-identity.md
  - plans/2026-05-10-secrets-payments-bench-and-harness.md
---

# Implementation plan (parallel waves)

This is the build plan that takes the system from today's state (cataloged in the research report) to the atomic-primitives spec. Work is organized into waves so independent sub-agents can run in parallel; cross-wave dependencies are listed at the start of each later wave.

Universal verification per worker: `bun run typecheck`, `bun run lint`, package-scoped `bun run test`. Live LLM passes are deferred to wave H once primitives are stable. All new actions get unit tests at land time.

---

## Wave A — Atomic-action skeletons + facade compatibility

Goal: split monolithic actions, keep callers green.

**A1. Split `MANAGE_SECRET`**
- New atomic action files in `packages/core/src/features/secrets/actions/`:
  - `get-secret.ts` (GET_SECRET)
  - `delete-secret.ts` (DELETE_SECRET) — DM-only validate
  - `list-secrets.ts` (LIST_SECRETS) — never returns values
  - `check-secret.ts` (CHECK_SECRET) — boolean presence
  - `mirror-secret-to-vault.ts` (MIRROR_SECRET_TO_VAULT)
- Keep `manage-secret.ts` as a facade that dispatches to the above based on `subaction`. Same response shape.
- Tests per atom in `*.test.ts` next to source. Reuse fixtures from existing `request-secret.test.ts`.

**A2. Decompose `REQUEST_SECRET` into `CREATE_SENSITIVE_REQUEST` + `DELIVER_SENSITIVE_LINK` + `AWAIT_SENSITIVE_SUBMISSION`**
- New: `packages/core/src/features/sensitive-requests/actions/{create,deliver,await,cancel,expire}.ts`.
- Move policy resolution out of `request-secret.ts` into `CREATE_SENSITIVE_REQUEST`. Move delivery dispatch into `DELIVER_SENSITIVE_LINK` (registry-based).
- `request-secret.ts` becomes a thin facade that calls `CREATE` + `DELIVER` with policy-resolved target. Old behavior preserved.
- New events: `SensitiveRequestCreated`, `SensitiveRequestDelivered`, `SensitiveRequestSubmitted`, `SensitiveRequestExpired`, `SensitiveRequestCanceled`.

**A3. Channel-adapter registry for `DELIVER_SENSITIVE_LINK`**
- `packages/core/src/sensitive-requests/dispatch-registry.ts` — registry keyed by `DeliveryTarget`.
- Adapters provided by: `discord` (`plugins/plugin-discord/src/sensitive-request-adapter.ts`), `telegram`, `slack`, `eliza_app_inline` (UI), `cloud_link` (cloud client), `tunnel_link` (app-core local).
- Each adapter exports `{ target, supportsChannel(channelId), deliver(request, channelId): Promise<DeliveryResult> }`.

Land checks: A1, A2, A3 all green individually. Old `REQUEST_SECRET` / `MANAGE_SECRET` planner traces unchanged.

---

## Wave B — Unified payment surface

Depends on: A2 (delivery registry).

**B1. Unified `payment_requests` table + service**
- Cloud migration `0116_add_payment_requests.sql`. Columns: `id, organizationId, agentId, provider, amount, currency, payment_context, payer_identity_id?, status, expires_at, hosted_url?, callback_url?, callback_secret?, metadata`.
- `cloud/packages/lib/services/payment-requests.ts` — CRUD + state machine.
- Provider adapters: `cloud/packages/lib/services/payment-adapters/{stripe.ts,oxapay.ts,x402.ts,wallet-native.ts}` — each implements `{ createIntent, hostedUrl, verifyProof, settle, parseWebhook }`.
- Cutover: rewrite `app-charge-requests.ts`, `x402-payment-requests.ts`, `crypto-payments.ts` services as thin wrappers that delegate to the unified service. Existing routes keep their URLs and shapes.

**B2. `PaymentCallbackBus`**
- `cloud/packages/lib/services/payment-callback-bus.ts` — in-process pub/sub, durable replay via the events table.
- All settlement paths (Stripe webhook, OxaPay webhook, x402 facilitator settle, wallet-native confirmation) publish `PaymentSettled` / `PaymentFailed` to the bus.
- Existing `app-charge-callbacks.ts` HTTP+DM dispatch is now a *subscriber* of the bus, not the source of truth.

**B3. Atomic payment actions**
- `packages/core/src/features/payments/actions/{create-payment-request,deliver-payment-link,verify-payment-payload,settle-payment,await-payment-callback,cancel-payment-request}.ts`.
- `core/types/payment.ts` gets the unified `PaymentContext` and `PaymentProvider` types from the spec.

**B4. Local-mode tunnel-served payment page**
- `packages/app-core/src/api/payment-routes.ts` — POST/GET/list local payment requests, renderable hosted page if a tunnel is up.
- `packages/app-core/src/api/payment-store.ts` — persistent local store (mirrors cloud schema).
- Cloud not required for `provider: "x402" | "wallet_native"` in local mode.

**B5. Stripe Checkout + webhook**
- `cloud/apps/api/v1/stripe/checkout/route.ts` — POST, server-side Stripe Checkout session create.
- `cloud/apps/api/v1/stripe/webhook/route.ts` — handles `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`. Publishes to `PaymentCallbackBus`.
- Stripe Payment Link flow added in `payment-adapters/stripe.ts`.

Land checks: existing app-charge / x402 / crypto-payments tests pass against the new service layer. New unit tests per adapter + bus.

---

## Wave C — OAuth atomic flow + linked-identity adapter

Depends on: A2.

**C1. `OAuthCallbackBus` + `oauth_intents` table**
- Cloud migration `0117_add_oauth_intents.sql`.
- `cloud/packages/lib/services/oauth-callback-bus.ts`.
- Both cloud `/api/v1/oauth/callback/[provider]` and a new local `/api/oauth/callback/[provider]` (`packages/app-core/src/api/oauth-callback-routes.ts`) publish to the bus.

**C2. Atomic OAuth actions**
- `packages/core/src/features/oauth/actions/{create-oauth-intent,deliver-oauth-link,await-oauth-callback,bind-oauth-credential,revoke-oauth-credential}.ts`.
- `BIND_OAUTH_CREDENTIAL` writes to vault via the existing `vault-mirror.ts` and links identity via the new `IdentityVerificationGatekeeper`.

**C3. Linked-identity adapter implementation**
- `cloud/packages/lib/services/identity-link-store.ts` — backs `areEntitiesLinked`. Persists in a new `identity_links` table.
- `cloud/packages/lib/services/sensitive-request-authorization.ts` — replace stub with the real adapter.

**C4. Vendor OAuth client wiring**
- For each vendor with credentials available (Discord done; add Linear, Shopify, Calendly, LinkedIn, Google), confirm the client-id/secret are wired in `cloud/packages/scripts/sync-api-dev-vars.ts` and in the provider adapter.

Land checks: full E2E "user clicks DM link → OAuth callback → identity bound → AWAIT_OAUTH_CALLBACK resolves" with mocked provider via mockoon (`test/mocks/mockoon/oauth-{provider}.json`).

---

## Wave D — Approval + identity-verification primitives

Depends on: A2, C1.

**D1. `approval_requests` table + service**
- Cloud migration `0118_add_approval_requests.sql`.
- `cloud/packages/lib/services/approval-requests.ts`.

**D2. Atomic actions**
- `packages/core/src/features/approvals/actions/{request-identity-verification,deliver-approval-link,await-approval,verify-approval-signature,bind-identity-to-session}.ts`.

**D3. `IdentityVerificationGatekeeper` service**
- `packages/app-core/src/services/identity-verification-gatekeeper.ts`. Validates approval signatures (Ed25519 / SIWE / OAuth-fresh-session), exposes `verify(approvalId, signature)`.

---

## Wave E — Plugin-config primitives + provider context

Depends on: A1.

**E1. Probe primitive**
- `packages/core/src/features/plugin-config/actions/{probe,deliver-form,poll-status,activate-if-ready}.ts`.
- Uses each plugin manifest's `requiredSecrets[]` (already declared in `packages/app-core/src/registry/entries/plugins/*.json`).

**E2. New providers (position −10)**
- `packages/core/src/providers/channel-privacy-class.ts`
- `packages/core/src/providers/user-identity-verification-status.ts`
- `packages/core/src/providers/linked-identities.ts`
- `packages/core/src/providers/outstanding-sensitive-requests.ts`
- `packages/core/src/providers/outstanding-payment-requests.ts`
- `packages/core/src/providers/plugin-configuration-completeness.ts`
- `packages/core/src/providers/sub-agent-credential-scope.ts`

---

## Wave F — Sub-agent credential bridge

Depends on: A2.

**F1. Credential scope table + service**
- Cloud migration `0120_add_coding_agent_credential_scopes.sql` (also writeable locally for local-only mode).
- `packages/app-core/src/services/credential-tunnel-service.ts`.

**F2. Bridge route**
- `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts` adds:
  - `POST /api/coding-agents/<sessionId>/credentials/request` — creates a `SensitiveRequest` of `kind="secret"`, returns request id + scoped one-time token.
  - `GET /api/coding-agents/<sessionId>/credentials/<key>?token=<scopedToken>` — long-poll, returns the secret value (only for the key in scope) when submitted.

**F3. Atomic actions for the parent**
- `packages/core/src/features/sub-agent-credentials/actions/{declare-scope,tunnel-credential,await-decision,retrieve-results}.ts`.
- Sub-agent (Claude Code, Codex) consumes the bridge via the existing PTY env / loopback HTTP — no new client code needed there beyond the route.

---

## Wave G — Secret voting (M-of-N, plaintext v1)

Depends on: A2.

**G1. Schema + service**
- Cloud migration `0119_add_secret_ballots.sql`.
- `cloud/packages/lib/services/secret-ballots.ts`.

**G2. Atomic actions**
- `packages/core/src/features/ballots/actions/{create-ballot,distribute-ballot,submit-ballot-vote,tally-ballot-if-threshold-met,expire-ballot}.ts`.
- DM-only enforcement on `DISTRIBUTE_BALLOT`. Per-participant scoped tokens reuse the sensitive-request token model.

---

## Wave H — Live integration + skip-when-missing-key gates

Depends on: A–G.

**H1. Per-channel verification glue**
- `plugins/plugin-discord/src/sensitive-request-gate.ts` — gate REQUEST_SECRET / payment delivery based on Discord OAuth verification status. Tests: `discord-sensitive-gate.live.e2e.test.ts` (skips without `DISCORD_API_TOKEN` + `DISCORD_TEST_GUILD_ID`).
- Same for Telegram, Slack, WhatsApp, X — each gate skips with a clear reason when test creds absent.

**H2. Tunnel callback hardening**
- `packages/app-core/src/api/sensitive-request-routes.ts` — replace `AGENT_SERVER_SHARED_SECRET` with per-request HMAC-bound tokens.
- Add `TunnelHealthMonitor` (`packages/app-core/src/services/tunnel-health-monitor.ts`) feeding `eligibleDeliveryTargets`.

**H3. SensitiveRequestExpirationSweeper**
- `packages/app-core/src/services/sensitive-request-expiration-sweeper.ts`. Cloud-side equivalent in `cloud/packages/lib/services/sensitive-request-sweeper.ts`. Both fire `SensitiveRequestExpired`.

**H4. Live E2E**
- See `plans/2026-05-10-secrets-payments-bench-and-harness.md` for the harness, scenarios, and runbook. This wave adds the per-channel suites and ensures every expected env-var gate is wired.

---

## Cross-wave deliverables

- **Documentation:** every wave updates `packages/docs/rest/secrets.md` and `packages/docs/rest/cloud.md` for new endpoints and actions; `packages/docs/security.md` for auth/redaction guarantees.
- **Telemetry:** every event emitted via the new buses goes into the existing trajectory logger (respect `ELIZA_DISABLE_TRAJECTORY_LOGGING`).
- **Backwards compatibility:** `REQUEST_SECRET`, `MANAGE_SECRET`, app-charge / x402 / crypto-payments routes keep their existing names + shapes.

---

## Sub-agent assignment (parallel)

When the user greenlights, spawn one `general-purpose` sub-agent per wave with `isolation: "worktree"`. Independent waves run in parallel; dependent waves run after their dependencies land. Suggested ordering:

1. **Phase 1 (parallel):** A1, A3, B5 (Stripe), C3 (linked-identity store), D3 (gatekeeper).
2. **Phase 2 (parallel, after A2 lands):** A2, B1, B2, B3, B4, C1, C2, E1, E2, F1, F2, F3, G1, G2.
3. **Phase 3 (after Phase 2):** D1, D2, H1, H2, H3, H4.

No wave introduces a new external dependency. Every wave's land includes type/lint/test gates and a brief CHANGELOG entry.

---

## Risks and explicit non-goals

- **Risk: facade drift.** Once atomic actions exist, the planner may still pick the facade if the prompt template still mentions only old names. Update `enabled_skills` provider output and the planner's action catalog snapshot at the same commit as Wave A lands.
- **Risk: payment migration.** Wave B unifies three live tables. Each pre-existing route keeps its URL but the underlying service is rewritten. Ship behind a feature flag (`UNIFIED_PAYMENTS=1`) with parity tests.
- **Non-goal:** new payment providers (no PayPal, no Coinbase Commerce in v1).
- **Non-goal:** threshold cryptography for ballots in v1.
- **Non-goal:** new connectors. We harden the existing dispatch registry; we don't add new channels.
