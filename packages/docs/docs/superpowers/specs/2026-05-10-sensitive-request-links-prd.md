# Sensitive Request Links PRD

Status: Draft
Date: 2026-05-10
Owner: elizaOS agent/runtime/cloud

## Problem

Agents need a safe way to ask users for sensitive inputs and money while they
are building apps, configuring connectors, running workflows, or operating in
public chat rooms. Today the system has fragments:

- Core secrets can be set only in DMs, but `REQUEST_SECRET` still instructs the
  owner to paste `set secret KEY value` into chat.
- Eliza Cloud has app charge payment URLs and callbacks, but payer identity
  semantics are implicit.
- OAuth connections exist in cloud, but are not modeled as one kind of
  sensitive request.
- Local tunnel plugins can expose local surfaces, but request generation does
  not choose between cloud, tunnel, DM, or in-app routes.

The product requirement is a single sensitive request primitive for:

- Secrets and configuration values.
- OAuth account connections.
- Payment links.
- Private non-secret information such as billing email, legal name, phone
  number, and app publishing metadata.

## Goals

1. An agent can request a sensitive value without receiving the value in a
   public room or logging it in normal conversation history.
2. A request has explicit security policy: who may satisfy it, whether identity
   verification is mandatory, whether any payer is acceptable, and how callbacks
   are delivered.
3. Delivery is environment-aware:
   - Cloud mode uses Eliza Cloud hosted links and cloud auth.
   - Local mode with a tunnel can use tunnel-hosted local links.
   - Local mode without a tunnel falls back to private DM or owner in-app entry.
4. The chat UI can render owner-only inline forms when the owner is already in a
   private app chat.
5. Public chat never receives secret entry fields. It receives at most a
   status/instruction message, and if a link is sent publicly it requires
   account verification.
6. Payment callbacks are guaranteed and auditable. The agent gets a typed
   event for paid, failed, canceled, and expired outcomes.
7. Secrets and private values have independent policies. Not every private
   value is a secret, and non-secret private info must still avoid the wrong
   audience.
8. Linked identities work across accounts. If the owner links Discord,
   Telegram, GitHub, and cloud account identities to the same owner entity, any
   verified linked account can satisfy a request allowed for that owner.

## Non-Goals

- Do not create a second LifeOps task primitive. Reminders to follow up on
  pending sensitive requests remain `ScheduledTask` records.
- Do not bypass the entity merge engine for identity linking.
- Do not put raw secrets in normal message text, action traces, LLM prompts,
  memory, analytics, or callback payloads.
- Do not treat "has a payment link" as "paid." Payment completion is callback
  and provider verified.

## Actors

- Request creator: the agent or tool creating the request.
- Owner: the human controlling the agent.
- Verified actor: an authenticated account linked to the owner entity or an
  authorized organization member.
- Any payer: a payer whose identity does not matter for the business outcome.
- Public room participant: anyone in a group/server/channel context.
- Cloud control plane: Eliza Cloud hosted APIs, auth, secrets, payments,
  OAuth, callbacks.
- Local runtime: desktop/local agent with optional tunnel plugin.

## Request Types

### Secret Request

Examples: `OPENAI_API_KEY`, `DATABASE_URL`, `DISCORD_BOT_TOKEN`.

Required behavior:

- Settable in owner DM, verified account link, or owner-only in-app chat.
- Public rooms get a private-route instruction or verified link only.
- Submitted value goes straight to the secrets store.
- Chat sees status only: missing, pending, set, failed validation, expired.
- The agent may subscribe to the secret change event and continue the blocked
  task after the secret is set.

### Payment Request

Examples: top up cloud credits, pay for a tunnel, purchase app access, pay a
human or app.

Required behavior:

- `paymentContext = verified_payer`: payer must authenticate or use a linked
  account. Used when the payer identity is part of authorization, entitlements,
  invoice ownership, or app credit allocation.
- `paymentContext = any_payer`: anyone may pay. Used when the only business
  outcome is that the request is funded.
- Callback required for paid, failed, canceled, and expired.
- Public rooms may receive a payment URL only if the context is `any_payer` or
  the URL forces login before checkout.

### OAuth Connection Request

Examples: connect GitHub, Google, X, Discord, Slack.

Required behavior:

- Always verified. The OAuth provider authenticates the account.
- Callback links the external account to the correct owner or organization.
- Public rooms may show a connect link only when the link includes state bound
  to the requester and verifies account identity on return.

### Private Info Request

Examples: billing email, legal name, phone number, app description.

Required behavior:

- Sensitive classification is independent from storage secrecy.
- Values may be stored as non-secret config or app metadata after collection.
- Public-room collection requires DM or verified account link.

## Delivery Matrix

| Context | Cloud available | Tunnel available | Required delivery |
| --- | --- | --- | --- |
| Owner in private app chat | any | any | Inline owner-only form; submit directly to local/cloud handler |
| DM/private platform chat | any | any | Private link or direct collection if platform supports secure input |
| Public room, verified actor required | yes | any | Authenticated cloud link plus public status |
| Public room, verified actor required | no | yes | Authenticated tunnel link if local auth is configured; otherwise DM instruction |
| Public room, any payer | yes | any | Cloud payment link may be public |
| Public room, any payer | no | yes | Tunnel payment link may be public if checkout does not expose local admin surface |
| Public room, secret | no | no | DM instruction or owner app instruction only |

