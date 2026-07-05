# In-chat widget system (plugin-registered, context-efficient)

## Summary

Workstream for the LifeOps Personal Assistant MVP (GitHub project 15): chat is
the primary surface, and functionality is moving from views/plugins INTO chat —
e.g. settings rendered as in-chat widgets that show information and accept
input. The mission constraint is to **minimize new scope**: turn what exists
into an MVP by fixing, testing, and verifying, preferring deletion over
addition.

The core finding of this research: **the widget system already exists and is
substantially built.** There is a plugin-extensible inline widget registry, a
typed connector-agnostic interaction protocol in `@elizaos/core`, an
out-of-band sensitive-request pipeline with a hosted cloud entry page, native
rendering + round-trip on Telegram and Discord, and an in-chat plugin-settings
card. The context-efficiency problem is also already solved structurally:
widget markers are mostly emitted by action *code* (zero prompt cost), and the
one model-facing authoring guide is a dynamic, relevance-gated provider that is
excluded from default prompt composition.

**Decision: build no new registry and no new widget framework.** MVP work is
closing six verified gaps: a dead form link on connectors, a missing date/time
field type that LifeOps scheduling needs, an oversized model-facing guide, zero
live-LLM scenario coverage of the widget round-trips, stale widget
documentation, and unverified settings-in-chat / hosted-secret flows.

## Current state (verified)

### 1. Inline widget registry — exists, plugin-extensible

- `packages/ui/src/components/chat/widgets/inline-registry.tsx:58-77` — a
  process-global `Map` keyed by marker `kind`; `registerInlineWidget({ kind,
  parse, render })` lets a plugin teach chat a new widget with no edit to
  `MessageContent`. Because plugin view bundles externalize `@elizaos/ui`
  (`packages/ui/CLAUDE.md`, "React is a peer dep"), a plugin's registration
  lands in the host's singleton registry. `plugin-task-coordinator` already
  uses this path (`registerTaskWidget()` in
  `packages/ui/src/components/chat/widgets/task-widget.tsx`).
- Built-ins registered at module load
  (`packages/ui/src/components/chat/widgets/inline-builtins.tsx:23-62`):
  `choice`, `followups`, `form`.
- One parser for every surface: `parseSegments`
  (`packages/ui/src/components/chat/message-parser-helpers.ts:1-16`) turns a
  reply into ordered segments — prose, code, `[CONFIG:…]`, UiSpec JSON,
  permission cards, plus every registry widget. Both `MessageContent`
  (ChatView) and `InlineWidgetText` (ContinuousChatOverlay, the primary
  web/mobile surface) delegate to it; parity is contract-tested
  (`render-parity.contract.test.tsx`, `parser-parity.contract.test.ts`).
- Widget → chat round-trip is single-sourced:
  `useInlineWidgetContext(sendActionMessage, setChatInput)`
  (`packages/ui/src/components/chat/widgets/use-inline-widget-context.ts:21-57`)
  provides exactly four handlers — `sendAction`, `navigate`,
  `prefillComposer`, `submitForm` — consumed identically by both surfaces.

### 2. Typed, connector-agnostic interaction protocol — exists in core

- `packages/core/src/types/interactions.ts:132-139` — `InteractionBlock =
  FormInteraction | ChoiceInteraction | FollowupsInteraction | TaskInteraction
  | SecretInteraction`; carried on `Content.interactions`
  (`packages/core/src/types/primitives.ts:174`).
- `packages/core/src/messaging/interactions/` — parse / serialize / layout /
  callback codec / normalize, with a README that is the protocol reference.
  `toNeutralLayout` (`layout.ts:97`) projects any block onto rows of
  buttons/links; `encodeReplyCallback`/`decodeCallback` fit Telegram's 64-byte
  `callback_data` limit.
- Connectors render natively and round-trip:
  `plugins/plugin-telegram/src/interactions.ts` (inline keyboards,
  `handleCallbackQuery` replays the tap as a user turn) and
  `plugins/plugin-discord/interactions.ts` + `discord-interactions.ts` (button
  action rows, `isButton` handler decodes `customId`). Both have unit tests.

### 3. Sensitive input (secrets / OAuth) — out-of-band pipeline exists end to end

