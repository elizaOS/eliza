# Onboarding Reimagining Implementation Plan

Date: 2026-05-12

## Delivery Shape

Implement as a staged migration behind flags:

- `ELIZA_NEW_ONBOARDING=1`
- `ELIZA_VIEWS_NAMING=1`
- `ELIZA_DESKTOP_COMPANION_START=1`
- `ELIZA_DYNAMIC_SURFACES=1`

Keep current startup working until the new flow passes E2E on web, desktop, iOS, and Android.

## Workstream A: Startup Paint and Background Runtime

Owner files:

- `packages/app/index.html`
- `packages/app/src/main.tsx`
- `packages/ui/src/components/shell/StartupShell.tsx`
- New `packages/ui/src/backgrounds/*`

Tasks:

- Set critical blue background on `html`, `body`, root container, and startup shell before React mount.
- Add `BackgroundHost` that loads a versioned background module.
- Implement initial `slow-clouds` module independently from the CodePen reference.
- Add reduced-motion behavior.
- Add `BACKGROUND_EDIT` action contract, validation, version history, activation, revert, and fallback.
- Add visual performance smoke test for first paint and background continuity.

Tests:

- Cold-load screenshot must never show white.
- Reduced motion disables drift.
- Background module failure falls back to solid blue.
- Revert restores previous active module.

Parallel notes:

- This can run independently of onboarding state work if the host accepts static children.

## Workstream B: New Onboarding State Machine

Owner files:

- New `packages/ui/src/onboarding-v2/*`
- `packages/ui/src/components/shell/StartupShell.tsx`
- `packages/ui/src/state/*`
- `packages/ui/src/i18n/*`

Tasks:

- Create explicit steps: runtime, language, speaker, microphone, owner facts, final handoff.
- Persist progress and allow resume.
- Remove theme selector from onboarding.
- Move language into onboarding and update app/agent language together.
- Render Cloud, Remote, and Local as equal cards.
- Keep current `RuntimeGate` available behind fallback flag.

Tests:

- Cloud, Remote, Local can complete.
- Back/forward/resume works.
- Theme controls do not appear.
- Language persists and changes copy before voice step.

Parallel notes:

- Depends only on Workstream A host shell contract, not Cloud backend.

## Workstream C: Cloud Setup Agent and Handoff

Owner files:

- `packages/app-core/src/*`
- `plugins/plugin-elizacloud/*`
- `packages/ui/src/api/*`
- New cloud setup session API types.

Tasks:

- Add tenant-isolated setup agent session.
- Limit setup agent actions through provider/capability policy.
- Show setup progress provider in chat.
- Provision user container in background after Cloud sign-in.
- Transfer chat transcript, memories, and extracted facts to the container agent.
- Switch live chat transport to the container without visible interruption.
- Remove cloud agent selection from first-run Cloud path.

Tests:

- Setup agent cannot access another tenant.
- Limited actions are enforced server-side.
- Handoff preserves transcript order and memory IDs.
- Agent announces setup completion exactly once.

Parallel notes:

- Can be developed against mocked UI contracts while Workstream B lands.

## Workstream D: Local Model Download, Hardware, and Disk Checks

Owner files:

- `packages/ui/src/onboarding/auto-download-recommended.ts`
- `packages/ui/src/services/local-inference/*`
- `packages/app-core/src/services/local-inference/*`
- `packages/shared/src/local-inference/*`

Tasks:

- Start model download immediately when Local is selected, before later onboarding steps.
- Add disk-space probe to local inference API.
- Warn below 24 GB effective VRAM/shared memory.
- Warn when free disk is below selected model size plus safety margin.
- If Cloud is available, route temporary chat to Cloud while Local downloads.
- If no model is available, make the agent answer with local-loading status.
- Add end-of-onboarding blocker message if model still downloading.

Tests:

- Download POST is sent once per local selection.
- Insufficient disk warning appears.
- Under-24 GB warning appears.
- Cloud fallback responses stop once local model is active.
- Download interruption/resume works.

Parallel notes:

- Can proceed independently of Cloud handoff. Needs final integration with Workstream B.

## Workstream E: Voice Setup and Kokoro Assets

Owner files:

- New `packages/ui/src/onboarding-v2/audio/*`
- `packages/app-core/src/services/local-inference/voice/kokoro/*`
- `packages/app-core/scripts/generate-onboarding-voicelines.mjs`
- Platform audio permission bridges.

