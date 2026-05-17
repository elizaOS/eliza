# Onboarding Reimagined — Integration & Migration Plan

Date: 2026-05-15
Supersedes: nothing. Extends `onboarding-reimagined-prd.md`, `onboarding-reimagined-implementation-plan.md`, and `prototypes/onboarding-reimagined/index.html`.

## What this plan adds on top of the existing PRD

The existing PRD/plan defined the new sky/cloud companion onboarding and the post-onboarding companion screen. This plan locks in three product changes that the PRD only hinted at, then maps every piece of current code that has to move:

1. **Home replaces Chat as the default app surface.** The "companion screen" in the PRD is not a post-onboarding chat view — it is the new top-level **Home view**, used on every platform (web, desktop, iOS, Android, AOSP, Linux). Onboarding is *the same surface* in a setup state; when setup completes the surface stays mounted and transitions to its idle home state. There is no navigation event.
2. **Chat becomes a secondary view, opened by intent.** What is today the main chat page becomes one of many openable views (`VIEW_OPEN chat`). The agent opens it on commands like "open chat", "open the dashboard", "show me the chat view". It is not in primary navigation.
3. **Home is the full-screen shell on platforms we control.** On AOSP and Linux (and any kiosk-style deploy), Home is the only window — no OS chrome, no other launcher. On those platforms we render a native-looking status bar inside Home: time on the left; power/battery, wifi, cell, audio output on the right. On platforms with a real OS status bar (iOS, Android stock, macOS, Windows), we suppress our own status bar and let the OS handle it.

Everything else inherits from the existing PRD and workstream plan.

## Hard constraints (carry-overs that must not be lost)

- Every backend call in today's onboarding must be preserved (cloud login, bootstrap exchange, agent provisioning, model registry/HF search, local model download, hardware probe, plugin enable, voice profiles, mobile runtime mode, remote pairing). Only the UI is being rewritten.
- Current UI lives behind `ELIZA_NEW_ONBOARDING=0` and stays shippable until the new flow passes E2E on web/desktop/iOS/Android.
- Architecture commandments in `AGENTS.md` apply: backend logic stays in services/use-cases; the new home view is presentation-only and reads DTOs.

## Backend surfaces to preserve (audit & move)

Source of truth for each, gathered from the current onboarding:

| Capability | Today's owner | Disposition |
| --- | --- | --- |
| Cloud login + bootstrap | `client.bootstrapExchange()` in `packages/ui/src/api/client-agent.ts`, `BootstrapStep.tsx` | Reused as-is by new Cloud card; Bootstrap UI deleted |
| Cloud agent picker | `RuntimeGate.tsx:1478+` cloud panel | **Removed.** PRD: one cloud agent per user |
| Local agent probe | `packages/ui/src/onboarding/probe-local-agent.ts` | Reused; informs On-Device card disabled state |
| Local model auto-download | `packages/ui/src/onboarding/auto-download-recommended.ts` | Reused; promoted from background to first-class progress UI |
| Hardware probe | `packages/app-core/src/services/local-inference/hardware.ts` | Reused; needs disk-space probe added (Workstream D) |
| Mobile runtime mode | `packages/ui/src/onboarding/mobile-runtime-mode.ts` | Reused as-is |
| Remote pairing | `RuntimeGate.tsx` remote panel | Logic reused, UI replaced |
| Voice prefix steps (current) | `packages/ui/src/components/onboarding/VoicePrefixSteps.tsx` + `voice-prefix.ts` | **Replaced** by new Speaker/Mic steps (Workstream E); the underlying `VoiceProfilesClient`, mic permission bridge, and TTS service are reused |
| Onboarding state machine | `packages/ui/src/state/useOnboardingState.ts` (`deployment | providers | features`) | **Replaced** by `onboarding-v2` machine (Workstream B). Identity/connector slices keep their DTOs |
| Plugin enable / connectors | AppContext + `PluginsView` | Moved out of onboarding entirely; configured later from the home composer or Views |
| Theme toggle | `RuntimeGate.tsx:74` | **Removed from onboarding** |
| Language dropdown | `LanguageDropdown` import | Moved into onboarding step 2 |
| Avatar / character | existing VRM assets | Wired into Avatar runtime (Workstream G) |

