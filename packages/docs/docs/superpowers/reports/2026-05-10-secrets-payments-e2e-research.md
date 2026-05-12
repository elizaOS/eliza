---
title: Secrets + Payments + Identity — End-to-End Research Report
date: 2026-05-10
status: complete
scope: full audit of sensitive-request, secrets, payments, identity-verification, sub-agent credential bridge, and live-eval harness surfaces
---

# Secrets + Payments + Identity — End-to-End Research Report

This is the consolidated research output of six parallel audit subagents, synthesized into one map of "what exists, what is monolithic, what is missing, what cannot be tested today." It is the input for the implementation plan and benchmark plan in the companion documents.

Companion documents:

- `packages/docs/docs/superpowers/plans/2026-05-10-secrets-payments-e2e-implementation.md` — implementation plan with parallel waves
- `packages/docs/docs/superpowers/plans/2026-05-10-secrets-payments-bench-and-harness.md` — benchmark suite + harness plan (SecretsBench, woobench/scambench/configbench/lifeops-bench extensions, mockoon, puppeteer, cerebras live judging)

---

## 1. What is already built

### 1.1 Sensitive-request core

- `packages/core/src/sensitive-request-policy.ts` — single source of truth for source classification (DM / public / API / owner_app_private), default policy per kind (secret / payment / oauth / private_info), delivery-mode resolution (`resolveSensitiveRequestDelivery`), redaction helper. Exported from `index.node.ts` and `index.browser.ts`.
- `packages/core/src/features/secrets/actions/{request-secret,set-secret,manage-secret}.ts` — REQUEST_SECRET, SET_SECRET, MANAGE_SECRET actions.
- `packages/core/src/features/secrets/providers/secrets-status.ts` — SECRETS_STATUS provider, position −10.
- `packages/core/src/features/secrets/services/secrets.ts` — SecretsService.
- `packages/core/src/sensitive-request-policy.test.ts` (~140 tests), `request-secret.test.ts` (~60 tests).

### 1.2 Cloud sensitive-request

- `cloud/packages/db/{schemas,repositories}/sensitive-requests.ts`, migration `0115_add_sensitive_requests.sql` — `sensitive_requests` + `sensitive_request_events` tables.
- `cloud/packages/lib/services/sensitive-requests.ts` — create/get/list/submit/cancel/expire.
- `cloud/packages/lib/services/sensitive-request-authorization.ts` — actor types (`cloud_session`, `connector_identity`, `oauth_connection`), policy enforcement, **`areEntitiesLinked?` adapter is stubbed**.
- `cloud/packages/lib/services/oauth/sensitive-request-binding.ts` — OAuth-state binding, callback authorization, `allowUnlinkedProviderIdentity` flag.
- `cloud/apps/api/v1/sensitive-requests/*` — REST routes (~146 + ~147 unit tests).
- `cloud/apps/frontend/src/pages/sensitive-requests/[requestId]/page.tsx` — hosted submission page.

### 1.3 Local / app-core sensitive-request

- `packages/app-core/src/api/sensitive-request-routes.ts` — token hashing, TTL, replay protection, tunnel-auth-required, get-tunnel-status callback (~399 tests).
- `packages/app-core/src/api/sensitive-request-store.ts` — in-memory + persistent store.

### 1.4 UI

- `packages/ui/src/components/chat/MessageContent.tsx` (lines 900–1029) — `SensitiveRequestBlock`. Renders inline owner-only secret form when `canCollectValueInCurrentChannel === true && kind === "secret"`. Public-channel renders status only. Calls `client.updateSecrets()` (~284 UI tests).

### 1.5 Payments

