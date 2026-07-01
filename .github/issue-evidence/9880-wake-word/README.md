# Evidence — name-aware "hey &lt;character&gt;" wake word (#9880)

Validation artifacts for the wake-word work. Reproducible on a macOS host.

## Tiers

| Tier | Artifact | Result |
|---|---|---|
| **Unit / fuzz** | `unit-tests.log` | 52 wake-specific tests green (name matcher, window reducer + 200-seed fuzz, **WakeController path selection + 3-path confirmation + 120-seed×80-step fuzz**, both hooks). |
| **Backend decision + cross-platform** | `packages/ui/src/voice/VOICE_UX.md` §6/§7, `packages/ui/src/voice/wake-controller.ts` | The two-stage name-aware wake (head-fast-path → two-stage-asr → swabble-fallback) and the per-platform capability/battery matrix (macOS/iOS/Android/Linux/Windows/web). Idle cost stays at Stage-A (~0.23 ms/80 ms frame); Swabble only as fallback. |
| **Real audio → real ASR → matcher** | `realaudio-wake-validation.mp4` (video **with audio**), `realaudio-validation.log`, `realaudio-results-card.png` | 5/5. `say` (TTS, spoken aloud) → whisper.cpp **Metal** ASR → `matchWakeName()` (the shipped UI matcher). Includes real ASR slop ("Hey Ada" heard as "Hey **Aida**", still matched for name=ada, rejected for name=eliza). |
| **Real audio → real ASR → WakeController** | `realaudio-controller-validation.mp4` (video **with audio**, 28s h264+aac), `realaudio-controller-validation.log` | 10/10. The whole controller decision on real speech: path-selection matrix + `stage-a-candidate`→`stage-b-transcript` through the shipped `wakeControllerReducer`. Homophone "Aida"→`ada`, rename to `nova`, bare distinctive name `samantha`, and correct rejections. |
| **Sustain-gate hardening** | `sustain-gate-verification.md`, `linux-native/LINUX-WAKEWORD-RESULTS.md` | `OpenWakeWordDetector` now requires 8 consecutive frames over threshold by default, matching the Linux-native discriminator: positives sustain 10-17 frames while hard negatives peak for at most 7. Focused detector tests, typecheck, and lint passed. |
| **iOS simulator** | `ios-simulator-voice-listening.png` | iPhone 16 Pro simulator showing the live-mic voice UI in the listening state (mic active, interim transcript "hey eliza what is on my calendar…"). |
| **Physical device — signed build** | `ios-device-build-proof.txt`, `ios-device-booting.png`, `ios-device-local-1.png`, `ios-device-backend-timeout.png` | Two signed device builds (`** BUILD SUCCEEDED **`, `ai.elizaos.app`, team `25877RY2EH`, Apple Development: Shaw Walters) — cloud thin-client **and** local on-device runtime (`ElizaBunEngine.framework`) — each bundling the WakeController + `ElizaosCapacitorSwabble.framework` (the live wake detector). Installed + launched on the real iPhone 16 Pro Max (MoonCycles, iOS 18.7.8); app shell renders on-device. |
| **Physical device — live voice UI** | — | Blocked by an environmental backend issue, **not** the wake-word change: the app's auth/boot gate polls `/api/auth/status` → HTTP 503 "Agent is in an error state" (remote backend down, both variants). Reaching the live listening UI needs interactive onboarding + a healthy backend + a spoken phrase (physical interaction). The device wake path is covered by the unit + host real-audio tiers; the shipped `hey-eliza` head's on-device accuracy is ~98.8% TA / ~3.6% FA (held-out 250+250). |

## Reproduce

```bash
# Real-audio validation (needs the repo's built whisper-cli + a ggml model):
#   plugins/plugin-local-inference/native/build-whisper/bin/whisper-cli
#   WHISPER_MODEL=~/.cache/eliza/whisper/ggml-base.en.bin
bun .github/issue-evidence/9880-wake-word/validate-wake-realaudio.mjs            # matcher (5/5)
bun .github/issue-evidence/9880-wake-word/validate-wake-controller-realaudio.mjs # controller (10/10)
#   add NO_AUDIO=1 to skip the audible pass; screen+mic capture via avfoundation "7:1".

# Unit / fuzz:
bun run --cwd packages/ui vitest run \
  src/voice/wake-name-match.test.ts \
  src/voice/wake-listen-window.test.ts \
  src/voice/wake-listen-window.fuzz.test.ts \
  src/voice/wake-controller.test.ts \
  src/voice/wake-controller.fuzz.test.ts \
  src/voice/useWakeController.test.tsx \
  src/voice/useWakeListenWindow.test.tsx \
  src/components/shell/__tests__/useShellController.test.tsx

# iOS simulator (boot a sim first):
#   serve the voice fixture, openurl in mobile Safari, simctl io screenshot
```

## What each tier proves

- **Name-awareness on real speech.** The matcher follows the configured character
  name and tolerates real ASR variance — "ada" matches "Aida", "eliza" does not.
- **Command extraction.** "hey eliza what is the weather today" → command
  "what is the weather today" (the request rides in one breath).
- **Mic-never-stuck + liveness.** The fuzz suites assert the wake-listen-window
  always drains to idle (mic only open in a non-idle phase) and the controller's
  Stage-B confirm window never gets stuck (a dangling candidate drains to idle).
- **The right backend, by capability.** `selectWakePath` picks the cheapest
  correct path; the controller fuzz asserts only the selected path's detector can
  ever fire and emits exactly once per confirmed candidate.
- **The UI renders + runs on iOS.** Simulator screenshot of the listening state.
