# Onboarding Reimagined — Deferred Work

Date: 2026-05-15

This session implemented the **UI layer** of the onboarding reimagining (Workstreams A, B-UI, F, G-UI, H-UI, K-labels) plus scaffolding for the elizaOS Linux + AOSP unified desktop shells. The items below are explicitly **out of scope for this session** and need their own focused work.

## Done in this session

- `packages/ui/src/backgrounds/` — `BackgroundHost`, slow-clouds SVG-filtered module, `registerBackground` + version history, `BACKGROUND_EDIT` action contract type, `SKY_BACKGROUND_COLOR` constant.
- `packages/ui/src/onboarding/state-machine.ts` + `state-persistence.ts` — 15-state flow with cloud / on-device-cloud-services / on-device-local-only / remote branches; localStorage persistence + resume.
- `packages/ui/src/components/onboarding/states/` — `OnboardingRoot` + 15 per-state components.
- `packages/ui/src/companion/` — `CompanionShell`, `CompactMessageStack`, `ComposerBar` with text/send/mic/dictate/voice modes.
- `packages/ui/src/companion/desktop-bar/` — Wispr-Flow-style pill + expanded chat panel, `useKeyboardShortcuts` (Ctrl+Space toggle + spacebar push-to-talk + macOS Fn push-to-talk), `usePushToTalk`, Electrobun tray platform shim, always-on red glow.
- `packages/ui/src/avatar-runtime/` — `AvatarModule` contract, `AvatarHost`, waveform shader preset (default), Jarvis preset, VRM placeholder preset, registry with version history + revert.
- `packages/ui/src/types/plugin-views.ts` — `PluginViewRegistration` + `ElizaPluginViews` (`views` first-class, `apps` deprecated alias).
- `packages/ui/src/components/shell/StartupShell.tsx` — `OnboardingRoot` rendered when `VITE_ELIZA_NEW_ONBOARDING=1` (or `ELIZA_NEW_ONBOARDING=1`), `RuntimeGate` rendered otherwise. Both wire-up sites covered (onboarding-required phase + ready-without-onboardingComplete phase).
- `packages/os/shared-system/` — canonical `SystemProvider` types (wifi/audio/battery/cell/time/controls).
- `packages/os/linux/desktop-shell/` — `DesktopShell` + `TopBar` + Wifi/Audio/Battery/Shutdown/Settings indicators + `MockSystemProvider` + `LinuxSystemProvider` stub + Wallpaper + `DEFERRED.md`.
- `packages/os/android/system-ui/` — `SystemUI` + `StatusBar` + `LockScreen` + `NavigationButtons` + Wifi/Cell/Audio/Battery icons + Mock/Android provider stubs + `DEFERRED.md`.
- Apps→Views user-facing rename was already in place (navigation group label + tab-title resolution both already say `Views`).

Tests passing: 36 across 5 files (`backgrounds/__tests__`, `onboarding/state-machine.test.ts`, `companion/__tests__`, `companion/desktop-bar/__tests__`, `avatar-runtime/__tests__`).

## Out of scope, not started

### Workstream C — Cloud Setup Agent and Handoff
Owner files (when picked up):
- `packages/app-core/src/services/cloud-setup-agent/*` (new)
- `plugins/plugin-elizacloud/*`
- `packages/ui/src/api/cloud-setup.ts` (new)
- New cloud setup session API in `cloud/apps/api/v1/eliza/agents/*`

Needs:
- Tenant-isolated setup agent session with action-allowlist policy.
- Provision-in-background container workflow.
- Transcript + memory transfer to container agent.
- Live chat transport handoff without visible interruption.

Why deferred: server-side product + security decisions and net-new cloud API surface; not safe to dictate from a UI session.

### Workstream D — Disk-space probe + onboarding-blocker copy
Existing `packages/app-core/src/services/local-inference/hardware.ts` already probes RAM/VRAM/architecture. Need to add:
- Disk-space probe per platform (statvfs on POSIX, GetDiskFreeSpaceEx on Windows).
- Onboarding-end blocker message when local model still downloading.
- Cloud-fallback-while-local-downloads routing.

