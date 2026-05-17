"""Vendored QJL kernel from https://github.com/amirzandieh/QJL.

Upstream commit: 648b3641f96b6e95e091217220b94e4739fd4d82
License:        Apache License 2.0 (see ./LICENSE in this directory).

Reference:
    Zandieh, Daliri, Han. *QJL: 1-Bit Quantized JL Transform for KV Cache
    Quantization with Zero Overhead*. arXiv:2406.03482, AAAI 2025.

The CUDA C++ extensions in ``./csrc`` must be compiled before any of the
Python wrappers in this directory will import. Build them with:

    cd scripts/quantization/qjl
    python setup.py build_ext --inplace

Build prerequisites (verified missing on the local 5080 dev box at the
time this was vendored — see scripts/quantization/qjl_apply.py for the
exact apt commands):
  * ``nvcc`` from the CUDA toolkit
  * ``Python.h`` from the matching ``pythonX.Y-dev`` package
  * Sufficient compute capability — set ``TORCH_CUDA_ARCH_LIST`` to your
    target arch list. Blackwell (sm_120) is not in the upstream test
    matrix; ``"12.0+PTX"`` is the recommended workaround.

The four extensions this directory builds:
  * ``cuda_qjl_score``     — full-attention QJL scoring kernel
  * ``cuda_qjl_quant``     — fused JL projection + sign quantization
  * ``cuda_qjl_gqa_score`` — grouped-query-attention scoring kernel
  * ``quantization``       — int4/int2 KV-value batched matmul kernel

The Python wrappers (``matmul.py``, ``new_pack.py``) are byte-identical
to upstream apart from this docstring. ``qjl_kernel.py`` was modified to
dispatch by ``head_dim`` to the correct ``_h{128,256}`` kernel
specialization (the kernels in ``csrc/`` are templated on EMB_DIM so a
single rebuild produces both variants). See ``NOTICE.md`` in this
directory for the full Apache 2.0 §4(b) modification log.
"""
