# Interactive message protocol

The connector-agnostic vocabulary for the structured controls an agent embeds in
a reply — **forms**, **choice pickers** (pick one, or supply your own), **secret /
OAuth requests**, **live task cards**, and **suggestion chips** — plus the engine
that parses, serializes, lays out, and round-trips them across every surface
(the dashboard, Telegram, Discord, …).

This document is both the protocol reference and the design spec for bringing the
task orchestrator to Codex / Claude-Code parity across chat surfaces. It records
what exists, what is implemented here, and the exact seams for the remaining work.

## Why this exists

The dashboard already renders rich inline widgets from bracket markers in message
text (`MessageContent.tsx`: `[FORM]`, `[CHOICE:…]`, `[FOLLOWUPS]`, `[TASK:…]`,
plus an out-of-band `secretRequest`). **Connectors did not** — in Telegram and
Discord a `[FORM]{…}` or `[TASK:…]` reached the user as raw marker text. This
module promotes the dashboard's markers into one shared, typed engine so every
surface renders the same agent output identically and routes answers back the
same way.

Design decision (locked): **keep the existing bracket markers**, share the
parser. Zero migration for existing agent output; connectors gain a single place
to render. The encoding is an implementation detail behind the typed API.

## The two transports

| Transport | Carries | How it travels | Round-trip |
|---|---|---|---|
| **In-band markers** | form · choice · followups · task | inside `Content.text` | user sends a text message (the chosen `value`, or `[form:submit <id>] {json}`) |
| **Out-of-band sensitive** | secret · oauth | `sensitive-requests` dispatch registry → `message.secretRequest` (never plaintext in text) | OAuth callback / secure form POST, server-side |

`SecretInteraction` is part of the typed union so a connector has **one** place to
render every control, but it is built from a dispatch envelope, not parsed from
text. Secrets must never transit a chat transport as text.

## Wire format (in-band markers)

```
[FORM]\n{ "id"?, "title"?, "description"?, "submitLabel"?, "fields":[{name,type,label?,placeholder?,required?,options?}] }\n[/FORM]
[CHOICE:<scope>( id=<id>)?]\n value=label\n … \n[/CHOICE]
[FOLLOWUPS( id=<id>)?]\n <kind>:<payload>=<label>\n … \n[/FOLLOWUPS]   # kind: reply|navigate|prompt
[TASK:<threadId>]<title>[/TASK]                                          # threadId: lowercase hex/uuid, 8–64 chars
```

`field.type`: `text | number | select | checkbox | secret | image | file |
date | time | datetime`. Date/time fields submit the native input string
(`YYYY-MM-DD`, `HH:mm`, `YYYY-MM-DDTHH:mm`). Parsing is strict —
a malformed block is left as plain text, never a broken control.

## Module API (`@elizaos/core`)

- `parseInteractionBlocks(text)` → `{ blocks, cleanedText }` — superset of the four
  dashboard parsers; `cleanedText` is the prose with markers removed.
- `findInteractionRegions(text)` → regions with char bounds (for interleaved rendering).
- `serializeInteractionBlock(block)` / `appendInteractionBlock(text, block)` — build
  markers programmatically (inverse of parse for the text-borne blocks).
- `toNeutralLayout(block, { resolveUrl, maxButtonsPerRow, maxCallbackBytes })` →
  `NeutralLayout`
  (rows of buttons) — the shared projection each connector maps to its native
  primitive. A button carries exactly one of `callbackData` (round-trip) or `url`
  (link-out).
- `toPlainTextFallback(block, { resolveUrl })` → concise prose for text-only
  transports such as SMS/iMessage, where there is no native control surface.
- `encodeReplyCallback(value, { maxBytes })` / `decodeCallback(data)` —
  legacy presentation codec. Its decoded value is untrusted input and grants no
  authority. New state-changing controls use the durable session protocol below.
- `normalizeContentInteractions(content)` — attach parsed blocks to
  `Content.interactions` **without** mutating `text` (so the dashboard's own
  segment renderer keeps interleaving). `stripInteractionMarkers(text)` for prose.

Types: `InteractionBlock` (`FormInteraction | ChoiceInteraction |
FollowupsInteraction | TaskInteraction | SecretInteraction`) in
`@elizaos/core` `types/interactions`. `Content.interactions?: InteractionBlock[]`.

## Negotiated delivery and durable callbacks

