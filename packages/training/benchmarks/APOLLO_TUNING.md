# APOLLO training-config audit — eliza-1 local SFT

Audit date 2026-05-11. Scope: `scripts/training/optimizer.py`,
`scripts/train_local.py` (APOLLO wiring + throughput knobs), the per-tier
APOLLO knobs in `scripts/training/model_registry.py`. Reference: APOLLO,
Zhu et al., MLSys 2025, arXiv:2412.05270 ("APOLLO: SGD-like Memory,
AdamW-level Performance"), plus the upstream `apollo-torch` recipe.
Dev box: RTX 5080 Laptop (16 GB, sm_120). Test model `eliza-1-0_6b`.

---

## A. Critical assessment

### A1. The optimizer wiring is sound and faithful to the paper
- `optimizer.py` builds two recipes that match the paper / upstream README
  exactly: full **APOLLO** = channel-wise scaling, rank 256, scale 1.0,
  `proj="random"` (Johnson–Lindenstrauss random projection, not GaLore's
  SVD — correct, APOLLO is explicitly the SVD-free variant); **APOLLO-Mini**
  = tensor-wise scaling, **rank 1**, scale 128.0, `scale_front=True`. The
  `update_proj_gap` (= the paper's `T`, the interval at which the random
  projection matrix is re-sampled) is **200** for both, which is the paper's
  and upstream's default. Good.
- Only 2-D weight matrices (q/k/v/o, gate/up/down) go through the projector;
  embeddings, `lm_head`, norms, biases stay in APOLLO's unprojected AdamW
  group (`_NON_LOWRANK_NAME_HINTS` + `p.dim() != 2`). Correct — the
  projector cannot reshape a 1-D tensor, and on these sub-2B Qwen3 models the
  *embedding* matrix dominates parameter count (≈156M of 596M for 0.6B), so
  it is the unprojected group, not the projected one, that actually drives
  optimizer-state size.
- `_FP32MomentsAPOLLO` pre-creates `exp_avg`/`exp_avg_sq` in fp32 before
  upstream's `torch.zeros_like(grad)` (which would inherit the bf16 grad
  dtype under FSDP `mixed_precision=bf16`). This is a real correctness fix —
  bf16 moments have a 7-bit mantissa and lose accumulated gradient ~10× faster
  than the fp32 the paper assumes. Keep it.
- The scaling factor: the paper's "norm-growth" rule scales the projected
  update by the ratio of the full-gradient norm to the low-rank-gradient
  norm; APOLLO-Mini's fixed `scale=128` is the paper's recommended constant
  for the rank-1 tensor-wise variant (Table 2 / §4.2), and full APOLLO with
  `scale=1` lets the norm-growth scaling do its job. Not the literal
  `sqrt(rank/d)` GaLore-style alpha — APOLLO deliberately replaces that with
  the norm-ratio rule — so this is correct as written.

### A2. `optimizer_rank` is dead/misleading for the apollo_mini tiers
- Every real eliza-1 tier in `model_registry.py` uses `optimizer="apollo_mini"`
  but carries a non-trivial `optimizer_rank` (128 for 0.6B; 256 for 1.7B/4B).
  **APOLLO-Mini is rank-1 by definition** — `build_apollo_mini_optimizer*`
  uses the frozen `_APOLLO_MINI` recipe (rank=1) and ignores any rank the
  caller passes; `train_local.py`'s `apollo_builder` for the mini branch
  doesn't even forward `--apollo-rank`. So `optimizer_rank=128/256` on those
  entries describes nothing the optimizer does. `memory_calc.py` *does* read
  `apollo_rank`, but only in its `TrainOpt.APOLLO` branch (rank-1 hardcoded
  for the mini branch), so the registry value only matters if a tier ever
  flips to full APOLLO. Recommendation below: either set it to `1` for the
  mini tiers (truthful) or document it as "rank if this tier is promoted to
  full APOLLO". Low risk; not changed here because tests/scripts don't depend
  on it and the field is harmless, just confusing.

