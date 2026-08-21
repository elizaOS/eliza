# Messaging Onboarding Gateway Technical Design

Status: design proposal

Provisioning authority updated: 2026-08-20

Owner boundary: this document is a docs-only design. It references existing
gateway, cloud, and plugin code but does not require implementation changes in
this patch.

## Problem

Eliza Cloud needs one messaging onboarding gateway that accepts first contact
from iMessage, Telegram, Discord, and WhatsApp, runs the same chat-first
onboarding flow, links the platform identity to an authenticated cloud identity,
observes an explicitly created user agent, copies the onboarding transcript
into that agent once it is running, and then routes later messages from the
same messaging identity to that agent.

The design must keep the onboarding worker stateless and deterministic and
preserve the gateway separation already present in the repo.

## Existing Surfaces

- `packages/cloud/services/gateway-webhook/src/index.ts` exposes shared webhook
  routes for `telegram`, `blooio`, `twilio`, and `whatsapp`, plus per-agent
  routes under `/webhook/:project/:platform/:agentId`.
- `packages/cloud/services/gateway-webhook/src/webhook-handler.ts` already
  implements the required high-level branch: verify webhook, extract event,
  dedupe, resolve identity, route linked users to agent-server, and route
  unlinked users to `/api/eliza-app/onboarding/chat`.
- `packages/cloud/services/gateway-webhook/src/adapters/types.ts` defines the
  current `PlatformAdapter`, `ChatEvent`, and `WebhookConfig` shape.
- `packages/cloud/services/gateway-webhook/src/adapters/telegram.ts` and
  `packages/cloud/services/gateway-webhook/src/adapters/whatsapp.ts` are the
  webhook adapter patterns for signed inbound DMs and outbound replies.
- `packages/cloud/services/gateway-webhook/src/adapters/blooio.ts` is the
  existing cloud iMessage-style adapter. It should be treated as the current
  hosted provider path, not as the Mac-hosted BlueBubbles path.
- `packages/cloud/services/gateway-discord/src/gateway-manager.ts` manages
  Discord WebSocket connections, leader election, failover, and message
  forwarding. Discord should remain a gateway service, not be forced through
  webhook-only code.
- `packages/cloud/shared/src/lib/services/agent-gateway-router.ts` contains
  post-link routing logic for Discord, Telegram, WhatsApp, Twilio, and Blooio,
  including room IDs, sender metadata, and sandbox/local-session dispatch.
- `packages/cloud/api/internal/identity/resolve/route.ts` is the internal
  identity lookup used by the webhook gateway.
- `packages/cloud/shared/src/lib/services/eliza-app/onboarding-chat.ts` is the
  current onboarding worker. It stores session state in cache, generates its
  short replies from a deterministic state machine, observes provisioning
  status without mutating compute, and copies the transcript to
  `/api/memory/remember` after the managed agent is running.
- `packages/cloud/shared/src/lib/services/eliza-app/provisioning.ts` is the
  observation-only status reader for Eliza App onboarding. It deterministically
  selects the authenticated user's newest eligible non-Shared, non-pool target
  and never creates, resumes, or enqueues compute.
- `GET /api/eliza-app/provisioning-agent` exposes that status. Its retained
  `POST` method is the same read-only operation for compatibility, not a
  provisioning command.
- `plugins/plugin-bluebubbles/src/setup-routes.ts` and
  `plugins/plugin-bluebubbles/src/data-routes.ts` document the local
  BlueBubbles setup contract and public webhook receiver used by an agent
  runtime.
- `plugins/plugin-bluebubbles/src/service.ts` maps BlueBubbles chats, handles
  incoming messages, and sends iMessage/SMS/RCS through the BlueBubbles bridge.
- `packages/cloud/services/headscale/README.md` and
  `packages/cloud/services/tunnel-proxy/README.md` define the current Headscale
  and tunnel-proxy tag model.
