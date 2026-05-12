# Sensitive Request Links Implementation Report

Status: Draft
Date: 2026-05-10

This report translates the PRD and gap report into the system that must exist
before the feature is complete.

## Target Architecture

The implementation must introduce one cross-cutting primitive:

```ts
SensitiveRequest
```

This is not a LifeOps task primitive. It is an interaction/security record.
LifeOps follow-ups about pending requests remain `ScheduledTask`s.

The sensitive request layer owns:

- request creation
- delivery policy
- link issuance
- submit authorization
- callback dispatch
- status query
- audit
- redaction

Domain-specific handlers own actual fulfillment:

- secrets handler writes to the core or cloud secrets store
- payment handler creates checkout and marks paid from provider callbacks
- OAuth handler starts provider auth and stores the connection
- private-info handler stores typed non-secret values

## Package Boundaries

### `packages/core`

Core owns the shared types and pure policy resolver because every runtime needs
the same decision matrix.

Add:

- `src/sensitive-request-policy.ts`
- exports from `src/index.ts`, `src/index.node.ts`, and browser/edge barrels if
  needed
- unit tests for every public/private/cloud/tunnel/payment context branch

Core secrets actions then consume this resolver:

- `REQUEST_SECRET` emits `content.secretRequest.delivery`
- public room responses stop asking for secret values in chat
- DM/private owner app responses produce private delivery instructions or
  inline descriptors

The existing `FormSchema`, `FormSession`, and `FormSubmission` types should
either be implemented behind the new sensitive request routes or retired. They
are currently misleading because they imply public/tunnel form support that
does not exist.

### `cloud`

Cloud owns hosted links and durable request records for cloud mode.

Add:

- `sensitive_requests` table
- `sensitive_request_events` table or audit extension
- `POST /api/v1/sensitive-requests`
- `GET /api/v1/sensitive-requests/:id`
- `POST /api/v1/sensitive-requests/:id/submit`
- `POST /api/v1/sensitive-requests/:id/cancel`
- `POST /api/v1/sensitive-requests/:id/expire`
- hosted page routes for secret/private-info form rendering
- OAuth request adapter that wraps existing OAuth initiate/callback
- callback dispatcher that emits the shared event payload

Use existing cloud services where possible:

- `cloud/packages/lib/services/secrets`
- OAuth provider registry and callbacks
- `app-charge-requests`
- `app-charge-callbacks`

### Payment Implementation

Extend app charge requests first because they already have the best shape.

Add:

```ts
type PaymentContext = "verified_payer" | "any_payer";
```

Persist it in app charge metadata. Include it in public charge detail and
callback payloads.

Rules:

- `verified_payer`: checkout route requires authenticated user and records
  payer user/org as today.
- `any_payer`: checkout route may allow anonymous checkout only if the charge
  settlement target does not require payer-owned credits or entitlements.

Important: the current app charge service credits the payer organization. That
means anonymous `any_payer` cannot be a one-line switch. It needs a settlement
target field such as:

```ts
type PaymentSettlementTarget =
  | { kind: "payer_credits" }
  | { kind: "creator_earnings" }
  | { kind: "agent_balance"; agentId: string };
```

Until settlement target exists, `any_payer` should be accepted in the policy
contract but rejected by cloud app-charge creation for flows that allocate
payer credits.

x402 request links need a separate pass:

- add signed callbacks or explicitly document that callbacks are not supported
- remove callback URLs and private integration metadata from public status
- add callback-channel parity if agent workflows need in-chat completion
- make middleware settlement failure blocking unless a route explicitly opts
  into best-effort settlement
- test duplicate payment/settlement events for idempotency

### Local/Tunnel Implementation

The tunnel service provides reachability only. It must not be used for secret
entry unless local auth is configured.

Add local runtime routes:

- `POST /api/sensitive-requests`
- `GET /api/sensitive-requests/:id`
- `POST /api/sensitive-requests/:id/submit`

Requirements:

- token/session auth for every submit
- CSRF for browser forms
- loopback-only creation unless authenticated
- no raw values in request status responses
- tunnel URL issuance only after route authorization checks pass

`ITunnelService.getStatus()` can be consumed by the policy resolver as an
environment input, but the resolver must also know whether the tunneled route
has auth.

Before using tunnel delivery in production, fix tunnel configuration drift:

- normalize `TUNNEL_USE_FUNNEL` and `TUNNEL_FUNNEL`
- hydrate ngrok region/subdomain registry settings into `NgrokService`
- add contract tests that a configured tunnel reports the URL and provider the
  policy resolver expects

### Messaging and DM Delivery

Public chat flow:

- Create the request.
- Attempt private DM delivery if connector supports it and owner identity is
  known.
- If DM delivery succeeds, public room gets "I sent a private request."
- If DM delivery fails but cloud authenticated link is allowed, public room gets
  a verified link.