Anything not listed above (LifeOps, browser, phone-companion, lifeops, tasks, etc.) stays exactly where it is — those are openable views, not part of Home or onboarding.

## The new surface, in one model

A single component tree, `HomeShell`, mounted by `StartupShell` once it knows the runtime is ready (or is being set up). `HomeShell` has three layers:

1. **Background layer** — `BackgroundHost` + slow-clouds module (Workstream A). Always mounted.
2. **Content layer** — exactly one of:
   - `OnboardingFlow` (when setup is incomplete) — the steps from the prototype: runtime card pick → language → speaker/mic → owner facts.
   - `HomeIdle` (post-onboarding) — avatar, compact message stack, composer, optional widgets grid.
   The transition between the two is internal state, not routing.
3. **Chrome layer** — `StatusBar` (only on platforms we control) + composer + view-open overlay.

Secondary views (Chat, LifeOps, Browser, Phone, Messages, Contacts, Tasks, Character, Inventory, Stream, Apps→Views, etc.) open on top of Home as a `ViewOverlay`, dismissible back to Home. The current `ViewRouter` in `packages/ui/src/App.tsx:466+` becomes the engine for that overlay; the existing tab-state machine in `useApp()` is repurposed: `home` is the new default, and explicit `tab !== 'home'` renders the overlay.

### Home-as-default routing

- `App.tsx` default tab → `home`.
- `chat` tab is still implemented and reachable, just not the landing page; it opens via:
  - Composer command parsing locally ("open chat", "show dashboard").
  - Agent action `VIEW_OPEN` with `id: "chat" | "dashboard" | <plugin-view-id>` (Workstream K).
  - Keyboard shortcut + URL deep link for web/desktop.
- Window-shell routes (`packages/ui/src/platform/window-shell.ts`: main | detached | popout) all default to `home`.

### Status bar on platforms we control

New module `packages/ui/src/components/shell/PlatformStatusBar.tsx`. Render rules:

- AOSP / Linux kiosk / Electrobun frameless / web fullscreen → render.
- iOS, Android stock app, macOS windowed, Windows windowed → suppress.

Detection lives in a new `PlatformChromeService` (`packages/app-core/src/services/platform-chrome/`) that exposes `{ owns: { statusBar: boolean; navBar: boolean }, capabilities: { battery, wifi, cell, audio, time } }`. Implementation per platform:

- **AOSP**: Capacitor plugin reading `BatteryManager`, `ConnectivityManager`, `TelephonyManager`, `AudioManager`. Already partly available via the existing native bridges in `packages/app/native/android/...`. New plugin: `@elizaos/native-android-system-status`.
- **Linux**: Bun-side service reading `/sys/class/power_supply/*`, `nmcli`/`iwgetid`, `ModemManager` via D-Bus, `pactl get-default-sink`. New module: `packages/app-core/src/services/platform-chrome/linux.ts`.
- **Desktop Electrobun fullscreen**: reuses Linux/macOS host probes through the existing dev-stack endpoints.
- **Time**: pure JS, locale-aware, updates every 15s.

The bar is purely presentational — no business logic. Polling/streaming lives in `PlatformChromeService` and is exposed via the same dev-stack pattern at `GET /api/dev/platform-status` so agents and overlays can read it.

### Full-screen kiosk shape

Added to `packages/app/src/main.tsx` boot config:

- `MILADY_KIOSK=1` (and auto-on for AOSP/Linux when no window manager is present): hides browser chrome, locks `HomeShell` to the only window, blocks `Esc`/keychords that would exit, and routes external URL opens through Views.
- AOSP launcher manifest entry so Eliza can be installed as the default home activity.
- Linux: ship a `.desktop` file + optional `cage`/`weston-kiosk` recipe in `apps/app/electrobun/linux-kiosk/`.

## The new flow in steps (matches the prototype)

Each step is a sub-state of `OnboardingFlow`, *not* a route. All run inside `HomeShell` so the background, status bar, and composer are continuous.