### Workstream E — Kokoro asset generation for onboarding voice lines
`packages/app-core/scripts/generate-onboarding-voicelines.mjs` needs:
- Replace ElevenLabs-only generator with Kokoro generator.
- Localized manifest matching the speaker/mic line list in the PRD.
- The prototype audio in `docs/prototypes/onboarding-reimagined/audio/` was generated with the Python Kokoro package and `hexgrad/Kokoro-82M`; the in-app generator needs the same pipeline reproducible from the build.

The Kokoro runtime work is being actively touched by the parallel swarm agents (`.swarm/impl/L-kokoro-distill.md`, `J2-kokoro-port-notes.md`). Pick this up only after that work lands.

### Workstream I — Always-On Audio, Replay Buffer, Response Gating
- `packages/app-core/src/services/ambient-audio/*` — net new.
- Rolling audio buffer + transcription + retention.
- VAD + wake-intent + direct-address + context classifier for response gating.
- Pause/delete/export controls + heard-but-did-not-respond debug trace.
- Visible always-on state with fast pause and consent flow.

Why deferred: privacy/consent product decisions + native audio bridges. Cross-cutting with the swarm's emotion/turn-intl work.

### Workstream J — Owner Facts, Nicknames, Diarization, Voice Profiles
- Owner profile fact schema + dedupe rules in `packages/app-core/src/evaluators/*`.
- Nickname evaluator or typed nickname fact subtype.
- Diarization pipeline abstraction.
- Voice profile store with quality metadata, >100 profile capacity.
- Owner-confidence scoring + private-challenge flow for protected access.

Why deferred: this is a full ML/security stream; needs pyannote/SpeechBrain integration and threat modeling.

### Workstream L — QA, Performance, Accessibility, Release
Per-platform E2E covering Cloud, On-Device cloud-services, On-Device local-only, Remote pairing, audio skip/success/retry, desktop bar push-to-talk/toggle, Apps→Views compatibility, BACKGROUND_EDIT revert.

Why deferred: meaningful E2E coverage requires the cloud setup agent and the audio path to exist first.

### Real OS shell integration
The new `packages/os/linux/desktop-shell/` and `packages/os/android/system-ui/` components are **React scaffolds only**. Real OS integration needs:

**Linux fork:**
- D-Bus client for `org.freedesktop.UPower` (battery), `org.freedesktop.NetworkManager` (wifi), `org.freedesktop.login1` (shutdown/restart/suspend).
- PulseAudio or PipeWire client for audio level + mute + output device.
- Wayland surface or X11 root-window override for the top bar.
- GTK4 / wayland-client native shim, or an Electron/Tauri host with privileged IPC.
- Replacement for GNOME Shell / Phosh status bar.
- Login screen integration.

**AOSP fork:**
- System UI replacement (replacing `SystemUI.apk` with an Eliza variant).
- Native bridges for `AudioManager`, `ConnectivityManager`, `BatteryManager`, `TelephonyManager`, `SettingsProvider`.
- Keyguard integration for the lock screen.
- Permission grants in `frameworks/base` for shutdown/restart.
- Vendor-partition placement and SELinux policy.

Both are multi-engineer-month efforts. Treat the scaffolds as the JS surface a future OS integrator will mount.

## OS native bridges progress (this session)

Scaffolded the JS↔native IPC contracts that sit between the React
surfaces and the (still-to-be-written) privileged native hosts:

- `packages/os/linux/desktop-shell/src/bridge/` — typed
  `BridgeTransport`, `LINUX_BRIDGE_CHANNELS`, `LinuxBridgeClient`.
  `LinuxSystemProvider` now consults `getBridgeTransport()` and
  subscribes to wifi/audio/battery/time channels when the host has
  installed `window.__elizaLinuxBridge`; otherwise it still falls back
  to `MockSystemProvider`.
