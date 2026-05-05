"""
Block-level cache operations for compressed KV cache in vLLM's paged system.

Our compressed blocks are stored as uint8 tensors with layout:
    [num_blocks, block_size, num_kv_heads, compressed_elem_size]

where compressed_elem_size = packed_dim + 4 (packed indices + fp32 norm).

Since blocks are just byte arrays, swap and copy are dtype-agnostic memcpy
operations — no decompression needed.
"""

from __future__ import annotations

from typing import List, Tuple

import torch


def compressed_swap_blocks(
    src: torch.Tensor,
    dst: torch.Tensor,
    src_to_dst: torch.Tensor,
) -> None:
    """Swap blocks between GPU and CPU (or GPU-GPU) for compressed KV cache.

    Used by vLLM's block manager to offload/reload KV cache blocks during
    memory pressure. Since our blocks are raw uint8 bytes, this is a
    straightforward indexed copy.

    Args:
        src: Source KV cache tensor [num_blocks, block_size, num_kv_heads, elem_size].
        dst: Destination KV cache tensor (same layout, possibly different device).
        src_to_dst: int tensor of shape [N, 2] mapping src block ids to dst block ids.
    """
    for pair in src_to_dst:
        src_idx = pair[0].item()
        dst_idx = pair[1].item()
        dst[dst_idx].copy_(src[src_idx])


def compressed_copy_blocks(
    kv_caches: List[torch.Tensor],
    src_to_dsts: torch.Tensor,
) -> None:
    """Copy blocks within GPU for beam search / prefix caching.

    Copies source blocks to one or more destination blocks across all layers.
    Used when beam search forks a sequence or when prefix caching shares blocks.

    Args:
        kv_caches: List of KV cache tensors, one per layer. Each tensor has
            shape [2, num_blocks, block_size, num_kv_heads, elem_size] where
            the first dim separates K (index 0) and V (index 1).
        src_to_dsts: int tensor of shape [N, 2] mapping src block ids to dst block ids.
    """
    for pair in src_to_dsts:
        src_idx = pair[0].item()
        dst_idx = pair[1].item()
        for kv_cache in kv_caches:
            kv_cache[:, dst_idx].copy_(kv_cache[:, src_idx])


def compute_compressed_elem_size(head_dim: int, bits: int) -> int:
    """Compute the number of uint8 bytes per KV position per head.

    Layout: [packed_indices ... | fp32_norm (4 bytes)]

    For head_dim=128:
        4-bit: 64 + 4 = 68 bytes  (3.76x vs 256B fp16)
        3-bit: 48 + 4 = 52 bytes  (4.92x vs 256B fp16)
        2-bit: 32 + 4 = 36 bytes  (7.11x vs 256B fp16)
    """
    if bits == 4:
        packed_dim = head_dim // 2
    elif bits == 3:
        packed_dim = head_dim * 3 // 8
    elif bits == 2:
        packed_dim = head_dim // 4
    else:
        raise ValueError(f"Unsupported bits={bits}, must be 2, 3, or 4")
    return packed_dim + 4  # +4 for fp32 norm


def write_compressed_to_slot(
    kv_cache: torch.Tensor,
    packed_indices: torch.Tensor,
    norms: torch.Tensor,
    slot_idx: int,
    kv_type: int,
) -> None:
    """Write one compressed KV vector into a paged cache slot.

    Args:
        kv_cache: [2, num_blocks, block_size, num_kv_heads, elem_size] uint8.
        packed_indices: [num_kv_heads, packed_dim] uint8.
        norms: [num_kv_heads] float32.
        slot_idx: linear slot index (block_idx * block_size + offset).
        kv_type: 0 for K, 1 for V.
    """
    block_size = kv_cache.shape[2]
    block_idx = slot_idx // block_size
    offset = slot_idx % block_size

    packed_dim = packed_indices.shape[-1]
    kv_cache[kv_type, block_idx, offset, :, :packed_dim] = packed_indices
    norm_bytes = norms.to(torch.float32).contiguous().view(torch.uint8).reshape(-1, 4)
    kv_cache[kv_type, block_idx, offset, :, packed_dim:packed_dim + 4] = norm_bytes


def read_compressed_from_blocks(
    kv_cache: torch.Tensor,
    block_table: torch.Tensor,
    seq_len: int,
    kv_type: int,
    packed_dim: int,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Gather compressed KV vectors from paged blocks for one sequence.

    Args:
        kv_cache: [2, num_blocks, block_size, num_kv_heads, elem_size] uint8.
        block_table: [max_blocks] int — physical block indices for this sequence.
        seq_len: number of valid KV positions.
        kv_type: 0 for K, 1 for V.
        packed_dim: number of packed index bytes per head.

    Returns:
        (packed_indices, norms):
            packed_indices: [num_kv_heads, seq_len, packed_dim] uint8
            norms: [num_kv_heads, seq_len] float32
    """
    block_size = kv_cache.shape[2]

    all_packed = []
    all_norms = []

    for pos in range(seq_len):
        block_idx = block_table[pos // block_size].item()
        offset = pos % block_size
        slot_data = kv_cache[kv_type, block_idx, offset]  # [num_kv_heads, elem_size]
        all_packed.append(slot_data[:, :packed_dim])
        norm_bytes = slot_data[:, packed_dim:packed_dim + 4]
        norm_f32 = norm_bytes.contiguous().view(torch.float32)
        all_norms.append(norm_f32.squeeze(-1))

    packed_indices = torch.stack(all_packed, dim=1)  # [num_kv_heads, seq_len, packed_dim]
    norms = torch.stack(all_norms, dim=1)  # [num_kv_heads, seq_len]
    return packed_indices, norms


def gather_compressed_kv_batched(
    kv_cache: torch.Tensor,
    block_tables: torch.Tensor,
    seq_lens: torch.Tensor,
    kv_type: int,
    packed_dim: int,
    max_seq_len: int,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Vectorized gather of compressed KV for a batch of sequences.

    Args:
        kv_cache: [2, num_blocks, block_size, num_kv_heads, elem_size] uint8.
        block_tables: [batch_size, max_blocks_per_seq] int.
        seq_lens: [batch_size] int — actual sequence lengths.
        kv_type: 0 for K, 1 for V.
        packed_dim: bytes of packed indices per head.
        max_seq_len: maximum sequence length in this batch.

    Returns:
        (packed_indices, norms):
            packed_indices: [batch, num_kv_heads, max_seq_len, packed_dim] uint8
            norms: [batch, num_kv_heads, max_seq_len] float32
    """
    batch_size = block_tables.shape[0]
    block_size = kv_cache.shape[2]
    num_kv_heads = kv_cache.shape[3]
    device = kv_cache.device

    out_packed = torch.zeros(
        batch_size, num_kv_heads, max_seq_len, packed_dim,
        dtype=torch.uint8, device=device,
    )
    out_norms = torch.zeros(
        batch_size, num_kv_heads, max_seq_len,
        dtype=torch.float32, device=device,
    )

    for b in range(batch_size):
        slen = seq_lens[b].item()
        for pos in range(slen):
            block_idx = block_tables[b, pos // block_size].item()
            offset = pos % block_size
            slot_data = kv_cache[kv_type, block_idx, offset]
            out_packed[b, :, pos, :] = slot_data[:, :packed_dim]
            norm_bytes = slot_data[:, packed_dim:packed_dim + 4]
            out_norms[b, :, pos] = norm_bytes.contiguous().view(
                torch.float32
            ).squeeze(-1)

    return out_packed, out_norms
