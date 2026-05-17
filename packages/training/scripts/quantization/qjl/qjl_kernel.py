"""Python dispatch layer for the vendored QJL CUDA extensions.

The CUDA kernels are compiled per (head_dim in {128, 256}) instantiation --
upstream hard-coded EMB_DIM=128, while active Qwen3.5 text models use
head_dim=256. The wrappers below pick the right
specialization at call-time based on the input tensor shape, so
downstream callers (e.g. ``LlamaAttention_QJL``) never have to know.

The public entry-point names (``qjl_quant``, ``qjl_score``,
``qjl_gqa_score``) and their argument signatures are byte-identical to
upstream. Only the dispatch internals changed.

Both module-level import of ``cuda_qjl_*`` and per-call dispatch are
deferred to runtime so this module imports cleanly on a host where the
CUDA extension has not been built. Callers can still use
``qjl_quantize_pytorch`` for the inlier branch without nvcc.
"""

import importlib

import torch


# Compiled head_dim specializations. Add new sizes here after rebuilding
# the kernel with a matching template instantiation in csrc/*.cu.
_SUPPORTED_EMB_DIMS = (128, 256)


_KERNEL_CACHE: dict[str, object] = {}


def _load_kernel(name: str):
    """Lazy import of a compiled CUDA extension. Raises ImportError when
    the build hasn't run; callers should catch and fall back to the
    pure-PyTorch reference path.
    """
    cached = _KERNEL_CACHE.get(name)
    if cached is not None:
        return cached
    mod = importlib.import_module(name)
    _KERNEL_CACHE[name] = mod
    return mod


def _emb_dim_suffix(emb_dim: int) -> str:
    if emb_dim not in _SUPPORTED_EMB_DIMS:
        raise NotImplementedError(
            f"QJL kernel: head_dim={emb_dim} is not a compiled specialization. "
            f"Supported: {_SUPPORTED_EMB_DIMS}. To add a new size, instantiate "
            "the templates in csrc/qjl_quant_kernel.cu, csrc/qjl_score_kernel.cu, "
            "and csrc/qjl_gqa_score_kernel.cu, then rebuild via setup.py."
        )
    return f"_h{emb_dim}"


def qjl_quant(key_states, outlier_indices, rand_prj, outlier_sketch_dim):
    # key_states: (B, H, N, group_size, head_dim)
    cuda_qjl_quant = _load_kernel("cuda_qjl_quant")
    emb_dim = key_states.shape[-1]
    suffix = _emb_dim_suffix(emb_dim)

    key_dtype = key_states.dtype
    rand_dtype = rand_prj.dtype

    if key_dtype == torch.half and rand_dtype == torch.half:
        fn = getattr(cuda_qjl_quant, f"qjl_quant_half_half{suffix}")
    elif key_dtype == torch.half and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_quant, f"qjl_quant_half_float{suffix}")
    elif key_dtype == torch.float and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_quant, f"qjl_quant_float_float{suffix}")
    elif key_dtype == torch.bfloat16 and rand_dtype == torch.bfloat16:
        fn = getattr(cuda_qjl_quant, f"qjl_quant_bf16_bf16{suffix}")
    elif key_dtype == torch.bfloat16 and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_quant, f"qjl_quant_bf16_float{suffix}")
    else:
        raise TypeError(
            f"Unsupported data types for QJL quantization: "
            f"key_dtype={key_dtype}, rand_dtype={rand_dtype}"
        )
    return fn(key_states, outlier_indices, rand_prj, outlier_sketch_dim)


