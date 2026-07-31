# Voice Validation Runbook (#8785)

Turn-key steps to execute the end-to-end validations once the corresponding
resource is available. Everything that does not need a hardware or service
resource is already proven in CI (see [VOICE_8785_ASSESSMENT.md](./VOICE_8785_ASSESSMENT.md)
§2–4). This runbook covers the remaining lanes: headful A/V capture (desktop /
web / simulator / iOS), live cloud STT/TTS, and the real on-device model lane.

Each section states: **precondition → command → expected artifact → pass bar.**

---

## 0. Always-runnable baseline (no resource needed) — run first

```bash
# Decision logic over the full scenario matrix (no models):
bun run --cwd plugins/plugin-local-inference voice:workbench --logic

# The labeled audio-sample corpus (listen to the degraded edge cases):
bun run --cwd plugins/plugin-local-inference corpus:generate --out /tmp/voice-corpus
```
Review the JSON/Markdown telemetry and the 14 scenarios under
`/tmp/voice-corpus/<id>/audio.wav` plus `ground-truth.json`.

---

## 1. Headful A/V capture — desktop + web (Playwright) ✅ DONE

**Status (2026-06-22): PASSING + recorded + adversarially verified.** `13 passed`;
evidence under `.github/issue-evidence/8785-voice-headful/`. (Precondition: the
app shell mounts — `typecheck` is 0. An earlier run failed against a transient
concurrent `AppContext.tsx` mid-refactor; once stabilized the matrix passed.)

```bash
# Full voice headful matrix WITH A/V recording (video+trace+screenshot per spec):
cd packages/app
E2E_RECORD=1 node scripts/run-ui-playwright.mjs \
  --config playwright.ui-smoke.config.ts voice-
```
**Artifacts:** `e2e-recordings/app/test-results/<spec>/{video.webm,trace.zip,test-finished-1.png}`
(open a trace: `npx playwright show-trace …/trace.zip`); per-turn DOM verdicts at
`[data-testid="voice-workbench-turn-<i>"]` / `…-overall`.
**Pass bar:** every `voice-*.spec.ts` green; `voice-workbench-overall` reads
`pass`; the real-mic round-trip (`voice-realaudio`) transcribes the injected
phrase at WER 0. (Backends are mocked — this proves the real client pipeline +
player + respond/EOT/diarization decisions, not acoustic-model accuracy.)

> The Playwright recording pipeline itself is verified working — a run on the
> broken branch already produced `video.webm` + a screenshot of the error
> boundary; it just needs the shell to mount.

## 2. Headful A/V — iOS simulator + connected device

**Precondition:** Xcode + a booted simulator (and, for device, an Apple ID
provisioning profile). The on-device agent build must embed the Bun engine
(`ELIZA_IOS_FULL_BUN_ENGINE=1`) for local inference.

```bash
# On-device real round-trip (Pixel pattern mirrors this for Android):
bun run --cwd packages/app test:e2e:android:webview      # Android device
# iOS: drive the booted sim/device via the app's ui-packaged config + cliclick
#      recipe (activate Simulator first; floating composer → send).
```
**Artifacts:** screen recording (simulator: `xcrun simctl io booted recordVideo`),
device-resource metrics via `/api/dev/device-resource-metrics`, and the agent's
trajectory jsonl. **Pass bar:** the STT→agent→TTS round-trip completes on-device;
TTFA within the research budget (≤800 ms good).

## 3. Live cloud STT/TTS (end-to-end)

**Precondition:** an authenticated Eliza Cloud session **with billing credits**
(today the test account returns HTTP 402 — a billing state, not a code bug).

```bash
# Cloud STT  → POST /api/v1/voice/stt   (ElevenLabs-backed)
# Cloud TTS  → POST /api/v1/voice/tts
# Mixed hybrid (local STT + cloud LLM + local TTS) is the default mobile-local
# routing — verify the chosen route per slot:
bun run --cwd packages/ui test -- src/voice/voice-provider-defaults.test.ts
```
**Pass bar:** a real STT call returns a transcript and a real TTS call returns
audio (200, non-empty body); the hybrid latency lands within the research TTFA
budget. Capture the structured `[ClassName] …` backend logs + the network trace.

## 4. Real on-device model lane (real WER / DER / EOT latency)

