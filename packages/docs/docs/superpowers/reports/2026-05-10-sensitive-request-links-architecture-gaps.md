# Sensitive Request Links Architecture Gap Report

Status: Draft
Date: 2026-05-10

This report is intentionally direct. The current architecture has useful
pieces, but it does not yet provide a safe, coherent product for agent-issued
secret, payment, OAuth, and private-info requests.

## Executive Summary

The repository currently has four disconnected systems:

- Core runtime secrets actions and storage.
- Cloud secrets storage and OAuth token storage.
- Cloud app charge/payment URLs and callback dispatch.
- Tunnel services and messaging connectors.

None of them owns the actual product primitive the user is asking for: a
typed, auditable, environment-aware sensitive request that decides whether a
link can be public, whether identity verification is mandatory, where the
input is collected, and how the agent resumes after completion.

As a result, the current architecture cannot reliably answer basic security
questions:

- Who is allowed to satisfy this request?
- Is this a private secret, non-secret private info, OAuth connection, or
  payment?
- Is a public link safe here?
- If someone else pays, is that acceptable?
- Which identity verified the request?
- Where is the completion callback recorded?
- Did the raw secret ever enter chat memory or an LLM prompt?

Until those questions have one shared contract, every caller will make local,
inconsistent decisions.

## What Exists

### Core Secrets

Core has `SecretsService` at `packages/core/src/features/secrets/services`.
It supports global, world, and user scoped secrets with encryption,
validation, access logs, and callbacks. Actions exist for:

- `SET_SECRET`
- `MANAGE_SECRET`
- `REQUEST_SECRET`
- `SECRETS_UPDATE_SETTINGS`

The good part: `SET_SECRET` and `MANAGE_SECRET` refuse non-DM channels.

The bad part: `REQUEST_SECRET` still tells the owner to provide the secret by
chat command. It has no route planner, no cloud/tunnel awareness, no owner app
inline form descriptor, and no pending request record.

There are `FormSchema`, `FormSession`, and `FormSubmission` types with
`publicUrl` and `tunnelId`, but they are only types. There is no token issuer,
submission route, TTL/replay guard, tunnel binding, cloud binding, or audit
implementation behind them.

### Cloud Secrets

Cloud has an organization/project/environment secrets table, encryption, audit
logs, OAuth storage integration, and service helpers. This is a real secret
store. It is not exposed as a user-facing request-link system.

The bad part: there is no "secret collection request" table, token lifecycle,
hosted form, submit endpoint, owner verification policy, or callback bridge
from cloud secrets back to the local blocked agent.

### Payments

Cloud app charge requests already create reusable payment URLs and support
callbacks through `app-charge-callbacks`. That is the strongest existing
surface.

The bad part: payer identity semantics are implicit. Checkout currently goes
through authenticated user/API-key paths, which is compatible with verified
payer but incompatible with "I do not care who pays." There is no explicit
`paymentContext`, no public-any-payer route, no policy that prevents a verified
payment URL from being posted unauthenticated in a public room, and no shared
callback event contract with secrets/OAuth/private info.

x402 durable requests are another payment flow, separate from app charges.
They have public status/settle routes, but they do not share app-charge callback
signing or callback-channel semantics. Their public view needs stricter
redaction, especially for callback URLs and private integration metadata.

### OAuth

Cloud has OAuth initiate/callback routes and adapters. OAuth state and
connection persistence are real.

The bad part: OAuth is not a `SensitiveRequest`. It cannot be requested through
the same product surface, cannot share a callback model, and cannot contribute
to the same owner-linked-identity decision used by secrets and payments.

### Tunnels

Core has an `ITunnelService` contract with active URL status. App registry
entries exist for tunnel, ngrok, and tailscale.

The bad part: no sensitive request code consumes the tunnel contract. More
importantly, a tunnel URL is not an auth policy. Exposing a local form through
ngrok or Tailscale does not make it safe. The architecture needs an explicit
auth boundary before tunnel links can be used for secrets.

### LifeOps and Connectors

LifeOps has strong rules around `ScheduledTask`, typed connectors/channels,
send policy, entity/relationship identity, and owner-visible state. These are
good foundations.

The bad part: sensitive requests are cross-cutting and currently live outside
that model. Follow-ups on pending requests should be `ScheduledTask`s, but the
request itself needs a typed record consumed by core, cloud, local runtime,
and UI.

LifeOps connector and channel contracts already use `DispatchResult`, and
private DM-capable channels exist for Discord, Telegram, Signal, WhatsApp,
iMessage, X DM, Twilio, and Gmail. However, the scheduled task runner still
defaults to a noop dispatcher. The runtime wiring validates channel keys but
does not yet inject a production dispatcher that evaluates send policy and
calls the channel/connector registry.

The default channel pack advertises `in_app` and `push` as send-capable, but
those entries do not provide connector-backed `send()` functions. That is a
sharp edge for any feature that assumes "channel says send=true" means a
message can actually be delivered.

## Critical Missing Pieces

### 1. No Sensitive Request Primitive

There is no persistent record that binds:

- agent id
- organization id
- requester identity
- source room and channel type
- target key/provider/payment
- delivery decision
- actor policy
- callback target
- expiration
- audit trail

Without this record, every flow is one-off and unreviewable.

### 2. No Policy Engine

Current code has local guardrails such as "secrets only in DMs." That is not
enough. The product requires a matrix:

- public vs DM vs owner app
- cloud vs tunnel vs no data plane
- verified actor vs any payer
- secret vs private info vs OAuth vs payment

