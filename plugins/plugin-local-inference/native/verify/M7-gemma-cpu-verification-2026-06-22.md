# M7 — Gemma 4 verification on Linux x64 (CPU + Vulkan GPU)

> Milestone **M7** of the [Gemma 4 cutover](../docs/gemma4-cutover-plan.md).
> Host: linux-x64, AMD CPU + **RTX 5080 Laptop GPU via Vulkan** (CUDA runtime is
> blocked — see "Blocked platforms" — but Vulkan drives the GPU; see the GPU
> section). Fork build: `c849143c9` (`b10028`, M3-seam branch) for CPU; the
> Vulkan `llama-bench` is a desktop `GGML_VULKAN=ON` build of the same tree.
> Tool: `llama-bench`, FA = AUTO. Date: 2026-06-22 (GPU section added 2026-06-23).

## Acceptance-criteria slice proven here

- ✅ **Gemma 4 runs through the fork** — `gemma4` (E2B/E4B) and `gemma3n` (E2B)
  all load and forward-generate through the same `libelizainference` llama.cpp
  build. A real generation smoke (`llama-cli`, gemma instruct template) answered
  "What is the capital of France?" → **"Paris"** on the gemma3n-E2B build.
- ✅ **tok/s + peak-RSS captured per tier** (table below).
- ✅ **Faster-or-justified vs the retired Qwen line** — head-to-head below.
- ⛔ **CUDA / Pixel-NPU / Apple** — honestly blocked (hardware/toolkit), not faked.

## CPU bench — all local tiers (8 threads, pp512 / tg128, 3 reps)

| tier | arch | quant | size | params | pp512 t/s | tg128 t/s | peak RSS |
|---|---|---|---:|---:|---:|---:|---:|
| `eliza-1-2b` (retired) | qwen35 | Q4_K_M | 1.26 GB | 1.88 B | **135.7** | **26.2** | 1924 MB |
| `eliza-1-4b` (retired) | qwen35 | Q4_K_M | 2.94 GB | 4.33 B | 53.0 | 11.9 | 4432 MB |
| gemma3n-E2B | gemma3n | Q4_K_M | 2.78 GB | 4.46 B | **96.1** | **16.0** | 3666 MB |
| gemma-4-E2B | gemma4 | Q8_0 | 4.95 GB | 4.65 B | 58.5 | 14.8 | 4969 MB |
| gemma-4-E4B | gemma4 | Q8_0 | 8.02 GB | 7.52 B | 36.2 | 7.7 | 7760 MB |

Per-tier raw `llama-bench -o json` + `/usr/bin/time -v` RSS in `reports/cpu-<tier>.{json,time}`.
The prior E2B-Q8 baseline (24-thread, pp64/tg32) is in `gemma4-baseline-cpu.json`.

### Gemma vs retired Qwen (the "faster-or-justified" criterion)

- **gemma3n-E2B Q4 (4.46 B) vs retired qwen35-4b Q4 (4.33 B)** — same quant,
  ~same params: **tg 16.0 vs 11.9 t/s (+34%), pp 96.1 vs 53.0 (+81%)**. Gemma is
  decisively faster at matched precision.
- **gemma-4-E2B Q8 (4.65 B) vs retired qwen35-4b Q4 (4.33 B)** — Gemma at *higher*
  precision (Q8) still edges it: tg 14.8 vs 11.9, pp 58.5 vs 53.0. Q8 vs Q4 is not
  apples-to-apples, but Gemma-at-Q8 ≥ Qwen-at-Q4 is the justified-or-faster bar.

RSS scales with on-disk size as expected; the largest local tier (E4B-Q8, 8 GB)
peaks at 7.76 GB RSS and fits comfortably in 16 GB.

## Flash-attention (FA) — on by default, and it helps Gemma

FA is `AUTO` for the text path on every non-Android platform
(`eliza-inference-ffi.cpp::eliza_llm_flash_attn_type`). Measured `-fa 0` vs `-fa 1`:

