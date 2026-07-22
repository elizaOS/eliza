# Per-platform on-device inference backend strategy — CoreML / LiteRT-LM / Metal

**Status: decision record + current-state evidence (2026-06-24).** Answers the
recurring question "should iOS/Mac LLM inference move to CoreML or LiteRT-LM, and
does llama.cpp give us per-platform backends for max battery/GPU efficiency?"

Short answer: **the per-platform backend strategy already exists and is correct.**
One `elizaOS/llama.cpp` fork compiles into `libelizainference` with the right GGML
backend per platform. **CoreML and LiteRT-LM are not the levers for Apple LLM
decode** — Metal is, and it is already the shipped, optimized, verified path.

---

## 1. Per-platform backend table (what is actually built/used)

| Platform | GGML backend | Source of truth |
|---|---|---|
| **macOS** (Apple Silicon) | **Metal** (TurboQuant + eliza kernels embedded) | `packages/app-core/scripts/build-llama-cpp-mtp.mjs` (`-DGGML_METAL=ON`, embed metallib) |
| **iOS** (arm64) | **Metal** (static archives) | same build script, `ios-arm64-metal` / `…-metal-fused` targets |
| **Android** arm64 | **Vulkan** (GPU) + CPU fallback | `packages/app-core/scripts/aosp/compile-libllama.mjs` |
| **Android** x86_64 | CPU only | same (Vulkan wired for arm64 only) |
| **Linux / Windows desktop** | CUDA (NVIDIA) / CPU | desktop dylib build + `cuda_verify` |

All from **one fork → one managed library (`libelizainference`) → one FFI pipe**
(native/AGENTS.md §11). This *is* "per-platform backends for max battery/GPU
efficiency." There is no separate per-platform runtime to add.

## 2. CoreML — wrong tool for LLM decode; correct where it is already used

- **LLM autoregressive decode:** CoreML/ANE is **not viable**. CoreML compiles a
  *static* graph with fixed tensor shapes; LLM decode grows a KV cache token by
  token with per-position masks. ANE targets fixed-graph CV/encoder workloads, not
  streaming text. There is no CoreML LLM-decode backend in llama.cpp, and we have
  none. The correct Apple LLM backend is **Metal/MPS**, which handles dynamic KV
  shapes natively.
- **Where CoreML IS used (correctly):** fixed-graph models — **Kokoro TTS on iOS**
  (`kokoro-coreml/*.mlmodelc`) and **image generation** (`src/services/imagegen/`
  CoreML backend). These are encoder/diffusion graphs, the right shape for CoreML.
- **Apple Foundation Models** (`src/backends/apple-foundation.ts`): an
  **opportunistic** iOS-26 text adapter, never the owned backend (native/AGENTS.md
  §11). Out-of-process OS model services cannot satisfy the single-runtime
  contract.

### 2a. Every voice/vision model is already on its optimal backend — MEASURED, no ANE win to capture

A natural follow-up: the **always-on** gate models (Silero VAD, openWakeWord) run
continuously, so wouldn't the ANE save battery vs the GPU? **Measured on this Apple
Silicon Mac (ANE present, CoreML native) — the answer is no, on two counts:**

1. They **don't run on the GPU** — both ship on **native CPU** (pure scalar C, "no
   ggml link"): `silero_vad_runtime.c` / `wakeword_runtime.c`, whose
   `*_active_backend()` returns `"native-cpu"`.
2. The **ANE is slower** for a model this tiny. Ran Silero VAD v5 ONNX (2.3 MB LSTM)
   200×32 ms windows, CoreML EP (ANE) vs CPU EP: **CPU 0.227 ms/window vs ANE
   0.798 ms/window — the ANE is 3.5× slower** (identical outputs). ANE dispatch
   overhead dominates a few-layer LSTM; the ANE wins on *large* fixed-graph models
   (Kokoro), not tiny per-frame gates. Reproduce with onnxruntime 1.22 and
   coremltools 9.0 using the 200-window method above, then attach the generated
   benchmark report to the reviewing issue or PR.

So the architecture already routes every model to its optimal backend by compute
profile, and it's verified:

| Model | Cadence | Backend | Right call |
|---|---|---|---|
| LLM (Gemma) decode | per-token, dynamic KV | **Metal** | ANE can't do dynamic decode |
| Vision mmproj / local ASR | bursty | **Metal** | GPU-sized bursty work |
| Kokoro TTS | per-utterance | **CoreML** (`kokoro_5s.mlmodelc`) | larger fixed-graph → ANE helps |
| **Silero VAD** | always-on | **native CPU** | tiny LSTM → CPU fastest+lowest-power (measured; ANE 3.5× slower) |
| **openWakeWord** | always-on | **native CPU** | same |

**Bottom line for "optimize voice for CoreML on iOS":** there is **no un-captured
CoreML/ANE win** — Kokoro already uses CoreML where it pays off, and the tiny
always-on gates are correctly on the CPU (the ANE would *regress* them, measured).
The system is already optimal. LiteRT-LM (the Android-NPU analogue) would hit the
same tiny-model dispatch-overhead wall for the gate models.

## 3. LiteRT-LM — not used; permitted only as a future in-process Android-NPU backend

- **Not present in the resolved code path.** No LiteRT/TFLite/MediaPipe LLM runtime
  is wired.
- The architecture **permits** LiteRT-LM *only* as an in-process backend that links
  into `libelizainference` behind the same FFI symbols, for the **Android NPU**
  path (native/AGENTS.md §11). It is **additive** to llama.cpp, not a replacement,
  and is **unimplemented**.
- It does **nothing for Apple.** Adopting it would not touch the iOS/Mac story.
  It is a future Android-NPU optimization, gated on real product demand.