def qjl_score(key_quant, key_outlier_quant, key_norm, key_outlier_norm, outlier_indices, query_sketch, query_states, rand_prj):
    # query_states: (B, H, N, head_dim)
    cuda_qjl_score = _load_kernel("cuda_qjl_score")
    emb_dim = query_states.shape[-1]
    suffix = _emb_dim_suffix(emb_dim)

    query_dtype = query_states.dtype
    rand_dtype = rand_prj.dtype

    if query_dtype == torch.half and rand_dtype == torch.half:
        fn = getattr(cuda_qjl_score, f"qjl_score_cuda_half_half{suffix}")
    elif query_dtype == torch.half and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_score, f"qjl_score_cuda_half_float{suffix}")
    elif query_dtype == torch.float and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_score, f"qjl_score_cuda_float_float{suffix}")
    elif query_dtype == torch.bfloat16 and rand_dtype == torch.bfloat16:
        fn = getattr(cuda_qjl_score, f"qjl_score_cuda_bf16_bf16{suffix}")
    elif query_dtype == torch.bfloat16 and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_score, f"qjl_score_cuda_bf16_float{suffix}")
    else:
        raise TypeError(
            f"Unsupported data types for QJL score calculation: "
            f"query_dtype={query_dtype}, rand_dtype={rand_dtype}"
        )
    return fn(key_quant, key_outlier_quant, key_norm, key_outlier_norm, outlier_indices, query_sketch, query_states, rand_prj)


def qjl_gqa_score(key_quant, key_outlier_quant, key_norm, key_outlier_norm, outlier_indices, query_sketch, query_states, rand_prj):
    # query_states: (B, H_q, N, head_dim)
    cuda_qjl_gqa_score = _load_kernel("cuda_qjl_gqa_score")
    emb_dim = query_states.shape[-1]
    suffix = _emb_dim_suffix(emb_dim)

    query_dtype = query_states.dtype
    rand_dtype = rand_prj.dtype

    if query_dtype == torch.half and rand_dtype == torch.half:
        fn = getattr(cuda_qjl_gqa_score, f"qjl_gqa_score_cuda_half_half{suffix}")
    elif query_dtype == torch.half and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_gqa_score, f"qjl_gqa_score_cuda_half_float{suffix}")
    elif query_dtype == torch.float and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_gqa_score, f"qjl_gqa_score_cuda_float_float{suffix}")
    elif query_dtype == torch.bfloat16 and rand_dtype == torch.bfloat16:
        fn = getattr(cuda_qjl_gqa_score, f"qjl_gqa_score_cuda_bf16_bf16{suffix}")
    elif query_dtype == torch.bfloat16 and rand_dtype == torch.float:
        fn = getattr(cuda_qjl_gqa_score, f"qjl_gqa_score_cuda_bf16_float{suffix}")
    else:
        raise TypeError(
            f"Unsupported data types for QJL GQA score calculation: "
            f"query_dtype={query_dtype}, rand_dtype={rand_dtype}"
        )
    return fn(key_quant, key_outlier_quant, key_norm, key_outlier_norm, outlier_indices, query_sketch, query_states, rand_prj)


# ---------------------------------------------------------------------------
# Pure-PyTorch reference path
# ---------------------------------------------------------------------------
#
# Used when the CUDA extension is not built. Mirrors the inlier branch of
# upstream ``QJLSketch.qjl_qunatize`` (sign-quantize after a JL projection,
# then bit-pack along the trailing axis). The outlier branch is approximated
# by zeroing the requested outlier coordinates before the projection so the
# downstream score path does not double-count them.
#
# The intent is correctness-of-shape, not throughput. This is a fallback
# for hosts that lack ``nvcc`` / ``python<X>-dev``; on a real serving host
# the user is expected to have built the CUDA extension.