`ConnectorInteractionCapabilityProfile` is the canonical, versioned capability
description for one connector account and one target. `MessageConnector`
implementations resolve it from `(target, delivery context)`; renderers select
native, signed-hosted, conversational, or sensitive-request delivery from the
profile rather than branching on a provider name. Every block kind is required,
unsupported primitives use zero limits, and supported primitives use positive
limits. `negotiateInteractionDelivery` enforces counts, UTF-8 byte budgets,
callback size, attachment MIME and byte limits, edit windows, threads, and URL
limits before selecting a mode. The generated `CAPABILITY_MATRIX.md` is the
reviewable golden contract and its test fails when a registered first-party
message connector is omitted.

State-changing controls use `MessageInteractionSessionAuthority`. The wire value
is only `is1:<128-bit opaque reference>`; it contains no answer, identity,
authorization, credential, or signature. The durable record binds the actor,
audience, agent, connector account, room, source message, response schema,
authorization decision, expiry, effect, and stable replay key. A store performs
atomic `pending → claimed → committed → completed` transitions and retains the
effect receipt. Reservation claims may expire before commitment. Once committed,
the host may cross the external effect boundary, but an outcome lost to a crash
remains permanently ambiguous: it is never transferred, retried, revoked as if
cancellation succeeded, or garbage-collected. Revocation after render, expiry,
mismatched context, response tampering, stale claims, and a different replay key
all fail closed.

Connector plugins access that authority through the registered
`MessageInteractionHost` service. `prepare` accepts the resolved profile plus
trusted bindings, authorization, and effect, but returns only the block,
negotiated delivery, opaque callback, expiry, and profile id needed to render.
`consume` accepts connector-authenticated bindings and the provider's inbound
event id, then dispatches through a host-registered effect handler using that id
as the idempotency key. Its retained receipt carries the provider receipt,
canonical inbound event id, audit id, and app-state result. Connectors must not
construct their own authority, store, or effect dispatcher.

The additive `MessageConnector.sendPreparedInteraction` hook accepts only the
renderer-safe `PreparedMessageInteraction` plus a target and optional prose.
The host is the producer; the connector is only the provider renderer. For
providers whose control value is the sole callback field,
`encodePreparedInteractionCallback` appends schema-validated non-secret user
input to the opaque reference within the declared provider byte budget.
`consumePreparedInteractionCallback` removes that input and submits the
provider-authenticated actor, audience, agent, account, room, and receipt to the
host. The original source message remains retained-only and survives restart.

`InMemoryMessageInteractionSessionStore` is for deterministic tests and embedded
processes. The agent host's `FileMessageInteractionSessionStore` is durable and
cross-process safe on one machine. It uses a same-filesystem fsync-and-rename
commit and a stale-owner-aware lock. Multi-host deployments must implement the
same store interface with a transactional database and idempotent effect/outbox
boundary; the JSON store does not claim distributed exactly-once semantics.

Secrets and OAuth values never enter these response records. A `secret` block
can only negotiate `sensitive-request`, and ordinary forms reject secret fields.

## Per-surface rendering matrix

| Block | Dashboard | Telegram | Discord | Text-only (SMS/iMessage) |
|---|---|---|---|---|
| choice | `ChoiceWidget` ✅ | inline-keyboard callback buttons ✅ | button action row ✅ | numbered reply list ✅ |
| followups | `FollowupsWidget` ✅ | callback buttons ✅ | button action row ✅ | suggestions line ✅ |
| form | `FormRequest` ✅ | free-text fallback (by design) ✅ | free-text fallback (by design) ✅ | title/description + free-text invite ✅ |
| task | `TaskWidget` (live poll) ✅ | link button + title ✅ (live status ⏳) | link button + title ✅ | title + `/orchestrator?taskId=…` link ✅ |
| secret/oauth | `SensitiveRequestBlock` ✅ | DM link via `sensitive-request-adapter` ✅ | DM link via `sensitive-request-adapter` ✅ | not inlined; requires secure adapter/failure surface |

✅ implemented · ⏳ remaining (seams below). Forms never link out on
connectors **by design** (#14321): no hosted `/forms/:id` page exists (form
specs are not persisted server-side), so `buildInteractionUrlResolver` resolves
no URL for them and the layout degrades to the form's title/description plus a
"Reply with your answer." invite. Secret-bearing input must never use a form —
it goes through the sensitive-request flow, which has a real hosted page.
The exhaustive production inventory is generated in
[`CAPABILITY_MATRIX.md`](./CAPABILITY_MATRIX.md). Discord, Slack, Telegram, and
WhatsApp Cloud API declare the provider-native controls their adapters actually
emit. Gmail, Google Chat, iMessage, Instagram, Matrix, WeChat, X DMs, and
WhatsApp Baileys declare semantic conversational delivery for unsupported
controls. Signal is deliberately listed as an exclusion because the first-party
package fails with `SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE` and registers no message
connector. A connector may not advertise a stronger family than its exact
account transport supports.

