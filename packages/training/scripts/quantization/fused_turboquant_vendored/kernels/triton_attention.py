"""
Fused Triton kernel for quantized attention scores with RHT.

Instead of: dequantize keys to fp16 -> Q @ K^T  (loads fp16 keys from HBM)
We do:      RHT(Q) -> gather(centroids, packed_key_indices) * norms  (loads packed uint8)

Key math identity (since RHT is orthogonal):
    <q, RHT_inv(centroids[idx])> = <RHT(q), centroids[idx]>

So pre-rotate the query once with a single RHT call (O(d log d)),
then per-KV-position work is just: score[s] = norm[s] * sum_d(q_rot[d] * C[idx[s,d]]) * scale

Keys are stored in packed form (nibble-packed for 4-bit, bitstream-packed for 3-bit,
2-bit packed for 2-bit) and unpacked inline in the kernel. For 3-bit, 8 indices are
packed into 3 bytes via bitstream encoding and extracted with a two-byte load +
shift+mask. This gives true 3-bit density (48 bytes for head_dim=128 vs 64 for 4-bit).

Compared to Dejan.ai's fused kernel which uses Dense QR for query rotation (O(d^2)),
ours uses the Triton fused RHT kernel for query rotation (O(d log d)).
"""

from __future__ import annotations

import torch

try:
    import triton
    import triton.language as tl
    HAS_TRITON = True
except ImportError:
    HAS_TRITON = False


def _fused_qk_scores_rht_pytorch(
    q_rotated: torch.Tensor,
    key_indices: torch.Tensor,
    key_norms: torch.Tensor,
    centroids: torch.Tensor,
    scale: float,
    bits: int,
) -> torch.Tensor:
    """Pure-PyTorch fallback for ``fused_qk_scores_rht``.

    Mathematically equivalent to the Triton kernel: unpack the compressed
    key indices, look up centroids, multiply by per-vector norms, then
    matmul with the pre-rotated query. Used when Triton's JIT can't run
    on the host (e.g. missing ``Python.h``) or when
    ``FUSED_TURBOQUANT_DISABLE_TRITON=1`` is set.

    Returns: attention scores ``[batch, n_q_heads, q_len, kv_len]``.
    """
    from quantization.fused_turboquant_vendored.core.packing import (
        unpack_2bit,
        unpack_3bit,
        unpack_nibbles,
    )

    batch, n_q_heads, q_len, head_dim = q_rotated.shape
    _, n_kv_heads, kv_len, _ = key_indices.shape

    if bits == 4:
        k_idx = unpack_nibbles(key_indices, head_dim)
    elif bits == 3:
        k_idx = unpack_3bit(key_indices, head_dim)
    elif bits == 2:
        k_idx = unpack_2bit(key_indices, head_dim)
    else:
        k_idx = key_indices

    # k_idx: [batch, n_kv_heads, kv_len, head_dim] uint8 → centroid lookup
    centroids_f = centroids.to(torch.float32).contiguous()
    k_recon = centroids_f[k_idx.long()]  # [batch, n_kv_heads, kv_len, head_dim]
    k_recon = k_recon * key_norms.to(torch.float32).unsqueeze(-1)

    # GQA: replicate KV heads to match Q heads.
    if n_q_heads != n_kv_heads:
        gqa = n_q_heads // n_kv_heads
        k_recon = k_recon.repeat_interleave(gqa, dim=1)

    q_f = q_rotated.to(torch.float32)
    # scores: [batch, n_q_heads, q_len, kv_len]
    scores = torch.matmul(q_f, k_recon.transpose(-1, -2)) * scale
    return scores