Tasks:

- Replace ElevenLabs-only onboarding line generator with Kokoro-capable generator.
- Add localized manifest for speaker/mic lines.
- Implement speaker playback test.
- Implement mic permission prompt, input selector, and live waveform.
- Cycle retry lines every few seconds up to the list, then loop.
- Add skip paths.

Tests:

- Generated voice assets exist and match manifest keys.
- Audio playback failure has visible fallback.
- Mic waveform responds to mock input.
- Multiple inputs render selector only when needed.

Parallel notes:

- Independent from Cloud and Local model work.

## Workstream F: Companion Chat Surface

Owner files:

- `packages/app-companion/*`
- `packages/ui/src/components/chat/*`
- `packages/ui/src/components/shell/*`
- New `packages/ui/src/companion-start/*`

Tasks:

- Make companion screen default after onboarding on mobile and desktop.
- Build compact expandable message stack.
- Build composer modes: attach, text, send, voice, dictate, waveform.
- Add fade-in full history behavior on upward scroll.
- Integrate chat transport status for Cloud setup, Remote, and Local fallback.

Tests:

- No text means right button is mic.
- Text means right button is send.
- Dictate toggles X/check behavior.
- Voice mode replaces input with waveform.
- Tapping message expands; upward scroll expands history.

Parallel notes:

- Can be built with mocked data while Workstream C/D transports mature.

## Workstream G: Avatar Runtime and Character View

Owner files:

- `packages/app-companion/*`
- `packages/ui/src/components/pages/Character*`
- New `packages/ui/src/avatar-runtime/*`

Tasks:

- Define dynamic avatar module contract.
- Implement waveform shader preset.
- Implement Jarvis preset.
- Implement VRM 3D preset using existing VRM/Three.js assets.
- Add Avatar item to Character view side menu.
- Add agent actions for avatar edit/create/revert/delete/restore.
- Add sandbox, validation, preview, and fallback avatar.

Tests:

- All three presets mount and unmount cleanly.
- Audio level changes avatar state.
- Bad module fails closed and reverts.
- Character view can select and save preset.

Parallel notes:

- Shares visual surface with Workstream F, but can own its runtime boundary.

## Workstream H: Desktop Tray and Bottom Bar

Owner files:

- `packages/ui/src/desktop-runtime/DesktopTrayRuntime.tsx`
- `packages/native-plugins/desktop/*`
- `packages/app/src/main.tsx`
- New `packages/ui/src/desktop-runtime/CompanionBar.tsx`

Tasks:

- Keep tray app behavior on macOS, Windows, and Linux.
- Open companion screen after setup.
- Add thin bottom bar.
- Add Ctrl Space shortcut.
- Add click-to-expand chat.
- Add mic toggle and press-hold push-to-talk.
- Add macOS Fn push-to-talk with conflict avoidance.
- Add soft red glow for collapsed always-on mode.

Tests:

- Tray launches without full shell when configured.
- Ctrl Space expands/collapses.
- Push-to-talk emits start/stop events.
- Toggle mic persists state.
- Fn behavior does not trigger during normal function-key combinations.

Parallel notes:

- Can build against mocked chat transport and audio capture events.

## Workstream I: Always-On Audio, Replay Buffer, and Response Gating

Owner files:

- `packages/app-core/src/services/local-inference/voice/*`
- `packages/native-plugins/*audio*`
- New `packages/app-core/src/services/ambient-audio/*`

Tasks:

- Add consented always-on mode.
- Capture rolling audio buffer.
- Transcribe ambient speech.
- Store ignored speech with retention policy.
- Add response gating classifier: direct address, wake intent, context expectation, confidence threshold.
- Add pause/delete/export controls.
- Add debug trace for "heard but did not respond."

Tests:

- Always-on cannot start without consent.
- Pause stops capture.
- Replay buffer respects retention.
- Agent stays silent for non-addressed speech in fixture tests.
- Protected actions require owner confidence or challenge.

Parallel notes:

- Depends on platform audio bridges from Workstream E but can prototype with file input fixtures.

## Workstream J: Owner Facts, Nicknames, Diarization, and Voice Profiles

Owner files:

- `packages/app-core/src/evaluators/*`
- `packages/app-core/src/memory/*`
- `packages/app-core/src/services/*speaker*`
- New `packages/app-core/src/services/voice-profiles/*`

Tasks:

