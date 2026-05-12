---
title: Action primitives — secrets, payments, identity, sub-agent credentials
date: 2026-05-10
status: spec
related:
  - reports/2026-05-10-secrets-payments-e2e-research.md
  - plans/2026-05-10-secrets-payments-e2e-implementation.md
  - plans/2026-05-10-secrets-payments-bench-and-harness.md
---

# Action primitives — secrets, payments, identity, sub-agent credentials

This is the contract for the atomic primitives the planner needs to handle every secrets / payments / identity / OAuth / sub-agent-credential flow. It enumerates every action, provider, service, and event with inputs, outputs, side effects, and the policy gates that compose them.

It is intentionally narrow: each action does one capability. Composition happens in the planner. The dispatch layer (channel adapters, vault, payment providers, OAuth providers) is registry-driven so the surface stays small while supporting every channel/provider.

This complies with the AGENTS.md rule about polymorphism: an action with a `target` parameter that dispatches across registered providers (e.g. `DELIVER_SENSITIVE_LINK target=discord_dm`) is allowed. Actions that bundle independent capabilities behind a `subaction` switch (today's `MANAGE_SECRET`) are not.

---

## 1. Common types

```ts
type ChannelPrivacy = "dm" | "owner_app_private" | "public" | "api";

type SensitiveKind = "secret" | "payment" | "oauth" | "private_info" | "approval";

type ActorPolicy =
  | "owner_only"
  | "owner_or_linked_identity"
  | "verified_payer"
  | "specific_payer"
  | "any_payer"
  | "organization_admin"
  | "anyone";

type DeliveryTarget =
  | "dm"                         // any DM channel adapter (discord, telegram, slack, imessage, …)
  | "owner_app_inline"           // inline form rendered in the Eliza app private chat
  | "cloud_authenticated_link"   // cloud-hosted page, identity gated
  | "tunnel_authenticated_link"  // tunnel-served local page, identity gated
  | "public_link"                // any-payer / unauthenticated link
  | "instruct_dm_only";          // text instruction only — no link, no inline form

type SensitiveRequestId = string;
type PaymentRequestId   = string;
type OAuthIntentId      = string;
type ApprovalRequestId  = string;
```

Policy comes from `packages/core/src/sensitive-request-policy.ts` and is unchanged at the resolver level. What changes is that the planner can now compose primitives that *honor* the policy rather than calling one bundled action.

---

## 2. Sensitive-request primitives

### 2.1 `CREATE_SENSITIVE_REQUEST` (atomic)

- **Inputs:** `kind`, `key | label`, `reason`, optional `actorPolicy` override, optional `paymentContext`, optional `expiresInMs`, optional `validation` (regex, type), optional `linkedIdentityHint`.
- **Side effects:** Persists request to local store and (if cloud paired) cloud store. Emits `SensitiveRequestCreated`.
- **Returns:** `{ requestId, policy, eligibleDeliveryTargets[], expiresAt }`.
- **Decision NOT inside this action:** which delivery target to use. The planner picks next.

### 2.2 `DELIVER_SENSITIVE_LINK` (atomic, registry-dispatched)

- **Inputs:** `requestId`, `target: DeliveryTarget`, optional `targetChannelId` (for DM target dispatch).
- **Side effects:** Renders inline owner-app block, sends DM via the registered DM adapter, or returns a hosted URL (cloud or tunnel). Emits `SensitiveRequestDelivered`.
- **Returns:** `{ delivered: true, url?: string, channelId?: string, formRendered?: boolean, expiresAt }`.
- **Replaces:** the embedded delivery branch in today's `REQUEST_SECRET` handler.
- **Validation gate:** rejects if `target` not in `eligibleDeliveryTargets`. The planner cannot bypass policy.

### 2.3 `AWAIT_SENSITIVE_SUBMISSION` (atomic, async)

- **Inputs:** `requestId`, optional `timeoutMs`.
- **Side effects:** Subscribes to `SensitiveRequestSubmitted` on the bus.
- **Returns (on resolution):** `{ status: "submitted" | "expired" | "canceled", submittedAt?, actorIdentity?, redactedSummary? }`. Never returns the raw secret value to the planner; only the SET_* / BIND_* atom that consumes it sees raw value.

### 2.4 `CANCEL_SENSITIVE_REQUEST` / `EXPIRE_SENSITIVE_REQUEST`

- Atomic state transitions. Emit corresponding events.

### 2.5 `REDACT_FOR_PUBLIC` (helper, callable)

- **Inputs:** `payload: unknown`, `policy: ActorPolicy`, `audience: ChannelPrivacy`.
- **Returns:** redacted payload safe to render publicly. Used by every renderer that emits to non-DM channels.

---

## 3. Secret primitives

Replace today's monolithic `MANAGE_SECRET` with atomic actions:

| Action | Inputs | Side effects | Returns | Notes |
|---|---|---|---|---|
| `SET_SECRET` | `secrets[{ key, value, level, validation? }]` | Stores via `SecretsService` at scope. **DM-only gate enforced.** | `{ stored: string[] }` | Existing today, kept. |
| `GET_SECRET` | `key`, `level?`, `mask: boolean` | None | `{ value: string \| null, masked: boolean }` | New atomic action. |
| `LIST_SECRETS` | `level?`, `prefix?` | None | `{ keys: string[], metadata: Record<string, { setAt, lastUsedAt, ttl? }> }` | New atomic action. Never returns values. |
| `CHECK_SECRET` | `key[]`, `level?` | None | `{ present: boolean[], missing: string[] }` | New atomic action. Used by plugin-config probe. |
| `DELETE_SECRET` | `key`, `level?` | Removes from store. | `{ deleted: boolean }` | New atomic action. **DM-only gate.** |
| `MIRROR_SECRET_TO_VAULT` | `key`, `vaultName` | Mirrors to Steward vault if configured. | `{ mirrored: boolean }` | New, optional. |

Compatibility: `MANAGE_SECRET` remains as a thin facade that accepts a `subaction` and forwards to the corresponding atomic action — so old planners keep working — but new planning prefers the atomic actions. The facade returns the same shape as the dispatched atom.

---

## 4. Payment primitives (unified across x402 / Stripe / OxaPay / on-chain)

A unified `PaymentContext` type lives in `packages/core/src/types/payment.ts`:

```ts
type PaymentContext =
  | { kind: "any_payer" }
  | { kind: "verified_payer", scope: "owner" | "owner_or_linked_identity" }
  | { kind: "specific_payer", payerIdentityId: string };

type PaymentProvider = "x402" | "stripe" | "oxapay" | "wallet_native";
```

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `CREATE_PAYMENT_REQUEST` | `provider`, `amount`, `currency`, `paymentContext`, `reason`, optional `callbackUrl`, optional `expiresInMs` | Creates row in unified `payment_requests` table; provider-specific intent (x402 EIP-3009, Stripe Checkout/Payment Link, OxaPay invoice) | `{ paymentRequestId, eligibleDeliveryTargets[], hostedUrl?, expiresAt }` |
| `DELIVER_PAYMENT_LINK` | `paymentRequestId`, `target: DeliveryTarget`, optional `targetChannelId` | Same dispatch as `DELIVER_SENSITIVE_LINK` but for payment URL | `{ delivered, url?, channelId? }` |
| `VERIFY_PAYMENT_PAYLOAD` | `paymentRequestId`, `proof` (provider-specific blob) | Calls provider verifier (x402 facilitator, Stripe webhook signature, OxaPay webhook signature) | `{ valid: boolean, payerIdentity?: string, errors?: string[] }` |
| `SETTLE_PAYMENT` | `paymentRequestId`, `proof?`, `strategy?` | Marks settled, fires `PaymentSettled` on bus | `{ settled: boolean, txRef?: string, settledAt }` |
| `AWAIT_PAYMENT_CALLBACK` | `paymentRequestId`, optional `timeoutMs` | Subscribes to `PaymentSettled` for that id | `{ status: "settled" \| "failed" \| "expired", payerIdentity?, amountReceived?, txRef? }` |
| `CANCEL_PAYMENT_REQUEST` | `paymentRequestId` | State transition | `{ canceled: boolean }` |

This collapses the three parallel surfaces (app-charge, x402, crypto-payments) into one DB row + provider adapter pattern. Adapter code lives in `cloud/packages/lib/services/payment-adapters/{x402,stripe,oxapay,wallet-native}.ts`. Local-mode tunnel-served payment pages live at `packages/app-core/src/api/payment-routes.ts`.

`PaymentCallbackBus` is a service-level event bus. `AWAIT_PAYMENT_CALLBACK` subscribes via the bus rather than HTTP polling.

---

## 5. OAuth primitives

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `CREATE_OAUTH_INTENT` | `provider`, `scopes[]`, `linkToUserIdentityId`, optional `expiresInMs` | Creates `oauth_intents` row, provider-specific PKCE/state, stored binding via `oauth/sensitive-request-binding.ts` | `{ intentId, authUrl, eligibleDeliveryTargets[], expiresAt }` |
| `DELIVER_OAUTH_LINK` | `intentId`, `target`, optional `targetChannelId` | Same dispatch pattern | `{ delivered, url?, channelId? }` |
| `AWAIT_OAUTH_CALLBACK` | `intentId`, optional `timeoutMs` | Subscribes to `OAuthCallbackReceived` on `OAuthCallbackBus` | `{ status: "bound" \| "denied" \| "expired", connectorIdentityId?, scopesGranted? }` |
| `BIND_OAUTH_CREDENTIAL` | `intentId`, `tokenSet` (received by callback handler internally) | Persists token in vault, links to identity, fires `OAuthBound` | `{ bound: true, connectorIdentityId }` |
| `REVOKE_OAUTH_CREDENTIAL` | `connectorIdentityId` | Calls provider revoke, deletes token | `{ revoked: boolean }` |

`OAuthCallbackBus` is a service. The cloud route `/api/v1/oauth/callback/[provider]` and the local tunnel route `/api/oauth/callback/[provider]` both publish to it.

---

## 6. Identity / approval primitives

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `REQUEST_IDENTITY_VERIFICATION` | `userIdentityId`, `challenge`, optional `expiresInMs` | Creates approval row, emits via `DELIVER_APPROVAL_LINK` (separate call) | `{ approvalId, eligibleDeliveryTargets[], expiresAt }` |
| `DELIVER_APPROVAL_LINK` | `approvalId`, `target`, `targetChannelId?` | Same dispatch | `{ delivered, url?, channelId? }` |
| `AWAIT_APPROVAL` | `approvalId`, `timeoutMs?` | Subscribes to `ApprovalSubmitted` | `{ status, signature?, signerIdentityId? }` |
| `VERIFY_APPROVAL_SIGNATURE` | `approvalId`, `signature` | Validates against challenge | `{ valid: boolean }` |
| `BIND_IDENTITY_TO_SESSION` | `sessionId`, `identityId` | Locks session to identity | `{ bound: true }` |

---

## 7. Plugin-configuration primitives

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `PROBE_PLUGIN_CONFIG_REQUIREMENTS` | `pluginName` | None | `{ required: SecretRequirement[], optional: SecretRequirement[], present: string[], missing: string[] }` |
| `DELIVER_PLUGIN_CONFIG_FORM` | `pluginName`, `target`, `targetChannelId?` | Creates a sensitive-request bundle for all missing required keys, dispatches form | `{ requestIds: string[], delivered, url? }` |
| `POLL_PLUGIN_CONFIG_STATUS` | `pluginName` | None | `{ ready: boolean, missing: string[] }` |
| `ACTIVATE_PLUGIN_IF_READY` | `pluginName` | If ready: registers plugin into the live runtime, fires `PluginActivated`. | `{ activated: boolean, missing?: string[] }` |

These compose: planner → `PROBE` → if missing → `CREATE_SENSITIVE_REQUEST` for each → `DELIVER_PLUGIN_CONFIG_FORM` → `AWAIT_SENSITIVE_SUBMISSION` for each → `POLL_PLUGIN_CONFIG_STATUS` → `ACTIVATE_PLUGIN_IF_READY`.

`SecretRequirement` lives in `packages/core/src/validation/secrets.ts` and is sourced from each plugin's manifest (e.g. `packages/app-core/src/registry/entries/plugins/*.json` already declares required secrets — this primitive consumes that).

---

## 8. Sub-agent credential primitives

For a parent agent to securely give a spawned coding sub-agent (Claude Code, Codex, OpenCode) a missing API key during a build:

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `DECLARE_SUB_AGENT_CREDENTIAL_SCOPE` | `childSessionId`, `credentialKeys: string[]` | Records scope in `coding_agent_credential_scopes` table, returns scoped one-time token | `{ credentialScopeId, scopedToken, expiresAt }` |
| `TUNNEL_CREDENTIAL_TO_CHILD_SESSION` | `childSessionId`, `credentialScopeId`, `key`, `value` | Pushes secret into the child PTY's runtime env via the orchestrator's existing IPC, encrypted with the scoped token | `{ tunneled: true }` |
| `AWAIT_CHILD_AGENT_DECISION` | `childSessionId`, optional decision-marker filter | Subscribes to the existing DECISION channel on stdout | `{ decision, payload }` |
| `RETRIEVE_CHILD_AGENT_RESULTS` | `childSessionId` | Reads structured results | `{ status, artifacts[] }` |

The bridge route `plugins/plugin-agent-orchestrator/src/api/bridge-routes.ts` gains a single new authenticated POST: `/api/coding-agents/<sessionId>/credentials/request` that creates a `SensitiveRequest` of `kind="secret"` with `actorPolicy="owner_only"` and `target="dm"` or `owner_app_inline`. The child polls a result endpoint scoped by the one-time token.

---

## 9. Secret-voting primitives (M-of-N)

| Action | Inputs | Side effects | Returns |
|---|---|---|---|
| `CREATE_SECRET_BALLOT` | `participants: identityId[]`, `threshold: number`, `purpose`, `expiresInMs` | Creates `secret_ballots` row | `{ ballotId }` |
| `DISTRIBUTE_BALLOT` | `ballotId`, optional `target=dm` (default) | Sends per-participant DM with one-time scoped sensitive-request | `{ distributed: number }` |
| `SUBMIT_BALLOT_VOTE` | `ballotId`, `participantToken`, `value` | Records vote (ciphertext or commitment) | `{ recorded: true }` |
| `TALLY_BALLOT_IF_THRESHOLD_MET` | `ballotId` | Decrypts/aggregates if `≥ threshold` votes; emits `BallotResolved` otherwise no-op | `{ resolved: boolean, result?, votes_received }` |
| `EXPIRE_BALLOT` | `ballotId` | State transition + cleanup | `{ expired }` |

Threshold cryptography is out of scope for v1 — v1 is "majority of plaintext votes counted server-side." v2 can plug in Shamir secret sharing.

---

## 10. Composable gates

Used by the planner as preconditions on any of the above:

| Gate | Behavior |
|---|---|
| `REQUIRE_PRIVATE_CHANNEL` | Throws `ChannelNotPrivateError` unless `CHANNEL_PRIVACY_CLASS == "dm"` or `"owner_app_private"`. |
| `REQUIRE_OWNER_APP_PRIVATE` | Stricter: `"owner_app_private"` only. |
| `REQUIRE_AUTHENTICATED_LINK` | Forces `target ∈ {cloud_authenticated_link, tunnel_authenticated_link, dm, owner_app_inline}`. |
| `REQUIRE_VERIFIED_PAYER` | Used inside payment composition. |

These are not actions — they are validators called inside the dispatch layer of the actions above. A planner that targets a non-private channel for a DM-only secret simply gets a structured error back and can recover by routing to `dm` or `owner_app_inline`.

---

## 11. Providers (planner context)

Each provider is small and registered at position −10 like `secrets-status`:

| Provider | Returns |
|---|---|
| `CHANNEL_PRIVACY_CLASS` | `"dm" \| "owner_app_private" \| "public" \| "api"` plus the originating `channelId` |
| `USER_IDENTITY_VERIFICATION_STATUS` | `{ verified: ProviderId[], unverified: ProviderId[] }` |
| `LINKED_IDENTITIES` | `{ identities: { providerId, externalId, displayName }[] }` |
| `OUTSTANDING_SENSITIVE_REQUESTS` | `{ requests: { id, kind, status, expiresAt }[] }` for the current conversation |
| `OUTSTANDING_PAYMENT_REQUESTS` | same shape, for payments |
| `PLUGIN_CONFIGURATION_COMPLETENESS` | `{ plugins: { name, ready, missing[] }[] }` |
| `SUB_AGENT_CREDENTIAL_SCOPE` | `{ childSessionId, scope }` when a child is awaiting credentials |

---

## 12. Services (background)

| Service | Responsibility |
|---|---|
| `SensitiveRequestExpirationSweeper` | Expires past-TTL requests, fires `SensitiveRequestExpired`. |
| `PaymentCallbackBus` | Provider-agnostic event bus for `PaymentSettled` / `PaymentFailed`. |
| `OAuthCallbackBus` | Same shape for `OAuthCallbackReceived`. |
| `IdentityVerificationGatekeeper` | Validates approvals, signatures, identity-link queries; backs `areEntitiesLinked`. |
| `CredentialTunnelService` | Parent → child credential push for spawned sub-agents. |
| `TunnelHealthMonitor` | Tracks tunnel availability / RTT to inform `eligibleDeliveryTargets`. |

---

## 13. Events (canonical bus messages)

`SensitiveRequestCreated`, `SensitiveRequestDelivered`, `SensitiveRequestSubmitted`, `SensitiveRequestExpired`, `SensitiveRequestCanceled`,
`PaymentRequestCreated`, `PaymentRequestDelivered`, `PaymentSettled`, `PaymentFailed`, `PaymentExpired`,
`OAuthIntentCreated`, `OAuthCallbackReceived`, `OAuthBound`, `OAuthRevoked`,
`ApprovalRequested`, `ApprovalSubmitted`, `ApprovalExpired`,
`PluginActivated`, `PluginConfigChanged`,
`BallotCreated`, `BallotVoteRecorded`, `BallotResolved`, `BallotExpired`.

All events carry `redactedPayload` for audit logs and a separate restricted `secretPayload` only consumable by the BIND_/SET_/SETTLE_ atoms.

---

## 14. Compatibility and migration

- `MANAGE_SECRET` becomes a thin facade. `REQUEST_SECRET` becomes a thin facade that internally calls `CREATE_SENSITIVE_REQUEST` and (for backwards compat) auto-calls `DELIVER_SENSITIVE_LINK` with the policy-resolved target. Old planners keep working.
- App-charge / x402 / crypto-payments routes keep existing shapes, but the cloud service layer is rewritten on top of the unified `payment_requests` table. Provider columns persist.
- Cloud DB migration: `0116_add_payment_requests.sql`, `0117_add_oauth_intents.sql`, `0118_add_approval_requests.sql`, `0119_add_secret_ballots.sql`, `0120_add_coding_agent_credential_scopes.sql`.
- All new actions ship with their own unit tests + an integration test against a Mockoon-mocked provider per the harness plan.

---

## 15. What this spec deliberately does not include

- No new payment provider beyond Stripe/OxaPay/x402/wallet_native in v1.
- No threshold-cryptography ballots in v1.
- No new connectors beyond what the existing dispatch registry already supports.
- No UI redesign beyond hosted pages already in `cloud/apps/frontend/src/pages/{sensitive-requests,payment}` and the inline owner-app form already in `packages/ui/src/components/chat/MessageContent.tsx`.