if HAS_TRITON:

    @triton.autotune(
        configs=[
            triton.Config({"BLOCK_S": 32, "BLOCK_D": 64}, num_warps=4),
            triton.Config({"BLOCK_S": 64, "BLOCK_D": 64}, num_warps=4),
            triton.Config({"BLOCK_S": 128, "BLOCK_D": 64}, num_warps=8),
            triton.Config({"BLOCK_S": 64, "BLOCK_D": 128}, num_warps=4),
            triton.Config({"BLOCK_S": 128, "BLOCK_D": 128}, num_warps=8),
        ],
        key=["head_dim"],
    )
    @triton.jit
    def _fused_qk_scores_kernel(
        Q_ptr,          # pre-rotated query: [BH_q, head_dim]
        K_idx_ptr,      # packed key indices: [BH_kv, seq_len, packed_dim] uint8
        K_norms_ptr,    # key norms: [BH_kv, seq_len] float32
        C_ptr,          # centroid table: [n_levels] float32
        Out_ptr,        # output scores: [BH_q, seq_len] float32
        seq_len,
        head_dim: tl.constexpr,
        n_q_heads,
        n_kv_heads,
        scale,
        stride_q_bh, stride_q_d,
        stride_ki_bh, stride_ki_s, stride_ki_d,
        stride_kn_bh, stride_kn_s,
        stride_o_bh, stride_o_s,
        BITS: tl.constexpr,
        BLOCK_S: tl.constexpr,
        BLOCK_D: tl.constexpr,
    ):
        pid_bh = tl.program_id(0)
        pid_s = tl.program_id(1)

        batch_idx = pid_bh // n_q_heads
        q_head_idx = pid_bh % n_q_heads
        gqa_ratio = n_q_heads // n_kv_heads
        kv_head_idx = q_head_idx // gqa_ratio
        kv_bh = batch_idx * n_kv_heads + kv_head_idx

        s_offs = pid_s * BLOCK_S + tl.arange(0, BLOCK_S)
        s_mask = s_offs < seq_len

        acc = tl.zeros((BLOCK_S,), dtype=tl.float32)

        for d_start in range(0, head_dim, BLOCK_D):
            d_offs = d_start + tl.arange(0, BLOCK_D)
            d_mask = d_offs < head_dim

            q_ptrs = Q_ptr + pid_bh * stride_q_bh + d_offs * stride_q_d
            q_vals = tl.load(q_ptrs, mask=d_mask, other=0.0).to(tl.float32)

            if BITS == 4:
                pack_d = d_offs // 2
                ki_ptrs = (K_idx_ptr
                           + kv_bh * stride_ki_bh
                           + s_offs[:, None] * stride_ki_s
                           + pack_d[None, :] * stride_ki_d)
                combined_mask = s_mask[:, None] & d_mask[None, :]
                packed_val = tl.load(ki_ptrs, mask=combined_mask, other=0).to(tl.int32)
                is_low = (d_offs % 2) == 0
                k_idx = tl.where(is_low[None, :], packed_val & 0xF, (packed_val >> 4) & 0xF)
            elif BITS == 3:
                bit_off = d_offs * 3
                byte_idx = bit_off >> 3
                bit_shift = bit_off & 7
                packed_total = head_dim * 3 // 8
                combined_mask = s_mask[:, None] & d_mask[None, :]
                ki_base = K_idx_ptr + kv_bh * stride_ki_bh
                b0_ptrs = (ki_base
                           + s_offs[:, None] * stride_ki_s
                           + byte_idx[None, :] * stride_ki_d)
                b1_ptrs = (ki_base
                           + s_offs[:, None] * stride_ki_s
                           + (byte_idx + 1)[None, :] * stride_ki_d)
                b0 = tl.load(b0_ptrs, mask=combined_mask, other=0).to(tl.int32)
                b1_valid = (byte_idx + 1) < packed_total
                b1 = tl.load(
                    b1_ptrs,
                    mask=combined_mask & b1_valid[None, :],
                    other=0,
                ).to(tl.int32)
                k_idx = ((b0 | (b1 << 8)) >> bit_shift[None, :]) & 0x7
            elif BITS == 2:
                pack_d = d_offs // 4
                ki_ptrs = (K_idx_ptr
                           + kv_bh * stride_ki_bh
                           + s_offs[:, None] * stride_ki_s
                           + pack_d[None, :] * stride_ki_d)
                combined_mask = s_mask[:, None] & d_mask[None, :]
                packed_val = tl.load(ki_ptrs, mask=combined_mask, other=0).to(tl.int32)
                shift = (d_offs % 4) * 2
                k_idx = (packed_val >> shift[None, :]) & 0x3
            else:
                ki_ptrs = (K_idx_ptr
                           + kv_bh * stride_ki_bh
                           + s_offs[:, None] * stride_ki_s
                           + d_offs[None, :] * stride_ki_d)
                combined_mask = s_mask[:, None] & d_mask[None, :]
                k_idx = tl.load(ki_ptrs, mask=combined_mask, other=0).to(tl.int32)

            k_vals = tl.load(C_ptr + k_idx, mask=combined_mask, other=0.0).to(tl.float32)

            acc += tl.sum(k_vals * q_vals[None, :], axis=1)

        kn_ptrs = K_norms_ptr + kv_bh * stride_kn_bh + s_offs * stride_kn_s
        norms = tl.load(kn_ptrs, mask=s_mask, other=0.0).to(tl.float32)

        scores = norms * acc * scale

        o_ptrs = Out_ptr + pid_bh * stride_o_bh + s_offs * stride_o_s
        tl.store(o_ptrs, scores, mask=s_mask)


