# Chat UI Review — `packages/ui`

_Review date: 2026-06-04. Scope: the chat surface in `@elizaos/ui`
(`packages/ui/src`), keyed to the working-notes backlog. Each note below has a
**Current state** (what exists today, with `file:line` citations) and a
**Recommendation** (what to build/fix)._

All paths are relative to `packages/ui/src` unless noted.

---

## Architecture at a glance

Three distinct chat surfaces coexist; understanding which is which is essential
to the notes below:

| Surface | File | Role |
| --- | --- | --- |
| **ContinuousChatOverlay** | `components/shell/ContinuousChatOverlay.tsx` | The ambient, always-mounted `/chat` overlay. Glassmorphic floating composer + collapsible "whisper" transcript. Non-blocking (`pointer-events-none` root). This is the primary chat the user sees on top of every view. |
| **ChatView** | `components/pages/ChatView.tsx` (~862 lines) | The full-page chat workspace: sidebar, multi-channel (inbox/terminal), image attachments, task creation, voice, typing indicators. Routed destination. |
| **PageScopedChatPane** | `components/pages/PageScopedChatPane.tsx` | Chat embedded inside another page (e.g. Browser view). |
| **ChatSurface** | `components/shell/ChatSurface.tsx` | Legacy/simpler fallback surface. Candidate for deletion (see Slop note). |

Shared composites live in `components/composites/chat/` (composer, transcript,
bubble, message, attachment-strip, sidebar, voice status bar, toggles).
State is a `useReducer` in `state/useChatState.ts` with an isolated
`state/ChatComposerContext.tsx` for input/images to limit re-renders.
Message → interactive-widget parsing is centralized in
`components/chat/MessageContent.tsx`.

**Overall verdict: the chat is genuinely slick.** Glassmorphism + backdrop
blur, whisper fade (`transition-opacity duration-1000`), listening/responding
"breath" aura, memoized transcript rows, debounced draft persistence,
ResizeObserver-driven composer reflow, and proper `aria-live` regions. The
engineering is solid (B+/A-). The gaps below are mostly *missing features* and a
few *unwired seams*, not broken foundations.

---

## 1. "Chat is slick af" — overall quality

**Current state.** Confirmed slick. Strengths:
- Ambient overlay that never traps focus; whispers recent lines and dissolves
  them on collapse (`ContinuousChatOverlay.tsx:475–492`).
- Listening/responding breath aura (`ContinuousChatOverlay.tsx:555–566`).
- Memoized `ChatMessage`/`ChatTranscript` with custom comparators to avoid
  per-token re-renders.
- Smart trailing action button that swaps send/stop/mic by state
  (`chat-composer.tsx`).

**Rough edges worth tracking:**
- Typing indicator shows only while `chatSending && !chatFirstTokenReceived`
  with **no timeout guard** — a stalled stream leaves dots forever
  (`ChatView.tsx:588–597`).
- Off-screen textarea-clone measurement hack in the composer
  (`chat-composer.tsx:67–88`) — necessary but DOM-polluting.
- Conversation switch snaps with no transition; stale messages can flash
  (`ChatView.tsx:361–370`).
- `MAX_CHAT_IMAGES` is defined in two places with different framing
  (`PageScopedChatPane.tsx:57` vs overlay default) — consolidate.

**Recommendation.** Keep the aesthetic. Add a typing-indicator timeout, hoist
`MAX_CHAT_IMAGES` to one constant, and add a short cross-fade on conversation
switch. These are polish, not blockers.

---

## 2. Upload button in chat

**Current state. Already implemented and wired.**
- Overlay: attach button at `ContinuousChatOverlay.tsx:639+`
  (`SoftButton` "attach image" → `fileInputRef.current?.click()`), hidden
  `<input type="file" accept="image/*" multiple>` at
  `ContinuousChatOverlay.tsx:604–614`, pending-image strip + inline error above
  the composer (`568–603`).
- ChatView: `<Paperclip>` button `chat-composer.tsx:568–595` (inline variant
  uses `<Plus>` at `377–392`); hidden input `ChatView.tsx:676–683`;
  drag-and-drop on the thread (`ChatView.tsx:519–528`).
- Processing via `filesToImageAttachments()` (`utils/image-attachment.ts`),
  capped at `MAX_CHAT_IMAGES = 4`, previewed inline, individually removable
  (`chat-attachment-strip.tsx:13–54`).

**Gap.** Images only — `accept="image/*"`. No documents/audio/arbitrary files.
No filename/size metadata exposed to the agent (base64 data URIs only).