**Precondition:** the native fused `libelizainference` built for the host
platform plus an Eliza-1 GGUF bundle with verified Gemma ASR, WeSpeaker,
pyannote, Silero, openWakeWord, and Kokoro staged under the models directory.
The retired Qwen compatibility bundle is not product evidence (#17477).

```bash
# Build the fused lib (macOS example), then run the real lane:
bun run --cwd plugins/plugin-local-inference voice:workbench --real \
  --out /tmp/voice-workbench-real

# Real ASR smoke (runs OUTSIDE `bun test` — coverage=true EMFILEs the GGUF mmap):
bun run --cwd plugins/plugin-local-inference test:asr:real
```
**Artifacts:** `/tmp/voice-workbench-real/report.{json,md}` with REAL WER (on the
degraded robustness corpus), diarization DER, EOT latency p50/p95, first-audio
latency. Review every scenario and the raw audio; the corpus from §0 (with
reverb/noise/far-field) is the input where robustness is actually measured.

## 5. Wake word "hey eliza"

**Precondition:** the trained head shipped in the tier bundle
(`voice/wakeword/hey-eliza.*.gguf` — published to `elizaos/eliza-1` v0.3.0;
placeholder until bundled everywhere). Verified ~98% true-accept / 4–7%
false-accept at training. Local-mode only; inert in cloud mode.

---

## Evidence checklist for closing #8785 (local + cloud)

- [x] Decision logic (EOT / respond / echo×2 / bystander / wake / owner) — CI `--logic` telemetry
- [x] Robustness corpus (noise/reverb/far-field/low-quality/babble/overlap) — DSP tests + corpus:generate
- [x] Research (pause lengths, VAD, AEC, diarization, owner verification, model landscape, hybrid latency)
- [x] Headful A/V — desktop + web  *(13/13 specs passed + recorded + adversarially verified; `.github/issue-evidence/8785-voice-headful/`)*
- [~] iOS **simulator** — app boots + UI renders, recorded (`.github/issue-evidence/8785-voice-ios-sim/`); voice *inference* on the sim is Metal-gated (no GPU on the sim) — fundamentally needs a physical device for local, or cloud credits.
- [~] iOS **physical device** — **the signed app + embedded full-Bun engine is INSTALLED on Shaw's iPhone 15 Pro** (`ios-device-installed.md`). Signing was cracked: the correct team is **25877RY2EH** (not the cert's CN `UT5K5Q5EVF`); automatic signing + the cached team profiles (which cover the device) + the generic "Apple Development" identity needs no Xcode account; aligning the 2 DeviceActivity extensions' entitlements to their profiles → BUILD SUCCEEDED → `devicectl device install` → app on device. The **only** thing left is a physical action: **unlock the iPhone** (it was locked, so iOS refused to launch the dev app — FBSOpenApplicationErrorDomain error 7 "Locked") + trust the developer (Settings → General → VPN & Device Management), then open Eliza → "This device". The embedded engine then runs on the iPhone's real Metal GPU — the same fused engine + GGUF proven running real voice models on this Mac's Apple Silicon.
  ```bash
  # after the user unlocks + trusts the dev cert:
  xcrun devicectl device process launch --device 00008130-001955E91EF8001C ai.elizaos.app
  idevicesyslog | grep -iE "eliza|bun|llama|metal|asr|inference"   # on-device engine logs
  ```
- [x] **Live cloud STT/TTS E2E** — ElevenLabs `eleven_turbo_v2_5` + `scribe_v1` round-trip, WER 0 (`.github/issue-evidence/8785-voice-real-cloud/`).
- [x] **Real on-device ASR + WER on the degraded corpus** — eliza-1-asr via the fused dylib + Metal; WER 0 across every realistic degradation (noise to 0 dB, reverb to 0.98, far-field, telephone, harsh), graceful past the edge.
- [x] **Mixed local STT + cloud LLM + cloud TTS** — `roundtrip:real`: ~770–870 ms hybrid (local STT ~200 ms + Cerebras ~270 ms + cloud TTS ~270 ms).
- [x] **Real speaker recognition + diarization + VAD + local TTS** — `voicestack:real`: WeSpeaker same-speaker ~0.72 vs different ~0.15 (owner-vs-intruder), pyannote ≥2 speakers, Silero speech 1.0 / silence 0.009, on-device TTS 3.9 s. (`.github/issue-evidence/8785-voice-real-cloud/`)
- [~] EOT turn-detector model — GGUFs present (en/intl); the heuristic EOT is validated in `--logic`; the model path (`eotScore`) needs the text model + tokenizer loaded to drive via FFI.
- [ ] Wake-word "hey eliza" model — a real head is published (v0.3.0, ~98% true-accept) but not staged in this bundle; the wake-word *decision* (phrase detection + override) is validated in `--logic`.
- [ ] iOS **physical device** — needs Apple ID provisioning
