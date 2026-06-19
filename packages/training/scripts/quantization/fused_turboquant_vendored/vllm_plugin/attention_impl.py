"""
Attention implementation for the FUSED_TURBOQUANT vLLM backend.

Handles both prefill and decode paths:
  - Prefill: SDPA on full-precision QKV → compress K/V → write to paged blocks
  - Decode:  compress new token → fused QK from packed → decompress V → output

Per-layer state (RHT signs, codebooks) is stored on the impl instance, which
vLLM creates once per attention layer in the model.
"""

from __future__ import annotations

import logging
import os
from typing import Any, List, Optional, Tuple, Type

import torch
import torch.nn.functional as F

from quantization.fused_turboquant_vendored.core.hadamard import randomized_hadamard
from quantization.fused_turboquant_vendored.core.quantizer import CompressedTensor, TurboQuantMSE
from quantization.fused_turboquant_vendored.vllm_plugin.cache_ops import (
    gather_compressed_kv_batched,
)

logger = logging.getLogger(__name__)

_TURBOQUANT_BITS = int(os.environ.get("TURBOQUANT_BITS", "4"))
_TURBOQUANT_COMPRESS_V = os.environ.get("TURBOQUANT_COMPRESS_V", "1") == "1"

_AttentionImplBase: Type = object
try:
    from vllm.attention.backends.abstract import AttentionImpl
    _AttentionImplBase = AttentionImpl
except ImportError:
    pass


