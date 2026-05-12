# Eliza-1 optimization campaign — rollup & prioritized action list

Index of the optimization work + a single prioritized list. Detail docs:
`THROUGHPUT.md` (measured tokens/sec), `OPTIMIZATION_INVENTORY.md` (37-row
audit of every active/stub/deferred optimization with benefit/cost),
`CONTEXT_SCALING.md` (`packages/shared/src/local-inference/` — context×memory
math, mobile/16-24GB decision table), `APOLLO_TUNING.md` (APOLLO config audit +
memory math), `CUDA_KERNEL_PUNCHLIST.md` (per-kernel punch-list for the
inference team), `docs/training/cuda-setup-and-degradation.md` (driver vs
toolkit, detection, degradation, installer plan), `docs/training/schema-constrained-decoding.md`
(grammar-constrained tool calls + jump-ahead decoding),
`INFERENCE_OPTIMIZATION_PLAN.md` (the 12-expert TTFT/TTFA-focused survey:
streaming ASR/output, multi-model orchestration, context length, API/harness,
pipeline config space, cross-platform/installer — with a unified P0/P1/P2
roadmap and the shared modules the plans converge on).

## Headline numbers (RTX 5080 Laptop, 16 GB, sm_120; `eliza-1-0_6b` = Qwen3-0.6B)

| backend | prefill (pp512) | gen (tg128) |
|---|---:|---:|
| CPU (8 thr), Q4_K_M | 57 | 7.5 |
| Vulkan, `-ngl 99` | 1 499 | 399 |
| **CUDA stock, `-ngl 99 -fa 1 -b 2048`, Q4_K_M** | **~22 000** | **~385** |
| CUDA stock, same, Q8_0 | ~23 000 | ~364 |

CUDA ≈ 150–300× CPU prefill, ≈ 15–50× CPU gen, ≈ 14× Vulkan prefill (Vulkan
build has no cooperative-matrix → no tensor cores). For a 0.6 B model gen is
memory-bandwidth bound (~360–440 t/s regardless of quant); quant choice and KV
compression matter for the bigger tiers and for fitting long context.

## DONE this campaign (committed to `develop`)

- **`run_pipeline.py` stage 6c** — `llama-bench` tokens/sec on every produced GGUF (CUDA > fork-Vulkan > CPU; `-fa 1 -b 2048 -ngl 99`) → `checkpoints/<run>/evals/throughput.json`.
- **Triton-probe Liger fallback** — `train_local.py` probes the Triton CUDA backend before applying Liger and falls back to HF defaults (warn) instead of crashing the SFT 8 min in when Triton can't JIT-compile (the dev box is missing `python3.12-dev`); `run_pipeline.py` gained `--use-liger {auto,on,off}` (was hardcoded `on`).
- **`dflash-server.ts accelBackendKey`** — the runtime keyed the `…-cpu` fork build unless `CUDA_VISIBLE_DEVICES` was hand-set; now it probes the managed bin dir for an installed `…-cuda`/`…-vulkan`/`…-rocm` build (cuda preferred) → a present-on-disk CUDA fork build actually gets used.
- **llama.cpp as a git submodule** — `packages/training/vendor/llama.cpp @ b6650` (shallow), `vendor_llama_cpp.sh` does `git submodule update --init` and builds `llama-quantize` + `llama-cli`; CUDA build recipe (`build-cuda`, arch `89-real;90-real;90-virtual`) documented.
- **`emit_native_grammar.py`** — emits the canonical GBNF for the `eliza_native_v1` planner envelope from the action catalog (`action-docs.ts` / `--names` / `--catalog`), `--with-args` for per-action arg-key/enum constraints; the reference the harness's local-path grammar should match. + test that asserts the grammar accepts real `eliza_native_v1` rows (format-drift CI check).
- **`model_registry.py` consistency fix** (`eliza_short_name` filled on the 2b/9b/27b entries) + `test_model_registry.py` rewritten for the 6-tier ladder; `ToonEncoder.close()` fix (3 tests); fork-resolution unified (all GGUF/dflash scripts find `packages/inference/llama.cpp` first); `RL_TRAINING.md` `--skip-train`→`--skip-finetune`.
- **GPU `optimize_for_eliza1.py` re-run** — TurboQuant now *calibrates* (it auto-skipped on CPU) → `eliza1_manifest.json` carries the real `tbq3_0` V-cache config.
- **7 analysis docs** (listed above) — the full survey + per-layer punch-lists.
- **CUDA builds** — stock llama.cpp CUDA build (`vendor/llama.cpp/build-cuda/`) and the fork's CUDA build (`~/.cache/eliza-dflash/milady-llama-cpp/build-cuda/`, `-j2` to avoid the `fattn.cu.o` OOM) — the custom `fattn-vec-instance-{tbq3_0,tbq4_0}` + Q4_POLAR/QJL kernels compile with stock nvcc 12.0.