- Gateway smoke scenarios already cover linked-user routing in
  `packages/test/scenarios/gateway/telegram-gateway.bot-routes-to-user-agent.scenario.ts`,
  `packages/test/scenarios/gateway/discord-gateway.bot-routes-to-user-agent.scenario.ts`,
  and
  `packages/test/scenarios/gateway/whatsapp-gateway.bot-routes-to-user-agent.scenario.ts`.

## Implementation Gaps Blocking Launch

The current repo has the major gateway surfaces, but the launch plan is not
complete until these gaps are closed:

- Identity resolution must be consistent. Gateway reads resolve through
  `user_identities`; auth/link paths that still write only canonical `users`
  columns must also upsert the provider identity projection, or the resolver
  must fall back to canonical columns until projection sync is guaranteed.
- Explicit identity-link start/confirm routes are required before production
  binding. Messaging possession alone must not bind Telegram, Discord,
  WhatsApp, or phone/iMessage handles to an existing cloud account.
- Discord system-bot DMs need an unlinked-user fallback. If route resolution
  returns `handled:false` because the Discord identity is unknown, the cloud
  route should call the shared onboarding worker and return the onboarding
  reply to the gateway.
- Linked identities without an active `agentId` must route to
  onboarding/provisioning status rather than throwing in the gateway resolver.
- The Mac-hosted iMessage path now has an authenticated registration record,
  per-device hash-stored credential, deterministic agent binding, synchronous
  reply relay, and degraded/offline health state. Headscale node attestation is
  still a future hardening option if Cloud ever initiates connections to Macs;
  the current relay is outbound-only HTTPS and exposes no Mac port to Cloud.
- Transcript handoff needs an idempotency key and platform/session metadata so
  retries do not duplicate memory records and audits can identify the source
  channel.

## Goals

1. One onboarding conversation contract across all messaging platforms.
2. One identity linking model with explicit authentication before durable
   account binding.
3. One explicitly created user agent selected deterministically for status and
   handoff; onboarding status reads must not create or restart it.
4. One transcript handoff path from onboarding session to the user's real
   agent.
5. One post-handoff routing rule: linked platform identities bypass onboarding
   and route to the active user agent.
6. No long-lived conversational state inside gateway or onboarding worker
   processes.
7. No platform behavior driven by prompt text. Routing is structural.

## Non-Goals

- Replacing the existing agent-server message pipeline.
- Creating a second agent provisioning system.
- Creating a new identity store outside the users and linked identity model.
- Making cloud-hosted iMessage a default path for every user. Mac-hosted
  BlueBubbles is an advanced user-owned gateway.
- Importing LifeOps or health plugin internals.

## Architecture

```text
Messaging platform
  -> platform adapter or gateway service
  -> normalized ChatEvent
  -> identity resolver
     -> linked: agent-server / sandbox / local-session route
     -> unlinked: stateless onboarding worker
        -> authenticated identity link
        -> observe an explicitly created non-Shared target
        -> transcript handoff
        -> mark route ready
  -> platform reply
```

The gateway owns ingress, verification, dedupe, and reply delivery. Explicit
cloud lifecycle surfaces own provisioning; the onboarding worker owns status
observation and transcript handoff only. The worker must reconstruct all state
from durable/cache records on every call.

## Platform Ingress

### Telegram

Use the existing webhook adapter pattern in
`packages/cloud/services/gateway-webhook/src/adapters/telegram.ts`.

- Verify `x-telegram-bot-api-secret-token`.
- Accept private chats only.
- Normalize `senderId` to Telegram user ID and `chatId` to Telegram chat ID.
- For unlinked identities, call onboarding with:
  - `platform: "telegram"`
  - `platformUserId: senderId`
  - `platformDisplayName: first_name`
- Durable linking must happen through Telegram Login/OAuth or another
  Telegram-signed authentication payload before `telegram_id` is written.

### WhatsApp

Use the existing webhook adapter pattern in
`packages/cloud/services/gateway-webhook/src/adapters/whatsapp.ts`.

