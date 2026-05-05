# QJL kernel attribution

This directory vendors the CUDA C++ extensions and Python wrappers from:

    https://github.com/amirzandieh/QJL
    Commit: 648b3641f96b6e95e091217220b94e4739fd4d82

Authored by Amir Zandieh, Majid Daliri, Insu Han. Licensed under the
Apache License, Version 2.0 — see [`LICENSE`](./LICENSE) for the full
text. (The integration prompt referred to "MIT-licensed"; the actual
upstream license at the commit pinned above is Apache 2.0. Distribution
under Apache 2.0 is compatible with this repo and requires preserving
the LICENSE and noting modifications. We do.)

## Modifications

Per Apache 2.0 §4(b), the changes made on top of upstream
`648b3641f96b6e95e091217220b94e4739fd4d82` are:

* **Added `__init__.py`** so the vendored directory functions as a
  regular Python package. Upstream ships these files in a flat
  directory and expects callers to add it to `sys.path`; we wanted
  clean `from scripts.quantization.qjl import ...` imports.

* **Parameterized `EMB_DIM` (head_dim) as a C++ template parameter.**
  Upstream hard-codes `#define EMB_DIM 128` at the top of every kernel.
  This is correct for Llama 2/3, Qwen2/2.5, and Qwen3 sub-9B (all
  head_dim=128) but fails to compile/run for head_dim=256 architectures
  like Qwen3.6-27B and Qwen3.6-35B-A3B. We changed:

    - `csrc/qjl_quant_kernel.cu`:
      `quantize_with_outliers_kernel` and `QJLQuantCudaTemplate` are now
      templated on `int EMB_DIM`. PYBIND11_MODULE explicitly instantiates
      `_h128` and `_h256` variants for every (T, Tproj) pair (10
      bindings total).
    - `csrc/qjl_score_kernel.cu`: same template parameterization on
      `calc_score_kernel` and `QJLScoreCudaTemplate`. 10 bindings.
    - `csrc/qjl_gqa_score_kernel.cu`: same template parameterization on
      `calc_gqa_score_kernel` and `QJLGQAScoreCudaTemplate`. 10
      bindings. The upstream `GQA_GROUP_SIZE=4` constant is unchanged —
      it gates the static `__shared__` query buffer's first dim and is
      independent of head_dim.
    - `csrc/qjl_quant_values_kernel.cu`: templated for source
      consistency. NOTE: this file has multiple unrelated upstream bugs
      (typo `sketched_vaues`, missing `quantize_value_kernel` symbol,
      wrong return tensors) and is not built by `setup.py`. Fixing those
      bugs is out of scope.
    - Each templated host wrapper adds a `TORCH_CHECK(emb_dim == EMB_DIM,
      ...)` guard so a wrong dispatch fails loud at the boundary instead
      of silently writing garbage.

* **Updated `qjl_kernel.py`** to dispatch by tensor `head_dim` to the
  matching `_h128` / `_h256` binding. The public function names
  (`qjl_quant`, `qjl_score`, `qjl_gqa_score`) and signatures are
  unchanged so downstream callers (`qjl_apply.py`,
  `LlamaAttention_QJL`, etc.) require no modifications. Also fixed an
  upstream typo (`tcuda_qjl_score` -> `cuda_qjl_score`) in the
  `qjl_score` float/float branch.

* **Added `build.sh`** that auto-detects the local GPU's compute
  capability via `nvidia-smi` and sets `TORCH_CUDA_ARCH_LIST`
  accordingly. Adds `+PTX` to sm_120 so PyTorch can JIT-compile from
  PTX on toolchains without sm_120 SASS support. Provides actionable
  install-command output when `nvcc` or `Python.h` is missing.

* **Added `test_kernel_dims.py`** with a pure-PyTorch QJL reference
  quantizer that runs without CUDA, verifies the analytic compression
  ratio for both head_dim values across `proj_dim ∈ {128, 256, 512}`,
  and exercises the CUDA kernel for both head_dim instantiations when
  the extension built (SKIPs cleanly with apt commands otherwise).

No other source-level changes were made to `csrc/*.cu`, `matmul.py`,
`new_pack.py`, or `setup.py` (the latter only gained a docstring).

## Citation

Please cite the original paper if you use this kernel:

```bibtex
@article{zandieh2024qjl,
  title={QJL: 1-Bit Quantized JL Transform for KV Cache Quantization with Zero Overhead},
  author={Zandieh, Amir and Daliri, Majid and Han, Insu},
  journal={arXiv preprint arXiv:2406.03482},
  year={2024}
}
```