### A3. The `train_local.py` default optimizer disagrees with the registry
- `--optimizer` defaults to `apollo` (full, rank-256, needs the
  norm-growth machinery + bigger optimizer state), but every registry entry
  says `apollo_mini`. The arg-merge fixes this *when `--registry-key` is
  passed* (the registry value wins over the unchanged CLI default), so a
  registry-driven run gets APOLLO-Mini as intended. A bare
  `python train_local.py --model Qwen/Qwen3-0.6B ...` (no registry key) gets
  full APOLLO. That is defensible — the registry is the source of truth and
  callers are told to use `--registry-key` — but the default could be
  `apollo_mini` to match the canonical recipe for this hardware.

### A4. Throughput knobs
- **`torch.compile(model)` — not used.** `train_local.py` never calls it.
  On a Qwen3-0.6B forward+backward with gradient checkpointing this is
  typically +15–30% step time. It is genuinely finicky with the custom
  `_ElizaSFTTrainer.compute_loss` override (graph break on the
  `outputs.loss is not None` branch) and with APOLLO's per-step
  `state["projector"].project(grad, step)` (a Python-side call inside the
  optimizer — that's fine, the optimizer isn't compiled, only the model
  forward/backward is). **Implemented as an opt-in env flag with a hard
  fallback** — `ELIZA_TORCH_COMPILE=1` → `model = torch.compile(model,
  mode="default")` inside a try/except that logs and continues uncompiled on
  any compile error. The call is placed *after* `_apply_liger_kernel_to_instance`
  (Liger replaces forward methods, so compile must capture the post-patch
  graph) and *after* gradient checkpointing is enabled, and *before* the
  trainer is constructed. Default OFF — it's finicky with the
  `_ElizaSFTTrainer.compute_loss` override and FSDP wrap order, so it still
  needs a real run to confirm it doesn't graph-break catastrophically; the
  flag just makes that experiment cheap to run.
- **`attn_implementation` — `sdpa` (correct).** `lib/attn.py` returns
  `flash_attention_2` only if `flash_attn` is importable, else `sdpa`;
  `flash-attn` isn't installed, so the model loads with `attn_implementation="sdpa"`,
  **not** `eager`. On CUDA sm_80+ `torch.nn.functional.scaled_dot_product_attention`
  auto-selects the FlashAttention-2 or mem-efficient fused backend, so the
  attention is already running a fused kernel — there is no eager-attention
  penalty here. Installing `flash-attn` would help the bigger tiers (longer
  seq, more attention-bound) but is ~marginal at 0.6B/1.7B, and the sm_120
  prebuilt-wheel situation makes it a source-build hassle (~1h). Fine to
  leave on `sdpa`.
- **bf16 vs `train_dtype`.** Registry `train_dtype="bf16"` for every real
  tier; `train_local.py` loads `torch_dtype=torch.bfloat16` and sets
  `bf16=True` in `SFTConfig` when on CUDA. Consistent. fp8 (`te_fp8.py`) is a
  no-op on sm_120 unless `ELIZA_FP8_TRAIN=1`, and `transformer_engine` isn't
  installed — so it's bf16 in practice, which is right for a 16 GB consumer
  GPU run.
- **Liger is currently broken on this box.** `_triton_runtime_ok()` probes
  Triton's CUDA backend up front; it fails because the interpreter is missing
  `python3.12-dev` headers (Triton JIT-compiles a `cuda_utils.c` against
  `Python.h` at first kernel launch). `train_local.py` correctly falls back
  to HF defaults and logs an actionable message. So on the dev box the
  fp32-logits transient (B·S·V·4) is **not** being chunked — that's the
  dominant memory term at long seq_len for Qwen's ~152k vocab. Fix:
  `apt install python3.12-dev`; until then, the 0.6B at seq=4096 still fits
  comfortably (see §B), but the 4096→8192 headroom analysis below assumes
  Liger is *off*.

