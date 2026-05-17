"""
Attention metadata for the FUSED_TURBOQUANT backend.

We reuse vLLM's existing FlashAttention metadata since our paged block
structure is identical — only the data inside each block is different
(compressed uint8 instead of fp16). The block table layout, slot mapping,
and sequence length tracking are all the same.

If FlashAttentionMetadata is not available (older vLLM or non-CUDA platform),
we fall back to a minimal standalone dataclass.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional, Type

import torch

logger = logging.getLogger(__name__)

_VLLM_METADATA_CLS: Optional[Type] = None
_VLLM_BUILDER_CLS: Optional[Type] = None
_VLLM_STATE_CLS: Optional[Type] = None

try:
    from vllm.attention.backends.abstract import CommonAttentionState
    from vllm.attention.backends.flash_attn import (
        FlashAttentionMetadata,
        FlashAttentionMetadataBuilder,
    )

    _VLLM_METADATA_CLS = FlashAttentionMetadata
    _VLLM_BUILDER_CLS = FlashAttentionMetadataBuilder
    _VLLM_STATE_CLS = CommonAttentionState
except ImportError:
    try:
        from vllm.attention.backends.utils import CommonAttentionState

        _VLLM_STATE_CLS = CommonAttentionState
    except ImportError:
        pass


@dataclass
class FusedTurboQuantMetadata:
    """Standalone attention metadata when vLLM's FlashAttentionMetadata is unavailable.

    Fields mirror the subset of FlashAttentionMetadata that our backend uses.
    When FlashAttentionMetadata IS available, we reuse it directly (see
    get_metadata_cls() in backend.py).
    """

    num_prefills: int = 0
    num_prefill_tokens: int = 0
    num_decode_tokens: int = 0
    slot_mapping: Optional[torch.Tensor] = None
    seq_lens: Optional[List[int]] = None
    seq_lens_tensor: Optional[torch.Tensor] = None
    max_query_len: Optional[int] = None
    max_prefill_seq_len: int = 0
    max_decode_seq_len: int = 0
    query_start_loc: Optional[torch.Tensor] = None
    seq_start_loc: Optional[torch.Tensor] = None
    context_lens_tensor: Optional[torch.Tensor] = None
    block_tables: Optional[torch.Tensor] = None
    use_cuda_graph: bool = False

    @property
    def prefill_metadata(self) -> Optional["FusedTurboQuantMetadata"]:
        if self.num_prefills == 0:
            return None
        return self

    @property
    def decode_metadata(self) -> Optional["FusedTurboQuantMetadata"]:
        if self.num_decode_tokens == 0:
            return None
        return self


def get_metadata_cls() -> Type:
    """Return the best metadata class for the current environment."""
    if _VLLM_METADATA_CLS is not None:
        return _VLLM_METADATA_CLS
    return FusedTurboQuantMetadata


def get_builder_cls() -> Optional[Type]:
    """Return the metadata builder class if available."""
    return _VLLM_BUILDER_CLS


def get_state_cls() -> Optional[Type]:
    """Return the attention state class if available."""
    return _VLLM_STATE_CLS
