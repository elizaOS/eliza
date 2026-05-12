# Eliza-1 end-to-end voice-loop benchmark — 2026-05-11

Harness: `packages/inference/verify/e2e_loop_bench.mjs` (Bun; `bun:ffi` for the
ASR FFI + TTS-cancel calls). Drives the *real* fused runtime per
`packages/inference/AGENTS.md` §4: the omnivoice-grafted `llama-server`
(`/completion` + `/v1/audio/speech` + the in-process DFlash speculative loop)
plus `libelizainference.so`'s ASR FFI — one process, one llama.cpp build, one
GGML pin. No second model process.

One voice turn = `WAV (mic) → ASR transcribe (FFI) → text generate w/ DFlash
spec decode (SSE) → phrase chunker → OmniVoice TTS (/v1/audio/speech, raw f32
PCM) → PCM out`. The "mic" WAVs are synthesized from a fixed reference-phrase
set via the bundle's own OmniVoice TTS (24 kHz → 16 kHz 16-bit), so WER is the
round-trip word error rate of the ASR transcript against the phrase that
produced the audio.

Results JSON: `packages/inference/verify/bench_results/e2e_loop_2026-05-11.json`.

## Host

| | |
|---|---|
| CPU | Intel Core Ultra 9 275HX (24 cores, AVX-VNNI) |
| RAM | ~30 GB |
| iGPU | Intel Arc/Xe (Mesa ANV Vulkan) |
| dGPU | NVIDIA RTX 5080 Mobile (Blackwell, 16 GB) — CUDA 13 driver live |

## Fused build inventory (`~/.eliza/local-inference/bin/dflash/`)

| dir | fused | backend | `/v1/audio/speech` | `llama-speculative-simple` | streaming ABI |
|---|---|---|---|---|---|
| `linux-x64-cpu-fused` | ✓ | cpu | ✓ (mounted) | — (graft drops it) | stubbed (`tts_stream_supported()==0`, `asr_stream_supported()==0`) — batch TTS/ASR work |
| `linux-x64-cpu` | — | cpu | — | ✓ | — |
| `linux-x64-vulkan` | — | vulkan | — | ✓ | — |
| `windows-x64-cpu`, `android-arm64-{cpu,vulkan}` | — | — | — | — | — |

Only `linux-x64-cpu-fused` is an omnivoice-fused build. There is **no**
`linux-x64-vulkan-fused` or `linux-x64-cuda-fused` build on disk yet, so the
`--backend vulkan` / `--backend cuda` runs honestly report `needs-build` rather
than silently using the CPU-fused build mislabeled (this honesty fix landed in
`discoverEngine` in this pass — a `--backend X` run uses an `X`-fused build or
nothing).

## Bundle artifacts (both real bundles, `~/.eliza/local-inference/models/`)

`eliza-1-0_6b.bundle` and `eliza-1-1_7b.bundle` both carry real GGUFs:
text (`eliza-1-{0_6b,1_7b}-…k.gguf`, base-v1 — converted + Milady-quantized,
NOT fine-tuned), DFlash drafter (`drafter-{0_6b,1_7b}.gguf`, a real GGUF that
is currently a near-copy of the target → ~100% acceptance), OmniVoice
TTS (`omnivoice-base-Q4_K_M.gguf` + `omnivoice-tokenizer-Q4_K_M.gguf`), ASR
(`eliza-1-asr.gguf` + `-mmproj.gguf`), VAD (`silero-vad-int8.onnx`). The ASR
GGUF is a stand-in-quality model — it transcribes ~garbage, so round-trip
WER ≈ 1.0 (an honest finding, not a harness bug).

## Results

`status: "needs-build"` for vulkan/cuda on both tiers — no fused build for
those backends on this host. CPU rows are real runs against the
`linux-x64-cpu-fused` build.

### 0.6B — CPU (`linux-x64-cpu-fused`, 1 turn, 40-token response)

