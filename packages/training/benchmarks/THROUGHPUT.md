# Eliza-1 inference throughput — measurements & optimization notes

Measured 2026-05-11 on an **RTX 5080 Laptop GPU** (16 GB, Blackwell sm_120,
driver 580.142, CUDA 13.0 runtime / nvcc 12.0 toolkit) + an Intel Arrow Lake-U
CPU (8 threads used). Model: `eliza-1-0_6b` (Qwen3-0.6B arch, 596 M params).
`run_pipeline.py` stage 6c writes a per-run `checkpoints/<run>/evals/throughput.json`
with the same `llama-bench` numbers for whatever GGUFs the run produced.

## Numbers (tokens/sec)

| backend | quant | prefill (pp512) | generation (tg64/128) | notes |
|---|---|---:|---:|---|
| CPU (8 threads) | Q4_K_M | 57 | 7.5 | dequant-bound; q4 is *slower* than q8 on CPU for a tiny model |
| CPU (8 threads) | Q8_0 | 86 | 25 | |
| Vulkan, `-ngl 99` | Q4_K_M | 1 499 | 399 | `matrix cores: none` — Vulkan build has no coopmat → no tensor cores |
| **CUDA, `-ngl 99 -fa 1 -b 2048`** | **Q4_K_M** | **~22 000** | **~385** | best config; cuBLAS/mma on Blackwell |
| CUDA, `-ngl 99 -fa 1 -b 2048` | Q8_0 | ~23 000 | ~364 | q8 ≈ q4 here (gen is bandwidth-bound for 0.6 B) |

**CUDA vs CPU: ~150–300× prefill, ~15–50× generation. CUDA vs Vulkan: ~14×
prefill** (Vulkan leaves the tensor cores on the table). For a 0.6 B model
generation tops out ~360–440 t/s regardless of quant — it's memory-bandwidth
bound, so weight-quant choice barely moves `tg` at this size; it matters for
the bigger tiers and for VRAM-constrained hosts.

## What moves tokens/sec — by layer

### Harness (the biggest practical lever)
- **Use the CUDA llama.cpp binary on NVIDIA hosts.** `node-llama-cpp 3.18.1`
  ships a CUDA prebuilt, so the *generic* path is fine. But eliza-1 GGUFs use
  the fork's custom GGML types (`Q4_POLAR=47`, `QJL1_256=46`, `TBQ3/4_0`), so
  `BackendDispatcher` routes them to the fork (`dflash-server`). The fork's
  build pipeline (`scripts/ensure-llama-cpp-submodule.mjs`,
  `packages/app-core/scripts/aosp/compile-libllama.mjs`) currently produces
  `linux-x64-cpu`, `linux-x64-cpu-fused`, `linux-x64-vulkan` — **no CUDA**. On
  a CUDA host that means eliza-1 inference falls to Vulkan (≈14× slower
  prefill than CUDA). **Add a `linux-x64-cuda` fork build target and select it
  on NVIDIA hosts.** Confirmed: the fork's CUDA backend (incl. the custom
  `fattn-vec-instance-{qjl,polar,tbq}.cu` kernels) compiles with the stock
  nvcc 12.0 at `CMAKE_CUDA_ARCHITECTURES="89-real;90-real;90-virtual"` (the
  driver JITs the sm_90 PTX to sm_120) — see `scripts/vendor_llama_cpp.sh`'s
  `build-cuda` for the recipe. **Build the fork's CUDA backend with `-j2`**,
  not `-j$(nproc)`, on a ≤ 32 GB-RAM box: the custom `fattn-vec-instance-*`
  instantiations ~1.6× the standard set of fattn template TUs, each `fattn*.cu`
  nvcc eats ~1.5–2 GB during template metaprogramming, and at full parallelism
  on a 30 GB laptop the concurrent nvcc's get OOM-killed on `fattn.cu.o`. (The
  *stock* llama.cpp CUDA build is fine at `-j$(nproc)` — fewer fattn TUs.)
- **Flash attention on** — `optimizations.flashAttention: true` is already set
  in `catalog.ts` `runtimeFor()`; keep it. `-fa 1` is +25 % prefill vs off.
- **Logical batch ≥ 2048** for prefill — `-b 2048` beats `-b 512` once `-fa`
  is on. node-llama-cpp `LlamaContextOptions.batchSize`.
