# Gemma 4 cutover + multi-backend `libelizainference` — living plan

> Status doc for the Gemma 4 cutover campaign. Supersedes the research issue
> #8794 (Gemma is real + shipped; the open questions there are answered below).
> Continuously updated as milestones land.

## Goal

Cut **eliza-1** over from the Qwen3.5/3.6 backbone to **Gemma 4** entirely
(remove Qwen), and make every platform run the *fastest in-process backend*
behind **one FFI pipe** (`libelizainference`):

| Backend | Where | §11 status |
|---|---|---|
| **llama.cpp** | everywhere (CPU / CUDA / Vulkan-Mali-Adreno / Metal) | owned pipe (today) |
| **LiteRT-LM** (compiled-in) | Android **NPU** (Tensor / Qualcomm QNN / MediaTek NeuroPilot), opt. desktop/iOS GPU | owned pipe ✅ |
| **CoreML / MLX** (compiled-in) | Apple (mac first, iOS later) | owned pipe ✅ |
| AICore / Apple Foundation | opportunistic fast-path | external (not owned) |

§11 ("single on-device runtime") is reinterpreted from "llama.cpp-only" to
**"one managed library, one pipe, no sidecar/subprocess/TCP."** LiteRT-LM and
MLX are *embeddable in-process C++ libraries* → linked into `libelizainference`,
exposing the **same FFI streaming symbols** `FfiStreamingRunner` already drives.
AICore is an out-of-process Android **system service** (Binder IPC) → it stays
an opportunistic adapter like `apple-foundation.ts`, never the owned backend.

## Gemma 4 — validated facts (2026)

Shipped **2026-04-02** (MTP drafters 04-16, 12B Unified 06-03).

- **Sizes:** E2B (~2.3B eff / 5.1B w/ embeddings), E4B (~4.5B / 8B), 12B Unified
  (11.95B dense, encoder-free, 256K ctx, **262,144 vocab**), 31B dense, 26B-A4B
  (MoE, 4B active). E2B ≈ 1.3 GB Q4, 2–3 GB RAM → mobile tier.
- **Architecture:** dense; **alternating local sliding-window (512/1024) + global
  full-attention**; dual RoPE; **Per-Layer Embeddings (PLE)**; **shared KV cache**
  (last N layers reuse earlier KV). No SSM/Gated-DeltaNet. **Dual head dims**
  (`global_head_dim` + SWA `head_dim`).
- **MTP:** official **separate drafter** models (speculative decode ~3×, no quality
  loss). Our catalog's `drafterFile?` already supports separate-drafter MTP.
- **Modalities:** image + audio (USM conformer) + **video**.
- **NPU fit:** dense graphs are NPU-delegate-friendly; LiteRT-LM ships
  pre-converted Gemma 4 `.litertlm` bundles. **Qwen3.5-hybrid is hostile to NPU
  delegates — the strongest technical reason to cut over.**
- **Our llama.cpp fork already speaks Gemma 4:** `LLM_ARCH_GEMMA4` + `gemma4.cpp`
  / `gemma4a.cpp` (audio) / `gemma4v.cpp` (vision) + converter (text/MoE/vision/
  audio). It already implements SWA (`LLAMA_SWA_TYPE_STANDARD`), **shared KV**
  (`n_kv_shared_layers` → `n_layer_kv_from_start` reuse cb), **PLE**
  (`per_layer_tok_embd`), and interleaved-SWA KV (`llama_kv_cache_iswa`).

## RAM / performance: llama.cpp is *not* optimal for Gemma out of the box

Gemma 4 is notorious for RAM blow-up in stock llama.cpp. Root causes + our levers
(several are config, not new kernels — "Gemma already does a lot of this"):

