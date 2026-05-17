"""
vLLM attention backend with fused-turboquant KV cache compression.

Implements the full AttentionBackend interface for vLLM, enabling:
    vllm serve <model> --attention-backend FUSED_TURBOQUANT

Compressed KV cache layout (per position per head):
    [packed_indices (packed_dim bytes) | fp32_norm (4 bytes)]

    4-bit, head_dim=128: 64 + 4 = 68 bytes   (vs 256B fp16 → 3.76x savings)
    3-bit, head_dim=128: 48 + 4 = 52 bytes   (vs 256B fp16 → 4.92x savings)
    2-bit, head_dim=128: 32 + 4 = 36 bytes   (vs 256B fp16 → 7.11x savings)

Architecture-aware: only compresses full-attention layers in hybrid models
like Qwen3.5 (skips DeltaNet/linear attention layers automatically).

Configuration:
    TURBOQUANT_BITS=4       Quantization bits (2, 3, or 4)
    TURBOQUANT_COMPRESS_V=1 Compress values too (1) or K-only (0)
"""

from __future__ import annotations

import logging
import os
from typing import Any, List, Optional, Tuple, Type

import torch

from quantization.fused_turboquant_vendored.vllm_plugin.cache_ops import (
    compressed_copy_blocks,
    compressed_swap_blocks,
    compute_compressed_elem_size,
)

logger = logging.getLogger(__name__)

_TURBOQUANT_BITS = int(os.environ.get("TURBOQUANT_BITS", "4"))

_AttentionBackendBase: Type = object
try:
    from vllm.attention.backends.abstract import AttentionBackend
    _AttentionBackendBase = AttentionBackend
except ImportError:
    pass


class FusedTurboQuantBackend(_AttentionBackendBase):
    """fused-turboquant attention backend for vLLM.

    Stores KV cache in compressed packed uint8 format within vLLM's paged block
    system. Uses fused Triton kernels for encode (RHT + quantize + pack) and
    attention (fused QK from packed indices).

    Usage:
        vllm serve Qwen/Qwen3-8B --attention-backend FUSED_TURBOQUANT

        # Or with Python API:
        from vllm import LLM
        llm = LLM("Qwen/Qwen3-8B", attention_backend="FUSED_TURBOQUANT")
    """

    name = "FUSED_TURBOQUANT"

    @staticmethod
    def get_name() -> str:
        return "FUSED_TURBOQUANT"

    @staticmethod
    def get_impl_cls() -> Type:
        from quantization.fused_turboquant_vendored.vllm_plugin.attention_impl import FusedTurboQuantImpl
        return FusedTurboQuantImpl

    @staticmethod
    def get_metadata_cls() -> Type:
        from quantization.fused_turboquant_vendored.vllm_plugin.metadata import get_metadata_cls
        return get_metadata_cls()

    @staticmethod
    def get_builder_cls() -> Optional[Type]:
        from quantization.fused_turboquant_vendored.vllm_plugin.metadata import get_builder_cls
        return get_builder_cls()

    @staticmethod
    def get_state_cls() -> Type:
        from quantization.fused_turboquant_vendored.vllm_plugin.metadata import get_state_cls
        cls = get_state_cls()
        if cls is not None:
            return cls
        try:
            from vllm.attention.backends.abstract import CommonAttentionState
            return CommonAttentionState
        except ImportError:
            raise ImportError(
                "Could not find CommonAttentionState. "
                "fused-turboquant requires vLLM >= 0.8."
            )

    @staticmethod
    def get_kv_cache_shape(
        num_blocks: int,
        block_size: int,
        num_kv_heads: int,
        head_size: int,
    ) -> Tuple[int, ...]:
        """Return shape for the compressed KV cache tensor.

        Instead of [2, num_blocks, block_size, num_kv_heads, head_size] in fp16,
        we use [2, num_blocks, block_size, num_kv_heads, compressed_elem_size]
        in uint8, where compressed_elem_size = packed_dim + 4 (norm bytes).
        """
        bits = _TURBOQUANT_BITS
        compressed_size = compute_compressed_elem_size(head_size, bits)
        return (2, num_blocks, block_size, num_kv_heads, compressed_size)

    @staticmethod
    def swap_blocks(
        src_kv_cache: torch.Tensor,
        dst_kv_cache: torch.Tensor,
        src_to_dst: torch.Tensor,
    ) -> None:
        """Swap blocks between devices (GPU ↔ CPU) for memory management."""
        compressed_swap_blocks(src_kv_cache, dst_kv_cache, src_to_dst)

    @staticmethod
    def copy_blocks(
        kv_caches: List[torch.Tensor],
        src_to_dsts: torch.Tensor,
    ) -> None:
        """Copy blocks within GPU for beam search / prefix caching."""
        compressed_copy_blocks(kv_caches, src_to_dsts)

    @classmethod
    def is_available(cls) -> bool:
        """Check if this backend can be used."""
        try:
            import importlib.util

            import torch
            if importlib.util.find_spec("quantization.fused_turboquant_vendored.core.quantizer") is None:
                return False
            return torch.cuda.is_available()
        except ImportError:
            return False

    @classmethod
    def get_supported_head_sizes(cls) -> List[int]:
        """Power-of-2 head sizes required by RHT butterfly operations."""
        return [64, 128, 256]

    @staticmethod
    def validate_configuration(
        head_size: int = 0,
        **kwargs: Any,
    ) -> None:
        """Raise if configuration is incompatible with this backend."""
        if head_size > 0 and (head_size & (head_size - 1)) != 0:
            raise ValueError(
                f"FUSED_TURBOQUANT requires power-of-2 head_size for RHT, "
                f"got {head_size}"
            )