- **x402** — `plugins/plugin-x402/{payment-wrapper.ts,x402-standard-payment.ts,payment-config.ts,types.ts}` + cloud `x402-facilitator.ts`, `x402-payment-requests.ts`, `cloud/apps/api/v1/x402/{verify,settle,requests,route.ts}`.
- **App-charge** (Stripe + OxaPay shell) — `cloud/packages/lib/services/{app-charge-requests,app-charge-callbacks,app-charge-settlement,payment-methods}.ts`, `cloud/apps/api/v1/apps/[id]/charges/*`, `cloud/apps/frontend/src/pages/payment/app-charge/[appId]/[chargeId]/page.tsx`. **`payment_context` field present on app-charge only**, default `verified_payer`. HMAC HTTP callback + Discord-DM callback paths exist (`app-charge-callbacks.ts:48`).
- **Crypto / OxaPay** — `cloud/packages/lib/services/{crypto-payments,oxapay}.ts`, `cloud/apps/api/crypto/payments/*`, schema `crypto_payments`.
- **Stripe** — `cloud/packages/lib/stripe.ts` + `payment-methods.ts` (customer + payment-method attach). **Hosted Stripe Checkout, Payment Links, webhook, customer portal, subscription billing all absent.**
- **Wallet** — `packages/agent/src/api/wallet-routes.ts`, `plugins/plugin-wallet/src/wallet-action.ts`.

### 1.6 Identity / channel verification

- Discord: `cloud/apps/api/v1/discord/{oauth,callback,connections,status}.ts` — full OAuth implemented.
- Telegram: `plugins/app-lifeops/src/api/client-lifeops.ts` POST `/api/lifeops/connectors/telegram/verify` — group-DM verify only.
- WhatsApp: `cloud/apps/api/v1/whatsapp/route.ts` — webhook signature only; no DM-auth gate to sensitive-requests.
- Slack: standard OAuth via `plugins/plugin-slack/src/connector-account-provider.ts`.
- X (Twitter): connector only, no DM-auth gate.
- Eliza app DM/group: implemented end-to-end against sensitive-request gate.
- Web (cloud.eliza.ai): SIWE via `cloud/packages/lib/auth/wallet-auth.ts`, helper `scripts/cloud-siwe-login.mjs`.

### 1.7 Tunnel

- Headscale (cloud): `plugins/plugin-tailscale/src/services/CloudTailscaleService.ts`. Env: `HEADSCALE_*`, `TUNNEL_PROXY_*`.
- Local Tailscale CLI fallback: `plugins/plugin-tailscale/src/services/LocalTailscaleService.ts`.
- ngrok: `plugins/plugin-ngrok/src/environment.ts`, used as fallback in `plugins/app-lifeops/src/lifeops/remote-desktop.ts`.

### 1.8 Sub-agent credential bridge (read-only today)

- `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts` — read-only `/api/coding-agents/<sessionId>/parent-context|memory`.
- `plugins/plugin-agent-orchestrator/src/api/hook-routes.ts` — Claude Code HTTP hooks.
- `plugins/plugin-agent-skills/src/actions/skill.ts` — canonical USE_SKILL.
- `packages/app-core/src/services/vault-mirror.ts` — parent-side vault.

### 1.9 Existing benchmark / eval infrastructure

- `packages/benchmarks/woobench` — Python persona-driven scenarios with payment_actions/payment_mock + revenue scoring.
- `packages/benchmarks/lifeops-bench` — strongest backend-state verification (LifeWorld + state-hash).
- `packages/benchmarks/configbench` — TS, exercises real eliza runtime for plugin discovery + agent config.
- `packages/benchmarks/scambench` — Python refusal/helpful scoring on 3000+ scam-vs-legit prompts.
- `packages/benchmarks/action-calling` — native function-call validation.
- `packages/scenario-runner/src/{loader,executor,interceptor,judge,reporter}.ts` — TS scenario engine. `interceptor.ts` captures `CapturedAction[]`, `ConnectorDispatch`, `ApprovalRequest`, `StateTransition`, `Artifact`. `judge.ts` uses `runtime.useModel(TEXT_LARGE)` (judge model is not decoupled from agent model).
- `packages/benchmarks/lifeops-bench/eliza_lifeops_bench/scenarios/_authoring/generate_candidates.py` — Cerebras-driven scenario synthesizer (only domain-specific).