1. **KV-cache layout (the ~40% fix)** — landed upstream ~2026-04-05 (align KV
   memory layout to Gemma's MHA/grouping). Our merge-base is 2026-05-14, so we
   **likely already have it**; the M1 sync to upstream master confirms + grabs the
   rest.
2. **`ctx-checkpoints` accumulation (#21690)** — Gemma-only: server KV
   checkpoints grow unbounded (64 GB filled in 4–5 × 16K-prompt). **Fix: bound
   `ctx-checkpoints` (1/0) + `-np 1` in our fused defaults.** Pure config.
3. **Windowed SWA KV (`swa_full=false`)** — `llama_kv_cache_iswa` already sizes
   SWA layers to `n_swa (512/1024) + n_ubatch` when `swa_full=false`. Most layers
   are SWA, so this is the dominant KV saving. **Default `swa_full=false`** (it's
   already plumbed through `capacitor-llama/types.ts` + the iOS shim).
4. **PLE memory** — `per_layer_tok_embd` is `{n_embd_per_layer·n_layer, n_vocab}`
   (~2.8B params for E2B). With **mmap ON** the OS pages it from disk (≈ LiteRT's
   "mmap embeddings, keep on disk until needed"). **Never force `--no-mmap` for
   Gemma**; on GPU backends, **pin PLE to CPU/mmap** rather than copying it to
   VRAM. (Watch Vulkan #18317: Vulkan can't run `mmap=0`.)
5. **Prefix-KV reuse caveat (#21468)** — Gemma's shared-KV layers log "cache reuse
   not supported" even with `-fa --swa-full`. So prefix reuse is *partial* on
   shared-KV layers — better than Qwen3.5 (which can't at all) but not free. Our
   `stream_reset_keep` work must account for this.

**Leverage Google's C++ work, don't reinvent:** LiteRT-LM already does
PLE-mmap + windowed-SWA + NPU optimally → use it as the in-process backend on
capable hardware. For llama.cpp, **absorb upstream Gemma memory PRs** and set
Gemma-aware defaults rather than porting our Qwen kernels blindly.

**Where our kernels still add value (M6), re-scoped:**
- **TurboQuant low-precision *weight* quant** — orthogonal to KV; applies to the
  dense FFN/attention weights. Keep.
- **QJL/PolarQuant *KV* quant** — now applied on top of the *windowed* SWA KV +
  the global-attention KV (where 256K context still hurts). Re-parameterize from
  uniform head_dim=128 to Gemma's dual dims (global ~256 + SWA). Validate it
  still wins after SWA+shared-KV already shrank the cache.
- Re-run the §8 8/8 kernel verify matrix per buildable backend for the new
  geometry.

## Frozen contracts re-opened (owner-approved 2026-06-22)

1. Training base lock (`model_registry.py`, `training/AGENTS.md`) — Qwen → Gemma 4.
2. `tokenizerFamily "qwen35"→"gemma4"`; vocab 248,320 → 262,144 (`memory_calc.py`).
3. KV geometry + kernels — head_dim 128 uniform → Gemma dual dims.
4. Same-file MTP NextN head → Gemma separate drafter GGUF.
5. EOT `<|im_end|>` → `<end_of_turn>` (3 scorer files).
6. Abliteration Gated-DeltaNet surgery → dense surgery.
7. `native/AGENTS.md` §11 reinterpreted (single lib + single pipe).

eliza-1 v1 is **base-not-fine-tuned** (`releaseState=base-v1`) → v1 cutover is
*swap base + re-optimize*, **not a retraining run**.

## Owner directives (2026-06-22)

- **Hard cutover, remove Qwen entirely.** Not shipped, no downloaders → no staging.
- **Local stack is ONLY eliza-1** (max-optimized Gemma). No generic single-GGUF
  engine path, no arbitrary-model selection — remove that machinery (closes
  #8808; M9). Cloud handles anything not local eliza-1.
- **HF downloads proxy through Eliza Cloud** — the cloud holds the HF token and
  streams files; **no HF keys on local/desktop/mobile**, no local token UI
  (re-scopes #8807; M10).
- **HF `elizaos/eliza-1` hard cutover** to Gemma bundles; purge legacy tiers
  (`0_6b/0_8b/1_7b`) (M8).
- **Max-optimize per platform**: fastest in-process backend behind one FFI
  (llama.cpp default; LiteRT NPU on Android; CoreML/MLX on Apple); TurboQuant
  weight-quant + MTP + Gemma-native SWA/shared-KV/PLE + stock KV; QJL/Polar
  deprioritized (Gemma KV already minimal).
- **Related issues:** #8808 closed (superseded); #8807 + #8809 kept, addressed in
  M10 (install cloud-proxy + integrity; memory LRU/dynamic-fit/bench).

## Milestones (PR per milestone → develop)

- **M1 — llama.cpp upstream sync + PR absorption.** Merge ggml-org/master (602
  commits ahead of our base; we are 867 ahead with kernels/voice) into the fork;
  review + absorb all relevant Gemma/MTP/LiteRT/CoreML/AICore/KV/quant PRs (incl.
  open #21587 Gemma4 BPE SIGSEGV, #24590 Gemma4Assistant memory-fit, #21690
  ctx-checkpoints, #21468 cache-reuse). Build + verify Gemma 4 E2B/E4B
  text+vision+audio+MTP on CPU/CUDA.
- **M2 — Code cutover Qwen→Gemma** (registry, catalog/types, memory_calc, EOT,
  abliterate, AGENTS; remove Qwen; tier map E2B/E4B/12B/31B(/26B-A4B); Gemma-aware
  runtime defaults: `swa_full=false`, bounded ctx-checkpoints, mmap-on/PLE-on-CPU).
- **M3 — Multi-backend FFI seam** (backend abstraction + `backend-selector`). ✅
  **Done + verified on Linux.** `src/llm-backend.h` (the `LlmBackendSession` /
  `LlmBackendFactory` interfaces + the `llm_backend_context_bundle_dir` accessor),
  `src/llm-backend-selector.cpp` (registry + env/rank selection, inert-by-default),
  and the non-invasive `eliza_inference_llm_stream_*` dispatch (one backend branch
  inserted *above* each existing llama.cpp/MTP branch). Compiles + links into the
  default fused `libelizainference.so` with the FFI pipe intact and the seam inert
  (no alternate backend registered → byte-for-byte the prior llama.cpp path).
  Design: [`docs/multi-backend-ffi-seam.md`](multi-backend-ffi-seam.md).
- **M4 — LiteRT-LM in-process backend** (Android NPU delegate ladder). 🧩
  **Scaffolded, gated `-DELIZA_ENABLE_LITERT` (OFF default).**
  `src/backends/litert-backend.{h,cpp}`: full `LlmBackendSession`/factory against
  the researched LiteRT-LM C++ API (Engine/Session, NPU→GPU→CPU ladder,
  `text/*.litertlm` probe) behind the gate; a no-SDK stub when OFF. CMake adds the
  source + SDK include/link knobs (`ELIZA_LITERT_SDK_DIR`/`ELIZA_LITERT_LIBS`) when
  enabled. Every hardware assumption tagged `DEVICE-VERIFY`; needs a Pixel/NPU
  device + the LiteRT-LM SDK to build + validate.
- **M5 — CoreML/MLX in-process backend** (mac first, iOS later). 🧩
  **Scaffolded, gated `-DELIZA_ENABLE_MLX` + `__APPLE__` (OFF default; FATALs on a
  non-Apple host).** `src/backends/mlx-coreml-backend.{h,mm}`: MLX-primary (mlx-c
  decode graph) + CoreML-alternate (stateful `MLState` KV) sessions behind the
  gate; a no-SDK stub when OFF. CMake adds the `.mm` + MLX/CoreML/Metal link knobs
  when enabled. Tagged `DEVICE-VERIFY`; needs Apple Silicon + the MLX/CoreML
  toolchain to build + validate.
- **M6 — Kernel re-optimization for Gemma geometry** (TurboQuant weight-quant +
  QJL/Polar KV-quant on windowed/global KV) across CPU/CUDA/Vulkan-Mali/Metal/NPU
  + low-precision + long context; re-verify 8/8.
- **M7 — Verification everywhere** (web / desktop app / Pixel / bench harnesses +
  PR_EVIDENCE).

## What's verifiable in-session vs needs hardware

- **Here (Linux x64 + CUDA):** llama.cpp merge + CPU/CUDA builds; Gemma 4
  text/vision/audio/MTP gen; code cutover; FFI seam; bench (`llama-bench`,
  `e2e_loop_bench`) on CPU/CUDA; web + desktop-app smoke.
- **Needs Mac:** Metal kernels, CoreML/MLX backends, iOS.
- **Needs Pixel/Android device:** Vulkan-Mali kernels, LiteRT NPU (Tensor/QNN),
  on-device tok/s + RSS. (Prior on-device work used adb/CDP on a Pixel 9a.)

Hardware-gated items are scoped + scaffolded here and marked for device
verification; nothing is claimed "verified" without the evidence.

## Acceptance criteria

- [ ] Fork synced to upstream master; all relevant Gemma/MTP/LiteRT PRs absorbed or rejected-with-reason.
- [ ] Gemma 4 runs through `libelizainference` (text+vision+audio+MTP) on every buildable backend.
- [ ] Qwen fully removed from the shipped eliza-1 line.
- [ ] Multi-backend selection behind one FFI; LiteRT/MLX/CoreML in-process; AICore/Foundation opportunistic.
- [ ] Gemma-aware RAM defaults set; kernels re-optimized + 8/8 verified per buildable backend; low-precision quant validated.
- [ ] tok/s + RSS + first-token + MTP-acceptance captured per platform; faster-or-justified vs retired Qwen line.
- [ ] Verified on web + desktop app + on-device (as hardware allows; else honestly scoped).
- [ ] eliza-1 branding preserved (users never see "Qwen"/"Gemma").
