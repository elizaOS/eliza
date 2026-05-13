# Eliza-1 Kokoro-82M integration

## Why both Kokoro and OmniVoice

Eliza-1's voice runtime exposes two streaming TTS backends behind the same
`OmniVoiceBackend + StreamingTtsBackend` seam:

- **OmniVoice** (existing default). Forwarded through the fused
  `libelizainference` build. Supports per-user voice cloning via a
  256-dim speaker preset. On the M3 Pro reference machine, TTFB ≈ 220 ms.

- **Kokoro-82M** (new alternative). Apache-2.0,
  [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). ~82M
  params, StyleTTS-2 derivative with fixed voice packs (no per-user
  cloning). CPU TTFB ≈ 97 ms — roughly 2× faster first-audio than the
  OmniVoice path.

The two backends are not redundant. Kokoro wins first-audio latency; the
fused OmniVoice path wins voice cloning. The runtime selector exposes the
tradeoff explicitly rather than hiding it behind a flag.

## Model artifacts

| Artifact | URL | License | SHA-256 (pin) | RAM budget |
|---|---|---|---|---|
| ONNX (fp32) | `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx` | Apache-2.0 | TBD — set on first download | ~310 MB |
| ONNX (q8) | `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx` | Apache-2.0 | TBD | ~80 MB |
| Voice packs | `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices` (one .bin per voice) | Apache-2.0 | per-file | ~1 KB each |
| GGUF (WIP) | `<bundleRoot>/voice/kokoro-82m-v1_0.gguf` (carried by our `packages/inference/llama.cpp` fork) | Apache-2.0 | TBD | ~85 MB int8 |

URLs and constants are exported from
`packages/app-core/src/services/local-inference/voice/kokoro/kokoro-runtime.ts`
(`KOKORO_ONNX_MODEL_URL`, `KOKORO_VOICES_BASE_URL`, `KOKORO_GGUF_REL_PATH`).
The runtime never auto-downloads — it verifies the on-disk SHA-256 against
the manifest pin and raises `KokoroModelMissingError` on mismatch. The
download is a separate operator step.

## Runtime selection

The selector lives at
`packages/app-core/src/services/local-inference/voice/kokoro/runtime-selection.ts`.
The decision is deterministic from a small set of inputs:

```
mode: "omnivoice" | "kokoro" | "auto"  (default "auto"; ELIZA_TTS_BACKEND env override)
requireVoiceCloning: boolean
targetTtfaMs: number
kokoroRtf, omnivoiceRtf: number | null  (latest autotune measurements)
kokoroAvailable, omnivoiceAvailable: boolean
```

The `auto` heuristic, in order:

1. `requireVoiceCloning === true` → OmniVoice.
2. `targetTtfaMs < 200` → Kokoro (when present), else OmniVoice.
3. Kokoro RTF measured and beats OmniVoice by ≥10% → Kokoro.
4. Only one backend's artifacts are present → that backend.
5. Default → OmniVoice (the existing fused-build path).

`ELIZA_TTS_BACKEND=kokoro|omnivoice|auto` forces a specific choice; an
unset env defers to the caller-supplied `mode`. A forced choice with
missing artifacts raises rather than silently downgrading.

## Three execution paths for Kokoro

The runtime contract (`KokoroRuntime`) is the same across all three —
`KokoroTtsBackend` does not care which one it is wrapping.

1. **`KokoroOnnxRuntime`** (default, production). Loads
   `onnxruntime-node` (or `onnxruntime-web` in the renderer) and runs
   the ONNX export. Sessions are reused; voice packs are loaded lazily
   and cached.

2. **`KokoroGgufRuntime`** (mobile / low-RAM). Talks to a running
   `llama-server` over `/v1/audio/speech` when the loaded build advertises
   the Kokoro head. Saves the ~310 MB cost of loading a second runtime
   on phones — both text gen and TTS share the llama-server process.

3. **`KokoroPythonRuntime`** (eval only). Spawns the upstream Python
   inference for the fine-tune evaluator. Never selected by the runtime
   selector — `synthesize()` throws if reached from the live scheduler.

A fourth runtime, `KokoroMockRuntime`, exists for tests and bench
fixtures. It synthesizes a deterministic sine sweep keyed to the input
phoneme count so the scheduler protocol can be exercised end-to-end
without loading ONNX.

## Benchmarking

The bench harness is at
`packages/inference/voice-bench/src/tts-bench.ts`. It drives any backend
that satisfies `BenchableStreamingBackend` over a fixed corpus of 50
utterances:

- 8 single words,
- 12 short clauses,
- 20 full sentences,
- 10 paragraphs.

Per-utterance metrics:

- **TTFB**: invocation → first non-empty `onChunk` body. The latency the
  listener perceives.
- **RTF**: `audio_duration_ms / wall_ms`. Higher is better.
- **Peak RSS**: sampled around each synthesis call.
- **PESQ**: opt-in via the `pesq-node` peer; absent by default, in which
  case PCM is preserved for manual A/B.

The aggregates (per-backend) record p50/p95 of TTFB and RTF and p95 RSS.

### Expected order-of-magnitude numbers

These are the *expected* ranges documented in the bench source — actual
runs may vary by ±30% depending on thermal state and concurrent load.

| Host | Backend | TTFB p50 (ms) | RTF p50 |
|---|---|---|---|
| Mac M3 Pro / Metal | Kokoro | ≈ 110 | ≈ 6× |
| Mac M3 Pro / Metal | OmniVoice | ≈ 220 | ≈ 4× |
| Linux + RTX 4070 / CUDA | Kokoro | ≈ 60 | ≈ 12× |
| Linux + RTX 4070 / CUDA | OmniVoice | ≈ 120 | ≈ 9× |
| Ryzen 9 7900 / CPU | Kokoro | ≈ 95 | ≈ 2.4× |
| Ryzen 9 7900 / CPU | OmniVoice | ≈ 350 | ≈ 1.4× |

## How to swap in a fine-tuned Kokoro

Fine-tunes (LJSpeech-format → Kokoro voice pack or full-model LoRA) live
under the standard `~/.eliza/local-inference/models/kokoro-finetunes/`
directory. The fine-tune pipeline is documented separately by the Apollo
training-loop agent; the integration contract here is:

- A fine-tuned voice produces a `voices/<id>.bin` file with the same 256
  fp32 dims as the upstream pack. Drop it under
  `<bundleRoot>/voice/kokoro/voices/<id>.bin` and add an entry to
  `KOKORO_VOICE_PACKS` (`voice-presets.ts`) — no other runtime change is
  needed.

- A fine-tuned full-model LoRA produces a `model_lora_<rev>.onnx` next to
  the base model. Configure the bundle manifest to point at the LoRA path
  in `layout.modelFile`; the runtime is otherwise unchanged.

The Apollo evaluator drives `KokoroPythonRuntime` against the same fixture
corpus used by `tts-bench.ts`, so per-fine-tune A/B comparisons reuse the
production metric definitions.