## Request Record

The platform needs a persistent `SensitiveRequest` record:

```ts
interface SensitiveRequest {
  id: string;
  kind: "secret" | "payment" | "oauth" | "private_info";
  status: "pending" | "fulfilled" | "failed" | "canceled" | "expired";
  agentId: string;
  organizationId?: string;
  ownerEntityId?: string;
  requesterEntityId?: string;
  sourceRoomId?: string;
  sourceChannelType?: string;
  sourcePlatform?: string;
  target: SensitiveRequestTarget;
  policy: SensitiveRequestPolicy;
  delivery: SensitiveRequestDelivery;
  callback: SensitiveRequestCallback;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  audit: SensitiveRequestAuditEvent[];
}
```

`target` is type-specific. For secrets it includes key, scope, project/app
binding, validation strategy, and whether to mirror to local runtime. For
payments it includes amount, currency, provider preferences, payer policy, and
settlement target. For OAuth it includes provider, scopes, and return binding.

## Policy

```ts
type SensitiveRequestActorPolicy =
  | "owner_or_linked_identity"
  | "organization_admin"
  | "verified_payer"
  | "any_payer";

interface SensitiveRequestPolicy {
  actor: SensitiveRequestActorPolicy;
  requirePrivateDelivery: boolean;
  requireAuthenticatedLink: boolean;
  allowInlineOwnerAppEntry: boolean;
  allowPublicLink: boolean;
  allowDmFallback: boolean;
  allowTunnelLink: boolean;
  allowCloudLink: boolean;
}
```

Rules:

- Secret requests always require private delivery or authenticated link.
- Secret requests never allow public unauthenticated links.
- Payment requests with `any_payer` may allow public links.
- Payment requests with `verified_payer` must authenticate before checkout.
- OAuth requests always require authenticated provider callback.
- Public links must be single-use or scoped to a server-generated request id
  with a short expiry.

## Callback Contract

Every request type emits typed callback events:

```ts
type SensitiveRequestEvent =
  | { kind: "secret.set"; requestId: string; key: string; scope: string }
  | { kind: "payment.paid"; requestId: string; provider: string; amount: string }
  | { kind: "payment.failed"; requestId: string; provider: string; reason?: string }
  | { kind: "oauth.connected"; requestId: string; provider: string; connectionId: string }
  | { kind: "private_info.submitted"; requestId: string; fields: string[] }
  | { kind: "request.expired" | "request.canceled"; requestId: string };
```

Callback payloads must not include raw secret values or OAuth tokens. HTTP
callbacks must be HMAC signed. In-chat callbacks must write visible status only
and structured metadata that excludes secret values.

## UX Requirements

- The agent says what is needed and why, but does not ask the user to paste a
  secret into public chat.
- Public room text must be non-sensitive: "I sent a private setup request" or
  "Open the verified link to continue."
- Owner private app chat renders inline when possible and shows status after
  submission.
- DM fallback text is explicit when no cloud/tunnel exists: "Send this in a
  private chat with me or open the local app as the owner."
- Payment links label whether identity matters: "Pay as yourself" vs "Anyone
  can pay this."
- Expired requests give a clean retry path.

## Security Requirements

- No raw secrets in normal chat text, memory, analytics, logs, or LLM prompts.
- Verify request creator authorization before issuance.
- Verify submitter authorization before storing values or marking payment
  entitlement.
- Bind request state to agent, organization, owner entity, source channel, and
  target key/provider/payment.
- Enforce single-use tokens for secret/private info submissions.
- Enforce CSRF on browser form submission.
- Enforce rate limits by IP, account, request id, and organization.
- Audit create, view, submit, fulfill, fail, expire, cancel, and callback.
- Public-room request messages must not mention secret values, token prefixes,
  OAuth state, callback secrets, or raw request tokens.
- Local tunnel links must validate host, scheme, and target route to avoid
  turning a tunnel into a general admin surface.

## Acceptance Criteria

- `REQUEST_SECRET` from a public channel emits a structured request with
  `privateRouteRequired = true` and never instructs the user to paste the value
  in public.
- `REQUEST_SECRET` from a private app owner chat emits an inline form descriptor
  and stores only status in chat history.
- Secret submit through cloud stores the secret, fires a callback, and redacts
  the value in every persisted artifact.
- Secret submit through tunnel stores locally, fires a callback, and refuses
  if tunnel auth is not configured.
- No-tunnel local mode emits DM/app fallback instructions.
- App charge creation stores an explicit `paymentContext`.
- Public unauthenticated checkout is accepted only for `any_payer`.
- Verified payer checkout requires auth and records payer identity.
- App charge callback includes payment context and payer verification outcome.
- OAuth request links bind a provider connection to the correct owner or org.
- Live LLM/e2e/security validation demonstrates a blocked app-building agent
  requests a key, receives it through a safe route, resumes, and does not leak
  the key into public contexts.