- Secrets never travel as marker text. The dispatch registry
  (`packages/core/src/sensitive-requests/dispatch-registry.ts:22-29`) routes a
  request to one of: `dm`, `owner_app_inline`, `owner_app_oauth`,
  `cloud_authenticated_link`, `tunnel_authenticated_link`, `public_link`,
  `instruct_dm_only`. Actions: `REQUEST_SECRET`
  (`packages/core/src/features/secrets/actions/request-secret.ts`),
  `DELIVER_OAUTH_LINK`
  (`packages/core/src/features/oauth/actions/deliver-oauth-link.ts`).
- In-app rendering: `SensitiveRequestBlock`
  (`packages/ui/src/components/chat/MessageContent.tsx:610-700`, rendered at
  `:1068-1069`) — per-field password inputs, OAuth connect button, tunnel path
  for sub-agent credentials, remote-connect path for first-run. The overlay
  renders it too (`packages/ui/src/components/shell/ContinuousChatOverlay.tsx:823-825`).
- Hosted page (the "elizacloud.ai flow" this workstream was asked to design)
  **already exists**:
  `packages/ui/src/cloud/public-pages/pages/sensitive-requests/sensitive-request-page.tsx`
  (no app-shell chrome, loads spec from `/api/v1/sensitive-requests/:id`,
  submits via `/submit`), registered in
  `packages/ui/src/cloud/public-pages/register.ts:33-35`. Backend:
  `packages/cloud/api/v1/sensitive-requests/[id]/submit/route.ts:1-16`
  (single-use token OR authenticated org member, per persisted policy),
  persistence + callback bus in `packages/cloud/shared/src/lib/services/`.
- Agent awareness: `outstanding-sensitive-requests` provider
  (`packages/core/src/providers/outstanding-sensitive-requests.ts:1-9`) tells
  the model what is pending.

### 4. Settings in chat — mostly exists

- `[CONFIG:pluginId]` renders a full, self-contained plugin-config card in chat
  (`InlinePluginConfig`, `packages/ui/src/components/chat/MessageContent.tsx:156-320`):
  fetches the plugin, auto-generates the form from its parameter schema
  (`packages/ui/src/config/plugin-ui-spec.ts`), saves config, enables/disables
  — the same API calls the Plugins view makes.
- App-level settings mutate via the owner-gated `SETTINGS` action
  (`packages/agent/src/actions/settings-actions.ts:816-820`): AI provider,
  capabilities, auto-training, display name, backend routing.

### 5. Context efficiency — the "deferred tools" pattern already exists

- The only prompt text the widget system costs is the `uiCatalog` provider
  (`packages/agent/src/providers/ui-catalog.ts:38-49`): `dynamic: true` (so it
  is **excluded from default state composition** — verified at
  `packages/core/src/runtime.ts:4088`, `!p.private && !p.dynamic`), relevance-
  keyword gated, cached per-agent, ADMIN-role + DM/API-channel gated.
- Everything else is free: `[CHOICE]`/`[FOLLOWUPS]`/`[TASK]` markers are
  appended by action handler *code* (e.g.
  `plugins/plugin-app-control/src/actions/views.ts`,
  `plugins/plugin-personal-assistant/src/lifeops/checkin/checkin-service.ts`),
  so the model never needs the syntax in context for those flows.
- The analogous machinery for actions (retrieval-ranked tier bands, umbrella
  parents) is `packages/core/src/runtime/action-tiering.ts:1-27` — the pattern
  to mirror if widget guidance ever needs to scale, which for a closed
  vocabulary it does not.

### 6. What is weak, broken, or untested

- **Dead link (broken pipeline):** on connectors, a `[FORM]` block renders as
  an "Open form" button whose URL is `${appBaseUrl}/forms/<id>`
  (`packages/core/src/messaging/interactions/layout.ts:196`) — but **no
  `/forms/:id` page exists anywhere**: not in the cloud public-pages registry
  (`packages/ui/src/cloud/public-pages/register.ts`), not in
  `packages/cloud/api/v1/`. Form specs are also never persisted server-side,
  so there is nothing such a page could load. The protocol README already
  marks connector forms "⏳ link-out"
  (`packages/core/src/messaging/interactions/README.md`, rendering matrix).
- **Missing field types:** `InteractionFieldType`
  (`packages/core/src/types/interactions.ts:32-39`) is `text | number | select
  | checkbox | secret | image | file`. No `date` / `time` / `datetime` — yet
  the MVP's center of gravity is scheduling (reminders, events, check-ins).
  Today a reminder-time form field is a free-text input.