**Recommendation.** The note is effectively **done for images**. If the intent
is general file upload, widen `accept`, add a non-image file chip in the strip,
and thread filename/MIME/size through `ImageAttachment` → send payload. Otherwise
mark this note complete.

---

## 3. Button to go to chat view from chat (make chat full screen?)

**Current state. Missing as described.** The overlay's chevron
(`ContinuousChatOverlay.tsx:618–634`) only **expands/collapses the overlay's own
transcript** (`max-h-[58vh]`); it does **not** navigate to the full-page
`ChatView`. `ChatView` itself has no "expand" button because it *is* the routed
full surface. There is no affordance bridging overlay → full page.

**Recommendation.** Add an explicit "open full chat" control in the overlay bar
(distinct from the expand chevron) that dispatches the existing view-navigation
event to the `chat` tab:
`window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail: { viewId: "chat", viewPath: "/chat" } }))`
(mechanism in note 4). Carry the active conversation id across so the full view
opens the same thread. Low effort — the navigation plumbing already exists.

---

## 4. Test & validate view switching with e2e and scenarios

**Current state.** View switching is **explicit/agent-commanded** and reasonably
covered. Full path:
1. Agent → `POST /api/views/:id/navigate` (`packages/agent/src/api/views-routes.ts:746–806`).
2. Backend broadcasts WS `shell:navigate:view`.
3. `state/startup-phase-hydrate.ts:414–444` validates + redispatches DOM
   `eliza:navigate:view`.
4. `App.tsx:1335–1345` → handler `app-navigate-view.ts:63–127` routes to tab /
   pin-tab / open-window / fallback path; records recent (`view-recents.ts`).

**Existing coverage:**
- Unit: `app-navigate-view.test.ts` (8 tests), `App.navigate-view-wiring.test.tsx`
  (4 tests), `startup-phase-hydrate.view-interact.test.ts` (WS→DOM).
- E2E: `packages/app/test/ui-smoke/view-manager-actual-flow.spec.ts` (CRUD +
  switch + open + delete), `packages/app/test/view-interaction-coverage.test.ts`
  (debt tracker, `MAX_INTERACTION_DEBT = 0`).

**Gaps:**
- No single end-to-end test exercising the real WS→DOM→handler→render chain
  (the wiring test mocks the bridge).
- No scenario test that drives view switching *from a chat message/agent action*
  (the user-facing path implied by these notes).
- Mobile/TUI view switching only covered indirectly.

**Recommendation.** Add (a) a scenario where an agent turn triggers a view
switch and asserts the active tab changed, and (b) one integration test that
feeds a real `shell:navigate:view` WS frame and asserts the rendered view. These
close the gap between "navigation API tested" and "chat-driven navigation
tested."

---

## 5. Passive / contextual view switching

**Current state. Does not exist.** Every switch is explicit (agent POST, user
click, or deep link). Verified absent in `startup-phase-hydrate.ts`,
`app-navigate-view.ts`, navigation state, and chat send paths — no
content/conversation heuristic auto-navigates.

**Recommendation.** Introduce a *separate, lower-trust* signal rather than
overloading the explicit one. Options:
- New WS event `shell:suggest:view` carrying `{ viewId, trigger, confidence }`,
  surfaced as a **dismissible suggestion chip** (ties directly into note 9's
  followups UI) rather than an automatic jump — avoids surprising the user.
- Auto-switch only above a confidence threshold and only for low-risk views;
  always show a toast with undo.

Design decision required: passive switching should almost certainly be
*suggested*, not *forced*. Recommend building it as a followup/recommendation
affordance (note 9) first.

---

## 6. Voice UX — always-listening and push-to-talk

**Current state.** Three modes defined in
`voice/voice-chat-types.ts:82–99`: `off` (push-to-talk), `vad-gated`,
`always-on`. Toggle UI is polished (`ContinuousChatToggle.tsx`, wide pills +
compact cycle button, persisted to localStorage). Status feedback is rich
(`ChatVoiceStatusBar.tsx`: status dot, label, speaker pill w/ owner crown, live
interim transcript, traffic-light latency badge). Interrupt-on-speech pulse and
avatar mouth bridge both work (`useContinuousChat.ts:200–230`,
`useChatAvatarVoiceBridge.ts`).