---

## B. Memory math — `eliza-1-0_6b` (Qwen3-0.6B, 596M params, 28 layers, H=1024, V≈152k) on 16 GB

Config under audit: `micro_batch=1, grad_accum=8, seq_len=4096, bf16,
optimizer=apollo_mini, gradient checkpointing on, Liger OFF on this box`.

Accounting (all bf16 = 2 B/param unless noted):

| bucket | formula | value |
|---|---:|---:|
| Params (bf16) | 596M·2 | **1.19 GB** |
| Grads (bf16) | 596M·2 | **1.19 GB** |
| APOLLO-Mini optimizer state — unprojected group (embedding+lm_head+norms, fp32 m+v = 8 B/param) | ≈156M·8 | **1.25 GB** |
| APOLLO-Mini optimizer state — projected group (2-D weights, rank-1: ≈ `2D_params · 8 / in_features`) | ≈440M·8/1024 | **~3 MB** (negligible) |
| fp32-logits transient (HF loss, no Liger) — peak, freed after loss | B·S·V·4 = 1·4096·152k·4 | **2.49 GB** |
| Activations w/ gradient checkpointing (re-materialized per block; peak ≈ a couple of blocks live + the checkpointed inputs ≈ O(B·S·H·√L) ) | ~0.3–0.6 GB | **~0.5 GB** |
| CUDA context + cuBLAS workspace + allocator fragmentation | — | **~0.8–1.2 GB** |
| **Peak (sum, transients overlapping conservatively)** | | **≈ 8.5–9 GB** |

That matches the registry's `train_mem_gb_budget=10.0` with ~1–1.5 GB of slack
on a 16 GB card — i.e. there is **~6–7 GB of real headroom** vs the 16 GB
ceiling, and ~1 GB vs the (deliberately conservative) registry budget.