| model | pp512 off→on | tg128 off→on | V-cache padding |
|---|---|---|---|
| gemma-4-E2B (512/256 dims) | 58.3 → 60.9 | 16.7 → 17.2 | **`pad V→512` warning gone with FA** |
| gemma3n-E2B (256 dims) | 61.1 → 66.2 | 9.97* → 15.5 | n/a |

\* the FA-off tg run had ±10.5 variance; FA-on (15.5 ±4.2) is both faster and stabler.

FA **engages for Gemma's 512-dim global-attention layers on CPU** and eliminates
the dual-head-dim V-cache padding (`llama_kv_cache: V embeddings have different
sizes across layers and FA is not enabled - padding V cache to 512`). See
[`M6-gemma-kv-geometry-and-fa.md`](M6-gemma-kv-geometry-and-fa.md) for the
geometry detail.

## GPU — Vulkan on the RTX 5080 (the GPU half; CUDA is blocked, Vulkan is not)

CUDA is toolkit-blocked on this host (below), but **Vulkan uses the DRM path, not
UVM, so it drives the RTX 5080 fine** (`ggml_vulkan: 1 = NVIDIA GeForce RTX 5080
Laptop GPU`). Built a desktop Vulkan `llama-bench`/`llama-cli` with the Android
NDK's host `glslc` (shaderc v2022.3) + the system spirv-headers. Note: that glslc
predates coopmat, so `matrix cores: none` — this is the **scalar Vulkan path, not
tensor-core-optimal**; real numbers would be higher with a coopmat-capable glslc.

| tier | quant | pp512 t/s | tg128 t/s | vs CPU (tg) |
|---|---|---:|---:|---:|
| gemma-4-E2B | Q8_0 | **1486** | **122.9** | 8.3× |
| gemma-4-E4B | Q8_0 | 634 | 65.2 | 8.5× |
| gemma3n-E2B | Q4_K_M | 1238 | 112.1 | 7.0× |
| `eliza-1-4b` (retired qwen35) | Q4_K_M | 1007 | 106.0 | — |

(`-ngl 99`, all layers offloaded. gemma-4-E2B is **26× CPU on prefill**, 8.3× on
decode.) Gemma again ≥ the retired Qwen line at matched precision on GPU
(gemma3n-E2B-Q4 112 tg vs qwen35-4b-Q4 106).

- **FA on Vulkan:** `flash_attn = enabled`, engages for the 512 global dim (no
  `padding V cache` line), and **helps prefill** (gemma-4-E2B pp512 1353→1546,
  +14%; decode flat within noise on the no-coopmat path).
- **Correctness verified:** `llama-cli` on the GPU with `-fa 1` produced coherent
  output (a correct prompt analysis), **not** the Mali-style FA garbage — so
  NVIDIA desktop Vulkan FA is numerically sound for Gemma's geometry.

## Blocked platforms (documented, not faked)

- **CUDA / RTX 5080 (sm_120, Blackwell):** `nvidia-smi`/NVML see the GPU, but the
  CUDA *runtime* returns `no CUDA-capable device is detected` under both the 12.0
  and 12.8 toolkits (and a hand-built `sm_120` deviceQuery); `nvidia-modprobe -u`
  fails (UVM device init). Blackwell sm_120 + driver 595.71.05 needs **CUDA 13.x**
  (not installed), or a live `nvidia_uvm` module reload. Host toolkit/driver gap,
  not a code defect. The **Vulkan path above already provides GPU evidence**;
  CUDA would add coopmat/tensor-core numbers + the CUDA `cuda_verify` 8/8.
- **Pixel / Android NPU (LiteRT, M4)** and **Apple Silicon (MLX/CoreML, M5):**
  backends are scaffolded + gated OFF; need a Pixel 9a/Pro and an Apple-Silicon
  Mac. Out of reach on this host.

## Reproduce

```bash
cd plugins/plugin-local-inference/native/llama.cpp
build-static-fused/bin/llama-bench -m <tier>.gguf -p 512 -n 128 -t 8 -r 3 -o json
# FA on/off: append -fa 1 / -fa 0 ; geometry: -p 1 -n 0 -r 1 -v
```