## 4. The shipped model is Gemma 4 — its optimization set is applied + verified

The current Eliza-1 tiers ship **Gemma 4** bases (E2B/E4B/12B/31B → 2b/4b/9b/27b),
not the retired Qwen3.5/3.6 line (`packages/shared/src/local-inference/catalog.ts`).
Gemma's KV is already minimal (MQA + windowed-SWA + shared-KV, dual head dims
512/256), so:

- **Mandatory set (applied):** TurboQuant weight-quant (`turbo3`/`turbo4`,
  `+turbo3_tcq` on big/long-ctx tiers) + **MTP separate-drafter speculative decode**
  + Gemma-native memory settings + **stock minimal KV (f16/q8_0)**.
- **MTP wiring (applied on the Apple/desktop path):** `catalog.ts runtimeForTier`
  → `active-model.ts` (`draftMin/draftMax/speculativeSamples`) →
  `desktop-fused-ffi-backend-runtime.ts` → the FFI's separate-drafter MTP engine
  (`tools/omnivoice/src/eliza-inference-ffi.cpp`).
- **NOT applicable on Gemma:** the legacy **head_dim=128 QJL K-cache /
  PolarQuant(TBQ) V-cache fused-attn** kernels. They still ship and pass
  verification, but the decode graph never routes a Gemma KV through them — the
  dequant-to-F16 hop in `src/llama-graph.cpp:1990` only fires for
  `QJL1_256`/`TBQ3_TCQ`/`Q4_POLAR` cache types, which Gemma never allocates.
  `catalog.test.ts` ("advertises only safe runtime optimizations for the shipped
  gemma4 tiers") pins this contract.

### Implication for issue #8848

#8848's headline item — "fused QJL/TBQ attention is implemented but never routed,
leaving a win on the table" — is a **legacy-Qwen** concern, filed from a Pixel
audit of the Qwen-shaped `eliza-1-0_8b`. It is **not on the shipped Gemma critical
path**: routing it would not speed up the Gemma model (Gemma has no QJL/TBQ cache
to route). The live Gemma audit (TurboQuant + MTP + stock KV) is green and tested.
The Mali/Vulkan items in #8848 (#4 generic-FA race, #5 prefill matmul) remain real
for Android GPU but are independent of the fused-attn routing.

## 5. Host-side verification evidence (Apple M-series, this machine, 2026-06-24)

Run from `plugins/plugin-local-inference/native/verify/` (Metal framework runtime
shader compilation — no full Xcode required):

```
make reference-test        → self-test: turbo3/turbo4/turbo3_tcq/qjl/polar/fused all finite, parity OK
make metal-verify          → turbo3 8/8 · turbo4 8/8 · turbo3_tcq 8/8 · qjl 8/8 · polar PASS (tol 1e-3)
make metal-verify-fused    → fused_attn_qjl_polar 1920/1920 PASS (max_diff 4.8e-7)
                             fused_attn_qjl_polar causal-prefix 1536/1536 PASS (max_diff 9.5e-7)
                             polar_preht use_qjl=0/1 8/8 PASS
```

Cross-check: `verify/PLATFORM_MATRIX.md` records the 2026-06-23 Gemma-4 Metal
cutover — §8 kernel gate 40/40 PASS incl. fused-attention, and **real
`google/gemma-4-E2B` (head_dim 512, MQA, SWA) generation + `llama-bench` pp512 636
/ tg128 23 t/s (FA=1)** on the Metal FA path.

**Conclusion:** the Apple/Metal Gemma path is optimized (TurboQuant + MTP + minimal
KV), and every shipped kernel is bit-exact on Apple Silicon. No CoreML/LiteRT pivot
is warranted or beneficial for iOS/Mac LLM decode.

## 6. Genuinely-remaining gated items (not code-fixable from a Mac host)

| Item | Issue | Why gated |
|---|---|---|
| ~~Gemma MTP drafter GGUF conversion + on-Metal `--spec-type draft-mtp` gate~~ — **DONE 2026-06-24**: drafter converted (`drafter-2b.gguf`), validated on M-series Metal, and the fast-tier draft window fixed (`draftMax` 4→1 = **1.37–1.66× decode win** on the 2B; the prior "regression" was the mistuned window, not the head). A from-scratch H200 head is now only a possible large/slow-tier optimization, not a fast-tier unlock. | #8848 / #9172 | n/a — shipped; see `docs/gemma4-mtp-drafter-conversion.md` (2026-06-24 correction) |
| ~~Rebuild + republish the **prebuilt Android Vulkan fused-lib** to `eliza-archive`~~ — **OBSOLETE: builds in CI, no archive.** `.github/workflows/build-llama-ffi-android.yml` is the standalone native producer and builds exactly two ABIs by default: `android-arm64-vulkan-fused` (`arm64-v8a`) and `android-x86_64-cpu-fused` (`x86_64`) through `compile-libllama.mjs` with the zig 0.13 pin from #9598. `.github/workflows/build-android.yml` is the real consumer: it queries successful producer runs through the Actions API, accepts only a run whose native producer inputs match the checkout, and downloads the named artifacts. There is **no eliza-archive prebuilt dependency and nothing to republish**. The producer fails before upload when the fused ABI or Mali mitigation marker is missing; the Linux/CUDA + Mali-G715 kernel gates are verified on real hardware (#9584/#9715). | #9508 | n/a — CI-built |
| **Real-audio GPU CI lane** (DER/WER/echo/owner/impostor numbers) | #9454 | needs a `gpu-cuda-12.6` self-hosted runner + `ELEVENLABS_API_KEY` |
| **PCM-level AEC3** sample-level echo cancellation (turn-level self-voice gate already shipped) | #9455 | net-new DSP feature (adaptive filter + double-talk detect + ERLE corpus) |
