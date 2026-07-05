# View<->chat integration

## Summary

The MVP doctrine is already half-built: chat is the primary surface, views are
information surfaces the agent (or the user via chat) drives. The plumbing
exists — a `view:interact` protocol (`STANDARD_CAPABILITIES` +
`AGENT_SURFACE_CAPABILITY_IDS`), a generic agent-surface bridge (`useAgentElement`
→ `agent-click`/`agent-fill`), a `VIEWS` action for switch/open/close, and a
`reportUserViewSwitch` hook that fires `VIEW_SWITCHED` so the agent can react
proactively when the user changes views. Roughly 40 view/settings components
already opt in with `useAgentElement`.

The gap is not "can chat touch the view" — the generic `agent-click`/`agent-fill`
bridge can synthesize any DOM interaction on an instrumented element. The gap is
**semantic**: several view interactions have *only* the generic synthetic-DOM
path, not a first-class agent action that changes the underlying state directly.
Synthetic DOM clicks are brittle (they depend on the exact element being mounted,
visible, and correctly `useAgentElement`-tagged), they are invisible to the
planner (the model cannot discover "toggle voice on" as an action — it must
guess a selector), and they will not survive the voice-first future where the
agent manipulates views as shared screen context.

This workstream's core deliverable is the **gap list**: every view interaction
that lacks a semantic chat/action path. Each gap becomes an issue that either
(a) adds/verifies a semantic action and turns the view control into a pure
renderer of state, or (b) confirms an existing action covers it and the view can
drop any local-only mutation. Minimal scope: we are wiring what exists, deleting
duplicate control surfaces, not adding new views.

## Current state

Route registration: `packages/ui/src/App.tsx` (`buildStaticTabRenderers`,
`renderStaticViewRouterTab`) + `packages/ui/src/navigation/index.ts:340`
(`TAB_PATHS`). Interact protocol: `packages/shared/src/views/view-interact-protocol.ts`.
Generic bridge: `packages/ui/src/components/views/view-interact-registry.ts`,
`packages/ui/src/components/views/ShellViewAgentSurface.tsx`,
`packages/ui/src/agent-surface/`. View-switch → proactive:
`packages/ui/src/chat/useSlashCommandController.ts:42` (`reportUserViewSwitch`).
Semantic actions: `plugins/plugin-app-control/src/actions/*`,
`plugins/plugin-personal-assistant/src/actions/*`.

### Inventory: view × primary interactions × chat path

| View (route) | Displays | Direct interactions | Semantic chat action | Gap |
| --- | --- | --- | --- | --- |
| Chat (`/chat`) | conversation | primary input surface | n/a (is chat) | — |
| Tasks (`/apps/tasks`) | coding-task coordinator | open/run/filter task rows | `START_CODING_TASK`, `SCHEDULED_TASKS` | **partial** — task-row filter/select has only generic bridge |
| Automations (`/automations`) | scheduled tasks + workflows | click row → editor; no create CTA | `SCHEDULED_TASKS` (list/create/update/snooze/complete/cancel), `VIEWS` | good — view already defers create to chat |
| Settings (`/settings`) | ~20 sections | per-section toggles/inputs/save | fragmented (see below) | **biggest gap** — most sections have no write action |
| Background (`/background`) | live background | color/image controls | `BACKGROUND` action | good |
| Knowledge/Documents (`/character/documents`) | docs + upload | upload / delete / open | none found (`plugin-documents` exposes no action) | **gap** — add/remove doc via chat |
| Relationships (`/apps/relationships`) | people graph | select / edit person | `ENTITY`, `TRUST`, contacts providers | partial |
| Memories (`/apps/memories`) | memory list | search / delete | `SEARCH_EXPERIENCES` (read only) | **gap** — no delete/edit via chat |
| Skills (`/apps/skills`) | skill catalog | enable / configure | `SKILL` action | good |
| Plugins (`/apps/plugins`) | plugin list | enable / configure / reorder | `APP`, connector actions partial | **partial** — enable/reorder via generic bridge only |
| Character (`/character`) | character editor | edit fields / persist | `CHARACTER`, `PERSONALITY` | good |
| Files (`/apps/files`) | stored files | download / delete | none | **gap** — delete file via chat |
| Logs / Runtime / Database / Trajectories / Transcripts | diagnostics | read + filter | read-only surfaces | acceptable read-only |
| Wallet/Inventory (`/wallet`) | balances/items | send / manage | `PAYMENT` | partial |
| Views/Apps launcher (`/views`,`/apps`) | app tiles | launch app | `VIEWS`, `APP` | good |

