# #12254 — Voice latency: before/after evidence

Branch `feat/12254-voice-latency` vs base `origin/develop` (a7db79c3fe0).
Host: macOS arm64 (M-series), Bun 1.3.14. No fused `libelizainference` build is
present on this host (only `libllama` + shim under
`~/.eliza/local-inference/bin/`), so every measurement below states exactly
which lane produced it.

## 1. Endpoint wait (the dominant knob) — deterministic VAD timeline

Method: a scripted utterance (19 speech windows ≈ 608 ms at 0.92 speech
probability, then sustained silence at 0.02) fed through the real
`VadDetector` state machine on its 32 ms window clock; the endpoint wait is
`speech-end.timestampMs − last-speech-window-end`. Deterministic — the state
machine is driven by scripted probabilities, so these numbers are exact
(quantized up to one 32 ms window). Script: the "measured endpoint wait" test
in `plugins/plugin-local-inference/src/services/voice/vad.v1-v4.test.ts`
(same harness as the standalone measurement below).

| Config | BEFORE (develop) | AFTER (this branch) | Δ |
| --- | --- | --- | --- |
| Shipped default, no semantic EOT (fixed-VAD) | **704 ms** | **512 ms** (500 floor) | **−192 ms** |
| Fused `FfiEotScorer` composite live (`semanticEotActive`) | **704 ms** (no gate existed) | **320 ms** (300 default) | **−384 ms** |
| Explicit `endHangoverMs: 700` (override preserved) | 704 ms | 704 ms | 0 |

Raw runs:

```
BEFORE (develop @ a7db79c3fe0):
default config (shipped): endpoint-wait=704ms (last-speech=608ms speech-end=1312ms)

AFTER (this branch):
default (no semantic EOT — fixed-VAD floor):    endpoint-wait=512ms (last-speech=608ms speech-end=1120ms)
semanticEotActive:true (fused EOT live):        endpoint-wait=320ms (last-speech=608ms speech-end=928ms)
explicit endHangoverMs:700 (pre-change value):  endpoint-wait=704ms (last-speech=608ms speech-end=1312ms)
```

Projection onto the measured hybrid E2E from
`research/VOICE_VALIDATION_RUNBOOK.md:131` (~770–870 ms TTFA + the endpoint
wait on top): cutting the endpoint wait 700→500 saves 200 ms on every turn
today; 700→300 saves 400 ms once the fused EOT scorer ships in the production
build — which is what brings speech-end→first-audio under the ≤800 ms good /
toward the ≤500 ms great target (§7). The 500 ms fixed-VAD floor matches
OpenAI Realtime `silence_duration_ms=500` and LiveKit
`min_endpointing_delay=500` (research §1); 300 ms is permitted only when the
semantic scorer gates commitment (mid-clause P<0.4 still extends the wait via
`EOT_HANGOVER_EXTENSION_MS`).

## 2. Turn-taking non-regression — workbench `--logic` lane vs baseline

`bun run --cwd plugins/plugin-local-inference voice:workbench -- --logic
--baseline src/services/voice/__fixtures__/voice-workbench-logic-baseline.json`

| Metric | BEFORE | AFTER |
| --- | --- | --- |
| Overall | PASS — 18 ran, 0 skipped | PASS — 18 ran, 0 skipped |
| EOT false-trigger rate (mean/worst, n=18) | 0 / 0 | 0 / 0 |
| Respond accuracy | 1 | 1 |
| WER | 0 | 0 |
| First-audio (ms, logic-lane synthetic) | 250 | 250 |
| Regressions vs golden baseline | none | none |

Full reports: `workbench-logic-{before,after}.report.{json,md}` in this
directory. The `pauses-midutterance` (pauses/eot class) scenario passes in
both runs. Note the logic lane exercises the shipped EOT/respond decision
logic over the corpus; the acoustic-layer premature-cutoff rate at the new
hangover needs the real lane (see N/A section).

## 3. Streaming-ASR partial stabilization (fake-FFI lane)