class FusedTurboQuantImpl(_AttentionImplBase):
    """vLLM attention implementation with fused TurboQuant KV cache compression.

    Each attention layer in the model gets one instance of this class.
    The instance holds its own TurboQuantMSE encoder (with RHT signs and
    Lloyd-Max codebooks) and uses the shared fused Triton kernels for
    attention computation.

    Configuration via environment variables:
        TURBOQUANT_BITS: 2, 3, or 4 (default: 4)
        TURBOQUANT_COMPRESS_V: "1" or "0" (default: "1")
    """

    def __init__(
        self,
        num_heads: int,
        head_size: int,
        scale: float,
        num_kv_heads: Optional[int] = None,
        alibi_slopes: Optional[List[float]] = None,
        sliding_window: Optional[int] = None,
        kv_cache_dtype: str = "auto",
        blocktable_shape: Optional[Tuple[int, ...]] = None,
        logits_soft_cap: Optional[float] = None,
        **kwargs: Any,
    ) -> None:
        if _AttentionImplBase is not object:
            super().__init__(
                num_heads=num_heads,
                head_size=head_size,
                scale=scale,
                num_kv_heads=num_kv_heads,
                alibi_slopes=alibi_slopes,
                sliding_window=sliding_window,
                kv_cache_dtype=kv_cache_dtype,
                blocktable_shape=blocktable_shape,
                logits_soft_cap=logits_soft_cap,
                **kwargs,
            )

        self.num_heads = num_heads
        self.head_size = head_size
        self.scale = scale
        self.num_kv_heads = num_kv_heads or num_heads
        self.num_kv_groups = self.num_heads // self.num_kv_heads

        if sliding_window is not None:
            raise NotImplementedError(
                "FUSED_TURBOQUANT does not yet support sliding window attention. "
                "Use a model without sliding window or a different backend."
            )

        if alibi_slopes is not None:
            raise NotImplementedError(
                "FUSED_TURBOQUANT does not support ALiBi attention. "
                "Use a model with RoPE or a different backend."
            )

        self.bits = _TURBOQUANT_BITS
        self.compress_v = _TURBOQUANT_COMPRESS_V

        self.tq = TurboQuantMSE(
            head_dim=head_size,
            bits=self.bits,
            device="cuda",
        )
        self.rht_signs = self.tq.rotation.signs
        self.centroids = self.tq.quantizer.levels
        self.boundaries = self.tq.quantizer.boundaries

        if self.bits == 4:
            self.packed_dim = head_size // 2
        elif self.bits == 3:
            self.packed_dim = head_size * 3 // 8
        elif self.bits == 2:
            self.packed_dim = head_size // 4
        else:
            raise ValueError(f"bits must be 2, 3, or 4, got {self.bits}")

        self.compressed_elem_size = self.packed_dim + 4

        logger.info(
            "FusedTurboQuantImpl: layer initialized with %d-bit K%s compression, "
            "head_size=%d, packed_dim=%d, compressed_elem=%d bytes",
            self.bits, "+V" if self.compress_v else "-only",
            head_size, self.packed_dim, self.compressed_elem_size,
        )

    def _compress_and_write_to_cache(
        self,
        key_states: torch.Tensor,
        value_states: torch.Tensor,
        kv_cache: torch.Tensor,
        slot_mapping: torch.Tensor,
    ) -> None:
        """Compress K (and optionally V) and write to paged cache slots.

        Args:
            key_states: [num_tokens, num_kv_heads, head_size] float.
            value_states: [num_tokens, num_kv_heads, head_size] float.
            kv_cache: [2, num_blocks, block_size, num_kv_heads, elem_size] uint8.
            slot_mapping: [num_tokens] int — maps each token to a cache slot.
        """
        num_tokens = key_states.shape[0]
        block_size = kv_cache.shape[2]

        k_compressed = self.tq.encode(key_states.float())
        k_packed = k_compressed.indices  # [num_tokens, num_kv_heads, packed_dim]
        k_norms = k_compressed.norms     # [num_tokens, num_kv_heads]

        if self.compress_v:
            v_compressed = self.tq.encode(value_states.float())
            v_packed = v_compressed.indices
            v_norms = v_compressed.norms

        for i in range(num_tokens):
            slot = slot_mapping[i].item()
            if slot < 0:
                continue
            block_idx = slot // block_size
            offset = slot % block_size

            kv_cache[0, block_idx, offset, :, :self.packed_dim] = k_packed[i]
            k_norm_bytes = k_norms[i].contiguous().view(torch.uint8).reshape(
                self.num_kv_heads, 4,
            )
            kv_cache[0, block_idx, offset, :, self.packed_dim:] = k_norm_bytes

            if self.compress_v:
                kv_cache[1, block_idx, offset, :, :self.packed_dim] = v_packed[i]
                v_norm_bytes = v_norms[i].contiguous().view(torch.uint8).reshape(
                    self.num_kv_heads, 4,
                )
                kv_cache[1, block_idx, offset, :, self.packed_dim:] = v_norm_bytes
            else:
                v_bytes = value_states[i].contiguous().half().view(torch.uint8)
                v_bytes = v_bytes.reshape(self.num_kv_heads, self.head_size * 2)
                kv_cache[1, block_idx, offset, :, :self.head_size * 2] = v_bytes

    def _gather_compressed_k(
        self,
        kv_cache: torch.Tensor,
        block_tables: torch.Tensor,
        seq_lens_tensor: torch.Tensor,
        max_seq_len: int,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """Gather compressed K vectors from paged cache for a decode batch."""
        return gather_compressed_kv_batched(
            kv_cache, block_tables, seq_lens_tensor,
            kv_type=0, packed_dim=self.packed_dim,
            max_seq_len=max_seq_len,
        )

    def _gather_and_decode_v(
        self,
        kv_cache: torch.Tensor,
        block_tables: torch.Tensor,
        seq_lens_tensor: torch.Tensor,
        max_seq_len: int,
    ) -> torch.Tensor:
        """Gather compressed V from paged cache, decompress, return dense."""
        v_packed, v_norms = gather_compressed_kv_batched(
            kv_cache, block_tables, seq_lens_tensor,
            kv_type=1, packed_dim=self.packed_dim,
            max_seq_len=max_seq_len,
        )

        ct = CompressedTensor(
            indices=v_packed,
            norms=v_norms,
            original_dim=self.head_size,
            bits=self.bits,
        )
        decoded_v = self.tq.decode(ct)
        return decoded_v

    def _repeat_kv(self, x: torch.Tensor) -> torch.Tensor:
        """Expand KV heads for GQA: [b, kv_heads, s, d] -> [b, q_heads, s, d]."""
        if self.num_kv_groups == 1:
            return x
        b, h, s, d = x.shape
        x = x[:, :, None, :, :].expand(b, h, self.num_kv_groups, s, d)
        return x.reshape(b, h * self.num_kv_groups, s, d)

    def forward(
        self,
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
        kv_cache: Optional[torch.Tensor],
        attn_metadata: Any,
        k_scale: float = 1.0,
        v_scale: float = 1.0,
        attn_type: Any = None,
        output: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Run attention with compressed KV cache.

        vLLM calls this with packed/flattened token dimensions:
            query:  [num_tokens, num_heads * head_size]
            key:    [num_tokens, num_kv_heads * head_size]
            value:  [num_tokens, num_kv_heads * head_size]

        The method handles both prefill and decode phases based on attn_metadata.
        """
        num_tokens = query.shape[0]
        query = query.view(num_tokens, self.num_heads, self.head_size)
        key = key.view(num_tokens, self.num_kv_heads, self.head_size)
        value = value.view(num_tokens, self.num_kv_heads, self.head_size)

        if kv_cache is not None and attn_metadata.slot_mapping is not None:
            self._compress_and_write_to_cache(
                key, value, kv_cache, attn_metadata.slot_mapping,
            )

        num_prefill = getattr(attn_metadata, "num_prefill_tokens", 0)
        num_decode = getattr(attn_metadata, "num_decode_tokens", 0)

        if num_prefill > 0 and num_decode > 0:
            prefill_out = self._forward_prefill(
                query[:num_prefill],
                key[:num_prefill],
                value[:num_prefill],
                attn_metadata,
            )
            decode_out = self._forward_decode(
                query[num_prefill:],
                kv_cache,
                attn_metadata,
            )
            attn_output = torch.cat([prefill_out, decode_out], dim=0)
        elif num_prefill > 0:
            attn_output = self._forward_prefill(
                query, key, value, attn_metadata,
            )
        elif num_decode > 0:
            attn_output = self._forward_decode(
                query, kv_cache, attn_metadata,
            )
        else:
            attn_output = self._forward_prefill(
                query, key, value, attn_metadata,
            )

        return attn_output.view(num_tokens, self.num_heads * self.head_size)

    def _forward_prefill(
        self,
        query: torch.Tensor,
        key: torch.Tensor,
        value: torch.Tensor,
        attn_metadata: Any,
    ) -> torch.Tensor:
        """Prefill: use SDPA on full-precision Q, K, V.

        KV are already compressed and written to the paged cache in forward().
        Here we just compute attention output using the original fp16 values.
        """
        seq_lens = getattr(attn_metadata, "seq_lens", None)

        if seq_lens is not None and len(seq_lens) == 1:
            q = query.unsqueeze(0).transpose(1, 2)
            k = key.unsqueeze(0).transpose(1, 2)
            v = value.unsqueeze(0).transpose(1, 2)

            k = self._repeat_kv(k)
            v = self._repeat_kv(v)

            out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
            return out.transpose(1, 2).squeeze(0)

        if seq_lens is not None:
            outputs = []
            offset = 0
            for slen in seq_lens:
                q_s = query[offset:offset + slen].unsqueeze(0).transpose(1, 2)
                k_s = key[offset:offset + slen].unsqueeze(0).transpose(1, 2)
                v_s = value[offset:offset + slen].unsqueeze(0).transpose(1, 2)

                k_s = self._repeat_kv(k_s)
                v_s = self._repeat_kv(v_s)

                out_s = F.scaled_dot_product_attention(q_s, k_s, v_s, is_causal=True)
                outputs.append(out_s.transpose(1, 2).squeeze(0))
                offset += slen
            return torch.cat(outputs, dim=0)

        q = query.unsqueeze(0).transpose(1, 2)
        k = key.unsqueeze(0).transpose(1, 2)
        v = value.unsqueeze(0).transpose(1, 2)
        k = self._repeat_kv(k)
        v = self._repeat_kv(v)
        out = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return out.transpose(1, 2).squeeze(0)

    def _forward_decode(
        self,
        query: torch.Tensor,
        kv_cache: torch.Tensor,
        attn_metadata: Any,
    ) -> torch.Tensor:
        """Decode: fused attention from compressed KV cache.

        Steps:
            1. Gather compressed K from paged blocks
            2. RHT-rotate query
            3. Fused QK scores from packed indices
            4. Softmax
            5. Gather + decompress V
            6. attn_weights @ V
        """
        from quantization.fused_turboquant_vendored.kernels.triton_attention import fused_qk_scores_rht

        batch_size = query.shape[0]  # decode: 1 token per sequence
        block_tables = attn_metadata.block_tables
        seq_lens_tensor = attn_metadata.seq_lens_tensor
        max_seq_len = attn_metadata.max_decode_seq_len

        if seq_lens_tensor is None and hasattr(attn_metadata, "seq_lens"):
            seq_lens_tensor = torch.tensor(
                attn_metadata.seq_lens, dtype=torch.int32,
                device=query.device,
            )

        k_packed, k_norms = self._gather_compressed_k(
            kv_cache, block_tables, seq_lens_tensor, max_seq_len,
        )

        q_flat = query.float().reshape(-1, self.head_size)
        q_rot = randomized_hadamard(q_flat, self.rht_signs)
        q_rot = q_rot.view(batch_size, self.num_heads, 1, self.head_size)

        attn_scores = fused_qk_scores_rht(
            q_rot,
            k_packed,
            k_norms,
            self.centroids,
            self.scale,
            bits=self.bits,
        )

        for i in range(batch_size):
            slen = seq_lens_tensor[i].item()
            if slen < max_seq_len:
                attn_scores[i, :, :, slen:] = float("-inf")

        attn_weights = F.softmax(attn_scores, dim=-1, dtype=torch.float32)
        attn_weights = attn_weights.to(query.dtype)

        if self.compress_v:
            decoded_v = self._gather_and_decode_v(
                kv_cache, block_tables, seq_lens_tensor, max_seq_len,
            )
            decoded_v = decoded_v.to(query.dtype)
        else:
            decoded_v = self._gather_uncompressed_v(
                kv_cache, block_tables, seq_lens_tensor, max_seq_len,
            )

        v_expanded = self._repeat_kv(decoded_v)
        attn_output = torch.matmul(attn_weights, v_expanded)
        return attn_output.squeeze(2)

    def _gather_uncompressed_v(
        self,
        kv_cache: torch.Tensor,
        block_tables: torch.Tensor,
        seq_lens_tensor: torch.Tensor,
        max_seq_len: int,
    ) -> torch.Tensor:
        """Gather uncompressed fp16 V from paged cache (when compress_v=False)."""
        batch_size = block_tables.shape[0]
        block_size = kv_cache.shape[2]
        device = kv_cache.device

        out = torch.zeros(
            batch_size, self.num_kv_heads, max_seq_len, self.head_size,
            dtype=torch.float16, device=device,
        )

        for b in range(batch_size):
            slen = seq_lens_tensor[b].item()
            for pos in range(slen):
                block_idx = block_tables[b, pos // block_size].item()
                offset = pos % block_size
                v_bytes = kv_cache[1, block_idx, offset, :, :self.head_size * 2]
                v_fp16 = v_bytes.contiguous().view(torch.float16).reshape(
                    self.num_kv_heads, self.head_size,
                )
                out[b, :, pos, :] = v_fp16

        return out