### Settings sections × write path

Sections (`packages/ui/src/components/settings/settings-sections.ts:264+`):
`identity, ai-model, voice, capabilities, apps, connectors, runtime, appearance,
background, remote-plugins, wallet-rpc, updates, advanced, app-permissions,
permissions, secrets, security` (+ cloud). Chat can *navigate* to any section
(`VIEWS subview=`, `settings-subviews.ts`). Chat can *write*: `ai-model`
(`MODEL_SWITCH`), `appearance`/`background` (`BACKGROUND`), `voice`
(`TTS_COMMAND`), `identity` (`CHARACTER`), `connectors` (`CONNECTOR`,
`CREDENTIALS`), `apps`/`capabilities` (`APP`, `SKILL`). **No semantic write
action:** `runtime`, `updates`, `permissions`/`app-permissions`, `secrets`
(vault add/remove), `wallet-rpc`, `advanced` (backup/reset), `remote-plugins`.
Those are reachable *only* by generic `agent-fill`/`agent-click` on the mounted
form — the planner cannot discover them.

## Design considerations

- **Semantic > synthetic.** `agent-click`/`agent-fill` is a fallback for
  arbitrary plugin views, not the design target for builtin LifeOps/settings
  surfaces. A semantic action (`SETTINGS action=set key=… value=…`) is
  discoverable by the planner, testable without a mounted DOM, and works
  headless/voice. The synthetic bridge stays for third-party plugin views only.
- **View = renderer of state.** Every builtin view should read state and format
  it; any mutation it performs must have an equivalent action, so the view's
  button is a *convenience shortcut* to the same action, never the only path.
- **One write, two triggers.** A toggle in Settings and the `SETTINGS` action
  must call the same use case — no divergent client-side mutation (Commandment
  #2/#3). This is the same pattern `BACKGROUND` already follows (view and action
  drive one store).
