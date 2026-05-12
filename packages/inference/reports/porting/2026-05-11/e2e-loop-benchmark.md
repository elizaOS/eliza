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

### 30-turn endurance — 0.6B CPU

_PENDING_ — `e2e_loop_bench.mjs --turns 30` (turn 1 full, turns 2–30 lighter:
single phrase, 12-token response). Asserts no crash, no monotone RSS leak, peak
RSS within `ramBudgetMb.recommended`. (Slow on this host under concurrent CUDA
build contention — runs ~min/turn.)

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