- Verify `x-hub-signature-256` with the configured app secret.
- Accept text messages from WhatsApp Cloud API webhooks.
- Normalize `senderId` and `chatId` to the WhatsApp ID/phone.
- WhatsApp is a phone-verified channel, but durable linking should still be
  explicit:
  - If the WhatsApp account already maps to a user, route to that user.
  - If not, onboarding may create a pending user record, but completing account
    linking must require a signed app session or a one-time link token.

### Discord

Keep Discord in `packages/cloud/services/gateway-discord/`.

- Discord uses persistent WebSocket bot connections, connection assignment,
  heartbeats, and failover; it should not be collapsed into webhook-only
  ingress.
- The Eliza App system bot should route unlinked DMs to the same onboarding
  endpoint used by webhook platforms.
- User-created managed Discord bot connections continue to use the existing
  connection assignment model.
- Durable account linking must use Discord OAuth2. A Discord DM alone proves
  control of a Discord account to the bot but should not silently bind that
  account to an existing cloud user without OAuth/session confirmation.

### iMessage With BlueBubbles, Mac, iPhone, And Headscale

The Mac-hosted iMessage path is separate from the existing hosted `blooio`
adapter.

Reference implementation surfaces:

- Local agent BlueBubbles setup and webhook routes:
  `plugins/plugin-bluebubbles/src/setup-routes.ts`
  and `plugins/plugin-bluebubbles/src/data-routes.ts`.
- Local BlueBubbles send/receive semantics:
  `plugins/plugin-bluebubbles/src/service.ts`.
- Headscale tunnel primitives:
  `packages/cloud/services/headscale/README.md`
  and `packages/cloud/services/tunnel-proxy/README.md`.

Implemented topology:

```text
User iPhone number / Apple ID
  -> user-owned Mac running BlueBubbles
  -> Eliza BlueBubbles relay on the Mac
  -> outbound HTTPS relay request
  -> cloud messaging gateway and the sender's linked Eliza agent
  -> reply in the same HTTPS response
  -> local relay sends through BlueBubbles/Messages
```

Requirements:

- The Mac is user-owned and makes outbound HTTPS requests; Cloud never opens a
  connection to the Mac or requires a public BlueBubbles port.
- BlueBubbles credentials remain on the Mac. Cloud stores the registering
  owner, routing mode, bridge ID, phone metadata, and only the SHA-256 digest
  of the per-device bearer credential. Sender-owned gateways do not pin an
  agent ID.
- The authenticated registration API returns the relay credential once. Each
  inbound request is authenticated against the registered bridge before its
  payload is routed, and message GUID dedupe prevents delivery replay.
- Cloud returns the resolved sender's agent reply in the inbound HTTP response. The
  local relay sends it through BlueBubbles/Messages and queues it on a bounded
  failure path; queued delivery is reported as degraded, not success.
- The spare iPhone is the carrier/SMS/iMessage phone-number anchor. The Mac
  BlueBubbles server provides the software bridge. The cloud must display this
  path as advanced self-hosted messaging, not as a managed SMS carrier product.

Normalized platform fields:

- `platform: "bluebubbles"` for the Mac-hosted path.
- `platform: "blooio"` remains the existing hosted/provider path.
- `senderId`: normalized phone/email handle from BlueBubbles.
- `chatId`: BlueBubbles chat GUID when available, otherwise deterministic
  direct room key.
- `messageId`: BlueBubbles message GUID.

Durable linking rules:

- A first iMessage from a phone/email handle can start onboarding but must not
  bind to an existing authenticated cloud account by message possession alone.
- Binding requires one of:
  - the user is already authenticated in Eliza Cloud and confirms the displayed
    iMessage handle;
  - a one-time link code generated in the app is sent from that iMessage
    handle;
  - the BlueBubbles gateway setup was initiated from an authenticated account
    and the relay attests the same organization and device registration.

## Stateless Onboarding Worker