### 1.10 Cerebras + LLM wiring

- `plugins/plugin-openai/index.ts` — routes through `OPENAI_BASE_URL` / `OPENAI_API_KEY`. Cerebras = base URL `https://api.cerebras.ai/v1`.
- `scripts/run-eliza-cerebras.ts` — sets all model tiers to `gpt-oss-120b` (overridable via `CEREBRAS_MODEL`).
- `packages/core/src/runtime/cost-table.ts` — `gpt-oss-120b` already registered.
- `packages/benchmarks/compactbench/eliza_compactbench/cerebras_provider.py` — Python provider wrapper.
- `plugins/plugin-openai/__tests__/cerebras-config.live.test.ts` — live verify.

### 1.11 Mockoon + Playwright

- `test/mocks/mockoon/*.json` — 22 services already mocked (Stripe-shaped `payments.json`, `cerebras.json`, Discord, Telegram, WhatsApp, etc.). Generator: `test/mocks/mockoon/_generate.mjs`. Spinner: `test/mocks/scripts/start-mocks.ts`.
- Playwright: `packages/app-core/playwright.config.ts` (UI smoke), `cloud/playwright.config.ts` (cloud auth/dashboard), `packages/app/playwright.*.config.ts`.

---

## 2. Architecture gaps — what is broken or missing

### 2.1 Identity and authorization

- **`areEntitiesLinked` is a stub.** `cloud/packages/lib/services/sensitive-request-authorization.ts` defines the adapter interface but the default cloud adapter is a no-op. No actual identity-link store. Linked-identity authorization scenarios cannot pass end-to-end today.
- **No identity-verification gate primitive on Telegram/WhatsApp/X.** Sensitive-request handlers have hooks for these connectors only stubbed.
- **No per-request callback token for local-mode tunnel callbacks.** `packages/app-core/src/api/sensitive-request-routes.ts` validates a single shared `AGENT_SERVER_SHARED_SECRET` rather than a per-request HMAC bound to the request id.

### 2.2 OAuth credential capture

- **No REQUEST_OAUTH action.** `kind="oauth"` is in the cloud schema, the binding helper exists, but no core action triggers an OAuth dance, no callback bus delivers the resulting token to a waiting agent, no atomic "BIND_OAUTH_CREDENTIAL" persists token + identity link.
- Vendor OAuth client IDs/secrets (Linear, Shopify, Calendly, LinkedIn) are missing from local env. See `cloud/packages/docs/full-real-e2e-missing-api-keys.md`.

### 2.3 Payment context model is inconsistent

- **App-charge has `payment_context`.** **x402 does not — it is implicitly `any_payer`.** **Crypto/OxaPay does not — implicitly `any_payer`.** **Stripe surface has none.**
- No unified `PaymentContext` type used across all payment surfaces. `packages/core/src/types/payment.ts` defines `PaymentConfigDefinition` only for x402.

### 2.4 Callbacks are fragmented

- App-charge has unified callback dispatch (HTTP + Discord DM). x402 has none — settlement is fire-and-forget on-chain. Crypto/OxaPay webhook does not auto-fire a notify callback to the agent. **There is no PaymentCallbackBus that notifies the originating agent/runtime/channel for all payment kinds uniformly.**

### 2.5 Stripe / credit card

- Hosted Checkout missing. Payment Links missing. Stripe webhook handler (`/api/stripe/webhook`) absent. Customer portal absent. Subscription billing absent. No agent action to create a Stripe one-time charge.

### 2.6 Tunnel for local-mode payments

- A local-only agent cannot issue a payment link. There is no `POST /api/payment-requests` route on `packages/app-core` that creates a tunnel-served payment page. The cloud is a hard dependency for any payment surface today.

### 2.7 Monolithic actions (where the LLM should be planning, but cannot)