There is no shared function that takes those facts and returns a delivery plan.

### 3. `REQUEST_SECRET` Is Actively Unsafe UX

`REQUEST_SECRET` does not accept secrets outside DMs, but its response still
teaches users to paste a secret into chat. That is the wrong mental model. It
should produce an owner-only inline form, a private DM route, a verified link,
or a fallback instruction. It should never normalize "put the key in a chat
message" as the primary path.

### 4. Public Payment Semantics Are Not Modeled

The user explicitly needs:

- "verify this payer is who they say they are"
- "I do not care who pays this; just pay me"

Current app charges do not express that. If a future caller posts payment URLs
in public without a policy, someone will eventually attach entitlements,
credits, invoices, or callbacks to the wrong identity.

### 5. Tunnel Is Treated as Connectivity, Not Security

The repo has a tunnel service, but no route says "this tunnel endpoint is safe
for secret entry because it also enforces owner auth." A tunnel without auth is
just a public door to local state. The architecture must separate reachability
from authorization.

### 6. Linked Identity Is Not a Shared Authorization Input

The entity/relationship graph can observe identities, and cloud OAuth has
connections, but sensitive request authorization does not consume a unified
linked-identity graph. That means Discord, cloud login, GitHub OAuth, and local
owner app sessions cannot yet answer "same owner?" consistently.

Entity resolution also has `safeToSend` concepts that are identity-oriented,
not channel-availability-aware. A verified Discord identity is not enough if
the Discord connector is disconnected or cannot DM that user.

### 7. No Unified Callback Semantics

Cloud app charges have callbacks. Core secrets have change callbacks. OAuth has
callback routes. These are different layers with different payloads and audit
semantics. The agent needs one typed completion event stream so blocked
workflows can resume deterministically.

### 8. No Leak Test Suite

There are no end-to-end tests that prove:

- A secret requested in public never enters public chat.
- A submitted secret never enters LLM context.
- A payment link in public cannot grant verified-payer entitlements to the
  wrong account.
- A tunnel secret form refuses unauthenticated submit.
- Callback payloads redact secrets and tokens.

The absence of these tests is not a small gap. It is a product-blocking gap for
this feature.

### 9. Parallel Secret Stores

Core `SecretsService`, app-core `@elizaos/vault`, cloud organization secrets,
onboarding config writes, and provider-switch vault writes are parallel paths.
A sensitive request submission needs an explicit sink and mirroring rule.
Without that, "the agent has the secret" will mean different things in local
app, cloud app, plugin activation, and runtime provider resolution.

### 10. Tunnel Configuration Drift

The tunnel ecosystem is not clean enough to be a security-sensitive dependency
yet. The registry and implementation appear to disagree on at least
`TUNNEL_USE_FUNNEL` vs `TUNNEL_FUNNEL`, and ngrok region/subdomain registry
settings do not appear to hydrate into the ngrok service. That is tolerable for
best-effort developer connectivity, but not for a security product that must
make exact delivery decisions.

## Why Current Architecture Will Not Get There By Incremental UI Alone

Adding a modal or a button is insufficient because the problem is not a UI
problem. It is a policy, identity, delivery, persistence, callback, and audit
problem.

If implementation starts in the chat UI:

- Public and private contexts will diverge.
- Cloud and local runtime will diverge.
- Payment and secret semantics will diverge.
- OAuth will keep using separate state machinery.
- Tunnels will be used as if they are secure by default.

If implementation starts only in cloud:

- Local/no-cloud mode remains broken.
- DM fallback remains untyped.
- Local app inline entry remains unimplemented.
- Runtime actions still cannot plan safe delivery.

If implementation starts only in core:

- Hosted links cannot submit anywhere durable.
- Payment checkout cannot express payer policy.
- Cloud OAuth cannot be incorporated.

The correct starting point is a shared contract and policy engine, followed by
cloud/local implementations that conform to it.

## Security Failure Modes To Expect If We Ship Without This

- A user pastes an API key in a Discord server because the agent asked for it
  in conversational text.
- A public payment URL grants credits or app access to the wrong cloud account.
- A public tunnel URL exposes a local secret form without owner auth.
- OAuth callback state links the wrong provider account to the wrong agent or
  organization.
- A raw secret appears in memory because a direct chat collection path treats
  the user reply as a normal message.
- Onboarding/provider context leaks a raw secret while trying to help the user
  set more secrets.
- URL validation for secret values becomes SSRF when fed user-controlled URLs.
- Payment callback metadata includes a callback secret or identity token.
- x402 public status leaks callback URLs or private metadata.
- Payment settlement failure still runs a paid handler.
- A linked identity bypasses the merge engine and becomes unauditable.
- A `ScheduledTask` follow-up appears to send but silently goes through the
  noop dispatcher.
- A channel marked send-capable drops a private link because no sender exists.
- A stale request link remains usable after the originating task has changed.

## Required Architectural Direction

1. Add `SensitiveRequest` as a cross-platform record and event contract.
2. Add a pure policy resolver that can be tested without cloud or UI.
3. Wire core actions to produce structured delivery plans.
4. Implement cloud request issuance and submission routes.
5. Implement local/tunnel request issuance only after local auth is enforced.
6. Extend app charges with explicit payment context.
7. Bridge OAuth into the same request/event contract.
8. Feed pending request status into agent context and LifeOps follow-ups through
   `ScheduledTask`, not a new task primitive.
9. Build leak-oriented tests before considering this production-ready.