The current worker is
`packages/cloud/shared/src/lib/services/eliza-app/onboarding-chat.ts`.

Design constraints:

- The worker process has no local durable state.
- Each request loads the onboarding session by `sessionId`, platform, and
  platform user ID from cache/durable storage.
- Replies are generated by the deterministic onboarding state machine; no
  model call participates in this worker.
- All decisions are structural:
  - authenticated user present or absent;
  - platform identity verified or pending;
  - provisioning status;
  - handoff copied or not;
  - route link active or not.
- No model decides whether an identity is linked, whether a provisioning job
  is complete, or where to route a post-handoff message.

Session fields should remain close to the existing `OnboardingSession` shape:

- `id`
- `platform`
- `platformUserId`
- `platformDisplayName`
- `userId`
- `organizationId`
- `agentId`
- `handoffCopiedAt`
- `launchUrl`
- `history`

Additional proposed fields:

- `identityLinkStatus: "none" | "pending" | "verified" | "linked"`
- `identityLinkId`
- `handoffRouteActivatedAt`
- `lastGatewayMessageId`
- `provisioningRequestId`

## Authenticated Identity Linking

The linking service should be explicit and idempotent.

Proposed internal contract:

```text
POST /api/eliza-app/identity-link/start
POST /api/eliza-app/identity-link/confirm
POST /api/internal/identity/resolve
```

`start` creates a pending link challenge for an authenticated cloud session or
for a trusted onboarding session. It returns a short code or OAuth URL.

`confirm` verifies the platform proof:

- Telegram: Telegram Login/OAuth signed payload.
- Discord: OAuth2 callback with state bound to the onboarding session.
- WhatsApp: Meta-verified webhook identity plus app session or one-time code.
- BlueBubbles/iMessage: registered relay attestation plus one-time code from
  the same handle, or authenticated setup confirmation.

Only `confirm` writes durable platform identifiers to the user record or linked
identity table. A gateway delivery can create or update a pending onboarding
session, but it must not silently merge identities across users.

After a successful link:

- invalidate `identity:${platform}:${platformId}` negative caches in the
  gateway;
- persist the linked `userId`, `organizationId`, and selected `agentId` in the
  onboarding session;
- return a platform-safe message telling the user they can keep chatting in the
  same thread.

## Provisioning Observation Boundary

Use `getElizaAppProvisioningStatus` in
`packages/cloud/shared/src/lib/services/eliza-app/provisioning.ts` as the
canonical onboarding read.

Rules:

- Scope candidates to the authenticated user inside the session organization.
- Exclude Shared rows, warm-pool rows, deleted rows, and rows in a deletion
  state.
- Select the newest remaining target by `created_at`, breaking equal-time ties
  by agent ID so repository return order cannot change the result.
- Keep error, disconnected, stopped, and sleeping targets observable; return
  `status: "none"` only when no eligible target exists.
- Repeated or concurrent reads, including the retained
  `POST /api/eliza-app/provisioning-agent` compatibility alias, must never
  create, resume, credit-gate, or enqueue compute.
- Present lifecycle state from the database, not from model output.

Messaging onboarding therefore adds neither a provisioning queue nor an
implicit provisioning trigger. A separate explicit lifecycle flow must create
or change the target before onboarding can observe it.

## Transcript Handoff

The existing handoff in `onboarding-chat.ts` is the right shape:

1. Wait until the explicitly managed target reports `running`.
2. Read its existing managed connection without launching or restarting it.
3. POST the normalized onboarding transcript to the agent's
   `/api/memory/remember`.
4. Set `handoffCopiedAt` on the onboarding session.

Refinements for gateway handoff:

- Use an idempotency key such as
  `handoff:${sessionId}:${agentId}:${transcriptHash}`.
- Store `handoffCopiedAt` only after a successful memory write.
- Include platform metadata in the transcript header:
  - platform;
  - platform display name;
  - verified identity link status;
  - original session ID;
  - first and last message timestamps.
