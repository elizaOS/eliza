# Shell Foundation — Design Spec

- **Date**: 2026-05-16
- **Status**: Draft, pending user review
- **Sub-project**: #1 of 4 (shell foundation → conversation persistence → wake word → thread management)
- **Branch**: `shell-foundation` (off `upstream/shaw/eliza-app-release-blockers` at `5d5545f2b5`)
- **Worktree**: `/Volumes/OWC Envoy Pro FX/desktop/eliza/eliza-shell-foundation`
- **v1 implementation**: landed via the tasks in `2026-05-17-shell-foundation-implementation-plan.md` (this branch's commits prefixed `feat(shell)` and `fix(shell)`)

## Context

The ElizaOS Platform brand architecture defines three product surfaces (OS, App, Cloud) and a device-shell layer for the Eliza App / ElizaOS device experience: a persistent home pill, an assistant overlay that rises from the pill, and a chat surface for talking to the agent.

The mockups show three visible states:

1. **Empty dark surface with red glowing pill** — assistant active/listening
2. **Chat overlay** — bubbles ("Good morning! What would you like to do?" / "Remind me to call Alex at 3pm" / "Done — reminder set for 3:00 PM.") with input row ("+", "Ask Eliza…", mic, send arrow) and the pill at the very bottom
3. **Blue-sky desktop wallpaper with status bar and dim pill at bottom** — idle on ElizaOS desktop

This sub-project lays the foundation. Three follow-up sub-projects (persistence, wake word, threading) layer on top after this one ships.

## Scope

### In scope

- `HomePill` component, all visual states (booting / idle / summoned / listening / responding)
- `AssistantOverlay` — sheet that rises from the pill, registered with the existing `ShellOverlays` system
- `ChatSurface` — message bubbles + input row (text + push-to-talk mic + send)
- `AmbientGlow` — pure visual halo around the pill (red glow, dim, etc.)
- `shell-state.ts` — state machine (single source of truth) for the five states + transitions
- `useShellState.ts` — React hook for components to read/dispatch shell state
- Ambient wallpaper integration — extend `packages/ui/src/backgrounds/registry.ts` with shell-aware modes
- Mount the pill in the existing `App` component as a sibling to `StartupShell`
- Storybook stories for all states
- Unit tests for state machine, Playwright smoke for end-to-end interaction
- Design-review extension following the existing `packages/app/test/design-review/` pattern

### Out of scope (this sub-project)

- Cross-session conversation history persistence → sub-project #2
- Wake word ("Hey Eliza") always-on hotword detection → sub-project #3
- Thread list, thread switching, thread auto-naming → sub-project #4
- TTS for agent responses → deferred to v2 entirely (not one of the four sub-projects)

## Architecture

### Where the work lives

All new files in `packages/ui/src/components/shell/`, alongside the existing 25-file shell directory Shaw and the team are actively iterating in. This is **Option B** from scoping — primitives + composition in `packages/ui`, mounted by `packages/app`.

```
packages/ui/src/components/shell/
  ├── (existing — Shaw et al.)
  │   ├── StartupShell.tsx                ← front door, controls visibility through boot phases
  │   ├── RuntimeGate.tsx                 ← gates the runtime (Shaw plans to retire once nothing references it)
  │   ├── ShellOverlays.tsx               ← overlay registry — AssistantOverlay registers here
  │   ├── ProvisioningChatView.tsx        ← existing chat pattern; ChatSurface borrows from it
  │   ├── PairingView.tsx, StartupFailureView.tsx, …
  │   └── (20+ more existing files)
  │
  └── (new — this sub-project)
      ├── HomePill.tsx                    ← the pill itself
      ├── AssistantOverlay.tsx            ← drawer/sheet, registered into ShellOverlays
      ├── ChatSurface.tsx                 ← bubbles + input row
      ├── AmbientGlow.tsx                 ← pure visual halo
      ├── shell-state.ts                  ← state machine (reducer)
      └── useShellState.ts                ← React hook

packages/ui/src/backgrounds/
  ├── BackgroundHost.tsx                  ← extended to listen to shell state
  └── registry.ts                         ← extended with shell-aware modes (dim-dark, dimmed-active, bright-desktop)

packages/ui/src/index.ts                  ← export new public components
packages/app/src/main.tsx (or App)        ← mount HomePill + AssistantOverlay sibling to StartupShell
packages/ui-stories/src/stories/shell.tsx ← new Storybook stories
packages/app/test/ui-smoke/shell-foundation.spec.ts ← new Playwright smoke
packages/app/test/design-review/run-shell-foundation-review.ts ← new design-review extension
```

### Branch strategy

- Branched from `upstream/shaw/eliza-app-release-blockers` at `5d5545f2b5`
- Rebase daily while Shaw's branch is active; if/when Shaw merges to `develop`, rebase from `develop` instead
- New files only in the first pass; existing files touched only at three required integration points (see Integration below)

### Mount strategy

`HomePill` and `AssistantOverlay` mount as **siblings** to Shaw's `StartupShell`, inside the existing `App` component from `@elizaos/ui`. The pill is **always present** — its `booting` state covers the period during which `StartupShell` dominates the visible surface. Z-index orders the pill above the splash so it remains visible.

```tsx
<App>
  <StartupShell />     {/* Shaw — dominates during boot */}
  <HomePill />         {/* New — always visible, dim during boot, lifecycle-aware */}
  <AssistantOverlay /> {/* New — registered with ShellOverlays, opens on pill tap */}
</App>
```

This matches the three mockup states: pill on dark empty surface (booting), pill on chat (summoned/listening/responding), pill on desktop (idle).

## Components

### `HomePill.tsx`

Persistent pill, 40-ish px tall, positioned bottom-center with a small safe-area inset. Reflects the current shell state visually. Interactions:

- **Tap** → `idle → summoned` (open overlay) or `summoned → idle` (close)
- **Long-press** → reserved for context menu (not implemented in v1; gesture detected but no-op)
- **Drag up** → equivalent to tap (summon overlay)
- **Drag down** while summoned → close overlay

Visual layers: solid pill body + `AmbientGlow` halo behind it (only renders in non-idle states).

### `AssistantOverlay.tsx`

The sheet/drawer that rises from the pill when the shell is `summoned`, `listening`, or `responding`. Hosts `ChatSurface` as its primary content.

- Registers with the existing `ShellOverlays` registry (do not bypass — coordinate with sibling overlays like `CommandPalette`, `ShortcutsOverlay`, `BugReportModal`, `ConnectionLostOverlay`)
- Open animation: rises from pill position, settles into a sheet that covers ~80% of the viewport on mobile and a centered drawer on desktop
- Dismissal: tap outside, swipe down, press Escape, or tap pill again
- Focus management: when opened, focus moves to the chat input; when closed, focus returns to the pill

### `ChatSurface.tsx`

The chat content. Renders inside `AssistantOverlay`. Composed of:

- **Bubble stack** — agent and user messages, newest at bottom. Streaming agent replies append to the active bubble character-by-character.
- **Input row** — left-aligned `+` button (reserved, no-op in v1), `<input>` with placeholder `"Ask Eliza…"`, right-aligned mic button (push-to-talk), right-aligned send arrow (enabled when input is non-empty).
- **Empty state** — when no messages exist for this session, show a greeting (e.g., "Good morning! What would you like to do?"). Greeting text is i18n-keyed.

Where possible, borrow primitives or patterns from `ProvisioningChatView.tsx` rather than re-implementing bubbles and streaming logic from scratch. Extract shared atoms if and only if both surfaces would benefit (YAGNI).

### `AmbientGlow.tsx`

Pure visual. Renders the halo around the pill:

- `booting` — no halo; pill body itself appears dimmed
- `idle` — no halo
- `summoned` — faint halo (low opacity)
- `listening` — red, pulsing on audio level (RMS hooked to a CSS variable)
- `responding` — soft glow, gentle ambient pulse

Implementation: CSS-only animation (no JS animation loop) — use `transform`, `opacity`, `filter: blur()`, and a `@keyframes` pulse. Honors `prefers-reduced-motion` by falling back to a static glow.

### `shell-state.ts`

Single source of truth for the state machine. Five states:

```
booting    → StartupShell phase ≠ ready
idle       → ready, no overlay open
summoned   → overlay open, no active mic/response
listening  → mic active (push-to-talk held)
responding → agent streaming a reply
```

Implementation: plain reducer (`type Action = …; function reducer(state, action): State`). No xstate dependency — the transitions are simple enough and the team's pattern in the existing shell uses plain hooks + reducers.

Transitions documented in the table below.

### `useShellState.ts`

React hook exposing `{ state, send }` to components. Internally subscribes to:

- `useApp()` `startupCoordinator.phase` → drives `booting ↔ idle`
- `client` agent stream events → drives `responding → summoned`
- `APP_PAUSE_EVENT` / `APP_RESUME_EVENT` → mobile lifecycle handling
- `NETWORK_STATUS_CHANGE_EVENT` → enriches state with `isOnline` flag (does not change state, but affects visuals)

## State machine — transitions

| From | To | Driver | Where it fires |
|---|---|---|---|
| `booting` | `idle` | `startupCoordinator.phase === "ready"` | `useShellState` subscribes to `useApp()` |
| `idle` | `summoned` | Tap pill | `HomePill` onClick dispatches `OPEN` |
| `summoned` | `idle` | Tap pill / swipe down / Escape | `HomePill` / `AssistantOverlay` dispatch `CLOSE` |
| `summoned` | `listening` | Hold mic button | `ChatSurface` mic onPointerDown dispatches `START_LISTEN` |
| `listening` | `summoned` | Release mic button (cancelled) | mic onPointerUp with empty transcript dispatches `CANCEL_LISTEN` |
| `listening` | `responding` | STT transcript ready OR text submitted | `client.sendMessage(...)` invoked, dispatches `SEND` |
| `responding` | `summoned` | Agent stream `message-done` event | `client` event listener dispatches `RESPONSE_DONE` |
| `responding` | `summoned` | Agent stream error | error listener dispatches `RESPONSE_ERROR` + toast |

Invalid transitions are no-ops (logged in dev, silent in prod).

App lifecycle (`APP_PAUSE_EVENT` / `APP_RESUME_EVENT`) is handled out-of-band by `useShellState`, not by the transition table. See **Error handling and edge cases** for state-specific pause/resume behavior.

## Data flow

```
User taps HomePill
    ↓
HomePill onClick → useShellState.send({ type: "OPEN" })
    ↓
reducer: idle → summoned
    ↓
AssistantOverlay (subscribes to state) opens

User types "Remind me to call Alex at 3pm" + Enter
    ↓
ChatSurface input onSubmit → useShellState.send({ type: "SEND", text })
    ↓
reducer: summoned → responding (and appends user bubble to in-memory message list)
    ↓
client.sendMessage(text)  ← existing @elizaos/ui client
    ↓ stream events
on "message-delta"  → append to active agent bubble (streaming)
on "message-done"   → useShellState.send({ type: "RESPONSE_DONE" }) → summoned
on "error"          → useShellState.send({ type: "RESPONSE_ERROR" }) → summoned + toast
```

### Push-to-talk voice (v1)

```
User holds mic button in ChatSurface
    ↓
mic onPointerDown → request mic permission (cached after first grant)
    ↓ on grant
useShellState.send({ type: "START_LISTEN" }) → listening
    ↓
start STT adapter:
  - desktop: Web Speech API
  - mobile (Capacitor): @capacitor/microphone + STT plugin (TBD during impl)
    ↓
visual: AmbientGlow goes red, halo pulses on audio level (RMS hooked to CSS variable)
    ↓
User releases mic
    ↓
mic onPointerUp
  - if transcript empty → send CANCEL_LISTEN → summoned
  - if transcript present → useShellState.send({ type: "SEND", text: transcript }) → responding
    ↓
(same flow as typed input from here)
```

### Reuses these existing things from Shaw's stack

- `client` from `@elizaos/ui` (the same one `StartupShell` uses)
- `CONNECT_EVENT`, `AGENT_READY_EVENT`, `APP_PAUSE_EVENT`, `APP_RESUME_EVENT`, `NETWORK_STATUS_CHANGE_EVENT` from the existing event bus
- `useApp()` for boot phase, agent ready state, network status
- `ProvisioningChatView.tsx` patterns for bubble rendering and streaming
- `ShellOverlays` registry — `AssistantOverlay` registers here, doesn't bypass
- `BackgroundHost` + `backgrounds/registry.ts` — extended, not replaced

No new infrastructure. All wiring reuses Shaw's existing channels.

## Integration with Shaw's branch

### Files touched (existing — three required integration points)

- `packages/ui/src/components/shell/StartupShell.tsx` — no change in this sub-project (pill is a sibling, not nested). May be touched in follow-up to coordinate animation hand-off.
- `packages/ui/src/backgrounds/BackgroundHost.tsx` — subscribe to shell state, swap registered mode.
- `packages/ui/src/backgrounds/registry.ts` — register three new modes (`dim-dark`, `dimmed-active`, `bright-desktop`).
- `packages/ui/src/index.ts` — export `HomePill`, `AssistantOverlay`, `ChatSurface`, `useShellState`, types.
- `packages/app/src/main.tsx` (or the `App` component in `@elizaos/ui`) — mount the pill and overlay as siblings to `StartupShell`. Exact location is the first thing to verify during implementation.

### Rebase cadence

- Rebase against `upstream/shaw/eliza-app-release-blockers` daily during active development
- If Shaw merges to `develop` mid-flight, switch base to `develop`
- Coordinate via PR description and Discord — flag the pill as the "deeper GUI/voice work" his [PR #7751](https://github.com/elizaOS/eliza/pull/7751) referred to

### Risk

Shaw's branch is moving fast (multiple commits per hour as of this writing). Some shell internals may shift. Mitigation: keep our changes additive and avoid editing his files except at the three required integration points.

## Error handling and edge cases

- **Agent unreachable but network is online** — inline error in overlay ("Couldn't reach Eliza. Retry?"), pill stays normal, partial reply preserved with "interrupted" affordance.
- **Network offline** (`NETWORK_STATUS_CHANGE_EVENT === "offline"`) — pill muted/grey tint, mic disabled, input placeholder changes to "Reconnecting…".
- **Mid-stream disconnect** — keep partial reply, mark with "interrupted", allow retry.
- **Mic permission denied** — show a one-time toast linking to system settings, disable mic button until permission is regranted.
- **App pause on mobile during `listening`** — abort listen, drop transcript-in-progress, return to `summoned`.
- **App pause during `responding`** — keep stream alive in the background if the platform allows; otherwise mark partial reply as "interrupted" on resume.
- **Invalid state transition** — no-op, log in dev, silent in prod.

## Testing strategy

| Layer | Coverage | Tool | Location |
|---|---|---|---|
| State machine | All transitions, invalid transition rejection | Vitest unit | `packages/ui/src/components/shell/__tests__/shell-state.test.ts` |
| Components (visual) | Every state of HomePill, AssistantOverlay open/closed/error, ChatSurface empty/streaming/error | Storybook | `packages/ui-stories/src/stories/shell.tsx` |
| Component logic | Interactions, keyboard shortcuts, focus management, ARIA | Vitest + React Testing Library | `packages/ui/src/components/shell/__tests__/HomePill.test.tsx`, etc. |
| Wiring with StartupShell | Pill renders alongside, z-index correct, transitions cleanly at `phase=ready` | Storybook composite story | `packages/ui-stories/src/stories/shell-with-startup.tsx` |
| End-to-end | Tap pill → overlay opens → type → see mocked response | Playwright smoke | `packages/app/test/ui-smoke/shell-foundation.spec.ts` |
| Design review | Visual regression for pill states vs mockups | Existing design-review pattern | `packages/app/test/design-review/run-shell-foundation-review.ts` |

## Open questions to resolve during implementation

1. **Exact mount point**: is it `packages/app/src/main.tsx` or inside the `App` component in `@elizaos/ui`? Read `App` source on Shaw's branch first to decide.
2. **Mic permissions UX on iOS**: `VoicePrefixGate` already prompts for voice intent — can we piggyback on its permission grant, or do we need a separate mic-permission prompt? Investigate the existing flow.
3. **Overlay choreography**: spring-based (framer-motion) vs CSS transitions — check what `ShellOverlays` and sibling overlays already use, match the pattern.
4. **Z-index strategy**: design-token variable vs hard-coded — check existing convention in `ShellOverlays.tsx`.
5. **Boot-state pill visual**: pure grey, or a desaturated brand color? Designer call before implementation begins.
6. **STT adapter on mobile**: `@capacitor/microphone` + which STT? Web Speech API doesn't ship on iOS WebView consistently. Investigate during impl, may need a server-side fallback.
7. **i18n keys**: greeting text and all UI strings need i18n. Follow existing convention (look at `onboarding-theme.ts` and shell-component i18n keys for the pattern).

These do not block writing this spec — they get decided in the implementation plan or during implementation itself.

## Related work (future sub-projects)

This is sub-project #1 of 4 that together deliver "v1" of the device-shell revamp:

### #2 — Conversation persistence

- Local storage layer (IndexedDB on desktop/web, `@capacitor/preferences` + SQLite on mobile)
- Schema: `conversations(id, created_at, updated_at, title)` + `messages(id, conversation_id, role, content, created_at)`
- Auto-save during conversation, load on overlay open (most recent thread by default)
- Pruning policy: keep last N conversations or last X MB, user-configurable
- Clear-all in settings, with confirmation
- **Depends on**: #1 (shell foundation must exist)
- **Unblocks**: #4 (threading needs persistence)

### #3 — Wake word ("Hey Eliza")

- SDK eval: Porcupine vs openWakeWord vs Picovoice — pick one based on (a) license, (b) custom-wake-word training feasibility, (c) per-platform support
- Always-on permission UX (separate from push-to-talk permission)
- Background listener lifecycle — start on app launch (if user opted in), pause on `APP_PAUSE_EVENT`, resume on `APP_RESUME_EVENT`
- Hotword detection triggers `START_LISTEN` directly (skips `idle → summoned → listening` and goes straight to `listening` with the overlay opening simultaneously)
- Settings: enable/disable, sensitivity, choose wake word (if SDK supports custom)
- **Depends on**: #1
- **Independent of**: #2, #4 (can be built in parallel)

### #4 — Thread management

- Thread list view inside the overlay (a tray or sidebar)
- New-thread button
- Switch active thread → re-mount `ChatSurface` with that thread's message history
- Auto-name threads (first user message, or LLM-generated title)
- Delete-thread UX with confirmation
- `useShellState` gains an `activeThreadId` field
- **Depends on**: #1 and #2

### Deferred to v2 (outside the 4-sub-project sequence)

- TTS for agent responses — voice selection, mute control, queue management, Web Speech API on desktop / native TTS on mobile.

## Success criteria

This sub-project is done when:

1. All six new components exist with their documented responsibilities and tests pass.
2. The pill renders in the running Eliza App in all five states.
3. Tapping the pill opens an overlay that lets a user type a message and see a streamed reply from the agent (mocked or live).
4. Push-to-talk mic works on desktop (Web Speech API) and at minimum produces a captured transcript on mobile (full STT pipeline may need follow-up).
5. Storybook coverage for every state.
6. Playwright smoke passes in CI.
7. Design review (visual regression against mockups) approved.
8. PR merged to `shaw/eliza-app-release-blockers` (or rebased onto `develop` and merged there if Shaw's branch has landed).
