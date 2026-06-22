# Voice Validation Runbook (#8785)

Turn-key steps to execute the **gated** end-to-end validations once the
corresponding resource is available. Everything that does NOT need a gated
resource is already proven in CI (see [VOICE_8785_ASSESSMENT.md](./VOICE_8785_ASSESSMENT.md)
§2–4). This runbook covers the remaining lanes: headful A/V capture (desktop /
web / simulator / iOS), live cloud STT/TTS, and the real on-device model lane.

Each section states: **precondition → command → expected artifact → pass bar.**

---

## 0. Always-runnable baseline (no resource needed) — run first

```bash
# Decision logic over the full scenario matrix + regression gate (no models):
bun run --cwd plugins/plugin-local-inference voice:workbench --logic \
  --baseline src/services/voice/__fixtures__/voice-workbench-logic-baseline.json

# The labeled audio-sample corpus (listen to the degraded edge cases):
bun run --cwd plugins/plugin-local-inference corpus:generate --out /tmp/voice-corpus
```
Pass bar: `[voice:workbench] no regressions … PASS`; 14 scenarios under
`/tmp/voice-corpus/<id>/audio.wav` + `ground-truth.json`.

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
platform + the Eliza-1 GGUF bundle (text + Qwen3-ASR + WeSpeaker + pyannote +
Silero + openWakeWord + Kokoro) staged under the models dir.

```bash
# Build the fused lib (macOS example), then run the real lane:
bun run --cwd plugins/plugin-local-inference voice:workbench --real \
  --baseline src/services/voice/__fixtures__/voice-workbench-logic-baseline.json \
  --out /tmp/voice-workbench-real

# Real ASR smoke (runs OUTSIDE `bun test` — coverage=true EMFILEs the GGUF mmap):
bun run --cwd plugins/plugin-local-inference test:asr:real
```
**Artifacts:** `/tmp/voice-workbench-real/report.{json,md}` with REAL WER (on the
degraded robustness corpus), diarization DER, EOT latency p50/p95, first-audio
latency. **Pass bar:** WER/DER under the per-scenario ceilings; no regression vs
the baseline. The corpus from §0 (with reverb/noise/far-field) is the input —
this is where robustness is actually measured.

## 5. Wake word "hey eliza"

**Precondition:** the trained head shipped in the tier bundle
(`voice/wakeword/hey-eliza.*.gguf` — published to `elizaos/eliza-1` v0.3.0;
placeholder until bundled everywhere). Verified ~98% true-accept / 4–7%
false-accept at training. Local-mode only; inert in cloud mode.

---

## Evidence checklist for closing #8785 (local + cloud)

- [x] Decision logic (EOT / respond / echo×2 / bystander / wake / owner) — CI `--logic` + regression gate
- [x] Robustness corpus (noise/reverb/far-field/low-quality/babble/overlap) — DSP tests + corpus:generate
- [x] Research (pause lengths, VAD, AEC, diarization, owner verification, model landscape, hybrid latency)
- [x] Headful A/V — desktop + web  *(13/13 specs passed + recorded + adversarially verified; `.github/issue-evidence/8785-voice-headful/`)*
- [ ] Headful A/V — simulator + iOS device  *(needs §2)*
- [ ] Live cloud STT/TTS E2E  *(needs §3 credits)*
- [ ] Real WER/DER/EOT-latency on degraded corpus  *(needs §4 artifacts)*