## QUICK WINS — one command / one small validated change

1. **`! sudo apt-get install -y python3.12-dev`** — unblocks Liger (≈ +25 % SFT throughput, longer seq_len via FLCE chunking), fused-turboquant (Triton path, ≈ 5× faster TBQ encode vs the pure-PyTorch fallback), and the QJL apply `build_ext`. One apt package; biggest training-side win.
2. **`! sudo apt-get install -y cuda-toolkit-12-8`** (or `13-0`) — native sm_120 `nvcc` → a `CMAKE_CUDA_ARCHITECTURES=120` fork build (uses `tcgen05` MMA / FP4 instead of JIT-ing sm_90 PTX), and unblocks the QJL `setup.py build_ext`. ~3 GB; needed for the kernel-level Blackwell work.
3. **`eliza-1-0_6b` `micro_batch=1→2`, `grad_accum=8→4`** in `model_registry.py` — keeps the effective batch (8) and the identical optimizer trajectory, fixes the 0.6 B's GPU under-occupancy at micro_batch=1 → ≈ +20–40 % SFT samples/sec, zero quality cost. (Validate against the in-flight GPU SFT's measured peak VRAM first — see `APOLLO_TUNING.md`.)
4. **`batchSize: 2048` in the catalog `optimizations` block** — `-b 2048` beats the node-llama-cpp default for prefill once flash-attn is on; zero quality cost.
5. **Add `{linux,windows}-x64-cuda` fork builds to the release pipeline** + a runtime `local-inference:fetch-binary` resolver — the build matrix already produces them in CI; promote to release artifacts so a CUDA host downloads the CUDA fork instead of falling to Vulkan. **The single biggest harness win** (≈ 14× prefill, ≈ 2–6× gen for eliza-1's custom-GGML-type GGUFs). See `cuda-setup-and-degradation.md`.
6. **Unconditional imatrix calibration** for K-quant publishes (`gguf-q4_k_m_apply.py`'s `--calibration` is currently "accepted for parity") — ≈ 0.15 PPL for free at low bit-rates.

## INFERENCE-TEAM PUNCH-LIST (the fork / `local-inference/` / `voice/` — actively rewritten by the voice swarm; punch-lists, not edits from here)

- **Q4_POLAR converter emit path** — add `Q4_POLAR` to the fork's `gguf-py` `GGMLQuantizationType` + a Python `quantize_q4_polar` packer (Lloyd-Max codebook + WHT + 1-bit QJL residual per `ggml-common.h` `block_q4_polar`); the runtime kernels already exist. → ~halve weight bytes vs q8_0 → ≈ 2× tg for 4b/9b/27b. **Highest unrealized model-level win.** (`gguf_eliza1_apply.py` already detects the gap and falls back to q8_0 with `weight_quant.deferred:true`.)
- **TBQ KV decode-once-into-shared in flash-attn** — `vec_dot_fattn_vec_KQ_tbq`/`dequantize_V_tbq` recompute the size-32 WHT + sign-flip per thread (8–16×/K vector); stage the decoded sub-block in shared once per block. Benefit HIGH / effort med.
- **Fused QJL flash-attention kernel** + a `qjl1_256`-K fattn-vec instance — `qjl_score_kernel` materializes the full score matrix in HBM then a separate softmax+aggregate (defeats flash-attn at the long-context regime QJL targets). Benefit HIGH / effort high.
- **Jump-ahead / fast-forward decoding** of schema-forced tokens — when the grammar admits a unique continuation (the `{"name":"`, an enum value, `"args":{`, required arg keys — ~10–30 forced tokens per tool call), emit it without a forward pass. llama.cpp's grammar sampler doesn't do this; XGrammar/llguidance/Outlines do. → real tg win on tool-call turns.
- **Native-envelope grammar on the local planner path** — the local model is fine-tuned on the `eliza_native_v1` envelope (`{thought, toolCalls:[{id,name,args}], messageToUser?}`); `buildPlannerActionGrammar` currently constrains the cloud `{action,parameters,thought}` shape → it can fight the local model. Add `buildNativeEnvelopeGrammar`; diff against `emit_native_grammar.py`'s output.
- **Per-action `args` grammar** — `plannerActionGrammar.actionSchemas` is computed and put on `providerOptions` but nothing consumes it; `args` is a free JSON object today, only checked post-generation by `validate-tool-args.ts` (costs a re-plan round). Wire the per-action arg-key/enum constraint into the second-pass grammar.
- **Parallelize the Q4_POLAR WHT tail + de-quadratic the QJL residual** — `polar_dequantize_kernel` does the size-128 WHT on `tid==0` (448 serial ops); use the 128 launched threads (7 stages + `__syncthreads`). `polar_qjl_sign_cuda(i)` is O(i) → the residual loop is O(128²); precompute the sign vector into shared. Benefit med / effort low.
- **Native sm_120 MMA-tile prefill path** for `mul_mat_q4_polar_q8_0` / `mul_mat_tbq3_tcq_q8_0` (hand-rolled GEMVs today — dequant-into-shared-tile + `wgmma`/`tcgen05`). Benefit med (pp only) / effort high; needs CUDA-12.8+.
- **Memory-aware runtime context selector** — after model choice, `maxFittingContext = (mem − weights − workingSet) / kvBytesPerToken`, clamp to `min(tier.contextLength, baseNativeContext)` — every device has KV slack (a 0.6 B on 16 GB uses ~0.6 GiB of KV at the catalog's 32k, leaving ~14 GB). **Don't bump the catalog `contextLength`** for 0.6 B/1.7 B — Qwen3 `max_position_embeddings` is 40960; past that needs a RoPE-extended GGUF. See `CONTEXT_SCALING.md` for the full table.
- **VRAM-aware tier+context picker** in `recommendation.ts` — use `nvidia-smi` VRAM directly; surface "Detected RTX XXXX (N GB) → eliza-1-Mb on CUDA".
- **`eliza-1-4b`** is missing from `catalog.ts` (real entry in `model_registry.py`, no published GGUF yet); add when the GGUF ships. The `eliza-1-0_6b-drafter` catalog companion is dead weight (0.6 B has no smaller-than-itself Qwen3 base).

## OPEN — needs hardware / a real run

- `eliza1_gates.yaml` numeric thresholds (mobile RSS, thermal, ASR WER on real audio, voice-loop latencies) — need real device measurements.
- DFlash drafters for 1.7b/4b/9b/27b — `distill_dflash_drafter.py --tier <t> --student-base Qwen/Qwen3-0.6B` (1.7b/4b) / `Qwen/Qwen3-1.7B` (9b/27b) on a GPU → ≈ 2–3× tg for the big tiers. Wiring in `catalog.ts runtimeFor()` already done.
- A clean fork-CUDA `llama-bench` (the campaign's run was contended by a concurrent SFT) — re-run idle: `~/.cache/eliza-dflash/milady-llama-cpp/build-cuda/bin/llama-bench -m <gguf> -ngl 99 -fa 1 -b 2048 -ctk qjl1_256 -ctv tbq3_0 -d 0,16384,65536` to measure the QJL/TBQ KV-cache kernels at long context.