Legacy `ia1:` choice/followup values are presentation-only and never dispatch a
state-changing turn. Discord, Telegram, Slack, and WhatsApp Cloud API emit
effect-capable controls only from a host-prepared `is1:` delivery, authenticate
the provider event, and consume it through the host. WhatsApp Baileys and every
transport without native controls remain on semantic conversational fallback.

The floating chat overlay (`ChatOverlay`) also renders these widgets.
It does **not** route through `MessageContent`: it renders assistant turns via
`InlineWidgetText` (which shares the same segment parser + inline registry and
reuses `MessageContent`'s `[CONFIG]` / permission / UiSpec / code renderers), and
mounts `SensitiveRequestBlock` itself for the secret/OAuth card.

## Shipped

- ✅ Keystone protocol (parse / serialize / layout / codec / normalize) — `@elizaos/core`.
- ✅ Telegram: choice/followups/task rendering + `callback_query` round-trip + secret/OAuth DM link-out adapter.
- ✅ Discord: choice/followups/task rendering (buttons + link buttons) + `isButton` round-trip.
- ✅ Floating chat overlay renders interaction widgets.
- ✅ **Thread per task** on both connectors. The orchestrator already routes each
  sub-agent's narration into a per-task thread (`emitProgress` in
  `plugin-agent-orchestrator/src/index.ts` — capability-gated on
  `create_thread` + `post_to_thread`, created via `runtime.createThreadOnTarget`).
  This worked only on Discord; Telegram now declares those capabilities and
  implements `createConnectorThread` (forum topic) / `postToConnectorThread`, so
  it works there too. Requires threaded progress mode
  (`ACPX_PROGRESS_MODE=threaded`) + a forum-enabled Telegram supergroup.
- ✅ **Task detail view with sub-agent message room** already exists:
  `plugin-task-coordinator/src/OrchestratorWorkbench.tsx` renders the per-task
  timeline (sub-agent / orchestrator / user / system senders), the sessions
  (sub-agents) list, plan, artifacts, usage, and recovery — with near-live room
  polling. The task widget links here via `/orchestrator?taskId=<threadId>`.
- ✅ **Multi-connector `dm` resolution.** The dispatch registry now holds a list
  of adapters per target and resolves via `supportsChannel`
  (`resolve(target, channelId, runtime)`), so Discord and Telegram can each
  register a DM secret/OAuth adapter and the right one is selected per request.

## Remaining work — optional

1. **Central normalization (optional).** Register `normalizeContentInteractions`
   on the `outgoing_before_deliver` pipeline hook so every consumer gets
   `Content.interactions` without re-parsing. Connectors are already self-sufficient
   (they call `parseInteractionBlocks` directly), so this is a convenience, not a
   dependency.

## UX principles (minimize slop, maximize signal)

- **One canonical block, every surface.** The agent emits the marker once; each
  surface renders its best-fit native control. No per-connector prompt authoring.
- **Controls, not walls of text.** A choice is buttons, not "reply 1, 2, or 3".
  A task is a card/thread, not a paragraph of status. Strip markers from prose so
  users never see raw `[CHOICE …]`.
- **Pick-one-or-your-own.** `ChoiceInteraction.allowCustom` renders the options as
  buttons *and* invites a free-text reply (`needsFallback` on the layout).
- **Secrets never in the transport.** Inline secure form in the app; a single
  link-out button on connectors → authenticated cloud/local entry page.
- **Task = thread.** Each task owns a Discord thread / Telegram forum topic; its
  sub-agent chatter and status updates stay there, out of the main channel.

## Adding a new surface

Register the connector's mechanically verified capability template, resolve a
concrete profile for each account/target, and ask the registered
`MessageInteractionHost` to prepare the delivery. Place only its opaque callback
reference in the native control. On receipt, pass the connector-authenticated
actor/account/room/message context and provider event receipt back to the host;
the host owns authorization, replay, effect dispatch, and durable receipts.
Conversational fallback must explain the accepted reply shape; signed-hosted
fallback must use a short-lived authenticated URL; secret/OAuth input must use
the sensitive-request service.