- Avoid raw tokens, webhook payloads, relay secrets, or OAuth codes in the
  transcript.

## Post-Handoff Routing

Post-handoff routing is purely structural.

1. Gateway receives a message and extracts a normalized `ChatEvent`.
2. Gateway calls `/api/internal/identity/resolve` with platform and platform ID.
3. If no identity resolves, route to onboarding.
4. If identity resolves but no agent exists, route to onboarding/provisioning
   status.
5. If identity resolves and an agent exists, route to the active runtime:
   - webhook platforms use `resolveAgentServer` and `forwardToServer` in
     `packages/cloud/services/gateway-webhook/src/server-router.ts`;
   - Discord keeps its gateway-manager flow;
   - cloud shared router paths use
     `packages/cloud/shared/src/lib/services/agent-gateway-router.ts` for
     sandbox/local-session routing.
6. Gateway sends the agent response through the same platform adapter that
   accepted the message.

Negative identity cache entries must be short-lived and invalidated on link
confirmation. Otherwise the message immediately after linking may incorrectly
continue onboarding.

## Security And Compliance

### Webhook And Gateway Authentication

- Telegram: require constant-time comparison of Telegram secret token.
- WhatsApp: require HMAC verification with Meta app secret.
- Discord: gateway service authenticates to cloud with JWT acquired from
  `GATEWAY_BOOTSTRAP_SECRET`.
- Webhook gateway: service-to-service calls use internal auth as in
  `packages/cloud/services/gateway-webhook/src/auth.ts` and
  `packages/cloud/api/internal/_auth`.
- Agent-server forwarding uses `AGENT_SERVER_SHARED_SECRET` through
  `X-Server-Token`.
- BlueBubbles relay: require the per-device bearer credential over TLS and
  authenticate the bridge record before reading routing metadata. If a future
  Headscale/cloud-initiated transport is added, also require node authorization
  and request signatures; tailnet membership alone is not authenticity.

### Secret Handling

- Platform bot tokens, WhatsApp access tokens, BlueBubbles passwords, relay
  keys, OAuth client secrets, Headscale auth keys, and agent-server shared
  secrets must be encrypted at rest or kept in the relevant secret manager.
- Logs must redact:
  - Discord bot tokens;
  - WhatsApp access tokens;
  - Telegram bot tokens;
  - BlueBubbles passwords;
  - OAuth codes;
  - phone numbers except last four digits.
- Onboarding transcripts must exclude raw webhook payloads and credentials.

### PII And Retention

- Messaging handles, phone numbers, and profile names are PII.
- Store normalized platform identifiers only where needed for routing and
  account recovery.
- Onboarding session cache can retain short-term history for handoff, but the
  durable user agent memory becomes the long-term conversational copy after
  handoff.
- Provide deletion paths that remove linked platform identifiers, pending link
  challenges, onboarding sessions, and Mac relay registrations.

### iMessage Compliance

- The BlueBubbles path is a user-owned bridge. It must be documented as an
  advanced self-hosted configuration that depends on the user's Apple ID,
  Mac, and iPhone setup.
- The cloud service must not impersonate a carrier or centralize Apple account
  credentials.
- The current outbound-only HTTPS relay is scoped by its organization/agent
  registration. Any future Headscale transport must add organization ACLs that
  prevent cross-customer relay access.

### Abuse Controls

- Rate-limit onboarding messages per platform identity and per source IP.
- Rate-limit link challenge creation and confirmation attempts.
- Dedupe inbound webhook message IDs as the webhook gateway already does.
- Preserve durable message-GUID replay dedupe; add timestamped request
  signatures if the transport expands beyond the current TLS bearer contract.
- Require manual escalation for identity conflicts instead of auto-merging.

## API Contracts

### Normalized Inbound Message

```json
{
  "platform": "telegram",
  "messageId": "platform-message-id",
  "chatId": "platform-chat-id",
  "senderId": "platform-user-id",
  "senderName": "display name",
  "text": "message text",
  "mediaUrls": [],
  "rawPayloadRef": "optional-redacted-debug-reference"
}
```

