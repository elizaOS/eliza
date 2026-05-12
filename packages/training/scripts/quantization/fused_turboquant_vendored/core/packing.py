"""
Sub-byte packing utilities for quantization indices.

4-bit: pack 2 indices per uint8 byte  →  head_dim/2 bytes  (2x reduction)
3-bit: pack 8 indices per 3 bytes     →  head_dim*3/8 bytes (2.67x reduction)
2-bit: pack 4 indices per uint8 byte  →  head_dim/4 bytes  (4x reduction)
"""

from __future__ import annotations

import torch


def pack_nibbles(indices: torch.Tensor) -> torch.Tensor:
    """
    Pack 4-bit indices (0-15) into uint8 nibble pairs.

    Two consecutive indices along the last dim are packed into one byte:
    byte = (high_nibble << 4) | low_nibble

    Args:
        indices: uint8 tensor of shape (..., d) where d is even.

    Returns:
        Packed uint8 tensor of shape (..., d // 2).
    """
    assert indices.shape[-1] % 2 == 0, "Last dimension must be even for nibble packing"
    flat = indices.view(*indices.shape[:-1], -1, 2)
    low = flat[..., 0].to(torch.uint8)
    high = flat[..., 1].to(torch.uint8)
    return (high << 4) | low


def unpack_nibbles(packed: torch.Tensor, original_dim: int) -> torch.Tensor:
    """
    Unpack uint8 nibble pairs back to 4-bit indices.

    Args:
        packed: uint8 tensor of shape (..., d // 2).
        original_dim: the original last dimension d.

    Returns:
        uint8 tensor of shape (..., d) with values in [0, 15].
    """
    low = packed & 0x0F
    high = (packed >> 4) & 0x0F
    return torch.stack([low, high], dim=-1).view(*packed.shape[:-1], original_dim)


def pack_2bit(indices: torch.Tensor) -> torch.Tensor:
    """
    Pack 2-bit indices (0-3) into uint8 (4 indices per byte).

    Args:
        indices: uint8 tensor of shape (..., d) where d is divisible by 4.

    Returns:
        Packed uint8 tensor of shape (..., d // 4).
    """
    d = indices.shape[-1]
    assert d % 4 == 0, "Last dimension must be divisible by 4 for 2-bit packing"
    flat = indices.view(*indices.shape[:-1], -1, 4).to(torch.uint8)
    packed = flat[..., 0] | (flat[..., 1] << 2) | (flat[..., 2] << 4) | (flat[..., 3] << 6)
    return packed


def unpack_2bit(packed: torch.Tensor, original_dim: int) -> torch.Tensor:
    """
    Unpack uint8 back to 2-bit indices (4 indices per byte).

    Args:
        packed: uint8 tensor of shape (..., d // 4).
        original_dim: the original last dimension d.

    Returns:
        uint8 tensor of shape (..., d) with values in [0, 3].
    """
    b0 = packed & 0x03
    b1 = (packed >> 2) & 0x03
    b2 = (packed >> 4) & 0x03
    b3 = (packed >> 6) & 0x03
    return torch.stack([b0, b1, b2, b3], dim=-1).view(*packed.shape[:-1], original_dim)


def pack_3bit(indices: torch.Tensor) -> torch.Tensor:
    """
    Pack 3-bit indices (0-7) into a bitstream: 8 values per 3 bytes.

    Args:
        indices: uint8 tensor of shape (..., d) where d is divisible by 8.

    Returns:
        Packed uint8 tensor of shape (..., d * 3 // 8).
    """
    d = indices.shape[-1]
    assert d % 8 == 0, "Last dimension must be divisible by 8 for 3-bit packing"
    flat = indices.view(*indices.shape[:-1], -1, 8).to(torch.int32)
    v0, v1, v2, v3, v4, v5, v6, v7 = (flat[..., i] for i in range(8))
    byte0 = (v0 & 0x7) | ((v1 & 0x7) << 3) | ((v2 & 0x3) << 6)
    byte1 = ((v2 >> 2) & 0x1) | ((v3 & 0x7) << 1) | ((v4 & 0x7) << 4) | ((v5 & 0x1) << 7)
    byte2 = ((v5 >> 1) & 0x3) | ((v6 & 0x7) << 2) | ((v7 & 0x7) << 5)
    packed = torch.stack([byte0, byte1, byte2], dim=-1).to(torch.uint8)
    return packed.view(*indices.shape[:-1], d * 3 // 8)


def unpack_3bit(packed: torch.Tensor, original_dim: int) -> torch.Tensor:
    """
    Unpack bitstream back to 3-bit indices (8 values per 3 bytes).

    Args:
        packed: uint8 tensor of shape (..., d * 3 // 8).
        original_dim: the original last dimension d.

    Returns:
        uint8 tensor of shape (..., d) with values in [0, 7].
    """
    groups = packed.view(*packed.shape[:-1], -1, 3).to(torch.int32)
    b0, b1, b2 = groups[..., 0], groups[..., 1], groups[..., 2]
    v0 = b0 & 0x7
    v1 = (b0 >> 3) & 0x7
    v2 = ((b0 >> 6) | (b1 << 2)) & 0x7
    v3 = (b1 >> 1) & 0x7
    v4 = (b1 >> 4) & 0x7
    v5 = ((b1 >> 7) | (b2 << 1)) & 0x7
    v6 = (b2 >> 2) & 0x7
    v7 = (b2 >> 5) & 0x7
    unpacked = torch.stack([v0, v1, v2, v3, v4, v5, v6, v7], dim=-1).to(torch.uint8)
    return unpacked.view(*packed.shape[:-1], original_dim)
