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
  callback codec that defaults to Telegram's 64-byte `callback_data` limit.
  Connectors with a larger native budget, such as Discord custom IDs, pass their
  own limit. Returns null when the answer is too big → caller links out or
  accepts a free-text reply.
- `normalizeContentInteractions(content)` — attach parsed blocks to
  `Content.interactions` **without** mutating `text` (so the dashboard's own
  segment renderer keeps interleaving). `stripInteractionMarkers(text)` for prose.

Types: `InteractionBlock` (`FormInteraction | ChoiceInteraction |
FollowupsInteraction | TaskInteraction | SecretInteraction`) in
`@elizaos/core` `types/interactions`. `Content.interactions?: InteractionBlock[]`.

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
Choice/followups round-trip works on **both** connectors:
- **Telegram**: `handleCallbackQuery` decodes the tap and replays it through
  `handleMessage` as a user turn (`plugin-telegram/src/messageManager.ts`).
- **Discord**: the `isButton` handler in `discord-interactions.ts` decodes the
  `customId` with `decodeCallback` and dispatches via `messageService.handleMessage`.

The floating chat overlay (`ContinuousChatOverlay`) also renders these widgets.
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

Implement one function: `parseInteractionBlocks(content.text)` → for each block
`toNeutralLayout(block, { resolveUrl })` → map `NeutralButton.callbackData`/`.url`
to the platform's button primitive; send `cleanedText` as the body. For the
round-trip, decode the platform's callback payload with `decodeCallback` and
re-inject `value` as an inbound user message. ~60 lines; see
`plugin-telegram/src/interactions.ts` and `plugin-discord/interactions.ts`.
