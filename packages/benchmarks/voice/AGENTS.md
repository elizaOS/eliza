# Voice Pipeline Benchmark — Agent Guide

Stress-tests the native voice stack: TTS synthesis (OmniVoice + Kokoro), speaker
diarization (pyannote-3 GGUF), speaker encoder/re-ID (WeSpeaker ResNet34-LM), ASR
(eliza-1 FFI), should-respond detection, and owner-voice security. Not registered
in the suite orchestrator — run scripts directly with Bun.

## Run

```bash
# Local real-acoustic eval: real pyannote diarizer + WeSpeaker encoder on real
# audio (Apple Silicon Metal, no GPU runner / no ElevenLabs)
ELIZA_INFERENCE_LIBRARY=<repo-root>/libelizainference.dylib ELIZA_BUNDLE_DIR=<bundle> \
ELIZA_PYANNOTE_GGUF=<pyannote.gguf> ELIZA_WESPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_SPK_A_WAV=<a.wav> ELIZA_SPK_B_WAV=<b.wav> \
  bun packages/benchmarks/voice/local-acoustic-eval.mjs

# Provisioned CI real matrix: fused lib + GGUFs + generated speech.
# Fails instead of skipping when any real dependency is absent.
ELIZA_ASR_BUNDLE=<bundle> \
ELIZA_INFERENCE_LIBRARY=<libelizainference> \
ELIZA_SPEAKER_GGUF=<wespeaker.gguf> \
ELIZA_DIARIZ_GGUF=<pyannote.gguf> \
ELEVENLABS_API_KEY=<key> \
  bun packages/benchmarks/voice/voice-real-ci-matrix.mjs

# Three-voice scenario with synthetic fixtures (no real TTS models needed)
bun packages/benchmarks/voice/three-voice-scenario.mjs [--bundle <path>]

# Owner-voice enrollment, recognition, rejection, and prompt-injection defense
bun packages/benchmarks/voice/owner-voice-first-run.mjs

# Diarizer smoke test (falls back to pure-JS if native lib not built)
bun packages/benchmarks/voice/test-diarizer.mjs [--bundle <path>]

# Speaker encoder smoke test (falls back to pure-JS if native lib not built)
bun packages/benchmarks/voice/test-speaker-encoder.mjs

# Kokoro agent voice + ASR roundtrip
bun packages/benchmarks/voice/verify-kokoro-agent-voice.mjs

```

## Smoke test (no TTS/ASR models)

`owner-voice-first-run.mjs` and `test-speaker-encoder.mjs` both use a pure-JS
synthetic voice generator and fall back automatically when the native
`libvoice_classifier.dylib` is not built. They pass without any model bundle:

```bash
bun packages/benchmarks/voice/owner-voice-first-run.mjs
bun packages/benchmarks/voice/test-speaker-encoder.mjs
bun packages/benchmarks/voice/test-diarizer.mjs
```

## Test the harness

No dedicated test suite — the scripts themselves are the verification. Exit code 0
means pass, non-zero means failure. `owner-voice-first-run.mjs` reports a check
count and exits 1 on any failure.

## Layout

| Path | Role |
| --- | --- |
| `local-acoustic-eval.mjs` | Local real-acoustic eval: real pyannote diarizer + WeSpeaker encoder on real audio (Apple Silicon Metal, no GPU runner / no ElevenLabs) — diarizer counts, DER proxy, WeSpeaker cosine |
| `voice-real-ci-matrix.mjs` | Provisioned CI real matrix: ElevenLabs owner/impostor speech + fused on-device agent TTS/ASR/diarizer/speaker encoder, producing DER/WER/echo-rejection/owner-security metrics |
| `three-voice-scenario.mjs` | Same scenario with synthetic-fixture PCM (no real TTS) |
| `owner-voice-first-run.mjs` | Owner enrollment, recognition, rejection, injection-attack defense (pure-JS, self-contained) |
| `test-diarizer.mjs` | Diarizer GGUF smoke test; falls back to pure-JS classifyFramesToSegments |
| `test-speaker-encoder.mjs` | WeSpeaker encoder smoke test; falls back to pure-JS cosine pipeline |
| `verify-kokoro-agent-voice.mjs` | Kokoro ONNX TTS + ASR roundtrip |
| `reports/` | JSON + Markdown reports written by scripts at runtime (not committed) |

## Notes

- The retired standalone `libvoice_classifier` scripts were removed after the
  direct GGML encoder/diarizer exports were retired. Use `local-acoustic-eval.mjs`
  for local real-audio diarizer/encoder checks, or `voice-real-ci-matrix.mjs`
  for the provisioned fused-library CI lane.
- Reports write to `packages/benchmarks/voice/reports/` at runtime (not in git).
- Not registered in `registry/commands.py` — no orchestrator `--benchmarks` ID.
- The pure-JS fallback paths in `test-diarizer.mjs` and `test-speaker-encoder.mjs`
  are intentional and documented; they exercise the JS segmentation logic without
  the native library.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — benchmark / eval suite:**
- A **real-model** run (not the mock/smoke fixture) producing the score-report JSON, with the numbers inspected and the provider/model recorded.
- The per-item trajectories the harness captured, spot-reviewed for correctness — a green harness run over mock fixtures is not a result.
- The provider matrix actually exercised, and the scoring math validated against a known case.
- Failure / timeout / partial-output handling in the harness itself.
<!-- END: evidence-and-e2e-mandate -->