- **All layers on GPU** — `gpuLayers: "auto"` already resolves to "fit
  everything" for small models on a 16 GB GPU; keep it.
- **KV-cache compression at long context** — `--cache-type-k qjl1_256
  --cache-type-v tbq3_0` (the fork types; `qjl_config.json` est. 4.15× KV
  reduction for the 0.6 B). At short context the KV cache is tiny so this is
  noise; at the long-ctx tiers (`27b-256k`, the voice loop) a 4× smaller cache
  is a real `tg` win and the deciding factor for whether the context fits in
  VRAM at all.

### Model
- **Q4_POLAR weights (4 bpw)** halve the weight memory traffic vs Q8_0 (8 bpw)
  → faster `tg` for the bigger tiers. *Currently deferred* — the fork's
  `convert_hf_to_gguf.py` doesn't emit `q4_polar` yet (the runtime kernels
  exist; the converter side lags), so `gguf_milady_apply.py` falls back to
  `q8_0` and records `weight_quant.deferred: true` in `<gguf>.milady.json`.
  Closing that gap (add `Q4_POLAR` to the fork's `gguf-py` + a Python
  `quantize_q4_polar` packer) is the inference team's converter work.
- **DFlash speculative decode** is the #1 model-level `tg` lever for the
  *bigger* tiers — a 0.6 B Qwen3 drafter verifying for a 4 B / 9 B / 27 B model
  can 2–3× generation. `distill_dflash_drafter.py --tier <t> --student-base
  Qwen/Qwen3-0.6B` distils one; the catalog `runtimeFor()` already wires
  `dflash.specType: "dflash"` + `draftGpuLayers: "auto"`. The 0.6 B tier
  itself gets *no* drafter (there is no smaller-than-0.6 B Qwen3 base, so the
  tokenizer-match contract can't be satisfied) — its `tg` is already ~400 t/s
  on a consumer GPU, so spec decode isn't needed there.

### Kernel (fork — coordinate with the inference team)
- The fork's CUDA flash-attn kernels for the custom KV types
  (`fattn-vec-instance-{qjl1_256,q4_polar,tbq3_0,tbq4_0}.cu`) are template
  instantiations of the standard vec-FA kernel — they get the standard
  CUDA-graph / split-K treatment. The main remaining headroom: a Blackwell
  (sm_120) MMA path for the custom-typed matmuls (the current build targets
  sm_89/90 PTX → JIT to sm_120, which works but doesn't use the new
  `tcgen05` tensor-core instructions or FP4). When a CUDA-12.8+ toolkit is
  available, build with `CMAKE_CUDA_ARCHITECTURES=120` and add a
  `tcgen05`-based MMA tile for `Q4_POLAR`/`QJL1_256` weight-dequant-and-mma.
- Vulkan: the build reports `matrix cores: none` — enable
  `VK_KHR_cooperative_matrix` / `VK_NV_cooperative_matrix2` if the SDK targets
  Blackwell coopmat, or accept that NVIDIA hosts should use the CUDA build.

### Training throughput (samples/sec — speeds iteration, not serving)
- **Liger kernel** is active on CUDA (`run_pipeline.py` passes `--use-liger on`;
  `train_local.py` applies it when `device == "cuda"` and `liger-kernel` is
  installed — it is). Keep it.
- **`flash-attn` is not installed** — `lib/attn.py` falls back to `sdpa`.
  Installing `flash-attn` (`uv pip install flash-attn --no-build-isolation`,
  ~30–60 min compile against the system CUDA) speeds up SFT for the bigger
  tiers; marginal for 0.6 B.
- **FP8 training** — `te_fp8.py` exists but only swaps on sm_90 unless
  `MILADY_FP8_TRAIN=1`; `transformer_engine` is not installed. Blackwell
  (sm_120) has native FP8/FP4 tensor cores, so FP8 SFT would be a real win for
  the bigger tiers — needs `transformer_engine[pytorch]` installed + the arch
  gate in `te_fp8.py` extended to include sm_120.

## How to re-measure

```bash
# Single GGUF, optimal GPU config:
packages/training/vendor/llama.cpp/build-cuda/bin/llama-bench \
  -m <path-to>.gguf -ngl 99 -fa 1 -b 2048 -p 256,512 -n 64,128

# As part of a pipeline run (writes evals/throughput.json):
uv run --extra train python scripts/run_pipeline.py --registry-key qwen3-0.6b ... # stage 6c runs automatically
```