The fused streaming decoder reports `asrStreamSupported() == 0` on every
shipped build today (the C-side W7 decoder has not landed), so the streaming
path cannot be exercised for real anywhere — including CI. Evidence is the
scripted-FFI test lane, which drives the REAL adapter + bridge code:

- `engine-bridge-asr-mode.test.ts` — a real `EngineVoiceBridge` (mocked
  `loadElizaInferenceFfi` only) picks streaming + LocalAgreement-2
  stabilization when the fake advertises the decoder, keeps the interim batch
  adapter byte-identical when it does not (today's state), and honours the
  `ELIZA_VOICE_STREAMING_ASR` kill switch and `ELIZA_LOCAL_ASR_BACKEND` pin.
- `__tests__/streaming-transcriber.test.ts` — feeder/wrapper never emit a
  retracted word (seeded property test over random hypothesis churn); this
  run found and fixed a real retraction bug in `LocalAgreementBuffer` /
  `PartialStabilizer` (a longer agreement could rewrite committed words).

## 4. Memory budget — allocator wire-up

`voice-budget-loaders.test.ts` drives arm/disarm cycles for all five loader
call sites (`GgmlSileroVad.load`, `GgmlWakeWordModel.load`,
`tryBuildFusedEotClassifier`, `VoicePipeline.run` TTS transient,
`FfiStreamingBackend.load` text-target + drafter): reservation rows appear
while armed, the allocator is empty after close/dispose/unload, and an
over-budget arm throws `VoiceLifecycleError("ram-pressure")` before any
native session opens.

## 5. Verification commands run

```
bun run --cwd plugins/plugin-local-inference typecheck        # clean
bun run --cwd plugins/plugin-local-inference lint:check       # clean
bunx vitest run src/services/voice/ src/services/ffi-unload-ordering.test.ts \
  src/services/memory-arbiter.test.ts src/services/memory-monitor.test.ts
  # 1035 tests: 1031 passed, 3 skipped, 1 failed
  # (nlms-echo-canceller.test.ts 5s timeout under 106-file parallel load —
  #  untouched echo-domain file; passes in isolation in 3.4s)
bun run --cwd plugins/plugin-local-inference voice:workbench -- --logic --baseline ...  # PASS, no regressions (before AND after)
```

## 6. N/A rows (with reasons)

- **`GET /api/dev/voice-latency` before/after against a running app**: N/A —
  the per-stage traces are only produced by live voice turns through the
  fused pipeline, and no fused `libelizainference` build exists on this host
  (or anywhere yet with the streaming decoder); a booted app would return an
  empty trace table. The deterministic VAD-timeline measurement above is the
  honest equivalent for the endpoint stage (the only stage this change
  moves — decision #6 explicitly excludes synthesis/chunking).
- **Workbench `--real` lane / real-lane ASR decode p90 (work item 3)**: N/A —
  requires the fused lib + `ELIZA_ASR_BUNDLE` artifacts, absent on this host.
  Consequence honoured in code: the interim-batch `stepSeconds` default STAYS
  1.2 s (not lowered to 0.8) until the real-lane per-pass decode p90 is
  measured below the candidate step; `ELIZA_ASR_STEP_SECONDS` + per-pass
  `decodeStats()` timing landed so that measurement is a one-liner on
  provisioned hardware.
- **voicebench `speechEndToFirstAudio*Ms` p95/p99**: N/A — the suite drives
  cloud providers (Groq Whisper/Orpheus or ElevenLabs; no keys on this host)
  over pre-segmented fixture audio, so the endpoint wait this PR cuts is not
  inside its measurement window either.
- **Captured audio + narrated walkthrough**: N/A — no reachable device or
  desktop run exercises the changed code path (the local fused voice loop)
  without the fused build; the cloud TTS paths a desktop run would use are
  untouched by this PR.
- **Real-LLM trajectories**: N/A — no agent/action/provider/prompt/model
  behavior changes; this PR is voice-runtime latency/memory plumbing.