- **Round-trip is text-only and unproven with a live model:** a form submit
  re-enters as the literal user message `[form:submit <id>] {json}`
  (`use-inline-widget-context.ts:49-53`); nothing server-side parses it
  structurally (repo-wide grep: only the UI hook and its test reference
  `form:submit`), and the raw marker text is what appears as the user's
  transcript bubble. The model is trusted to read the JSON. No live-LLM
  scenario exercises FORM emission → submission → use of the values, CHOICE
  pick, or `[CONFIG]` emission (only two deterministic computeruse scenarios
  touch any marker: `packages/scenario-runner/test/scenarios/deterministic-*computeruse*-progress*.scenario.ts`).
- **Doc drift:** `packages/ui/src/components/chat/widgets/WIDGET_MATRIX.md`
  divergence "D1 — host-only segments" claims the overlay does not render
  `[CONFIG]`/permission/secret/UiSpec — false since the overlay gained those
  renderers (`InlineWidgetText.tsx:109-137`,
  `ContinuousChatOverlay.tsx:823-825`).
- **Oversized guide:** `uiCatalog` leads with "Method 1 — inline JSONL patches"
  (GenUI) and appends a ~156-component catalog summary
  (`packages/agent/src/shared/ui-catalog-prompt.ts`, 1178 lines) every time it
  fires. For the MVP's closed marker vocabulary, most of that text is spend
  without return, and it steers the model toward the heaviest output mode.

## Design considerations

- **Closed vocabulary beats per-plugin widgets.** The canonical set — `form`,
  `choice`, `followups`, `task`, `secret/oauth` (out-of-band), `[CONFIG]` —
  already covers the MVP list: forms ✓, OAuth/sign-in ✓, secrets/API-key ✓,
  confirmations = `choice`, pickers = `form` field types (gap: date/time),
  lists = markdown prose or `choice`, status/info cards = the `task`-card
  pattern + home/sidebar slot widgets (`packages/ui/src/widgets/registry.ts`,
  slots `home | chat-sidebar | character | nav-page` in
  `widgets/types.ts:12-19`). Plugins parameterize the canonical widgets; they
  do not mint new marker kinds. `registerInlineWidget` remains the escape
  hatch for a plugin that ships its own *display* renderer (as tasks do), and
  a renderer registration adds **zero prompt text** — that is the registry's
  context-efficiency contract.
- **GenUI (`packages/ui/src/genui/`) is the arbitrary-UI escape hatch, not the
  MVP path.** It stays admin-gated; the MVP does not depend on it.
- **Security invariant (keep):** secrets never transit chat as text. In-app →
  inline secure form; connectors → one link-out button to the hosted
  authenticated page (single-use token / org auth). This is implemented; the
  MVP work is *proving* it on a real connector, not building it.
- **Fail fast:** malformed marker blocks render as plain text, never a broken
  control (`message-form-parser.ts:113-121`, error-policy:J3). The dead
  `/forms/:id` link violates this doctrine today — it fabricates a healthy-
  looking button for a nonexistent page.

## Open questions → answers

**Q1. Do we need a new widget registry for plugins?**
No. `registerInlineWidget` (inline markers) and the slot registry
(`widgets/registry.ts`, including `uiSpec` declarations for plugins without
bundled React) already cover both layers, and `plugin-task-coordinator` proves
the plugin path works. Building a second registry would violate the
minimal-scope constraint. MVP work is verification, not construction.

**Q2. How does the agent have many widget options without filling context?**
Already solved, in three layers: (1) most markers are emitted by action code —
zero prompt cost; (2) the model-facing guide is one `dynamic: true`,
relevance-gated, cached provider excluded from default composition
(`runtime.ts:4088`); (3) if guidance ever needs to scale, mirror action
tiering (`action-tiering.ts`). The actionable gap is that the *content* of the
guide is bloated (GenUI catalog) — slim it, don't re-architect it.

**Q3. What happens on Discord/Telegram where a widget can't render?**
`toNeutralLayout` already degrades every block to native buttons/links, and
choice/followups/task round-trip works on both connectors. Forms are the one
broken case (dead `/forms/:id` link). Answer for MVP: suppress the fabricated
URL so the layout's existing `needsFallback` free-text path takes over ("reply
with your answer"), and keep the standing rule that secret-bearing input uses
the sensitive-request flow (which has a real hosted page). Building a hosted
generic-form page (persist spec → token page → submit → inbound message) is
the correct *eventual* design but is new scope; defer unless a concrete MVP
scenario needs multi-field non-secret input on a connector — none identified.