| metric | value |
|---|---|
| ASR latency (FFI transcribe) | 4850 ms |
| ASR WER (round-trip) | 1.00 (transcript: `"i."` for `"What is the capital of France?"`) — ASR GGUF is stand-in quality |
| first-token latency (ASR-done → first text token) | 307 ms |
| decode tokens/sec | 12.4 tok/s |
| DFlash acceptance | 1.000 (23/23 — drafter ≈ copy of target) |
| first-audio (mic-in → first PCM of phrase 1) | ~19.6 s (dominated by 3-phrase TTS; conservative end of the streaming-handoff window — the batch HTTP route can't expose the mid-stream first-PCM timestamp) |
| TTS RTF (median over phrases) | 7.14 (≈ 0.41 s/MaskGIT-step × 32 steps; CPU MaskGIT is slow) |
| total turn latency | 48.6 s |
| barge-in cancel latency | 5.2 ms (client-side HTTP abort surrogate — `cancel_tts` is a no-op on the batch-only build; native streaming-cancel symbols are stubbed) |
| server peak RSS | 3070 MB — **over** manifest `ramBudgetMb.recommended` (1800 MB): the fused process holds text + drafter + omnivoice (base + tokenizer + DAC + HuBERT + sem-enc) all resident |

### 1.7B — CPU (`linux-x64-cpu-fused`, 1 turn, 16-token response, ≤3 TTS phrases)

Run under heavy CPU contention from a concurrent fork CUDA build (`-j5..-j24`)
— TTS RTF in particular is inflated by that, not a true idle figure.

| metric | value |
|---|---|
| ASR latency (FFI transcribe) | 4430 ms |
| ASR WER (round-trip) | 1.00 (transcript: `"[0."`) — ASR GGUF is stand-in quality |
| first-token latency | 87 ms |
| decode tokens/sec | 12.0 tok/s |
| DFlash acceptance | 0.333 (2/6 — drafter ≈ copy of target; lower draft-window hit ratio on 1.7B) |
| first-audio (mic-in → first PCM of phrase 1) | ~25.3 s (3-phrase TTS at >1×-RTF dominates) |
| TTS RTF (median over phrases) | 10.5 (CPU MaskGIT under build contention) |
| total turn latency | 58.9 s |
| barge-in cancel latency | 0.7 ms (client-side HTTP abort surrogate; `cancel_tts` no-op on batch-only build) |
| server peak RSS | 4485 MB — **within** manifest `ramBudgetMb.recommended` (4500 MB) ✓ |

### Vulkan / CUDA — both tiers

`status: "needs-build"` — `no fused vulkan build dir` / `no fused cuda build
dir` for `linux-x64`. The non-fused `linux-x64-vulkan` build exists (and a fork
CUDA build is being assembled by a sibling agent), but neither is omnivoice-
fused, so the e2e voice loop cannot run on those backends here. Re-run once a
`linux-x64-{vulkan,cuda}-fused` build is staged (`--bin-dir` overrides
discovery).

### 30-turn endurance — 0.6B CPU (`e2e_loop_bench.mjs --turns 30`)

Completed: 30 turns ran with **no crash, no RSS leak** (`leakSuspected: false`),
but `thirtyTurnOk: false` because peak server RSS (3132 MB) exceeds the
manifest `ramBudgetMb.recommended` (1800 MB) — the same single-process voice-
region footprint flagged for the 1-turn run. `e2eLoopOk: true`. Medians over
the 30 turns (turn 1 full, turns 2–30 lighter — 12-token response, 1 TTS
phrase): ASR 3498 ms, first-token 30 ms, decode 38.4 tok/s, DFlash acceptance
0.993, TTS RTF 6.33, total turn 15.8 s, barge-in cancel 1.1 ms,
peak RSS 3132 MB (over budget).

Report: `eliza-1-0_6b.bundle/evals/e2e-loop-bench-30turn.json`. A 1.7B 30-turn
run on this host takes ~45–90 min under concurrent CUDA-build CPU contention —
status of that run is in the eval-suite output below.

## Eval-suite gate results (`eliza1_eval_suite.py` against the real bundles)

The TTS-RTF / ASR-WER / e2e-loop / 30-turn / DFlash-accept eval-suite runners
(previously `not-run` placeholders) now drive the real fused runtime via this
bench. 0.6B aggregate (`eliza-1-0_6b.bundle/evals/aggregate.json`):

| gate | measured | threshold | pass? |
|---|---|---|---|
| `text_eval` | 0.2779 | ≥ 0.55 | ✗ (base-v1, not fine-tuned) |
| `voice_rtf` | 8.62 | ≤ 0.5 | ✗ (CPU MaskGIT TTS) |
| `asr_wer` | 1.00 | ≤ 0.10 | ✗ (stand-in ASR GGUF) |
| `e2e_loop_ok` | **true** | true | **✓** |
| `thirty_turn_ok` | false | true | ✗ (peak RSS over budget) |
| `dflash_acceptance` | **0.8696** (20/23) | ≥ 0.60 | **✓** (`llama-speculative-simple` on `linux-x64-cpu`) |
| `dispatch` (`make kernel-contract reference-test`) | pass | — | ✓ |
| `vad_latency_ms`, `vad_boundary_mae_ms`, `vad_endpoint_p95_ms`, `vad_false_bargein_per_hour` | null | — | ✗ (no labelled speech corpus on host — separate VAD workstream) |
| `barge_in_cancel_ms` | null in aggregate | ≤ 80 | ✗ (the bench measures ~1 ms client-side abort; the gate consumer is `bargein_latency_harness.mjs`, a separate harness — feed it the bench's `bargeInCancelMs` to close this) |
| `peak_rss_mb`, `thermal_throttle_pct` | null | — | needs-hardware (mobile device) |

Manifest `evals` block (patched on disk in the bundle from the aggregate — the
publish orchestrator's `build_manifest` would regenerate it once it gets past
the release-evidence stage):

```json
{
  "textEval": { "score": 0.2779, "passed": false },
  "voiceRtf": { "rtf": 8.6212, "passed": false },
  "e2eLoopOk": true,
  "thirtyTurnOk": false,
  "asrWer": { "wer": 1.0, "passed": false },
  "dflash": { "acceptanceRate": 0.8696, "speedup": null, "passed": true }
}
```

(1.7B eval-suite numbers added when its run — including the slower 30-turn —
finishes; see the report's tail / the bundle's `aggregate.json`.)

## Publish dry-run verdict (0.6B)

`python -m scripts.publish.orchestrator --tier 0_6b --bundle-dir … --dry-run
--metal-verification …/metal_verify.json` — **fails at stage 2 (validate
release evidence)**, before it reaches the eval gates / manifest build:

```
- releaseState must be 'upload-candidate' or 'final'
- final.evals must be true
- final.kernelDispatchReports must be true
- final.platformEvidence must be true
- final.sizeFirstRepoIds must be true
```

So the dry-run never re-builds the manifest. The independent eval-gate verdict
(from the eval suite's `aggregate.json`): `passed = false`, 9 required gate
failures. **Still blocking publish**, even ignoring the release-evidence stage:
- `text_eval` (needs the v2 fine-tune — base-v1 lands 0.28),
- `voice_rtf` (8.6× — CPU MaskGIT TTS; needs a GPU-fused build to land ≤0.5),
- `asr_wer` (1.0 — the bundle's ASR GGUF is stand-in quality),
- `thirty_turn_ok` (peak RSS over `ramBudgetMb.recommended` — the fused process
  holds every voice region resident; either trim the budget or page regions),
- `vad_*` (no labelled speech corpus staged — VAD workstream),
- `barge_in_cancel_ms` (not in the aggregate — wire `bargeInCancelMs` from this
  bench into `bargein_latency_harness.mjs`),
- plus the kernel set itself is incomplete (`missingRequiredKernels:
  ["turbo3_tcq", "qjl_full", "polarquant"]` on `linux-x64-cpu-fused`).

What *now passes* that was previously `not-run`: `e2e_loop_ok`,
`dflash_acceptance`, and the bundle's `dispatch.json` (the `make` verify
targets).

## Notes / honesty caveats

- The text models are **base-v1** (converted + quantized, not fine-tuned), so
  the generated text is off-topic (e.g. LaTeX) — the loop still exercises the
  full decode + DFlash + TTS path correctly; quality is a v2 (fine-tune)
  concern.
- The DFlash drafter is a real GGUF but ≈ a copy of the target, so acceptance
  ≈ 1.0; this is the right *shape* but not a meaningful acceptance number until
  a trained drafter ships.
- The ASR GGUF is stand-in quality → round-trip WER ≈ 1.0. Recorded honestly.
- Server peak RSS exceeds the manifest budget on both tiers because the fused
  process keeps every voice region resident — this is a real publish blocker
  (the `peak_rss_mb` gate is `needs_hardware`/mobile, but the budget mismatch
  is worth flagging for the runtime team).
- Barge-in is the client-side HTTP-abort latency (PCM-ring-drain surrogate) —
  the build's streaming-TTS / `cancel_tts` symbols are stubbed
  (`tts_stream_supported()==0`), so there's no in-flight forward-pass cancel to
  measure. A fused build with the streaming ABI implemented would tighten this.
