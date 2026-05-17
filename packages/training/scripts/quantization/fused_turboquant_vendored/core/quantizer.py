"""
TurboQuant_MSE encoder/decoder — the complete quantization pipeline.

Pipeline (unfused fallback):
    Encode: x -> RHT rotate -> normalize -> Lloyd-Max quantize -> pack nibbles
    Decode: unpack -> dequantize -> denormalize -> inverse RHT

Fused pipeline (Triton, automatic on CUDA):
    Encode: single kernel — RHT + norm + quantize + pack
    Decode: single kernel — unpack + dequant + denorm + inverse RHT

This is the drop-in variant (TurboQuant_MSE) that minimizes reconstruction
MSE and works with any existing attention kernel.
"""

from __future__ import annotations

from dataclasses import dataclass

import torch

from quantization.fused_turboquant_vendored.core.hadamard import (
    RHTRotation,
)
from quantization.fused_turboquant_vendored.core.lloyd_max import LloydMaxQuantizer
from quantization.fused_turboquant_vendored.core.packing import (
    pack_2bit,
    pack_3bit,
    pack_nibbles,
    unpack_2bit,
    unpack_3bit,
    unpack_nibbles,
)


@dataclass
class CompressedTensor:
    """Compressed representation of a tensor after TurboQuant encoding."""

    indices: torch.Tensor  # packed uint8 quantization indices
    norms: torch.Tensor  # fp32 vector norms (1 per vector)
    original_dim: int  # head_dim before packing
    bits: int  # quantization bit-width

    @property
    def compression_ratio(self) -> float:
        original_bytes = self.norms.numel() * self.original_dim * 2  # fp16
        compressed_bytes = self.indices.numel() + self.norms.numel() * 4
        if compressed_bytes == 0:
            return float("inf")
        return original_bytes / compressed_bytes


class TurboQuantMSE:
    """
    TurboQuant_MSE: full encode/decode pipeline with RHT rotation.

    This is the first open-source TurboQuant implementation using Randomized
    Hadamard Transform instead of dense QR rotation, achieving O(d log d)
    rotation cost and O(d) storage per layer.

    Usage:
        tq = TurboQuantMSE(head_dim=256, bits=4, device="cuda")
        compressed = tq.encode(key_vectors)   # (..., head_dim) → CompressedTensor
        decoded = tq.decode(compressed)       # CompressedTensor → (..., head_dim)
    """

    def __init__(
        self,
        head_dim: int,
        bits: int = 4,
        seed: int = 42,
        device: torch.device | str = "cpu",
    ):
        if head_dim < 1 or (head_dim & (head_dim - 1)) != 0:
            raise ValueError(f"head_dim must be a power of 2, got {head_dim}")
        if bits not in (2, 3, 4):
            raise ValueError(f"bits must be 2, 3, or 4, got {bits}")

        self.head_dim = head_dim
        self.bits = bits
        self.device = device

        self.rotation = RHTRotation(head_dim, seed=seed, device=device)
        self.quantizer = LloydMaxQuantizer(head_dim, bits=bits, device=device)

        self._use_fused_triton = False
        self._try_enable_fused_triton()

    def _try_enable_fused_triton(self) -> None:
        import os
        if os.environ.get("FUSED_TURBOQUANT_DISABLE_TRITON", "").lower() in (
            "1", "true", "yes",
        ):
            self._use_fused_triton = False
            return
        from quantization.fused_turboquant_vendored.kernels.triton_rht import is_triton_available
        if is_triton_available() and str(self.device).startswith("cuda"):
            self._use_fused_triton = True

    def encode(self, x: torch.Tensor) -> CompressedTensor:
        """
        Compress vectors using TurboQuant_MSE.

        On CUDA with Triton available, uses the fused kernel (single launch).
        Otherwise falls back to the multi-kernel PyTorch path.

        Args:
            x: tensor of shape (..., head_dim) in any float dtype.

        Returns:
            CompressedTensor with packed indices and norms.
        """
        if self._use_fused_triton and x.is_cuda:
            return self._encode_fused(x)
        return self._encode_unfused(x)

    def _encode_fused(self, x: torch.Tensor) -> CompressedTensor:
        from quantization.fused_turboquant_vendored.kernels.triton_encode import triton_fused_encode
        packed, norms = triton_fused_encode(
            x, self.rotation.signs,
            self.quantizer.boundaries,
            self.bits,
        )
        return CompressedTensor(
            indices=packed,
            norms=norms,
            original_dim=self.head_dim,
            bits=self.bits,
        )

    def _encode_unfused(self, x: torch.Tensor) -> CompressedTensor:
        x = x.float()
        rotated = self.rotation(x)

        norms = torch.norm(rotated, dim=-1, keepdim=True)
        normalized = rotated / (norms + 1e-8)

        indices = self.quantizer.quantize(normalized)

        if self.bits == 4:
            packed = pack_nibbles(indices)
        elif self.bits == 3:
            packed = pack_3bit(indices)
        elif self.bits == 2:
            packed = pack_2bit(indices)
        else:
            packed = indices

        return CompressedTensor(
            indices=packed,
            norms=norms.squeeze(-1).float(),
            original_dim=self.head_dim,
            bits=self.bits,
        )

    def decode(self, compressed: CompressedTensor) -> torch.Tensor:
        """
        Decompress vectors from TurboQuant_MSE representation.

        On CUDA with Triton available, uses the fused kernel (single launch).
        Otherwise falls back to the multi-kernel PyTorch path.

        Args:
            compressed: CompressedTensor from encode().

        Returns:
            Reconstructed tensor of shape (..., head_dim) in float32.
        """
        if self._use_fused_triton and compressed.indices.is_cuda:
            return self._decode_fused(compressed)
        return self._decode_unfused(compressed)

    def _decode_fused(self, compressed: CompressedTensor) -> torch.Tensor:
        from quantization.fused_turboquant_vendored.kernels.triton_decode import triton_fused_decode
        return triton_fused_decode(
            compressed.indices, compressed.norms,
            self.quantizer.levels, self.rotation.signs,
            compressed.bits, compressed.original_dim,
        )

    def _decode_unfused(self, compressed: CompressedTensor) -> torch.Tensor:
        if compressed.bits == 4:
            indices = unpack_nibbles(compressed.indices, compressed.original_dim)
        elif compressed.bits == 3:
            indices = unpack_3bit(compressed.indices, compressed.original_dim)
        elif compressed.bits == 2:
            indices = unpack_2bit(compressed.indices, compressed.original_dim)
        else:
            indices = compressed.indices

        reconstructed = self.quantizer.dequantize(indices)
        reconstructed = reconstructed * compressed.norms.unsqueeze(-1)
        decoded = self.rotation.inverse(reconstructed)

        return decoded

    def roundtrip(self, x: torch.Tensor) -> torch.Tensor:
        """Encode then decode — convenience for quality testing."""
        return self.decode(self.encode(x))

    def to(self, device: torch.device | str) -> "TurboQuantMSE":
        self.device = device
        self.rotation = self.rotation.to(device)
        self.quantizer = self.quantizer.to(device)
        self._try_enable_fused_triton()
        return self
