"""
TurboQuant-compressed KV cache for HuggingFace transformers.

Patches a standard DynamicCache to transparently compress key/value tensors
on every cache.update() call. Works with any model that uses DynamicCache,
including Qwen3.5's hybrid attention layers.

Two integration strategies:
1. Full compression: store compressed, decompress on read (real memory savings)
2. Simulation: compress→decompress on write, store fp16 (accuracy testing only)
"""

from __future__ import annotations

from typing import Optional

import torch

from quantization.fused_turboquant_vendored.core.quantizer import CompressedTensor, TurboQuantMSE


class TurboQuantKVCache:
    """
    Drop-in KV cache with TurboQuant_MSE compression.

    Stores keys and values in compressed form (uint8 indices + fp32 norms)
    and decompresses on-the-fly when attention reads them.

    For active Qwen3.5 models, only full_attention layers use this cache.
    Linear attention (DeltaNet) layers have a different state representation
    and are not affected.

    Usage:
        cache = TurboQuantKVCache(head_dim=256, num_layers=8, bits=4, device="cuda")
        cache.update(key, value, layer_idx=0)
        k, v = cache.get(layer_idx=0)
    """

    def __init__(
        self,
        head_dim: int,
        num_layers: int,
        bits: int = 4,
        compress_values: bool = True,
        seed: int = 42,
        device: torch.device | str = "cpu",
    ):
        self.head_dim = head_dim
        self.num_layers = num_layers
        self.bits = bits
        self.compress_values = compress_values
        self.device = device

        self.key_quantizers: list[TurboQuantMSE] = []
        self.value_quantizers: list[TurboQuantMSE | None] = []

        for i in range(num_layers):
            self.key_quantizers.append(
                TurboQuantMSE(head_dim, bits=bits, seed=seed + i * 2, device=device)
            )
            if compress_values:
                self.value_quantizers.append(
                    TurboQuantMSE(head_dim, bits=bits, seed=seed + i * 2 + 1, device=device)
                )
            else:
                self.value_quantizers.append(None)

        self._key_cache: list[list[CompressedTensor]] = [[] for _ in range(num_layers)]
        self._value_cache: list[list[CompressedTensor] | list[torch.Tensor]] = [
            [] for _ in range(num_layers)
        ]

        self._key_fp_buffer: list[Optional[torch.Tensor]] = [None] * num_layers
        self._value_fp_buffer: list[Optional[torch.Tensor]] = [None] * num_layers

    def update(
        self,
        key: torch.Tensor,
        value: torch.Tensor,
        layer_idx: int,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Compress and store new key/value tensors, return decompressed versions
        for the current attention computation.

        Args:
            key: shape (batch, num_kv_heads, seq_len, head_dim)
            value: shape (batch, num_kv_heads, seq_len, head_dim)
            layer_idx: which layer this cache belongs to.

        Returns:
            (decompressed_key, decompressed_value) for attention computation.
        """
        compressed_key = self.key_quantizers[layer_idx].encode(key)
        self._key_cache[layer_idx].append(compressed_key)

        if self.compress_values and self.value_quantizers[layer_idx] is not None:
            compressed_value = self.value_quantizers[layer_idx].encode(value)
            self._value_cache[layer_idx].append(compressed_value)
        else:
            self._value_cache[layer_idx].append(value)

        self._key_fp_buffer[layer_idx] = None
        self._value_fp_buffer[layer_idx] = None

        return self._get_decompressed(layer_idx)

    def _get_decompressed(self, layer_idx: int) -> tuple[torch.Tensor, torch.Tensor]:
        """Decompress and concatenate all cached tensors for a layer."""
        key_parts = []
        for ct in self._key_cache[layer_idx]:
            key_parts.append(self.key_quantizers[layer_idx].decode(ct))
        keys = torch.cat(key_parts, dim=-2) if key_parts else None

        value_parts = []
        for item in self._value_cache[layer_idx]:
            if isinstance(item, CompressedTensor):
                value_parts.append(self.value_quantizers[layer_idx].decode(item))
            else:
                value_parts.append(item)
        values = torch.cat(value_parts, dim=-2) if value_parts else None

        return keys, values

    def get(self, layer_idx: int) -> tuple[Optional[torch.Tensor], Optional[torch.Tensor]]:
        """Get full decompressed KV cache for a layer."""
        if not self._key_cache[layer_idx]:
            return None, None
        return self._get_decompressed(layer_idx)

    @property
    def seq_length(self) -> int:
        """Current cached sequence length (from layer 0)."""
        if not self._key_cache[0]:
            return 0
        total = 0
        for ct in self._key_cache[0]:
            if ct.bits == 4:
                total += ct.indices.shape[-1] * 2
            elif ct.bits == 2:
                total += ct.indices.shape[-1] * 4
            else:
                total += ct.indices.shape[-1]
        return total // self.head_dim if self.head_dim > 0 else 0

    def memory_bytes(self) -> dict[str, int]:
        """Report compressed memory usage."""
        key_bytes = 0
        value_bytes = 0
        norm_bytes = 0

        for layer_cache in self._key_cache:
            for ct in layer_cache:
                key_bytes += ct.indices.numel()
                norm_bytes += ct.norms.numel() * 4

        for layer_cache in self._value_cache:
            for item in layer_cache:
                if isinstance(item, CompressedTensor):
                    value_bytes += item.indices.numel()
                    norm_bytes += item.norms.numel() * 4
                else:
                    value_bytes += item.numel() * item.element_size()

        return {
            "key_indices_bytes": key_bytes,
            "value_bytes": value_bytes,
            "norm_bytes": norm_bytes,
            "total_bytes": key_bytes + value_bytes + norm_bytes,
        }

    def reset(self) -> None:
        """Clear all cached data."""
        self._key_cache = [[] for _ in range(self.num_layers)]
        self._value_cache = [[] for _ in range(self.num_layers)]
        self._key_fp_buffer = [None] * self.num_layers
        self._value_fp_buffer = [None] * self.num_layers