**Q4. How do widget interactions round-trip to the agent?**
Taps re-enter the ordinary message pipeline: choice/followup → the option's
`value` as a user message (connector taps are decoded by `decodeCallback` and
replayed through `handleMessage`); form → `[form:submit <id>] {json}`; secrets
→ server-side submit + callback bus, surfaced via the
`outstanding-sensitive-requests` provider. This is acceptable for MVP —
"structured event" = a deterministic text encoding the model reads — but it is
unproven with a live model and the raw `[form:submit …]` JSON renders in the
user's own transcript bubble. Both belong to one verification issue.

**Q5. Should the settings view be deleted in favor of chat widgets?**
Not in this workstream. The chat path already exists (`[CONFIG:pluginId]` card
+ `SETTINGS` action); the MVP need is to *verify* it end to end with rendered
evidence so chat is a fully working settings surface. View retirement is a
views-workstream decision once the chat path is proven. (Owner call if it
should be forced earlier; default: verify first.)

**Q6. Date/time pickers?**
Add `date` / `time` / `datetime` to `InteractionFieldType`, the FORM parser,
and the `FormRequest` renderer (native `<input type="date|time|datetime-local">`
— no new dependency); connectors keep free-text fallback. Small, additive,
and directly required by LifeOps scheduling forms. This is the one vocabulary
addition the MVP justifies.

## Recommendation (minimal-scope MVP plan, ordered)

1. **Fix the connector form dead-link** — stop minting `/forms/<id>` URLs in
   `buildInteractionUrlResolver`; let the free-text fallback render. (P0, small)
2. **Live-LLM scenario coverage for widget round-trips** — FORM emit→submit→use,
   CHOICE pick, `[CONFIG]` emission on "set up discord", followups restraint.
   Fix what the trajectories reveal, including the raw `[form:submit]` bubble.
   (P0, the actual MVP work)
3. **Add date/time field types** to the interaction vocabulary + FORM widget. (P1)
4. **Slim the `uiCatalog` provider** — markers first; split the GenUI JSONL
   method + component catalog into a separate dynamic provider. (P1)
5. **Verify settings-in-chat end to end** — `[CONFIG]` card + `SETTINGS` action
   with rendered evidence on both chat surfaces. (P1)
6. **Prove the sensitive-request hosted-page flow on a real connector** —
   Telegram/Discord DM link-out → hosted page → submit → agent sees the value. (P1)
7. **Refresh `WIDGET_MATRIX.md`** to match the code (D1 stale, coverage table). (P2)

## Out of scope (MVP non-goals)

- A new widget framework, registry, or renderer; adopting A2UI as a dependency
  (GenUI's local subset stays as-is, admin-gated).
- Per-plugin marker kinds or a widget-manifest prompt protocol; the vocabulary
  stays closed.
- A hosted generic form-filling page (`/forms/:id`) with server-side form
  persistence — revisit only when a connector scenario needs non-secret
  multi-field input.
- Widget builder UI, user-authored widgets, new widget slots.
- Deleting the settings view (views workstream, after verification).
- Structured server-side `[form:submit]` parsing (chat-pre-handler) — only if
  live trajectories show the model mishandling text re-entry.

## Proposed issues

1. **[chat-widgets] P0** — Connector `[FORM]` link-out points at a nonexistent `/forms/:id` page: suppress the dead URL, use free-text fallback
2. **[chat-widgets] P0** — Live-LLM scenario coverage for in-chat widget round-trips (FORM submit, CHOICE pick, `[CONFIG]` emission)
3. **[chat-widgets] P1** — Add `date`/`time`/`datetime` field types to the interaction FORM vocabulary
4. **[chat-widgets] P1** — Slim the `uiCatalog` provider: markers first, GenUI catalog split into its own dynamic provider
5. **[chat-widgets] P1** — Verify settings-in-chat end to end: `[CONFIG:pluginId]` card + `SETTINGS` action with rendered evidence
6. **[chat-widgets] P1** — Prove the sensitive-request hosted-page flow on a real connector (DM link-out → hosted page → agent sees the result)
7. **[chat-widgets] P2** — Refresh `WIDGET_MATRIX.md` to match the code (stale D1 divergence, coverage table)