**Gaps (the polish that "always listening + PTT" needs):**
- **No client-side VAD / end-of-turn detection.** `vad-gated`/`always-on` enter
  "passive" mode (`useContinuousChat.ts:162–183`) but rely entirely on the
  backend/TalkMode plugin to emit `isFinal:true`. `LocalAsrAutoStopOptions`
  exist (`voice/local-asr-capture.ts`) but are **not surfaced in settings**.
- **Push-to-talk has no shell "listening" phase.** Reserved in the type surface
  but not yet surfaced in shell UI
  (`components/shell/shell-state.d.ts:8–10`); PTT records via
  `useShellController.ts:159–198` but the pill shows no listening state.
- Browser SpeechRecognition silently auto-restarts on drop
  (`useVoiceChat.ts:742–754`) — no "mic reconnected" signal.
- AudioContext autoplay-suspension tracked but no "tap to enable audio" prompt
  (`useVoiceChat.ts:220–229`).
- Wake-word toggle is a prop slot, not wired (`components/settings/VoiceSection.tsx`).
- "thinking" status has no timeout bound (`useContinuousChat.ts:272–287`).

**Recommendation.** Prioritize: (1) implement the shell `listening` phase so PTT
has visible feedback; (2) add a browser-side VAD fallback (e.g. Silero) for
`always-on`/`vad-gated` when SpeechRecognition is the backend; (3) surface
`LocalAsrAutoStopOptions` in `VoiceSection`; (4) add an intermediate
"detecting end of turn" status and bound the "thinking" state. The contracts
(cancellation token `useContinuousChat.ts:42–49`) are flagged for a future R11
cross-layer spec — align with that.

---

## 7. In-chat request for secrets and OAuth

**Current state. Secret collection works; OAuth is request/pick only — no
end-to-end orchestration.**
- Data model `ConversationSecretRequest` + `SensitiveRequestForm`
  (`api/client-types-chat.ts:144–166`) with 6 delivery modes.
- Rendered by `SensitiveRequestBlock` (`components/chat/MessageContent.tsx:920–1033`):
  shows reason/status, renders form when `pending` and
  `canCollectValueInCurrentChannel`, `type="password"` for secrets, POSTs to
  `client.updateSecrets()`, never echoes the value into chat.
- Connector/OAuth: `ConnectorAccountPicker.tsx` (choose existing account) and
  `AccountRequiredCard.tsx` (blocking card with Connect/Reconnect/Confirm),
  triggered on `isLikelyAccountRequiredError` in `ChatView.tsx`.

**Gaps.**
- No orchestrated OAuth loop (request → external auth → return → auto-retry the
  original action). Reconnect is a manual button press.
- The 6 `SensitiveRequestDelivery.mode` values are declared but UI always renders
  inline when collectable; cloud-link/DM routing isn't visible in the UI layer.

**Recommendation.** Build the OAuth round-trip: on `needs-reauth`, open the auth
flow, and on return re-dispatch the pending action automatically (carry a
`retryToken`). Audit/wire the non-inline delivery modes or trim the enum to
what's actually routed. Secret-form path is solid as-is.

---

## 8. In-chat request for form

**Current state. No generic form widget — only type-specific forms.** The
message-parsing pipeline (`MessageContent.tsx:307–433`, `parseSegments`)
recognizes: `permission_request` JSON, `[CONFIG:@plugin]`, `[CHOICE:…]`,
fenced-JSON `UiSpec`, and RFC-6902 JSONL patches → compiled `UiSpec`. Forms
exist for **secrets** (`SensitiveRequestBlock`) and **plugin config**
(`InlinePluginConfig`, `MessageContent.tsx:435–797`). Agent-generated UI renders
via `UiSpecBlock` + `UiRenderer` with an action callback
(`MessageContent.tsx:801–898`).

**Gap.** No reusable "agent asks the user to fill arbitrary fields X/Y/Z" form
request distinct from secrets/config.

**Recommendation.** Two viable paths:
- **Reuse GenUI** — the `UiSpec`/`UiRenderer` path already renders
  agent-authored interactive UI with action callbacks; define a small form
  schema and a `form:submit` action. Lowest new surface area.
- Or generalize `SensitiveRequestForm` into a `RequestForm` with `kind: "form"`
  (non-secret) and a result-delivery callback.

Prefer the GenUI route since the rendering + action plumbing already exists.

---

## 9. Chat recommendations / followups  &  10. Making followups organic/dynamic