1. **Hello** — first paint is blue. Tap to begin.
2. **Setup runtime** — three equal cards: Cloud (recommended), On-Device, Remote. Device profile (`ios | android | aosp | cuda16 | cuda32 | mac32 | low`) reorders/recolors recommendations using the prototype's `deviceProfiles` map.
3. **Language** — locale picker; persists before voice step.
4. **Connection branch** — Cloud sign-in + immediate setup-agent chat **OR** On-Device security/mode + model download progress **OR** Remote URL+token pairing. Each branch keeps its existing backend handler.
5. **Speaker test** — playback "Hey, can you hear me?" with retry voice lines (Kokoro assets under `prototypes/onboarding-reimagined/audio/`).
6. **Mic setup** — permission, input selector when >1 device, live waveform, retry-line cycling, skip path.
7. **Owner facts** — name + location collected by the in-line agent; written through the existing evaluator pipeline (Workstream J).
8. **Tutorial cards** — settings, AI subscriptions, views, connectors, permissions. Each is a one-tap explainer; all are skippable.
9. **Handoff** — onboarding state collapses; `HomeIdle` takes over. If Cloud, container provisioning continues in the background and the chat transcript is migrated (Workstream C).

If the user re-launches mid-flow, `HomeShell` resumes at the last completed step. `HomeIdle` is reachable any time via "skip the rest" — the remaining tutorial cards become Views the agent can open later.

## Sub-agent assignments (parallel)

These can run concurrently. Each agent owns a workstream, lands behind its flag, and has a single integration target. All agents must follow `AGENTS.md` (no stash, commit on the current branch, push proactively).

| # | Agent | Owns | Inputs | Output | Flag |
| --- | --- | --- | --- | --- | --- |
| 1 | **Shell-paint** | Workstream A: blue first paint, `BackgroundHost`, slow-clouds module, reduced-motion, `BACKGROUND_EDIT` action contract | `packages/app/index.html`, `packages/app/src/main.tsx`, `StartupShell.tsx`, new `packages/ui/src/backgrounds/*` | `HomeShell` host that accepts a content child | `ELIZA_NEW_HOME_SHELL` |
| 2 | **Onboarding-v2** | Workstream B: state machine, runtime/language/handoff steps, prototype copy | New `packages/ui/src/onboarding-v2/*`, refactor of `useOnboardingState.ts` | `OnboardingFlow` component | `ELIZA_NEW_ONBOARDING` |
| 3 | **Cloud-handoff** | Workstream C: tenant-isolated setup agent, container provisioning, transcript/memory migration, single-agent rule | `packages/app-core/src/*`, `plugins/plugin-elizacloud/*`, `client-agent.ts` | New cloud setup session API | `ELIZA_CLOUD_SETUP_AGENT` |
| 4 | **Local-inference** | Workstream D: model download UX, hardware/disk warnings, cloud fallback while downloading | `auto-download-recommended.ts`, `local-inference/hardware.ts`, `packages/shared/src/local-inference/*` | DTO + UI hooks | `ELIZA_LOCAL_DOWNLOAD_FIRST_CLASS` |
| 5 | **Voice-setup** | Workstream E: Kokoro asset generator, speaker/mic flow, waveform, retry cycling, skip paths | `packages/app-core/scripts/generate-onboarding-voicelines.mjs`, `kokoro-runtime.ts`, new `onboarding-v2/audio/*` | `SpeakerStep`, `MicStep` | `ELIZA_VOICE_SETUP_V2` |
| 6 | **Companion+avatar** | Workstreams F/G: `HomeIdle`, compact message stack, composer modes, avatar runtime presets (waveform/Jarvis/VRM), Character side menu | `packages/ui/src/companion-start/*`, `packages/ui/src/avatar-runtime/*`, `packages/ui/src/components/chat/*` | `HomeIdle` + avatar presets | `ELIZA_DESKTOP_COMPANION_START` |
| 7 | **Desktop-bar** | Workstream H: Wispr-style bottom bar, Ctrl-Space, push-to-talk, Fn handling, always-on glow | `packages/ui/src/desktop-runtime/*`, `plugins/plugin-native-desktop/*`, `packages/app/src/main.tsx` | `CompanionBar` | `ELIZA_DESKTOP_COMPANION_BAR` |
| 8 | **Ambient + voice profiles** | Workstreams I/J: always-on capture w/ consent, replay buffer, response gating, diarization, voice profiles, owner facts/nicknames | `packages/app-core/src/services/ambient-audio/*`, `services/voice-profiles/*`, `evaluators/*` | New services + agent actions | `ELIZA_AMBIENT_AUDIO`, `ELIZA_VOICE_PROFILES` |
| 9 | **Views migration** | Workstream K: rename Apps→Views, plugin `views` array, `VIEW_*` actions, generated-view storage | `packages/ui/src/navigation/index.ts`, `App.tsx`, `AppsPageView.tsx`, plugin types | Rename + plugin contract | `ELIZA_VIEWS_NAMING` |
| 10 | **Platform-chrome (NEW)** | Status bar + kiosk shape | New `packages/app-core/src/services/platform-chrome/*`, `packages/ui/src/components/shell/PlatformStatusBar.tsx`, `apps/app/electrobun/linux-kiosk/*`, AOSP manifest, `@elizaos/native-android-system-status` | `PlatformStatusBar`, kiosk launchers, `/api/dev/platform-status` | `ELIZA_PLATFORM_STATUS_BAR`, `MILADY_KIOSK` |
| 11 | **Chat-as-secondary (NEW)** | Demote chat from default; build `ViewOverlay`; voice intent → `VIEW_OPEN`; deep links | `App.tsx`, `useApp()`, `window-shell.ts`, intent parser in agent | Chat openable but not default | `ELIZA_HOME_IS_DEFAULT` |
| 12 | **QA / E2E** | Workstream L: matrix tests for all branches, no-white-flash test, kiosk smoke, status-bar contract test, Apps→Views migration check | `packages/app/test/*`, Playwright configs | CI gate | n/a |