- **Doctrine already adopted** (#13586/#13590/#13592/#13597): uniform top bar,
  no side panels, no suggestion chips, agent-proactive-on-view-switch,
  view-scoped actions. This workstream extends "view-scoped actions" from
  navigation into *mutation*: the actions available while a view is focused
  should be able to change what the view shows.
- **Read-only views need no write action.** Logs, Runtime, Database,
  Trajectories, Transcripts are diagnostic surfaces; chat drives them via
  navigation + read providers only. Do not manufacture write actions for them.

## Open questions -> answers

**Q1. Do we need a per-view write action for every view, or one generic
`SETTINGS`/state action?** → One consolidated `SETTINGS` action for the settings
surface (keyed by section+field), reusing existing domain actions where they
already exist (`MODEL_SWITCH`, `BACKGROUND`, `TTS_COMMAND`). Per-view bespoke
actions only where the domain is genuinely distinct (documents, memories, files).
Rationale: minimizes planner surface and new code; the settings sections share a
config-write shape.

**Q2. Should we delete the local-only mutations that have no action?** → No —
keep the on-screen control (users press buttons), but route it through the same
action/use case so there is one write path. Delete only *duplicate* client-side
computation, not the UI affordance. Rationale: MVP serves elderly/children who
tap; chat-only would exclude them.

**Q3. How is a gap verified closed?** → A real-LLM scenario that says "turn on
voice" / "delete that document" / "reset my background" and asserts the state
changed *without* the model emitting a raw selector. If the model reaches for
`agent-fill` on a builtin settings field, the semantic action is missing.

**Q4. Where do view mutations live so voice gets them for free?** → In actions,
never in the view. See Voice-first future. Rationale: an action is modality-
agnostic; a click handler is not.

**Q5. Does agent-proactive-on-view-switch already fire?** → Yes,
`reportUserViewSwitch` → `VIEW_SWITCHED`/`SHORTCUT_FIRED`
(`useSlashCommandController.ts:322-354`). No new plumbing; verify the decider
actually greets per-view (owned by the views-redesign workstream).

## Recommendation (minimal-scope MVP plan, ordered)

1. **Audit + gap-close Settings writes.** Add a single `SETTINGS` action
   (`action=get|set`, `section`, `key`, `value`) that dispatches to existing use
   cases and covers the sections with no write path (`runtime`, `updates`,
   `permissions`, `secrets`, `wallet-rpc`, `advanced`, `remote-plugins`). Wire
   each settings toggle to the same use case. Verify via real-LLM scenarios.
2. **Documents/Knowledge chat CRUD.** Add `DOCUMENT` (add/remove/list/open)
   so the Knowledge view is a renderer; today `plugin-documents` exposes no
   action.
3. **Memories chat delete/edit.** Extend beyond read-only `SEARCH_EXPERIENCES`
   with a `MEMORY action=delete|forget` so the Memories view control has a chat
   twin.
4. **Files chat delete.** Small: a `FILES action=list|delete` so `FilesView`
   delete is not the only path.
5. **Tasks/Plugins: replace generic-bridge-only controls with semantic
   verbs** where a LifeOps user would say it in chat (filter tasks, enable a
   plugin). Confirm `SCHEDULED_TASKS`/`APP` cover it; only add where missing.
6. **Ratchet test.** A gate that asserts every builtin view's on-screen mutation
   maps to a registered action (fails when a new local-only mutation lands).

Ship 1–4 for MVP; 5–6 are hardening. No new views, no side panels, no new
control chrome.

## Voice-first future

With full bidirectional voice, the user speaks and the agent manipulates views as
*shared screen context*: "show me my week" → agent switches to the schedule view
and narrates "here's Tuesday, you've got the dentist at 3." "Move the dentist to
Thursday" → agent calls the reschedule action; the view re-renders; the agent
says "done, moved to Thursday 3pm." There is no keyboard, no selector, no button
press. This only works if **every view mutation is an action**: voice has no DOM
to click. The synthetic `agent-fill`/`agent-click` bridge is a dead end for voice
— the model would have to describe pixel targets it cannot see. A semantic action
layer means voice gets every view control *for free*, and the agent can narrate
exactly what it changed (the action name + params are the narration script).

This constrains today's design: prefer the semantic action even when a click
handler would be faster to write, because the click handler is throwaway the day
voice ships. The view becomes a live projection of state the agent mutates by
action and describes by voice — the screen is a shared whiteboard, not a control
panel. The gap list above is precisely the set of controls that would go mute
under voice; closing it is the same work as making voice control the app.

## Out of scope

- New views, new tabs, redesigned layouts (owned by views-redesign workstream).
- The top-bar / no-side-panels / proactive-greeting doctrine itself
  (#13586/#13590/#13592/#13597 — landed).
- Read-only diagnostic surfaces (Logs, Runtime, Database, Trajectories,
  Transcripts) gaining write actions.
- Voice implementation (this doc only states the constraint it imposes).
- Third-party plugin views: they keep the generic `useAgentElement` bridge; we
  do not mandate semantic actions for external bundles.
- The `view:interact` protocol / WS transport itself (working, unchanged).

## Proposed issues

1. [views] Add consolidated `SETTINGS` action + wire all settings writes through one use case
2. [views] Add `DOCUMENT` chat action so Knowledge view is a state renderer (add/remove/list)
3. [views] Add `MEMORY delete/forget` chat action to pair the Memories view control
4. [views] Add `FILES list/delete` chat action so FilesView delete has a chat twin
5. [views] Replace generic-bridge-only view controls (Tasks filter, Plugins enable/reorder) with semantic verbs
6. [views] Ratchet: assert every builtin view on-screen mutation maps to a registered action