def qjl_quantize_pytorch(
    key_states: torch.Tensor,
    outlier_indices: torch.Tensor | None,
    rand_prj: torch.Tensor,
    outlier_sketch_dim: int,
):
    """Pure-PyTorch QJL inlier-branch quantization.

    Args:
        key_states:        (B, H, N, group_size, head_dim) bf16/fp16/fp32
                           tensor of grouped K activations.
        outlier_indices:   (B, H, N, outlier_count) uint8 tensor of the
                           per-group outlier coordinate indices to mask
                           out before projection. Pass ``None`` to skip
                           the masking (no outliers).
        rand_prj:          (sketch_dim, head_dim) JL projection matrix.
        outlier_sketch_dim: kept for API parity with the CUDA wrapper;
                           currently unused by the inlier-only fallback.

    Returns:
        Tuple ``(key_quant, key_outlier_quant, key_outliers_norm)`` shaped
        analogously to the CUDA path so the caller can substitute either
        backend without changing downstream code:

            key_quant:           (B, H, N, group_size, sketch_dim/8) uint8
            key_outlier_quant:   (B, H, N, group_size, outlier_sketch_dim/8) uint8
                                 -- zero-filled in this fallback (outlier
                                 branch not implemented in pure PyTorch).
            key_outliers_norm:   (B, H, N, outlier_count) float32 -- the
                                 per-coordinate L2 norm across the group.
    """
    if rand_prj.dim() != 2:
        raise ValueError(
            f"rand_prj must be (sketch_dim, head_dim); got shape {tuple(rand_prj.shape)}"
        )
    sketch_dim, head_dim = rand_prj.shape
    if sketch_dim % 8 != 0:
        raise ValueError(f"sketch_dim must be a multiple of 8; got {sketch_dim}")
    if outlier_sketch_dim % 8 != 0:
        raise ValueError(
            f"outlier_sketch_dim must be a multiple of 8; got {outlier_sketch_dim}"
        )
    if key_states.shape[-1] != head_dim:
        raise ValueError(
            f"key_states.shape[-1]={key_states.shape[-1]} does not match "
            f"rand_prj head_dim={head_dim}"
        )

    B, H, N, group_size, _ = key_states.shape

    keys = key_states
    if outlier_indices is not None:
        if outlier_indices.shape[:3] != (B, H, N):
            raise ValueError(
                f"outlier_indices.shape[:3]={tuple(outlier_indices.shape[:3])} "
                f"does not match key_states.shape[:3]={(B, H, N)}"
            )
        outlier_count = outlier_indices.shape[-1]
        # Build a (B, H, N, head_dim) boolean mask of inlier coordinates.
        idx = outlier_indices.long()
        mask = torch.ones(B, H, N, head_dim, device=keys.device, dtype=keys.dtype)
        mask.scatter_(-1, idx, 0.0)
        # Zero out outlier coords before projecting (inlier branch only).
        keys = keys * mask.unsqueeze(-2)
    else:
        outlier_count = 0

    # Project: (..., group_size, head_dim) @ (head_dim, sketch_dim) ->
    # (..., group_size, sketch_dim).
    proj_t = rand_prj.transpose(0, 1).to(keys.dtype)
    sketched = torch.matmul(keys, proj_t)

    # Sign quantize and pack to uint8 along the trailing axis.
    bits = (sketched > 0).to(torch.uint8)
    bits = bits.view(B, H, N, group_size, sketch_dim // 8, 8)
    enc = (
        1 << torch.arange(8, device=keys.device, dtype=torch.uint8)
    ).view(1, 1, 1, 1, 1, 8)
    key_quant = (bits * enc).sum(dim=-1).to(torch.uint8)

    # Outlier branch is not implemented in the pure-PyTorch reference. Return
    # zero-filled tensors with the right shape so callers can still slot in.
    key_outlier_quant = torch.zeros(
        B, H, N, group_size, outlier_sketch_dim // 8,
        device=keys.device, dtype=torch.uint8,
    )
    if outlier_count > 0:
        # Per-coord L2 norm across the group axis (matches the CUDA path's
        # `outlier_norms` semantics for downstream score reconstruction).
        outlier_vals = torch.gather(
            key_states, -1, idx.unsqueeze(-2).expand(B, H, N, group_size, outlier_count),
        )
        key_outliers_norm = outlier_vals.float().norm(dim=-2)
    else:
        key_outliers_norm = torch.zeros(
            B, H, N, 0, device=keys.device, dtype=torch.float32,
        )

    return key_quant, key_outlier_quant, key_outliers_norm
