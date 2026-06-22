# M6 — Gemma KV geometry, flash-attention, and kernel re-opt status

> Milestone **M6** of the [Gemma 4 cutover](../docs/gemma4-cutover-plan.md):
> kernel re-optimization for Gemma's geometry. This doc is the *measured*
> evidence behind the plan's claim that **QJL/Polar KV-quant is low-ROI on Gemma
> and the head_dim=128 KV kernels are dimensionally inapplicable** — plus the FA
> finding and the 8/8 re-verify status. Measured on fork `c849143c9`, 2026-06-22.

## 1. Measured geometry per tier

Read directly from the GGUF headers via `llama-bench -v`:

| field | gemma-4-E2B | gemma-4-E4B | gemma3n-E2B |
|---|---:|---:|---:|
| arch | `gemma4` | `gemma4` | `gemma3n` |
| layers | 35 | (gemma4) | 30 |
| n_head | 8 | 8 | 8 |
| **n_head_kv (MQA)** | **1** | **1** | **2** |
| **head_dim global** | **512** | 512 | 256 |
| **head_dim SWA** | **256** | 256 | 256 |
| sliding_window | 512 | 512 | 512 |
| global / SWA layers | 7 / 28 | — | (4×SWA : 1×global) |
| **shared_kv_layers** | **20** | — | **10** |
| layers owning KV | 15 | — | — |
| per-layer-embedding (PLE) | 256 | 256 | 256 |
| vocab | 262144 | 262144 | — |
| SWA pattern | 4×SWA → 1×global | same | `[T,T,T,T,F,…]` |

## 2. The KV cache is already minimal (why QJL/Polar is low-ROI)

Three structural facts stack to make Gemma's KV tiny *before* any KV-quant:

1. **MQA — 1 KV head** (gemma4) / 2 (gemma3n). vs multi-head, KV is divided by
   `n_head / n_head_kv` = 8×.
2. **Windowed SWA on most layers.** 28 of 35 layers (gemma4-E2B) are SWA, capped
   at `sliding_window = 512` tokens *regardless of context length*. At runtime:
   `llama_kv_cache_iswa: creating SWA KV cache, size = 256 cells` — the SWA cache
   does not grow with the prompt.
3. **Shared-KV — 20 of 35 layers reuse another layer's KV** (only 15 own KV).
   Observed as `llama_kv_cache: layer N: filtered` for the shared layers.
4. The non-SWA (global) cache is likewise tiny: `creating non-SWA KV cache,
   size = 256 cells`.

**Consequence:** the on-device KV footprint is dominated by ~15 own-KV layers
with 1 KV head, most of them window-bounded. Quantizing that KV (QJL/Polar) saves
a small absolute number of bytes. The owner directive to **deprioritize QJL/Polar
KV-quant for Gemma** is confirmed by the geometry.

### The head_dim=128 kernels are dimensionally inapplicable

Our QJL (`block_qjl1_256`) and PolarQuant (`Q4_POLAR`) KV kernels were authored
for **uniform head_dim = 128** (the Qwen line). Gemma's dual dims are **512
(global) / 256 (SWA)** — neither is 128. The kernels would need re-parameterizing
to a per-layer head_dim before they could even run on Gemma, and §2 shows the
payoff would be marginal. **Verdict: do not re-parameterize QJL/Polar for Gemma
now; keep TurboQuant *weight*-quant (orthogonal to KV, full ROI).**

## 3. Flash-attention is the actual KV/attention lever for Gemma — already default

Without FA, Gemma's dual head dims force V-cache padding to the max dim:

```
llama_kv_cache: the V embeddings have different sizes across layers
                and FA is not enabled - padding V cache to 512   (E2B)
                                                          to 1024  (E4B)
```

With `-fa 1` that padding is **gone** (verified on CPU; `flash_attn = enabled`,
no padding line) and throughput rises (E2B pp 58→61 / tg 16.7→17.2; gemma3n
pp 61→66 / tg →15.5). FA is the right Gemma KV optimization — and it is **already
the default**: `eliza_llm_flash_attn_type()` returns `AUTO` on every platform
except Android (where the Mali Vulkan `flash_attn.comp` scalar kernel is a
device-verified race → disabled, perf-neutral there, overridable via
`ELIZA_LLM_FLASH_ATTN`).

### ⚠ Open M6 verification gap: does AUTO *engage* FA for the 512 global dim per backend?

`AUTO` only turns FA on where the backend's FA kernel supports the head dim.
**Proven: CPU engages FA for Gemma's 512 global dim** (padding eliminated). But
CUDA/Metal FA kernels historically cap near head_dim 256 — if a backend's FA
kernel does not support 512, `AUTO` **silently falls back to non-FA on the 7
global layers** and the V-padding cost returns *on that backend only*. This must
be checked on each GPU backend; it could not be checked here (CUDA is
toolkit-blocked — see the M7 report). **Action:** on CUDA 13.x / Apple, run
`llama-bench -m gemma-4-E2B … -fa 1 -v` and confirm no `padding V cache` line.

## 4. 8/8 kernel verify matrix — status for the Gemma geometry

| backend | reference fixtures | status for Gemma |
|---|---|---|
| CPU | head_dim=128 (Qwen-shaped) | **runnable here**; Gemma forward proven via llama-bench (text). Kernel-parity fixtures still head_dim=128 → need Gemma-geometry re-gen. |
| CUDA | head_dim=128 | **blocked** — sm_120 needs CUDA 13.x (not installed); GPU not enumerable by the CUDA runtime on this host. |
| Vulkan-Mali | — | FA off by policy (race); QJL/Polar is the on-device attention path (#8848) — but it is head_dim=128 → re-param needed before it applies to Gemma. |
| Metal | — | needs Apple Silicon. |

**The 8/8 matrix cannot be honestly closed for Gemma yet:** the parity fixtures
are head_dim=128 and must be regenerated against Gemma-geometry GGUFs, and the
GPU backends are hardware/toolkit-blocked on this host. This is scoped, not done.

## 5. M6 work remaining (owners)

- **[needs GPU]** FA-engage check for the 512 global dim on CUDA/Metal (§3 gap).
- **[needs GPU + fixture re-gen]** Regenerate kernel-parity fixtures at Gemma
  dual dims (512/256) and re-run the 8/8 matrix per buildable backend.
- **[M1/M2 agent — `src/services/` is dirty]** Wire the Gemma-aware RAM defaults
  into the load-args resolver (`active-model.ts`, `kv-spill.ts`): `swa_full=false`,
  bounded `ctx-checkpoints` (≤1), `mmap` ON, PLE pinned to CPU on GPU backends.
  See [`M8-M9-M10-remaining-work.md`](M8-M9-M10-remaining-work.md).
- **[done — keep]** TurboQuant weight-quant (orthogonal to KV). FA default = AUTO.