Suggested wave order (each wave runs all listed agents in parallel):

- **Wave 1** (foundation, no UX dependency): Shell-paint, Local-inference, Voice-setup asset gen, Platform-chrome research, Views migration scaffolding, QA scaffolding.
- **Wave 2** (depends on Wave 1 host): Onboarding-v2, Companion+avatar, Cloud-handoff (contract first), Desktop-bar against mocks, Chat-as-secondary, Platform-chrome implementation.
- **Wave 3** (integration): Ambient+voice profiles, Cloud-handoff full integration, kiosk packaging, end-to-end matrix.

## Integration order (single source of truth)

1. Land flags + blue first paint + `HomeShell` host (Wave 1).
2. Land `OnboardingFlow` with mocked branch outcomes inside `HomeShell` (Wave 2).
3. Wire real backends into each branch (Wave 2/3).
4. Switch default tab to `home`; chat becomes overlay (Wave 2).
5. Land `PlatformStatusBar` + kiosk shape behind `MILADY_KIOSK` (Wave 2).
6. Land `HomeIdle` + avatar presets (Wave 2).
7. Land Apps→Views rename (Wave 2/3).
8. Land Cloud handoff, local download UX, voice setup, desktop bar, ambient + voice profiles (Wave 3).
9. Flip flags on for staff dogfood; collect telemetry; remove old `RuntimeGate` only at parity.

## Risks specific to this plan

- **Kiosk lockout.** A bug in kiosk mode on AOSP/Linux can leave a user with no escape. Always ship with a debug exit (long-press 5-finger gesture / `Ctrl+Alt+Q`) gated by a build flag; never strip it from production until rollback telemetry is clean.
- **Status bar drift.** Native status bars (battery icons especially) come with platform expectations users will judge harshly. Treat the icons as a versioned asset set with snapshot tests.
- **Chat demotion.** Existing users muscle-memoried to chat-on-launch. Add a one-time "Chat moved to a view — say 'open chat'" toast on first launch after upgrade, and a settings opt-out that restores chat-as-default for the legacy path.
- **Voice intent collisions.** "Open chat" inside chat itself must be a no-op, not a re-open. Intent parser needs surface-aware suppression.
- **Background module sandbox.** `BACKGROUND_EDIT`, `VIEW_*`, and Avatar edit actions ship dynamic code. None of these are in MVP scope for the first launch — keep their action handlers stubbed-but-permissioned until the sandbox lands.

## Out of scope for the first cut

- LifeOps redesign.
- Replacing `ScheduledTask`.
- Final model weights/licensing decisions.
- Always-on capture turned on by default (must be opt-in, off, with cost warning per existing memory `feedback_plugin_vision_cost.md`).
