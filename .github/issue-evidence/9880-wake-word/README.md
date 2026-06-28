# Evidence — name-aware "hey &lt;character&gt;" wake word (#9880)

Validation artifacts for the wake-word work. Reproducible on a macOS host.

## Tiers

| Tier | Artifact | Result |
|---|---|---|
| **Unit / fuzz / controller** | `unit-tests.log` | 29 wake-specific tests green (name matcher, window reducer, 200-seed×80-step state fuzz, hook). 184 total ui voice/shell tests pass. |
| **Real audio → real ASR → matcher** | `realaudio-wake-validation.mp4` (video **with audio**), `realaudio-validation.log`, `realaudio-results-card.png` | 5/5. `say` (TTS, spoken aloud) → whisper.cpp **Metal** ASR → `matchWakeName()` (the shipped UI matcher). Includes real ASR slop ("Hey Ada" heard as "Hey **Aida**", still matched for name=ada, rejected for name=eliza). |
| **iOS simulator** | `ios-simulator-voice-listening.png` | iPhone 16 Pro simulator showing the live-mic voice UI in the listening state (mic active, interim transcript "hey eliza what is on my calendar…"). |
| **Physical device** | — | Remaining: requires a signed Capacitor app build installed on the paired iPhone for on-device openWakeWord. See *Reproduce* / issue. |

## Reproduce

```bash
# Real-audio validation (needs the repo's built whisper-cli + a ggml model):
#   plugins/plugin-local-inference/native/build-whisper/bin/whisper-cli
#   WHISPER_MODEL=/path/to/ggml-base.en.bin
bun .github/issue-evidence/9880-wake-word/validate-wake-realaudio.mjs

# Unit / fuzz / controller:
bun run --cwd packages/ui vitest run \
  src/voice/wake-name-match.test.ts \
  src/voice/wake-listen-window.test.ts \
  src/voice/wake-listen-window.fuzz.test.ts \
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
- **Mic-never-stuck + liveness.** The fuzz suite asserts the wake-listen-window
  always drains to idle and the mic is only open in a non-idle phase.
- **The UI renders + runs on iOS.** Simulator screenshot of the listening state.