These violate atomicity in a way the LLM should care about — i.e. independent capabilities buried inside one handler:

1. **`MANAGE_SECRET`** (`packages/core/src/features/secrets/actions/manage-secret.ts`) bundles `get | set | delete | list | check` with hidden masking + level resolution + validation. Should split into atomic `GET_SECRET`, `DELETE_SECRET`, `LIST_SECRETS`, `CHECK_SECRET`. SET_SECRET stays separate.
2. **`REQUEST_SECRET`** (`packages/core/src/features/secrets/actions/request-secret.ts`) hides delivery-mode selection. The LLM should be able to pick `DELIVER_VIA_DM`, `DELIVER_VIA_OWNER_APP_INLINE`, `DELIVER_VIA_CLOUD_LINK`, `DELIVER_VIA_TUNNEL_LINK`, or fall back to `INSTRUCT_DM_ONLY`. Today the action picks one and emits text only.
3. **x402 `payment-wrapper`** (`plugins/plugin-x402/src/payment-wrapper.ts`) is opaque middleware. Verification strategy + settlement + replay-guard are baked in. Should expose `INITIATE_PAYMENT_REQUEST`, `VERIFY_PAYMENT_VIA_*`, `SETTLE_PAYMENT` as atomic primitives the planner can compose.

What is NOT a violation, per AGENTS.md: a single action with a `subaction` parameter is fine when the subactions are conceptually one capability with a target/adapter dispatch (e.g. one BROWSER action that targets registered browser drivers). The MANAGE_SECRET case fails this test because get/set/delete/list/check are independent capabilities.

### 2.8 Missing atomic primitives

By scenario:

- **Plugin configuration:** `PROBE_PLUGIN_CONFIG_REQUIREMENTS`, `DELIVER_PLUGIN_CONFIG_FORM`, `POLL_PLUGIN_CONFIG_STATUS`, `ACTIVATE_PLUGIN_IF_READY`.
- **Sub-agent build needs API key:** `DECLARE_SUB_AGENT_CREDENTIAL_SCOPE`, `TUNNEL_CREDENTIAL_TO_CHILD_SESSION`, `AWAIT_CHILD_AGENT_COMPLETION`.
- **Approve a login:** `REQUEST_IDENTITY_VERIFICATION`, `AWAIT_APPROVAL`, `VERIFY_APPROVAL_SIGNATURE`, `BIND_IDENTITY_TO_SESSION`.
- **OAuth account connection:** `CREATE_OAUTH_INTENT`, `DELIVER_OAUTH_LINK`, `AWAIT_OAUTH_CALLBACK`, `BIND_OAUTH_CREDENTIAL`.
- **Secret voting:** `COLLECT_SECRET_BALLOT`, `TALLY_SECRETS_ON_THRESHOLD`, `EXPIRE_BALLOT`.
- **Public payment any-payer:** `REQUEST_PUBLIC_PAYMENT`, separate from `REQUEST_VERIFIED_PAYMENT` and `REQUEST_SPECIFIC_PAYER_PAYMENT`.
- **DM-only enforcement:** composable `REQUIRE_PRIVATE_CHANNEL` gate.
- **Async waits:** `AWAIT_PAYMENT_CALLBACK`, `AWAIT_SENSITIVE_SUBMISSION`, `AWAIT_OAUTH_CALLBACK` — backed by a real callback bus, not polling.

### 2.9 Missing providers (planner context)

- `CHANNEL_PRIVACY_CLASS` — DM / owner_app_private / public.
- `USER_IDENTITY_VERIFICATION_STATUS` — which providers verified for the current user.
- `LINKED_IDENTITIES` — for routing across linked accounts.
- `OUTSTANDING_SENSITIVE_REQUESTS_THIS_CONVERSATION` — to prevent cascade.
- `OUTSTANDING_PAYMENT_REQUESTS_THIS_CONVERSATION`.
- `PLUGIN_CONFIGURATION_COMPLETENESS`.
- `SUB_AGENT_CREDENTIAL_SCOPE`.

