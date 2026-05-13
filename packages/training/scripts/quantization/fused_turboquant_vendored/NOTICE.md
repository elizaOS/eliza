# fused_turboquant vendor notice

This directory vendors the upstream `fused-turboquant` package so we can
patch it in-place to support active Qwen3.5 gated attention without
waiting on an upstream release.

## Source

* Package: `fused-turboquant==0.1.0`
* Install command used to obtain the source: `pip install fused-turboquant==0.1.0`
* Upstream repo: <https://github.com/Argonaut790/fused-turboquant>
* Project metadata source of truth: the wheel METADATA at
  `.venv/lib/python3.12/site-packages/fused_turboquant-0.1.0.dist-info/METADATA`
  (`Name: fused-turboquant`, `Version: 0.1.0`, `License-Expression:
  Apache-2.0`).

## License

Apache License 2.0. The full upstream license text is reproduced in
[`LICENSE`](./LICENSE) (copied verbatim from the wheel's
`fused_turboquant-0.1.0.dist-info/licenses/LICENSE`). Apache 2.0 is
compatible with this repository's distribution and requires preserving
the LICENSE and noting modifications. We do.

## Modifications

Per Apache 2.0 §4(b), the changes made on top of upstream `0.1.0` are:

* **Internal imports rewritten from `fused_turboquant.X` to
  `quantization.fused_turboquant_vendored.X`** across every `.py` file in
  this tree (`__init__.py`, `core/*`, `hf/*`, `kernels/*`, `cache/*`,
  `benchmark/*`, `vllm_plugin/*`). This makes the package self-contained
  inside the workspace's `scripts/` directory; callers reach it as
  `from quantization.fused_turboquant_vendored.hf import patch_model`
  with `scripts/` on `sys.path`. No behavioral change.

* **`hf/fused_cache.py` — gated-attention support.** The upstream
  `make_fused_attention_forward` assumes a vanilla `q_proj` of shape
  `num_heads * head_dim`. Active Qwen3.5 models use a gated variant:
  `q_proj.out_features == 2 * num_heads * head_dim` (chunked along the
  last dim into `(query, gate)`) and the post-attention output is
  multiplied by `sigmoid(gate)` before `o_proj`. Three changes:

    1. New helper `_detect_attn_output_gate(module, config)` — returns
       True iff the attention module is the gated variant. Uses
       `config.attn_output_gate` when present, otherwise falls back to
       a `q_proj.out_features` shape probe (`== 2 * n_heads * head_dim`).
    2. `_probe_attention_module` now returns `attn_output_gate` so
       downstream callers can branch. `make_fused_attention_forward`
       reads it and:
         - Uses the config's `num_attention_heads` directly when
           computing `n_heads` (since `q_proj.out_features // head_dim`
           overcounts by 2x on gated modules).
         - When gated: chunks `q_proj(hidden_states)` along the last
           dim of a `(B, T, n_heads, 2*head_dim)` view into
           `(query, gate)`, runs the existing fused path on `query`
           only, then multiplies the post-attention output by
           `sigmoid(gate)` (reshaped to `(B, T, n_heads*head_dim)`)
           before `o_proj`.
         - When non-gated: behavior unchanged.
    3. `KNOWN_COMPATIBLE` now includes the hybrid Qwen3.5
       text decoders (`Qwen3_5ForCausalLM`, `Qwen3_5MoeForCausalLM`,
       `Qwen3_5ForConditionalGeneration`).

  The K/V projection paths are untouched — gating affects only Q in the
  Qwen3.5 layout, and `cache.store_compressed_key` /
  `cache.store_compressed_value` operate on K/V which retain their
  vanilla `(B, T, n_kv_heads * head_dim)` shape.

* **`hf/fused_cache.py` — partial-rotary RoPE.** Qwen3.5 uses partial
  rotary embeddings (only the first `cos.shape[-1]` coordinates of each
  head are rotated, the rest pass through). The upstream
  `_apply_rotary_pos_emb` assumed full-head RoPE and crashed with a
  shape mismatch on Qwen3.5 (`rotary_dim=64` vs `head_dim=256`). The
  vendored version now branches: if `cos.shape[-1] == q.shape[-1]` the
  fast path is unchanged; otherwise it splits Q/K into `(rot, pass)`,
  rotates only the leading slice, and concatenates them back. This
  matches `transformers.models.qwen3_5.modeling_qwen3_5.apply_rotary_pos_emb`.

* **`core/quantizer.py` — opt-out env var.** Added a check in
  `_try_enable_fused_triton`: setting `FUSED_TURBOQUANT_DISABLE_TRITON=1`
  forces the pure-PyTorch encode/decode path. Useful on dev boxes
  whose Triton JIT can't link `Python.h` (no `python3.X-dev` package).

* **`kernels/triton_attention.py` — pure-PyTorch fallback.** Added
  `_fused_qk_scores_rht_pytorch`, a math-equivalent reimplementation of
  the Triton kernel that unpacks the compressed key indices, gathers
  centroids, scales by per-vector norms, and runs the Q·K^T matmul
  through standard PyTorch ops. The dispatcher in `fused_qk_scores_rht`
  routes to this fallback when Triton is unavailable or
  `FUSED_TURBOQUANT_DISABLE_TRITON=1`. The Triton kernel path is
  unchanged when Triton is available.

* **No changes to `cache/`, `benchmark/`, or `vllm_plugin/`** beyond
  the import rewrite. The vLLM backend continues to behave exactly as
  upstream.

## Diff summary

| File | Change |
|------|--------|
| `__init__.py` | Import rewrite (`fused_turboquant.X` → `quantization.fused_turboquant_vendored.X`) |
| `core/quantizer.py`, `core/hadamard.py` | Import rewrite |
| `hf/__init__.py` | Import rewrite |
| `hf/fused_cache.py` | Import rewrite; gated-attention support: new `_detect_attn_output_gate`, gated branch in `make_fused_attention_forward`, expanded `KNOWN_COMPATIBLE` |
| `kernels/__init__.py`, `kernels/triton_*.py` | Import rewrite (none had cross-module imports needing rewrite outside of the module) |
| `cache/kv_cache.py` | Import rewrite |
| `benchmark/runner.py` | Import rewrite |
| `vllm_plugin/*.py` | Import rewrite |

## Citation

Please cite the original TurboQuant paper and the fused-turboquant
project when using this vendored copy in published work:

```bibtex
@software{fused_turboquant,
  title   = {fused-turboquant: Fused Triton Kernels for TurboQuant KV Cache Compression},
  author  = {fused-turboquant Contributors},
  url     = {https://github.com/Argonaut790/fused-turboquant},
  year    = {2025},
  license = {Apache-2.0},
}

@inproceedings{zandieh2026turboquant,
  title     = {TurboQuant: Online Vector Quantization with Near-optimal Distortion Rate},
  author    = {Zandieh, Amir and Daliri, Majid and Hadian, Majid and Mirrokni, Vahab},
  booktitle = {International Conference on Learning Representations (ICLR)},
  year      = {2026},
  url       = {https://arxiv.org/abs/2504.19874},
}
```