- `packages/os/linux/desktop-shell/native/` — Rust crate skeleton
  (`eliza-linux-desktop-bridge`) with `lib.rs` modules per channel
  group. Every native function is `unimplemented!()` with an `// IMPL:`
  marker pointing at the upstream crate (`zbus`, `pipewire-rs`, etc.).
  `main.rs` exits with `not implemented`.
- `packages/os/android/system-ui/src/bridge/` — typed
  `BridgeTransport`, `ANDROID_BRIDGE_CHANNELS`, `AndroidBridgeClient`
  covering wifi / cell / audio / battery / time / connectivity /
  lockscreen / power / settings.
  `AndroidSystemProvider` mirrors the Linux wiring.
- `packages/os/android/system-ui/native/` — Android library skeleton
  (`ai.elizaos.system.bridge`) with `SystemBridge.kt` stubs and a
  manifest that declares (but cannot grant) the signature permissions.

Still needs native engineering:
- Real D-Bus / PipeWire / login1 wiring on Linux + a Polkit policy.
- Real AudioManager / ConnectivityManager / TelephonyManager /
  PowerManager wiring on Android + AOSP fork APK build slot, vendor
  privapp allowlist, SELinux policy, signing under the platform key.
- Lock-screen / keyguard replacement on Android; replaceable
  compositor / layer-shell surface on Linux.

## Workstreams I + J — scaffolded (2026-05-15)

The TypeScript-only surfaces for I and J have landed under `packages/app-core/src/services/ambient-audio/` and `packages/app-core/src/services/voice-profiles/`. What is implemented is real (types, consent state machine, ring-buffer data structure, pure response-gate, in-memory voice profile store with cosine search, owner-confidence scoring, SHA-256 challenge service, naive nickname evaluator) and tested. What is **still missing** for either workstream to be shipping:

### I — Ambient audio, replay buffer, response gating

- Native audio capture per platform (CoreAudio / WASAPI / PipeWire / AVAudioSession / AudioRecord) and 16 kHz mono Int16 normalization. The `AmbientAudioService` interface is the seam; only `MockAmbientAudioService` exists today.
- Real VAD (Silero v5 or webrtcvad) driving `ResponseGateSignals.vadActive`.
- Real wake-intent classifier (openWakeWord or a distilled model) driving `wakeIntent`.
- Streaming ASR (Whisper-small int8 desktop, llama.cpp GGUF mobile) populating `TranscribedSegment` with real confidences.
- Retention policy enforcement and a heard-but-did-not-respond debug surface wired into the desktop bar.
- ANT-style consent UI integration with Workstream F so the service refuses to `start()` without an explicit `ConsentRecord`.
- See `packages/app-core/src/services/ambient-audio/IMPL_NOTES.md`.

### J — Owner facts, nicknames, diarization, voice profiles

- pyannote-audio v3 diarization replacing `MOCK_DIARIZATION_PIPELINE`.
- SpeechBrain ECAPA-TDNN (`spkrec-ecapa-voxceleb`) embeddings, L2-normalized, full vector in durable storage (not just `vectorPreview`).
- Durable `VoiceProfileStore` backed by PGlite (desktop) / SQLite (mobile) with an append-only audit log for upsert/delete.
- Argon2id-salted challenge answers in `InMemoryChallengeService`'s production replacement, plus per-id rate-limiting on `verify`.
- Real nickname evaluator (LLM- or classifier-driven) replacing `NAIVE_NICKNAME_EVALUATOR`, with dedupe against the owner-facts memory store.
- Owner-facts memory schema and evaluator (the Workstream-J extension in `packages/app-core/src/evaluators/` and `packages/app-core/src/memory/`) — those directories do not yet exist and are the next thing to land for this stream.
- Threat model write-up covering voice cloning, replay, embedding leakage, household-vs-owner escalation, drift, and cross-device sync key handling.
- See `packages/app-core/src/services/voice-profiles/IMPL_NOTES.md`.

Both directories explicitly avoid the active swarm workspaces (kokoro, emotion, turn-intl, diarizer-*, voice-classifier, wakeword, vad). They wire in once those interfaces stabilize.