def fused_qk_scores_rht(
    q_rotated: torch.Tensor,     # [batch, n_q_heads, q_len, head_dim] pre-rotated via RHT
    key_indices: torch.Tensor,   # [batch, n_kv_heads, kv_len, packed_dim] uint8 (packed)
    key_norms: torch.Tensor,     # [batch, n_kv_heads, kv_len] float32
    centroids: torch.Tensor,     # [n_levels] float32
    scale: float,
    bits: int = 3,
) -> torch.Tensor:
    """
    Compute attention scores Q @ K^T directly from packed compressed keys.

    The query is pre-rotated via RHT (O(d log d)) instead of Dense QR matmul (O(d^2)).
    The kernel loads packed uint8 indices, unpacks inline (nibble for 4-bit,
    2-bit shift for 2-bit), and gathers from a small centroid table in L1 cache.

    Args:
        key_indices: packed uint8 indices. Last dim is packed_dim:
            4-bit: packed_dim = head_dim // 2
            3-bit: packed_dim = head_dim * 3 // 8  (bitstream packed)
            2-bit: packed_dim = head_dim // 4
        bits: quantization bit-width (2, 3, or 4).

    Returns: attention scores [batch, n_q_heads, q_len, kv_len]
    """
    import os
    if not HAS_TRITON or os.environ.get(
        "FUSED_TURBOQUANT_DISABLE_TRITON", "",
    ).lower() in ("1", "true", "yes"):
        return _fused_qk_scores_rht_pytorch(
            q_rotated, key_indices, key_norms, centroids, scale, bits,
        )

    batch, n_q_heads, q_len, head_dim = q_rotated.shape
    _, n_kv_heads, kv_len, packed_dim = key_indices.shape

    q_flat = q_rotated.reshape(batch * n_q_heads * q_len, head_dim).contiguous()
    ki_flat = key_indices.reshape(batch * n_kv_heads, kv_len, packed_dim).contiguous()
    kn_flat = key_norms.reshape(batch * n_kv_heads, kv_len).contiguous()
    centroids = centroids.contiguous().float()

    out = torch.empty(batch * n_q_heads * q_len, kv_len,
                      device=q_rotated.device, dtype=torch.float32)

    effective_q_heads = n_q_heads * q_len

    def grid(meta):
        return (batch * effective_q_heads, triton.cdiv(kv_len, meta["BLOCK_S"]))

    _fused_qk_scores_kernel[grid](
        q_flat, ki_flat, kn_flat, centroids, out,
        kv_len, head_dim,
        effective_q_heads, n_kv_heads,
        scale,
        q_flat.stride(0), q_flat.stride(1),
        ki_flat.stride(0), ki_flat.stride(1), ki_flat.stride(2),
        kn_flat.stride(0), kn_flat.stride(1),
        out.stride(0), out.stride(1),
        BITS=bits,
    )

    return out.reshape(batch, n_q_heads, q_len, kv_len)