- If neither is available, public room gets "Please DM me or open the owner app
  to continue."

Private chat flow:

- DM can show a private link.
- Direct collection in plain text should be avoided for secrets when a form
  route exists, because platform message history is still not a secret store.
- If no form route exists, existing `SET_SECRET` behavior remains a fallback,
  but this must be described as fallback only.

Owner app private chat:

- Render inline form descriptor from structured callback content.
- Submit directly to local/cloud sensitive request submit route.
- Chat history stores status only.

LifeOps delivery needs a production dispatcher before scheduled follow-ups can
be trusted:

- inject a `ScheduledTaskDispatcher` through runtime wiring
- resolve channel/target structurally from task fields
- evaluate LifeOps send policy before connector dispatch
- call `ChannelRegistry`/`ConnectorRegistry` send methods
- preserve typed `DispatchResult` through logs and task state
- either implement real `in_app`/`push` senders or stop advertising them as
  send-capable

### Identity and Authorization

The authorization layer must use a shared owner-linked-identity service.

Inputs:

- cloud session user id
- organization membership and role
- connector platform id from Discord/Telegram/etc.
- OAuth connection id
- LifeOps entity identities where applicable

Rules:

- Identity observation flows through existing entity merge mechanisms.
- Manual merges are audited.
- Sensitive request submit checks authorization against the request policy and
  linked identity graph.
- Public channel membership is never proof of owner identity.

### Callback/Event Implementation

Add a shared event payload:

- `secret.set`
- `payment.paid`
- `payment.failed`
- `oauth.connected`
- `private_info.submitted`
- `request.expired`
- `request.canceled`

Dispatch targets:

- local in-memory callback subscription
- cloud HTTP callback with HMAC signature
- room callback message with redacted visible text
- pending task continuation by `ScheduledTask` subject/request id

Raw values forbidden in callback payloads:

- secret value
- OAuth access token
- OAuth refresh token
- callback secret
- payment provider secret
- one-time submit token

### Data Model

Minimum cloud tables:

```sql
sensitive_requests(
  id uuid primary key,
  kind text not null,
  status text not null,
  organization_id uuid,
  agent_id text not null,
  owner_entity_id text,
  requester_entity_id text,
  source_room_id text,
  source_channel_type text,
  source_platform text,
  target jsonb not null,
  policy jsonb not null,
  delivery jsonb not null,
  callback jsonb not null,
  token_hash text,
  expires_at timestamp not null,
  fulfilled_at timestamp,
  created_at timestamp not null default now(),
  updated_at timestamp not null default now()
);

sensitive_request_audit_events(
  id uuid primary key,
  request_id uuid not null,
  organization_id uuid,
  actor_user_id uuid,
  actor_entity_id text,
  action text not null,
  outcome text not null,
  metadata jsonb not null default '{}',
  created_at timestamp not null default now()
);
```

Local runtime can initially store equivalent records in its existing local
state store, but the interface must match cloud.

### Test Requirements

Unit tests:

- policy resolver matrix
- `REQUEST_SECRET` public/DM/private app behavior
- secret callback redaction
- payment context validation
- app charge callback payload contains context and never callback secret
- x402 public status redacts callback/private fields
- x402 settlement failure does not run paid handlers by default

Integration tests:

- cloud secret request create, submit, audit, callback
- local no-tunnel fallback
- local tunnel with auth success
- local tunnel without auth refusal
- LifeOps scheduled-task dispatch reaches a real typed channel sender
- `in_app`/`push` channel capability matches implementation
- OAuth request state binds to expected owner/org
- payment verified payer requires auth
- payment any payer does not allocate payer credits unless settlement target
  supports anonymous payment

E2E/live tests:

- live LLM app-building agent asks for missing key, receives safe request,
  resumes after key set
- Discord public room asks for key and receives no secret field
- Discord DM sets key and public room only receives status
- payment link posted in public with verified context forces login
- payment link posted in public with any-payer context pays and callback lands
- security agent scans conversation memory, action traces, callback payloads,
  and logs for leaked secret material

## Incremental Shipping Plan

1. Shared policy and core action behavior.
2. Cloud sensitive request persistence and secret submit.
3. Cloud payment context on app charges.
4. Local request persistence and owner-app inline submit.
5. Tunnel link issuance gated by local auth.
6. OAuth request adapter.
7. LifeOps ScheduledTask follow-ups for pending request expiry/reminders.
8. Full e2e and security validation wave.

## Completion Definition

The feature is not complete until:

- every sensitive request has a persisted record and audit trail
- every generated link is tied to an explicit policy
- secret values are never normal chat content
- payment callbacks are deterministic and typed
- public-room behavior is tested against leaks
- local/no-cloud/no-tunnel fallback works
- cloud and tunnel flows pass the same contract tests