**Current state. Completely absent.** No "suggested next action", quick-reply,
or "related" affordance anywhere in chat (grep across `components/chat/` returns
nothing beyond i18n/comments). Adjacent-but-different: `ChatEmptyState`
suggestion buttons (starter prompts only, `chat-empty-state.tsx:22–95`),
`ChoiceWidget` (agent-driven disambiguation, not open-ended suggestions),
`SaveCommandModal` (save *your own* message as a command).

**Recommendation.** This is the biggest greenfield item and the hinge for notes
5 and 11.
- **Rendering:** add a `followups` segment to the same parser
  (`MessageContent.tsx`) — render as a chip row under the latest assistant
  message; reuse `ChoiceWidget` styling.
- **Source (organic/dynamic):** generate followups server-side from the turn's
  context (the agent already produces structured output) rather than
  client-side heuristics, so they stay grounded. Stream them as a trailing block
  on the assistant message. Make them *actions*, not just text: a followup can be
  "open wallet view" (note 5), "create task" (note 11), "fill this form"
  (note 8), or a plain reply prompt. That unifies followups with view-switch
  suggestions and task drill-downs.
- Keep them dismissible and capped (2–4) to avoid clutter.

---

## 11. Show tasks created; click task → orchestrator task view

**Current state. Tasks are created and displayed, but the click-through is
unwired.**
- **Create:** `create-task-popover.tsx` (prefills from composer, agent-type
  select) → `ChatView.handleCreateTask` (`ChatView.tsx:296–303`) sends a message
  with `metadata: { intent: "create_task", agentType }`.
- **Display:** `useActivityEvents.ts:104–137` ingests `pty-session-event` WS
  frames (`task_registered`, `task_complete`, `tool_running`, …); rendered in the
  sidebar `OrchestratorActivityWidget` (`components/chat/widgets/agent-orchestrator.tsx:198–250`).
- **The view exists:** `TasksPageView` (`components/pages/TasksPageView.tsx`) →
  `CodingAgentTasksPanel` slot (implemented in `@elizaos/plugin-task-coordinator`),
  routed at the `tasks` tab (`App.tsx:614–618`).

**Gap (verified).** Activity rows have hover styling (`hover:bg-bg-hover/40`,
`agent-orchestrator.tsx:227`) **but no `onClick`** — no navigation from a task in
chat to the task view. The plumbing pattern already exists elsewhere:
`AppRunsWidget` does `setTab("apps")` + state (`agent-orchestrator.tsx:447–483`),
and `focusTerminalSession` switches terminals (`ChatView.tsx:241–246`).

**Recommendation.** Wire an `onClick` on activity rows:
- If `event.sessionId` present → focus that PTY/terminal session (reuse
  `focusTerminalSession`).
- Otherwise → `setTab("tasks")` to open `TasksPageView`.
- Stretch: add per-task deep linking (sessionId in route) so the orchestrator
  view can scroll to / select the specific task. Today `TasksPageView` renders
  the whole panel with no task param.

---

## Cross-cutting recommendation: one chat-message block system

Notes 5, 7, 8, 9, and 11 all want the agent to surface an **interactive
affordance inside chat** (suggest a view, request a secret/form, propose
followups, show a clickable task). The parser in `MessageContent.tsx` is already
the right home — it has segment kinds for choice/permission/config/ui-spec.
Adding `followups` and a generic `form`/`action` segment, and wiring task rows to
navigate, would knock out five notes with one coherent mechanism instead of five
bespoke ones. Build the segment-level "agent action chip" once; reuse for
view-switch suggestions, task drill-down, and followups.

---

## Priority summary

| Note | Status | Effort | Priority |
| --- | --- | --- | --- |
| 2 Upload button | Done (images) | — | Verify intent, else close |
| 1 Slick / polish | Done; minor fixes | Low | Low |
| 11 Task click-through | Unwired (~90% there) | Low | **High** (quick win) |
| 3 Overlay → full chat | Missing affordance | Low | **High** (quick win) |
| 4 View-switch tests | Partial | Low–Med | Med |
| 7 Secrets/OAuth | Secrets done; OAuth loop missing | Med | Med |
| 8 In-chat form | Reuse GenUI | Med | Med |
| 6 Voice PTT/always-on | Modes exist; VAD + listening phase missing | Med–High | **High** |
| 9/10 Followups | Absent | Med–High | **High** (unlocks 5) |
| 5 Passive view switch | Absent | Med | Med (build on 9) |

**Suggested sequence:** quick wins first (11 task click-through, 3 overlay→full
chat), then the unifying followups/action-chip system (9/10) which de-risks 5,
then voice polish (6) and OAuth orchestration (7), with form (8) riding on the
GenUI path.
