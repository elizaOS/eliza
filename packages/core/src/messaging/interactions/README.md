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

`field.type`: `text | number | select | checkbox | secret`. Parsing is strict —
a malformed block is left as plain text, never a broken control.

## Module API (`@elizaos/core`)

- `parseInteractionBlocks(text)` → `{ blocks, cleanedText }` — superset of the four
  dashboard parsers; `cleanedText` is the prose with markers removed.
- `findInteractionRegions(text)` → regions with char bounds (for interleaved rendering).
- `serializeInteractionBlock(block)` / `appendInteractionBlock(text, block)` — build
  markers programmatically (inverse of parse for the text-borne blocks).
- `toNeutralLayout(block, { resolveUrl, maxButtonsPerRow })` → `NeutralLayout`
  (rows of buttons / a select) — the shared projection each connector maps to its
  native primitive. A button carries exactly one of `callbackData` (round-trip) or
  `url` (link-out).
- `encodeReplyCallback(value)` / `decodeCallback(data)` — 64-byte-safe codec
  (Telegram's `callback_data` limit). Returns null when the answer is too big →
  caller links out or accepts a free-text reply.
- `normalizeContentInteractions(content)` — attach parsed blocks to
  `Content.interactions` **without** mutating `text` (so the dashboard's own
  segment renderer keeps interleaving). `stripInteractionMarkers(text)` for prose.

Types: `InteractionBlock` (`FormInteraction | ChoiceInteraction |
FollowupsInteraction | TaskInteraction | SecretInteraction`) in
`@elizaos/core` `types/interactions`. `Content.interactions?: InteractionBlock[]`.

## Per-surface rendering matrix

| Block | Dashboard | Telegram | Discord |
|---|---|---|---|
| choice | `ChoiceWidget` ✅ | inline-keyboard callback buttons ✅ | button action row ✅ |
| followups | `FollowupsWidget` ✅ | callback buttons ✅ | button action row ✅ |
| form | `FormRequest` ✅ | link-out (multi-field is awkward as a keyboard) ⏳ | link-out ⏳ |
| task | `TaskWidget` (live poll) ✅ | link button + title ✅ (live status ⏳) | link button + title ✅ |
| secret/oauth | `SensitiveRequestBlock` ✅ | DM link via adapter ⏳ | DM link via `sensitive-request-adapter` ✅ |

✅ implemented · ⏳ remaining (seams below). Choice/followups round-trip:
- **Telegram**: `handleCallbackQuery` decodes the tap and replays it through
  `handleMessage` as a user turn (`plugin-telegram/src/messageManager.ts`).
- **Discord**: the click already emits `DISCORD_INTERACTION` with the `customId`
  (= the callback payload) in `discord-interactions.ts` — decode it with
  `decodeCallback` and re-inject (seam below).

## Remaining work — exact seams

1. **Discord inbound round-trip.** In `plugin-discord/discord-interactions.ts`
   `isButton()` handler (~L259): if `isInteractionCallback(interaction.customId)`,
   `decodeCallback` → build a Memory (mirror `inbound-envelope.ts` /
   `formatInboundEnvelope`) with `text = decoded.value` and dispatch via
   `messageService.handleMessage`, then `interaction.deferUpdate()`. Use a turn id
   derived from `interaction.id` to avoid colliding with the source message memory
   (same pattern as Telegram's `handleCallbackQuery`).
2. **Thread per task.** On task create, materialize `OrchestratorTaskRecord.taskRoomId`
   as a platform thread and route that task's sub-agent messages + status into it.
   - Discord: `DiscordService.createConnectorThread` (`service.ts` ~L2375) +
     `postToConnectorThread` (~L2415).
   - Telegram: `bot.telegram.createForumTopic(chatId, name)` → `message_thread_id`;
     rooms already key on `<chatId>-<threadId>` (`buildForumTopicRoom`). Send into
     it via `sendMessageInChunks(ctx, content, undefined, message_thread_id)`.
3. **Secret link-out auto-pick (cloud vs local).** Resolve the delivery target by
   deployment: `cloud_authenticated_link` when Eliza Cloud is linked, else the
   local dashboard URL (loopback/tunnel). Wire as the `resolveUrl` passed to
   `toNeutralLayout`, and add a Telegram `sensitive-request-adapter` mirroring
   `plugin-discord/sensitive-request-adapter.ts` (register against
   `SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE_NAME`; Discord's already branches on
   `isCloudPaired`).
4. **Task view parity + floating chat UI.**
   - Task detail view (Codex/Claude-Code parity): header (goal, status, live
     timeline), sub-agent message room, plan/diff, forms-and-asks inbox. Data is
     already there: `GET /api/orchestrator/tasks/:id` + `/timeline` + `/stream`
     (SSE). Widget link target is `/orchestrator?taskId=<threadId>`
     (`plugin-agent-orchestrator` + `TasksPageView`).
   - Floating chat UI: `ContinuousChatOverlay.tsx` is currently text-only — route
     its messages through the `MessageContent` segment renderer so choices, forms,
     task cards, and secret blocks appear inline there too.
5. **Central normalization (optional).** Register `normalizeContentInteractions`
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

Implement one function: `parseInteractionBlocks(content.text)` → for each block
`toNeutralLayout(block, { resolveUrl })` → map `NeutralButton.callbackData`/`.url`
to the platform's button primitive; send `cleanedText` as the body. For the
round-trip, decode the platform's callback payload with `decodeCallback` and
re-inject `value` as an inbound user message. ~60 lines; see
`plugin-telegram/src/interactions.ts` and `plugin-discord/interactions.ts`.