- Add owner profile fact schema.
- Add dedupe rules so known facts are not repeatedly extracted.
- Add nickname evaluator or typed nickname fact.
- Add diarization pipeline abstraction.
- Add speaker embedding/profile storage.
- Support more than 100 voice profiles with quality metadata.
- Add owner confidence scoring.
- Add private challenge flow for low-confidence protected access.

Tests:

- Known name is not re-added.
- New nickname attaches to owner.
- Multiple speakers are attributed in transcript fixtures.
- Profile search scales beyond 100 profiles.
- Low confidence blocks protected action until challenge passes.

Parallel notes:

- Can use offline fixture audio/text while Workstream I captures live audio.

## Workstream K: Apps to Views Migration

Owner files:

- `packages/ui/src/navigation/index.ts`
- `packages/ui/src/components/pages/AppsPageView.tsx`
- `packages/ui/src/components/pages/AppsView.tsx`
- `packages/ui/src/App.tsx`
- Plugin registration types across packages/plugins.

Tasks:

- Rename user-facing Apps labels to Views.
- Add plugin `views` array contract.
- Keep `apps` alias with deprecation warnings.
- Register existing mini apps as views.
- Make Views page itself a registered view.
- Add agent actions: `VIEW_CREATE`, `VIEW_EDIT`, `VIEW_REVERT`, `VIEW_DELETE`, `VIEW_RESTORE`, `VIEW_OPEN`.
- Add generated-view storage, version history, and restore flow.

Tests:

- Navigation shows Views.
- Existing apps remain reachable.
- Plugin `views` render.
- Deprecated `apps` still works during migration.
- Agent view actions are permissioned and auditable.

Parallel notes:

- Broad rename. Keep it isolated from onboarding visuals until route aliases are stable.

## Workstream L: QA, Performance, Accessibility, and Release

Owner files:

- `packages/app/test/*`
- `packages/ui/src/**/*.test.*`
- Playwright configs.
- Release docs.

Tasks:

- Add E2E matrix for Cloud, Remote, Local, audio skipped, audio accepted, desktop bar.
- Add screenshot baselines for desktop and mobile onboarding.
- Add first-paint no-white test.
- Add Lighthouse/performance budget for background animation.
- Add accessibility checks for focus, labels, reduced motion, contrast, keyboard paths.
- Add migration notes for Apps to Views.
- Add rollback flags and observability events.

Tests:

- CI runs new onboarding E2E behind flag.
- Visual diff catches white flash and mobile crop regressions.
- Keyboard-only onboarding completes.
- Screen reader labels exist for icon-only controls.

Parallel notes:

- Starts early with prototype tests, then follows each workstream for coverage.

## Suggested Parallel Agent Assignments

1. Shell/background agent: Workstream A only.
2. Onboarding UI agent: Workstream B plus integration with E/F mocks.
3. Cloud handoff agent: Workstream C only.
4. Local inference agent: Workstream D only.
5. Voice setup agent: Workstream E only.
6. Companion/avatar agent: Workstreams F and G, with separate file ownership inside avatar runtime if split further.
7. Desktop agent: Workstream H only.
8. Ambient intelligence agent: Workstreams I and J, split into audio pipeline and memory/profile schema if needed.
9. Views migration agent: Workstream K only.
10. QA agent: Workstream L, continuously rebasing against completed workstreams.

## Integration Order

1. Land flags and blue first paint.
2. Land background host with static slow-clouds module.
3. Land onboarding-v2 with mocked Cloud/Remote/Local outcomes.
4. Integrate Local download and warnings.
5. Integrate Cloud setup agent and handoff.
6. Integrate voice setup and Kokoro assets.
7. Switch post-onboarding target to companion screen.
8. Add avatar runtime presets and Character menu.
9. Add desktop bottom bar.
10. Migrate Apps to Views.
11. Add always-on/replay/diarization/profile features behind separate consent flag.
12. Remove old RuntimeGate only after telemetry and E2E show parity or better.

## Main Risks

- Dynamic code editing can become a security boundary failure. Require sandboxing and permissions before exposing agent edit actions.
- Always-on capture can create trust and compliance risk. Consent, visible state, retention, delete, and audit are part of MVP.
- Cloud handoff can lose memory or duplicate messages. Treat handoff as a transactional migration with idempotent replay.
- Apps-to-Views rename touches many files. Use compatibility aliases and route redirects until plugins migrate.
- Local model download can fail or take too long. The UI needs honest status, cloud fallback, and resumable downloads.