**Can we push `seq_len` to 8192?** The two seq-linear terms are the fp32-logits
transient (2.49 GB → **4.98 GB** at 8k) and activations (~0.5 GB → ~0.8 GB at
8k with checkpointing — sublinear-ish). New peak ≈ 11–12 GB. **Yes, 8192 fits**
on a 16 GB card even with Liger off — and if you `apt install python3.12-dev`
so Liger turns on, the logits transient gets divided by the FLCE chunk count
(`train_local.py` pins `chunk_size=512`), dropping it from ~5 GB to well under
1 GB, which would make 8k trivially comfortable and even 12–16k plausible.
Recommendation: bump the `qwen3-0.6b` registry `seq_len` to **8192** *only after
Liger is fixed* (so the budget has the chunked-CE margin baked in, matching the
1.7B/2B convention), or leave at 4096 and let callers pass `--max-seq-len 8192`
per run today. Conservative call: leave the registry default at 4096, raise
`train_mem_gb_budget` is *not* needed; document the 8k path. (No registry edit
made — `seq_len` bumps should be validated with `memory_calc.py --shape qwen3-0.6b`
on the actual box once Liger is back, per the registry's own contract.)

**Can we push `micro_batch` to 2?** Memory: doubles the logits transient
(2.49 → 4.98 GB at seq=4096) and activations (~0.5 → ~1.0 GB); new peak
≈ 11–12 GB — fits. **Throughput: yes, this helps.** A 0.6B model at micro_batch=1
leaves the GPU badly under-occupied (the matmuls are tiny; the launch overhead
and the gradient-checkpointing recompute dominate). micro_batch=2 (and even 4,
if you drop seq to 2048) raises arithmetic intensity and amortizes the
checkpoint recompute, typically +20–40% samples/sec on a card this size. The
*effective* batch is `micro_batch · grad_accum`, so to keep the same effective
batch when raising micro_batch to 2, drop `grad_accum` from 8 to 4 — that's a
strict win (fewer, larger micro-steps; identical optimizer trajectory).
**Recommendation: for the 0.6B tier, `micro_batch=2, grad_accum=4` (same
effective batch 8) is a free throughput gain.** Not changed in the registry
here because it's a behavior change that deserves a confirming throughput run
(`benchmarks/THROUGHPUT.md` already has the harness); flagged as the highest-
value cheap tuning knob.

---

## C. Recommendations

**High confidence**
1. Install `python3.12-dev` on the training box so Liger's Triton backend
   initializes — without it the fp32-logits transient isn't chunked and the
   8k+ seq_len budgets in the registry are not actually achievable. (Box
   config, not a code change. Still pending — needs box access.)
2. For the `qwen3-0.6b` tier, prefer `micro_batch=2, grad_accum=4` (same
   effective batch). micro_batch=1 starves a 16 GB GPU on a model this small;
   this is +20–40% samples/sec at no quality cost. **Done as an overridable
   knob** rather than a registry-default change: `run_pipeline.py --micro-batch 2
   --grad-accum 4` (forwarded to `train_local.py`). The registry default is
   left at `micro_batch=1` because measured peak VRAM at seq 4096 (~12 GB) is
   tighter than the analytical estimate; bump the registry default only after
   a confirming THROUGHPUT.md run on the box.
3. **Done** — `ELIZA_TORCH_COMPILE=1` opt-in in `train_local.py`: wraps the
   model in `torch.compile(model, mode="default")` *after* the Liger patch and
   *after* gradient checkpointing, *before* the trainer is constructed, inside
   a try/except that logs and falls back to uncompiled. +15–30% step time when
   it works. Default OFF — still needs a real run to confirm no catastrophic
   graph-break with the `compute_loss` override + FSDP.

**Medium confidence**
4. **Done** — `optimizer_rank=1` set for all `apollo_mini` tiers in
   `model_registry.py` (was 128/256/512). APOLLO-Mini is rank-1 by
   definition; both `build_apollo_mini_optimizer*` and `memory_calc.py`'s
   `APOLLO_MINI` branch ignore the value. `qwen3.5-9b` stays `apollo@512`.
   Field docstring updated to say the value only matters under full `apollo`.
5. Default `train_local.py --optimizer` to `apollo_mini` (matches the
   canonical recipe for ≤16 GB hardware and every registry entry). Not done —
   the arg-merge already makes `--registry-key` runs use `apollo_mini`; only a
   bare `--model ...` run with no registry key would change behavior, and that
   path is documented as "use a registry key". Low value; left as-is.

**Low confidence / needs a run**
6. After Liger is fixed: bump `qwen3-0.6b` `seq_len` 4096→8192 (and re-check
   `qwen3-1.7b`'s 4096 default — the registry note already says "drop to 2k
   if peak >15 GB", suggesting that one is close to the edge; with Liger on it
   has room). Today: `run_pipeline.py --max-seq-len 8192` makes this an
   overridable per-run knob without touching the registry default.
7. Consider `flash-attn` source build for the bigger (4B+) tiers; skip for
   0.6B/1.7B (sdpa already gets a fused backend; marginal gain, big build
   cost).

## D. Verification
- Read all three files end-to-end; cross-checked the recipe constants against
  arXiv:2412.05270 §4.2 / Table 2 and the upstream `apollo-torch` README.
- Memory accounting done by hand from the Qwen3-0.6B config geometry
  (H=1024, L=28, V≈152k, 596M params; embedding ≈156M); consistent with
  `memory_calc.py`'s documented formula and `OPTIMIZATION_INVENTORY.md`'s
  KV/weight numbers.
- No `pytest`/CUDA run done (this is an audit; the only code touched is the
  `.gitignore` allow-list for these two docs — no behavior change). The
  high-confidence registry/`train_local.py` edits are intentionally *not*
  applied blind: items 2 and 6 are budget changes the registry's own contract
  says must be validated with `memory_calc.py` + a real run, and item 3 needs
  a compile run to confirm it doesn't graph-break catastrophically with Liger
  + FSDP. Hand them to whoever has the box with `python3.12-dev` installed.