### Onboarding Chat Request

```json
{
  "sessionId": "platform:telegram:123",
  "message": "hello",
  "platform": "telegram",
  "platformUserId": "123",
  "platformDisplayName": "Ada"
}
```

Internal gateway callers may include internal auth, which marks the delivery as
trusted for transport authenticity. Transport authenticity is not the same as
durable account linking.

### Identity Resolve Response

```json
{
  "success": true,
  "userId": "user-id",
  "organizationId": "org-id",
  "agentId": "agent-id",
  "data": {
    "user": { "id": "user-id", "organizationId": "org-id" },
    "agent": { "id": "agent-id", "status": "running" },
    "identity": { "telegramId": "123" }
  }
}
```

`agentId` should be nullable in the route response schema, but the gateway
should treat a missing `agentId` as an onboarding/provisioning condition, not
as an agent-server routing target.

## Failure Modes

- Webhook signature invalid: reject with 401.
- Unsupported platform: reject with 400.
- Duplicate message ID: acknowledge and skip.
- Identity not linked: route to onboarding.
- Identity linked but agent missing: route to onboarding/provisioning.
- Agent server scaled to zero: wake server and retry through existing
  `forwardWithRetry`.
- Provisioning job stuck: show structural provisioning status and rely on the
  existing provisioning recovery paths.
- Handoff copy fails: keep routing status as provisioning/running but leave
  `handoffCopiedAt` unset so the next onboarding turn retries.
- BlueBubbles relay offline: queue a bounded outbound retry and report degraded
  gateway status for that connection.

## Rollout Plan

1. Document the shared platform contract and identity-link states.
2. Add identity-link start/confirm routes and tests.
3. Done: do not negative-cache unknown phone identities, so authenticated
   linking takes effect on the next message.
4. Route Discord Eliza App bot unlinked DMs through onboarding, preserving the
   existing gateway-manager service.
5. Done: add Mac-hosted BlueBubbles relay registration with per-device
   credentials, sender-owned routing, and legacy fixed-agent compatibility.
6. Done: expose `bluebubbles` as a distinct public relay contract while
   retaining the existing `blooio` database enum as an internal compatibility
   detail.
7. Add transcript idempotency and platform metadata.
8. Expand gateway scenarios for unlinked onboarding, link confirmation,
   observation of an explicitly provisioned target, handoff, and post-handoff
   same-thread routing.

## Test Plan

- Unit tests for each adapter signature verifier and event extractor.
- Unit tests for identity-link challenge start/confirm and conflict handling.
- Unit tests for deterministic target selection and zero compute side effects
  under repeated or concurrent status requests.
- Unit tests for transcript handoff idempotency and secret redaction.
- Gateway scenario tests:
  - Telegram unlinked DM starts onboarding, OAuth link routes next DM to agent.
  - Discord system bot DM starts onboarding, OAuth link routes next DM to agent.
  - WhatsApp unlinked message starts onboarding, confirmed link routes next
    message to agent.
  - BlueBubbles relay message starts onboarding, code confirmation routes next
    iMessage to agent.
  - Linked users never re-enter onboarding unless the link is removed.
- Security tests:
  - invalid signatures fail;
  - replayed BlueBubbles relay messages fail;
  - identity conflicts do not merge;
  - logs redact tokens and phone numbers.

## Open Questions

- Whether platform links should remain columns on `users` or move to a
  first-class linked identities table for multi-account-per-platform support.
- Whether unsolicited outbound messages (not replies to an inbound turn) need
  a future Headscale or outbound WebSocket/long-poll transport. Inbound-turn
  replies use the current synchronous HTTPS response and require neither.
- Whether WhatsApp first contact can create a full non-anonymous account, or
  should always create a pending account until app-session confirmation.
- Whether the same onboarding session should support multiple platform
  identities before an explicit lifecycle flow creates the first agent.
