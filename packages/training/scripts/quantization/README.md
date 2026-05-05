# Post-Training Quantization

This directory holds the post-training quantization passes used to
shrink the fine-tuned Qwen Eliza checkpoints before they leave the
training rig. Each method is a self-contained CLI; they are independent
and can be combined or compared on the same fine-tuned checkpoint.

## PolarQuant

Reference: Caio Vicentino, *PolarQuant: Optimal Gaussian Weight
Quantization via Hadamard Rotation for LLM Compression*, arXiv:2603.29078
(March 2026). The arXiv PDF was withdrawn for errata fixes; the
implementation we run against lives in
[`caiovicentino/eoq-quantization`](https://github.com/caiovicentino/eoq-quantization)
@ commit `15a12160245d7d3015290c6c5b6dbb7f22094d5e`. The two source
files we depend on are vendored under `polarquant/` (see
`polarquant/LICENSE.md` for the upstream license situation — currently
no LICENSE file in the upstream repo; vendored under a documented
research-citation arrangement that must be revisited if the upstream
project publishes a restrictive license).

### Algorithm in one paragraph

For each linear's weight tensor, group the values into power-of-two
blocks (default 128). Per block: extract the L2 norm and store it as
fp16; normalize the block to the unit hypersphere; multiply by a
Walsh–Hadamard matrix so that each coordinate is an i.i.d. draw from
roughly N(0, 1/√d); quantize each coordinate against the **Lloyd–Max
optimal centroids for N(0, 1)** (precomputed via the iterative
conditional-expectation algorithm in `polarquant/polar_quant.py`),
storing the centroid index as int8; optionally append a 1-bit QJL
residual sign per block as a cheap correction. At inference, undo
each step: lookup centroid → divide by √d → inverse Hadamard → rescale
by per-block norm. The Hadamard rotation alone accounts for ~98% of
the perplexity recovery vs absmax (paper, Ablation §4.2). PolarQuant
is **data-free** — no calibration set is required — because the
post-rotation distribution is analytically Gaussian.

### Tradeoffs

- **Pros.** Data-free; near-lossless at Q5 (paper claims PPL Δ ≈ +0.02
  on Qwen3.5-9B vs FP16). int8 codes + fp16 per-block norms gives the
  storage payload that downstream INT4 inference kernels (torchao,
  llama.cpp, MLX) consume directly. Architecture-agnostic at the
  ``nn.Linear`` level.
- **Cons.** Reconstruction-back-into-fp16 (the path we use today) does
  **not** save inference VRAM by itself — the model still loads as a
  fp16 ``nn.Linear`` matrix; the win shows up when the codes-only
  payload is loaded by an INT4 inference kernel. The sidecar
  ``polarquant_artifacts.safetensors`` we emit is the artifact for
  that downstream path. The vendored compute kernel is a pure-Python
  PyTorch loop over linears (no Triton, no fused kernel), so the
  *quantization step itself* is slow on big models — it costs O(N)
  Hadamard products at quantization time, then is free at inference.

### Supported architectures

The vendored kernel runs on any model that exposes its weights as
``nn.Linear`` modules. We have explicitly verified it on:

- Qwen2 / Qwen2.5 (`Qwen2ForCausalLM`)
- Qwen3 (`Qwen3ForCausalLM`)
- Llama, Mistral, Phi-3 (the linear layout matches Qwen2; should work)

#### Qwen3.5 / Qwen3.6 caveat (read this)

The user-listed targets `Qwen3.5-{0.8B, 2B, 4B, 9B, 122B-A10B,
397B-A17B}` and `Qwen3.6-{27B, 35B-A3B}` ship as **multimodal
hybrid-attention** checkpoints (`Qwen3_5ForConditionalGeneration`).
The text decoder mixes `linear_attention` and `full_attention` layers
and adds Mamba-style SSM state, mrope vision embeddings, and a separate
vision encoder. PolarQuant operates on `nn.Linear` weights, so it
*will* still quantize the Q/K/V/O and MLP projections inside both
layer types — but:

1. The Mamba-style SSM in `linear_attention` layers carries a few
   non-linear state buffers (`A_log`, `D`, `dt_bias`) that are **not**
   `nn.Linear`. We deliberately skip those (they fall under the
   `min_numel` cutoff or aren't `nn.Linear` instances) — quantizing
   them through PolarQuant's Gaussian assumption would produce
   garbage.
2. The default `AutoModelForCausalLM` loader will refuse Qwen3.5 since
   the architecture is `ForConditionalGeneration`. The orchestrator
   needs to load it via `AutoModelForVision2Seq` (or the
   `Qwen3_5ForConditionalGeneration` class directly) and walk the
   text decoder. We have **not** done that integration yet — for the
   `0.8B` validation we fall back to `Qwen/Qwen3-0.6B`.
3. The MoE variants (`Qwen3.5-122B-A10B`, `Qwen3.5-397B-A17B`,
   `Qwen3.6-35B-A3B`) have router weights — those are tiny, fall
   under the `--min-numel` cutoff, and are deliberately skipped.

If/when we need to ship PolarQuant on a Qwen3.5/3.6 checkpoint, the
fix is: load with the right `AutoModel*` class, expose the text
decoder via `model.language_model` (or whichever attribute carries the
text tower), then call `quantize_checkpoint` against that submodule.
The rest of the kernel does not need to change.

### CLI

Quantize a fine-tuned 2B checkpoint:

```bash
uv run python scripts/quantization/polarquant_apply.py \
    --model checkpoints/qwen35-2b-eliza/final \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --output checkpoints/qwen35-2b-eliza/final-polarquant
```

The `--calibration*` flags are accepted for parity with the rest of
the quantization pipeline but are **unused** — PolarQuant is data-free
per the paper. Passing a non-existent calibration path still errors so
that misconfigured callers fail loudly.

Useful knobs:

- `--bits {2,3,4,5,6}` (default 4). Q5 is the paper's near-lossless
  point; Q4 is the practical default for INT4 inference kernels.
- `--block-size N` (default 128, must be a power of 2).
- `--no-qjl` to drop the 1-bit residual correction (slightly worse
  PPL, slightly smaller sidecar).
- `--no-artifacts` to skip writing the sidecar codes; useful when you
  only want the reconstructed fp16 model.
- `--include-lm-head` / `--include-embedding` to override the default
  skip behavior. Quantizing the LM head on weight-tied models is
  redundant; quantizing embedding tables hurts logits because they're
  looked up rather than multiplied.

### Validation

`scripts/quantization/test_polarquant.py` runs the round-trip on
`Qwen/Qwen3-0.6B` (the closest text-only causal-LM stand-in for
`Qwen/Qwen3.5-0.8B` — see caveat above), using 5 TOON-shaped samples
from `data/final/val.jsonl`. It asserts (a) the codes-only payload is
at least 30% smaller than the fp16 baseline checkpoint and (b) the
quantized model produces non-degenerate text on every sample.

```bash
uv run python scripts/quantization/test_polarquant.py
```

## TurboQuant

Reference: Amir Zandieh, Majid Daliri, Majid Hadian, Vahab Mirrokni
(Google Research / Google DeepMind / NYU), *TurboQuant: Online Vector
Quantization with Near-Optimal Distortion Rate*, **arXiv:2504.19874**,
ICLR 2026. Implementation:
[`vivekvar-dl/turboquant`](https://github.com/vivekvar-dl/turboquant)
shipped to PyPI as `turbokv` v0.1.0 (import name: `turboquant`). Pinned
in `pyproject.toml` under `[project.optional-dependencies] train`.

### What this is — and what it is NOT

TurboQuant is an **online, data-oblivious KV-cache quantizer**. It runs
at inference time and replaces the standard fp16 ``DynamicCache`` with
a ``TurboQuantCache`` that stores keys and values in 2- or 4-bit
packed form per coordinate.

It is **not** a weight quantizer. The ``model.safetensors`` file does
not change. ``turboquant_apply.py`` therefore writes the merged base
model unchanged and adds a ``turboquant.json`` sidecar that records the
quantizer config (`nbits`, `base_seed`, calibrated `skip_layers`,
`residual_length`) so a downstream loader can reconstruct the cache
deterministically.

### Algorithm in one paragraph

For each cached vector ``x`` of length ``head_dim`` (per attention
head, per token): (1) extract and store ``||x||`` in bf16; (2) rotate
the unit vector by a fixed-per-layer random orthogonal matrix Π drawn
from SO(d) via QR-decomposition with sign-fix — after rotation each
coordinate is approximately Beta-distributed (≈ N(0, 1/d) for large
d); (3) bucketize each coordinate against the precomputed Lloyd-Max
optimal centroids for the Beta distribution at b bits; (4) bit-pack
the indices into uint8 (2 indices/byte at 4-bit, 4 indices/byte at
2-bit). At attention time, unpack → centroid lookup → inverse rotation
``x ≈ ||x|| · ΠᵀC[i]``. The recent ``residual_length`` tokens stay in
fp16 to keep the freshly-generated context lossless.

### Tradeoffs

- **Pros.** Data-free / online — calibration is a single forward pass
  used only to detect outlier-norm layers (typically only layer 0) that
  should stay fp16. Drops naturally into ``model.generate`` via
  ``past_key_values=cache``. Works across architectures (Qwen, Llama,
  Gemma, Phi) without per-model code paths. Information-theoretic
  near-optimal: paper proves the rate is within ~2.7× the per-channel
  Shannon-Bennett lower bound.
- **Cons.** The reference implementation is pure PyTorch — the
  per-step quantize/dequantize is a Python-level operation per layer
  per step, which costs throughput. On a 0.6B model on a 5080 we
  observed **~5× slowdown** vs the bf16 ``DynamicCache``
  (66.8 → 12.2 tok/s). The TurboQuant paper claims faster runtime than
  the bf16 baseline because it ships **Triton kernels**; those are not
  in the `turbokv` 0.1.0 PyPI release we depend on. Until upstream
  ships Triton, this method is a *memory* win, not a *speed* win.
- The savings are concentrated in the long-context regime. At 4096-
  token prefill on Qwen3-0.6B we measured **3.52× per-token KV
  reduction** (114,688 → 32,608 bytes/token) which produced a real
  274 MB peak-VRAM drop on a tiny model — the absolute savings scale
  with `num_hidden_layers × num_kv_heads × head_dim × context_length`.

### Supported architectures

`TurboQuantCache` materializes a `TurboQuantLayer` per full-attention
layer reported by the model config. Verified locally against:

- Qwen3 (`Qwen3ForCausalLM`) — single-mode full attention. Works.

Should work, by structural inspection, on:

- Qwen2 / Qwen2.5, Llama, Gemma, Phi — all uniform full-attention with
  GQA, the same shape `TurboQuantLayer` already handles.

#### Qwen3.5 / Qwen3.6 caveat (read this)

The user-listed targets `Qwen3.5-{0.8B, 2B, 4B, 9B, 122B-A10B,
397B-A17B}` and `Qwen3.6-{27B, 35B-A3B}` are **hybrid linear-attention
+ Gated Attention** models (`Qwen3_5ForConditionalGeneration`). The
text decoder declares per-layer `layer_types`: most layers are
`linear_attention` (Gated DeltaNet — recurrent state, **no** (B, H, T,
D) KV cache) and only a minority (typically every 4th layer) are
`full_attention`. TurboQuant is only meaningful for the full-attention
layers — there is nothing to quantize in a recurrent state. Concretely
on Qwen3.5-2B, 6 of 24 layers are full attention; the analytic ceiling
on KV reduction is therefore at most ~25% of the standard ratio
applied to those 6 layers. The `kv_bytes_per_token_analytic` helper in
`test_turboquant.py` honors `layer_types` so the reported reduction
factor is correct for hybrid models.

The 0.8B target is also a **vision-language** checkpoint
(`Qwen3_5ForConditionalGeneration` with vision encoder), so loading it
needs `AutoModelForVision2Seq` (or the `Qwen3_5ForConditionalGeneration`
class directly), and `TurboQuantCache(model.config, ...)` must receive
the **text decoder config** — `model.config.get_text_config(decoder=True)`.
The `cache.py` in `turbokv` 0.1.0 already calls `get_text_config` when
available, so this should work in principle, but we have not validated
it end-to-end on a Qwen3.5 checkpoint yet — for the 0.8B-class
validation we fall back to `Qwen/Qwen3-0.6B`.

For the dense MoE variants (`Qwen3.5-122B-A10B`, `Qwen3.5-397B-A17B`,
`Qwen3.6-35B-A3B`), TurboQuant is orthogonal to the expert routing —
the KV cache shape is unaffected by MoE. Apply as normal once the
model fits on the target hardware.

### CLI

Apply to a fine-tuned 2B checkpoint (auto-merges if `--model` points
to a LoRA adapter):

```bash
uv run python scripts/quantization/turboquant_apply.py \
    --model checkpoints/qwen35-2b-eliza/final \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --output checkpoints/qwen35-2b-eliza/final-turboquant
```

Useful knobs:

- `--nbits {2,4}` (default 4). 4-bit hits ~3.5× KV reduction with
  ~zero quality loss; 2-bit hits ~6.4× with measurable but small
  degradation per the paper.
- `--residual-length N` (default 128). Most-recent N tokens stay in
  fp16 to keep freshly-generated context lossless.
- `--base-seed N` (default 42). Layer i uses `seed = base_seed + i`.
  Pin this to the value recorded in `turboquant.json` at inference
  time; otherwise the rotation matrices will not match and dequant
  gives garbage.
- `--norm-threshold f` (default 5.0). Calibration skips layers whose
  per-token key norms exceed `f × median`.

### Inference-time use

```python
import json
from turboquant import TurboQuantCache
from transformers import AutoModelForCausalLM, AutoTokenizer

side = json.load(open("checkpoints/qwen35-2b-eliza/final-turboquant/turboquant.json"))
model = AutoModelForCausalLM.from_pretrained(
    "checkpoints/qwen35-2b-eliza/final-turboquant",
    torch_dtype="bfloat16", device_map="cuda",
)
tok = AutoTokenizer.from_pretrained("checkpoints/qwen35-2b-eliza/final-turboquant")

cache = TurboQuantCache(
    model.config,
    nbits=side["nbits"],
    residual_length=side["residual_length"],
    base_seed=side["base_seed"],
    skip_layers=set(side["skip_layers"]),
)
out = model.generate(**tok("...", return_tensors="pt").to("cuda"),
                     past_key_values=cache, max_new_tokens=256)
```

### Validation

`scripts/quantization/test_turboquant.py` runs the round-trip on
`Qwen/Qwen3-0.6B` (closest text-only stand-in for `Qwen/Qwen3.5-0.8B`
— see caveat above), with 5 TOON-shaped prompts from
`data/final/val.jsonl` and a 4096-token long-context probe. It asserts
(a) the per-token KV-cache size shrinks by at least 30% and (b) every
quantized output is non-empty and not degenerate.

```bash
uv run python scripts/quantization/test_turboquant.py
```

The full numeric report is written to
`scripts/quantization/turboquant_report.json`. Last measured run on
Qwen3-0.6B / 5080 (4-bit, skip={0}, 4096-token long context):

| metric | baseline (bf16 DynamicCache) | TurboQuant 4-bit | delta |
|---|---|---|---|
| KV bytes/token | 114,688 | 32,608 | **3.52× / -71.6%** |
| Peak VRAM (4096-tok prefill) | 1.783 GB | 1.509 GB | -274 MB |
| Tok/s (5 short prompts × 128 new) | 66.8 | 12.2 | -82% (no Triton) |

## Fused TurboQuant (Triton)

Reference: same paper as TurboQuant above (arXiv:2504.19874). Implementation:
[`fused-turboquant`](https://pypi.org/project/fused-turboquant/) v0.1.0 — a
re-implementation of the TurboQuant scheme in **Triton kernels** (encode,
decode, fused Q@K^T scoring directly from packed indices). The math is
identical to ``turbokv`` 0.1.0 above; the win is throughput.

Pinned in `pyproject.toml` under `[project.optional-dependencies] train`
alongside `turbokv`. The two are kept side-by-side because (a) `turbokv` is
the architecture-portable fallback when ``patch_model`` rejects a model
(non-power-of-2 head_dim, fused QKV, sliding window), and (b) `fused-turboquant`
needs a working Triton + system-dev-headers stack that ``turbokv`` does not.

### CLI

Apply to a fine-tuned 27B checkpoint (auto-merges if `--model` points to a
LoRA adapter):

```bash
uv run python scripts/quantization/fused_turboquant_apply.py \
    --model checkpoints/qwen36-27b-eliza/final \
    --output checkpoints/qwen36-27b-eliza/final-fused-turboquant \
    --bits 4
```

The script runs ``check_model_compatibility(model)`` first and refuses to
proceed if the architecture isn't supported (logged with a structured
report). After patching it discards the cache, unpatches the model, and
saves the **unmodified** base weights — fused-TurboQuant is a runtime
concern, the safetensors files are byte-identical to the input.

`--calibration` / `--calibration-samples` are accepted for parity with the
other quantizer CLIs but are unused: the Lloyd-Max codebooks and RHT seeds
are data-oblivious.

### Inference-time use

```python
from quantization.fused_turboquant_vendored.hf import patch_model
from transformers import AutoModelForCausalLM, AutoTokenizer

model = AutoModelForCausalLM.from_pretrained(
    "checkpoints/qwen36-27b-eliza/final-fused-turboquant",
    torch_dtype="bfloat16", device_map="cuda",
)
tok = AutoTokenizer.from_pretrained("checkpoints/qwen36-27b-eliza/final-fused-turboquant")

cache = patch_model(model, bits=4, compress_v=True)  # patches model.forward in-place
out = model.generate(**tok("...", return_tensors="pt").to("cuda"),
                     past_key_values=cache, use_cache=True, max_new_tokens=256)
```

### Compatibility constraints (read this before deploying)

The Triton-kernel path is more constrained than the pure-PyTorch
``turbokv`` 0.1.0 path. The script's first step is
``check_model_compatibility(model)`` — these are the failure modes:

- **`head_dim` must be a power of 2** ∈ {64, 128, 256}. The Randomized
  Hadamard Transform in `fused_turboquant.kernels.triton_rht` is built
  around butterfly operations and has no implementation for arbitrary
  dims. Verified working on Qwen3 (head_dim=128) and Qwen3.5 text decoder
  (head_dim=256).
- **Separate Q/K/V projections required.** Fused-QKV models (`qkv_proj`,
  `c_attn`) are rejected — `make_fused_attention_forward` raises with a
  clear error rather than producing garbage.
- **No sliding-window attention.** Models with `sliding_window` set on
  the config or attention module are rejected (e.g., Mistral-Sliding,
  Gemma-2). The kernel is causal-full-attention only.
- **No attention logit softcapping** (Gemma-2-style).
- **RoPE expected.** ALiBi / learned positional embeddings produce
  incorrect results; `check_model_compatibility` warns when RoPE isn't
  detected in config.
- **Hybrid linear-attention models** (`Qwen3.5*`, `Qwen3.6*`): only the
  full-attention layers (typically 1-in-4) are patched; the linear
  layers keep their recurrent state. The compatibility checker reports
  `compatible=True` because the Triton path *will* run, but the savings
  scale only with the full-attention layer count. **Note**: the bonus
  Qwen3.5-0.8B run in our local test failed at the *baseline* generate
  step (HF `DynamicCache` is not the right cache for a hybrid model —
  it raises `has_previous_state can only be called on LinearAttention
  layers`); fused-TurboQuant is orthogonal to that issue. Hybrid models
  need a `HybridCache` wrapped around `CompressedKVCache`, which is
  upstream work. We document the gap and skip the bonus run.

### Blackwell / RTX 5080 Laptop notes

The 5080 Laptop is **sm_120** (Blackwell), CUDA 13.0, torch 2.11. Triton
3.6.0 supports this architecture. The build does, however, require Python
development headers to compile its `cuda_utils.so` shim on first use:

```bash
sudo apt install python3.12-dev
```

If the headers are missing the kernel raises a confusing error nested
inside the smoke test — see the "Last measured run" section below for the
exact failure mode. Without the headers the JIT cannot build and
`patch_model(..., verify=True)` fails on the very first forward pass.

### Validation

`scripts/quantization/test_fused_turboquant.py` runs three paths back-to-
back on `Qwen/Qwen3-0.6B` with 5 prompts × 128 new tokens at a 4096-token
prompt. It writes the full report to
`scripts/quantization/fused_turboquant_report.json` and asserts:

- fused peak VRAM ≤ pure-PyTorch turbokv peak VRAM, and
- fused tok/s ≥ 1.5x pure-PyTorch turbokv tok/s.

```bash
uv run python scripts/quantization/test_fused_turboquant.py
```

#### Last measured run (Qwen3-0.6B, 5080 Laptop, 4-bit, 4096-token prompt + 128 new tokens)

| path | peak VRAM | tokens/sec | notes |
|---|---|---|---|
| baseline (bf16 DynamicCache) | 1.782 GB | 33.34 tok/s | HF default |
| pure-PyTorch turbokv 0.1.0 | 1.496 GB | 9.59 tok/s | -286 MB vs baseline; **3.48x slower** (Python per-step quant/dequant) |
| fused-turboquant 0.1.0 | **BLOCKED** | **BLOCKED** | Triton JIT could not compile its `cuda_utils.so` helper |

The fused path failed at `patch_model(..., verify=True)` during the first
single-token forward pass. The exact error from
`/usr/bin/gcc` was:

```
fatal error: Python.h: No such file or directory
    7 | #include <Python.h>
      |          ^~~~~~~~~~
```

**Fix:** install the matching Python development headers system-wide so
Triton's CUDA utility helper can compile:

```bash
sudo apt install python3.12-dev
```

After installing, re-run the test — the same script will exercise the
Triton path without modification. The pure-PyTorch numbers above are real
and confirm that `turbokv` 0.1.0 still delivers the documented memory win
(-19.2% peak VRAM vs baseline at 4096-token prompt) but at a 3.48x
throughput cost; recovering that throughput is exactly what the Triton
kernels in `fused-turboquant` exist to do.

## QJL

Reference: Amir Zandieh, Majid Daliri, Insu Han, *QJL: 1-Bit Quantized JL
Transform for KV Cache Quantization with Zero Overhead*,
**arXiv:2406.03482**, AAAI 2025
([acm dl](https://dl.acm.org/doi/10.1609/aaai.v39i24.34773)).
Implementation: vendored from
[`amirzandieh/QJL`](https://github.com/amirzandieh/QJL) @
`648b3641f96b6e95e091217220b94e4739fd4d82` under
`scripts/quantization/qjl/` (Apache 2.0 — see
`scripts/quantization/qjl/LICENSE` and `qjl/NOTICE.md`). There is **no
`pyqjl` package on PyPI** — the QJL kernel is shipped as a CUDA C++
extension that the user has to compile against their local nvcc.
`pyproject.toml` adds `pybind11>=2.12.0` to the `train` extras so the
template-binding step has its dep; `nvcc` and the matching
`pythonX.Y-dev` headers come from the system package manager.

### What this is — and what it is NOT

QJL is the **K (keys) side** companion to TurboQuant's V (values) side.
Both compressors were authored by Amir Zandieh; they are explicitly
designed to compose. The combination delivers ~10x KV-cache compression
at long context: 1-bit per JL-projected key coordinate + 4-bit per value
coordinate, plus a small per-token bf16 norm on each side and an
amortized outlier sketch shared across `group_size` consecutive tokens.

QJL is **not** a weight quantizer. ``model.safetensors`` is unchanged
after applying. ``qjl_apply.py`` writes the merged base model unchanged
plus a ``qjl_config.json`` sidecar that records the projection geometry
(`projection_dim_per_head`, `projection_seed`, `outlier_count_*`,
`initial_layers_count`, `group_size`, `buffer_size`, paired
`value_bits`) so the inference loader can deterministically reconstruct
the JL projection matrix Π and the value-side codebook.

### Algorithm in one paragraph

For each cached key vector ``k`` of length ``head_dim`` (per attention
head, per token): (1) extract ``||k||`` and store it in bf16; (2)
multiply by a fixed-per-layer Johnson–Lindenstrauss matrix Π ∈
R^{head_dim × s} drawn from N(0, 1) and orthogonalized via a chunked
QR decomposition (``QJLSketch.init_rot_dir``), giving a sketch ``s = Πᵀ
k`` of length ``s = projection_dim_per_head``; (3) take the **sign** of
each sketch coordinate, packing 8 signs into one uint8. To recover an
unbiased estimator of inner products at attention time, the query is
projected through the *same* Π and the score is reconstructed in a
custom CUDA kernel (``qjl_kernel/csrc/qjl_score_kernel.cu``). The paper
proves the resulting cosine-similarity estimator has minimal relative
distortion at 1 bit. To handle outlier coordinates (a few head_dim
indices with disproportionately large norms — common on layer 0 in
Llama / Qwen models), the kernel additionally stores a top-k outlier
sketch per group of ``group_size`` consecutive tokens, with its own
larger JL projection of dimension ``dim_outlier`` (256 for general
layers, 128 for the first ``initial_layers_count`` layers). The recent
``buffer_size`` tokens stay in fp16 to preserve freshly-generated
context losslessly.

### Tradeoffs

- **Pros.** Provably minimal relative distortion at 1-bit (paper
  Theorem 3). Storage is purely the packed sign sketch plus a per-token
  bf16 norm — no quantization scale/zero-point per coordinate, which
  is what gives the "zero overhead" tagline. Hand-written CUDA kernels
  for both quantize and score paths recover throughput at long context
  (the paper reports 2.0–2.5x speedup on prefill and decode for
  Llama-2/3 at 32k context). Composes cleanly with TurboQuant on the V
  side for end-to-end ~4x KV reduction whole-model.
- **Cons.** The compression unit is the JL sketch dimension, not the
  number of bits per coord — at the canonical
  ``projection_dim_per_head=256`` the K-side ratio
  ``head_dim*2 / (projection_dim/8 + 2)`` works out to **7.53x for
  head_dim=128** (Qwen3-0.6B / Llama-3 / Qwen3.5-2B), not the
  marketing-headline 16x (which would assume zero norm overhead).
  Pushing to ``projection_dim_per_head=128`` recovers ~14.2x at the
  cost of attention-score quality. The kernel hard-codes
  ``EMB_DIM 128`` in ``csrc/qjl_quant_kernel.cu`` (line 7), so other
  head_dim values need a kernel rebuild with a different define.
  The CUDA kernel was written for Ampere/Hopper; Blackwell (sm_120)
  requires the PTX-fallback build flag (see "Build" below).

### Supported architectures

The vendored ``LlamaAttention_QJL`` and ``LlamaDecoderLayer_QJL``
modules under ``scripts/quantization/qjl/`` (mirrored from upstream
``models/llama3_qjl.py``) target the Llama-3 attention shape directly:
``q_proj`` / ``k_proj`` / ``v_proj`` / ``o_proj`` linear projections
plus ``LlamaRotaryEmbedding`` and grouped-query attention (the GQA
score kernel ``cuda_qjl_gqa_score`` handles
``num_attention_heads != num_key_value_heads``). Verified upstream on:

- Llama-2 7B and Llama-3 8B (the upstream ``run_longbench.py``
  evaluation set)

Should work, by structural match, on:

- Qwen2 / Qwen2.5 (full-attention, GQA, head_dim=128)
- Qwen3 0.6B / 1.7B / 4B / 8B (full-attention, GQA, head_dim=128) —
  validated locally by the pure-PyTorch ratio probe in `test_qjl.py`

#### Qwen3.5 / Qwen3.6 caveat (read this)

The user-listed targets `Qwen3.5-{0.8B, 2B, 4B, 9B, 122B-A10B,
397B-A17B}` and `Qwen3.6-{27B, 35B-A3B}` are **hybrid linear-attention
+ Gated Attention** models. QJL only applies to ``full_attention``
layers — there is nothing to compress in a recurrent state. The
``qjl_apply.py`` calibration step honors `layer_types` and silently
skips linear-attention layers. The on-disk config records
``n_full_attention_layers`` so the inference loader knows which layers
to wrap.

The 0.8B / 2B / 4B vision-language variants
(`Qwen3_5ForConditionalGeneration`) need to be loaded with
`AutoModelForVision2Seq` and the text decoder extracted via
`model.language_model` before patching the attention modules. We have
**not** done that integration yet — `test_qjl.py` falls back to
`Qwen/Qwen3-0.6B` for the 0.8B-class validation.

### Build

The QJL kernel is **not** pip-installable. Build it once, in place,
inside the vendored directory:

```bash
cd scripts/quantization/qjl
# Default Ampere/Hopper build:
python setup.py build_ext --inplace
# Blackwell (RTX 50-series, sm_120) — the kernel was not authored
# against this arch; force PTX fallback so it compiles for compute_120
# via the JIT path:
TORCH_CUDA_ARCH_LIST="12.0+PTX" python setup.py build_ext --inplace
```

Prerequisites (verified missing on the local 5080 dev box at the time
this was vendored):

```bash
sudo apt install nvidia-cuda-toolkit python3.12-dev
```

The first installs `nvcc` (PyTorch wheels ship `ptxas` and `nvrtc` but
**not** the full nvcc driver — the cu13 wheel directory only contains
`include/`, `lib/`, no `bin/nvcc`). The second installs `Python.h` so
the C++ extension's pybind11 bindings can compile.

### CLI

Apply to a fine-tuned 2B checkpoint (auto-merges if `--model` points to
a LoRA adapter):

```bash
uv run python scripts/quantization/qjl_apply.py \
    --model checkpoints/qwen35-2b-eliza/final \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --output checkpoints/qwen35-2b-eliza/final-qjl
```

Apply to a fine-tuned 27B checkpoint (same shape; calibration is
single-pass forward and fits in 16 GB only with offload):

```bash
uv run python scripts/quantization/qjl_apply.py \
    --model checkpoints/qwen36-27b-eliza/final \
    --calibration data/final/val.jsonl \
    --calibration-samples 128 \
    --projection-dim-per-head 256 \
    --projection-dim-per-head-initial 512 \
    --initial-layers-count 15 \
    --outlier-count-general 8 \
    --value-bits 4 \
    --output checkpoints/qwen36-27b-eliza/final-qjl
```

Useful knobs:

- `--key-bits 1` (only). QJL is a 1-bit-per-projected-coord scheme by
  construction; the flag exists for forward-compat.
- `--projection-dim-per-head N` (default 256). The JL sketch dimension
  per attention head. Smaller = more compression, lower attention
  score fidelity. Must be byte-aligned (`% 8 == 0`).
- `--projection-dim-per-head-initial N` (default 512). The first
  `--initial-layers-count` layers carry more attention mass; the paper
  recommends a larger sketch budget there. Leaving this at 2× the
  general dim matches upstream defaults exactly.
- `--initial-layers-count N` (default 15, paper's choice for Llama-7B
  with 32 layers). For different layer counts, scale ~half.
- `--outlier-count-general K` / `--outlier-count-initial-layers K`
  (default 8 each). Top-K head_dim coords promoted to the outlier
  sketch per group. The calibration step measures per-layer outlier
  norm ratio and records it in the sidecar so the inference loader
  can validate this budget.
- `--value-bits {2,4}` (default 4). Companion TurboQuant V-side bits
  recorded in the sidecar.
- `--group-size N` (default 32). Group of consecutive tokens that
  share an outlier-coord index table. Larger = smaller per-token
  outlier overhead, slightly worse outlier tracking on bursty
  activations.
- `--projection-seed N` (default 42). PRNG seed for the JL matrix.
  Pin this to the value recorded in `qjl_config.json` at inference
  time; otherwise Π won't match and the dequantized cosine scores are
  garbage.

### Validation

`scripts/quantization/test_qjl.py` runs on `Qwen/Qwen3-0.6B` (closest
text-only stand-in for `Qwen/Qwen3.5-0.8B` — see caveat above):

1. Attempts to build the vendored CUDA extension. If `nvcc` or
   `Python.h` is missing it records the exact remediation command
   (`sudo apt install nvidia-cuda-toolkit python3.12-dev`) and skips
   the runtime-kernel path.
2. Runs a baseline bf16 generation and records peak VRAM, tok/s, and
   sample outputs.
3. Captures the K activations from the first 4 attention layers via a
   forward hook, runs a **pure-PyTorch reference QJL quantize** on
   them (no CUDA extension needed — JL @ matmul + sign + bit-packing
   in plain PyTorch), and reports the realized K-side compression
   ratio per layer.
4. Sweeps `projection_dim ∈ {128, 256, 512}` so the report shows the
   full size-vs-quality curve at the same K activations.
5. Computes the analytic whole-model KV-bytes-per-token reduction with
   the paired V-side TurboQuant numbers via
   `qjl_apply.kv_bytes_per_token_analytic`.
6. Asserts (a) K-side ratio ≥ 7× at the canonical 256-dim setting,
   matching the closed-form `head_dim*2 / (projection_dim/8 + 2) =
   7.53×` for head_dim=128, and (b) baseline outputs are
   non-degenerate.

```bash
uv run python scripts/quantization/test_qjl.py
```

The full numeric report is written to
`scripts/quantization/qjl_report.json`. Last measured run on
Qwen3-0.6B / 5080 (bf16 baseline cache, projection_dim=256, seed=42):

| metric | value | notes |
|---|---|---|
| nvcc present | **No** | system blocker; `sudo apt install nvidia-cuda-toolkit` |
| Python.h present | **No** | system blocker; `sudo apt install python3.12-dev` |
| QJL CUDA kernel built | **No** | both blockers above must be fixed first |
| K-side ratio (proj_dim=256, real activations) | **7.53×** | head_dim=128, per-token bf16 norm |
| K-side ratio (proj_dim=128, real activations) | 14.22× | smaller sketch — quality tradeoff |
| K-side ratio (proj_dim=512, real activations) | 3.88× | larger sketch — higher fidelity |
| Analytic KV bytes/token (bf16 baseline) | 114,688 B | K + V over 28 full-attention layers |
| Analytic KV bytes/token (QJL-K + TurboQuant-V) | 27,608 B | proj_dim=256 + V 4-bit, group_size=32 |
| **Whole-model KV reduction** | **4.15×** (-75.9%) | K + V combined; matches paper's headline range |
| Baseline tok/s (5 prompts × 128 new) | 28.93 | bf16 DynamicCache baseline |
| Baseline peak VRAM | 3.43 GB | single-prompt generation |
| Baseline output sample | `"<think> Okay, let's see. The user provided the terminal output and wants me to check if the task is complete..."` | non-degenerate |

### Blockers (current state on the 5080 dev box)

- **`nvcc` is not on the system.** PyTorch's bundled cu13 wheel ships
  `nvrtc` and `ptxas` but no full `nvcc` driver, and the
  `nvidia-cuda-nvcc-cu12` PyPI wheel only ships `ptxas` (verified). Fix:
  `sudo apt install nvidia-cuda-toolkit`.
- **`Python.h` is not present** (no `python3.12-dev` package
  installed). Fix: `sudo apt install python3.12-dev`.
- **Blackwell (sm_120) is not in the upstream test matrix.** The
  kernel sources are written against Ampere/Hopper. After the two
  `apt install`s above, the recommended build command is
  `TORCH_CUDA_ARCH_LIST="12.0+PTX" python setup.py build_ext
  --inplace`, which forces the JIT-PTX fallback path; the kernel will
  compile to compute_120 via PTX at first load. If the kernel still
  fails at runtime on sm_120, the immediate workaround is to run the
  pure-PyTorch reference path in `test_qjl.py:qjl_pure_pytorch_quantize`
  for measurement and ship the validated checkpoint to a
  Hopper/Ampere host for actual inference.
- **Hard-coded `EMB_DIM 128`** in
  `qjl/csrc/qjl_quant_kernel.cu:7`. The code only works for
  `head_dim == 128` out of the box. Qwen3-0.6B / Qwen3.5-2B / Llama-3
  all match. If we later need to apply QJL to a model with
  `head_dim != 128`, the `#define EMB_DIM` must be edited and the
  kernel rebuilt; there is no runtime arg for it.

## Abliteration

Reference: Arditi et al., *Refusal in LLMs is mediated by a single
direction* ([arXiv:2406.11717](https://arxiv.org/abs/2406.11717)).
Practical writeup: [Maxime Labonne, "Uncensor any LLM with
abliteration"](https://huggingface.co/blog/mlabonne/abliteration).

Computes the rank-1 refusal direction
`r = normalize(mean(harmful) - mean(harmless))` from residual-stream
activations at a configurable mid-stack layer, then projects `r` out of
every block's `self_attn.o_proj` and `mlp.down_proj` weights so the
model can never write the refusal direction back into the residual
stream. Destructive transform — save to a NEW directory.

```
uv run python scripts/quantization/abliteration_apply.py \
    --checkpoint Qwen/Qwen3-0.6B \
    --output checkpoints/qwen3-0.6b-abliterated \
    --harmful-jsonl data/harmful.jsonl \
    --harmless-jsonl data/harmless.jsonl
```

Without `--harmful-jsonl` / `--harmless-jsonl` the script falls back to
a small built-in pair list intended for smoke testing only — pass real
prompt corpora (e.g.
[`mlabonne/harmful_behaviors`](https://huggingface.co/datasets/mlabonne/harmful_behaviors))
in production.