### 2.10 Missing services (background)

- `SensitiveRequestExpirationSweeper`.
- `PaymentCallbackBus` (unified).
- `OAuthCallbackBus`.
- `IdentityVerificationGatekeeper`.
- `CredentialTunnelService` (parent ↔ child secret push).
- `TunnelHealthMonitor`.

### 2.11 Test / harness gaps

- **Goal-to-script generator is lifeops-only.** Need a generic synthesizer that emits scenario turns (user messages + expected actions + expected mock-state changes) from a free-form goal.
- **No dedicated test/dev message-injection route.** Scenario-runner uses `runtime.handleMemory` directly. We want a documented `POST /api/v1/test/message` that returns the structured action trace + any sensitive-request envelopes emitted, suitable for both Python and TS harnesses.
- **`judge.ts` model is coupled to agent model.** Need `--judge-provider cerebras --judge-model gpt-oss-120b` independent of the agent under test.
- **No Puppeteer/Playwright harness for hosted sensitive-request page or hosted payment page.** Cloud Playwright config covers auth/dashboard only. We need both the cloud-hosted variant (cloud.eliza.ai) and the tunnel-served variant (`packages/app-core` local route exposed via Tailscale/ngrok).
- **No assertion DSL for "mock-backend received this POST and DB-state changed to that."** Mockoon stores requests but exposes no query API. lifeops-bench's `state-hash` is closest.
- **No redaction-leak assertion.** No tooling captures all agent outputs across all channels in a scenario and asserts no secret value, raw OAuth token, or full payment-link token leaked into a public channel/transcript/log.

### 2.12 Coverage gaps in existing tests

- **0 unit tests** for `SET_SECRET` and `MANAGE_SECRET` action handlers.
- **0 tests** for `oauth/sensitive-request-binding.ts`.
- **0 tests** for `linked-identity` adapter beyond the stub interface.
- **0 plugin-x402 unit tests** (`plugins/plugin-x402` has no `.test.ts`).
- No end-to-end scenario across `REQUEST_SECRET → user submits via cloud page → callback → SET_SECRET stored → SECRETS_STATUS reflects it`.

---

## 3. Live-network keys missing for true E2E

Reference: `cloud/packages/docs/full-real-e2e-missing-api-keys.md`. Critical for the harness:

- `ELIZA_API_TOKEN` (local API token).
- One tunnel: Headscale set (`HEADSCALE_*`, `TUNNEL_PROXY_*`) **or** authenticated local Tailscale CLI **or** `NGROK_AUTH_TOKEN`.
- Callback URLs: `ELIZA_API_URL`, `OXAPAY_CALLBACK_URL`.
- Discord test target: `DISCORD_TEST_GUILD_ID`, `DISCORD_TEST_CHANNEL_ID`.
- Telegram: `TELEGRAM_TEST_CHAT_ID`.
- Twilio: `TWILIO_ACCOUNT_SID`/`AUTH_TOKEN`/`PHONE_NUMBER`/`PUBLIC_URL`.
- Slack: `SLACK_BOT_TOKEN`, `SLACK_TEST_CHANNEL_ID`.
- Vendor OAuth clients: Shopify, Calendly, LinkedIn, optionally Google test token.
- Steward platform/vault keys.
- Live LLM judge: **`CEREBRAS_API_KEY=csk-…` + `CEREBRAS_MODEL=gpt-oss-120b`** — required for the harness's user-script-generation and judging passes.

The first three groups are the hard blockers. The harness must skip-with-clear-reason when any are absent.

---

## 4. What this report does not cover

- It does not propose an implementation. See `2026-05-10-secrets-payments-e2e-implementation.md`.
- It does not specify benchmarks or harness shape. See `2026-05-10-secrets-payments-bench-and-harness.md`.
- It does not retest items the prior wave already verified (passing test counts are taken at face value from the audit subagents).
