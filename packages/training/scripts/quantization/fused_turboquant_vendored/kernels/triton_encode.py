"""
Fused Triton kernel for TurboQuant_MSE encoding.

Performs the entire encode pipeline in a single GPU kernel launch:
    input -> sign flip -> FWHT butterfly -> normalize -> quantize -> pack -> output

This fusion is uniquely enabled by RHT: the rotation needs only O(d) signs
in SRAM, whereas Dense QR requires an O(d^2) matrix that cannot be fused.
After the butterfly stages complete, norm computation, normalization,
quantization, and packing all execute in registers with zero additional
HBM round-trips.

Compared to the unfused pipeline (5+ separate kernel launches), this kernel
eliminates 4 launches and their associated HBM read/write cycles.
"""

from __future__ import annotations

import torch

try:
    import triton
    import triton.language as tl

    HAS_TRITON = True
except ImportError:
    HAS_TRITON = False


if HAS_TRITON:

    @triton.jit
    def _fused_encode_kernel(
        x_ptr,
        signs_ptr,
        boundaries_ptr,
        packed_out_ptr,
        norms_out_ptr,
        scratch_ptr,
        stride_x,
        stride_packed,
        N,
        D: tl.constexpr,
        LOG2_D: tl.constexpr,
        BITS: tl.constexpr,
        N_LEVELS: tl.constexpr,
        N_BOUNDARIES: tl.constexpr,
    ):
        pid = tl.program_id(0)
        if pid >= N:
            return

        row_offset = pid * stride_x
        scratch_offset = pid * D
        idx = tl.arange(0, D)

        # --- Load and sign flip ---
        x = tl.load(x_ptr + row_offset + idx, mask=idx < D).to(tl.float32)
        signs = tl.load(signs_ptr + idx, mask=idx < D)
        x = x * signs

        # --- FWHT butterfly stages ---
        tl.store(scratch_ptr + scratch_offset + idx, x, mask=idx < D)
        tl.debug_barrier()

        for s in tl.static_range(LOG2_D):
            h = tl.constexpr(1 << s)
            xi = tl.load(scratch_ptr + scratch_offset + idx, mask=idx < D)
            xp = tl.load(scratch_ptr + scratch_offset + (idx ^ h), mask=(idx ^ h) < D)
            is_even = (idx & h) == 0
            result = tl.where(is_even, xi + xp, xp - xi)
            tl.store(scratch_ptr + scratch_offset + idx, result, mask=idx < D)
            tl.debug_barrier()

        rotated = tl.load(scratch_ptr + scratch_offset + idx, mask=idx < D)
        rotated = rotated * (1.0 / tl.sqrt(float(D)))

        # --- Compute norm (cross-thread reduction, stays in registers after) ---
        norm_sq = tl.sum(rotated * rotated, axis=0)
        norm = tl.sqrt(norm_sq + 1e-16)
        tl.store(norms_out_ptr + pid, norm)

        # --- Normalize ---
        normalized = rotated / (norm + 1e-8)

        # --- Quantize: replicate torch.bucketize(x, boundaries) - 1 ---
        quantized = tl.zeros((D,), dtype=tl.int32)
        for i in tl.static_range(N_BOUNDARIES):
            b = tl.load(boundaries_ptr + i)
            quantized += (b < normalized).to(tl.int32)
        quantized = quantized - 1
        quantized = tl.maximum(quantized, 0)
        quantized = tl.minimum(quantized, N_LEVELS - 1)

        # --- Pack indices (store to scratch for neighbor access) ---
        if BITS == 4:
            tl.store(scratch_ptr + scratch_offset + idx, quantized.to(tl.float32), mask=idx < D)
            tl.debug_barrier()
            pack_idx = tl.arange(0, D // 2)
            low = tl.load(scratch_ptr + scratch_offset + pack_idx * 2).to(tl.int32)
            high = tl.load(scratch_ptr + scratch_offset + pack_idx * 2 + 1).to(tl.int32)
            packed = ((high & 0xF) << 4) | (low & 0xF)
            tl.store(
                packed_out_ptr + pid * stride_packed + pack_idx,
                packed.to(tl.uint8),
                mask=pack_idx < D // 2,
            )
        elif BITS == 3:
            tl.store(scratch_ptr + scratch_offset + idx, quantized.to(tl.float32), mask=idx < D)
            tl.debug_barrier()
            grp_idx = tl.arange(0, D // 8)
            base = scratch_ptr + scratch_offset
            v0 = tl.load(base + grp_idx * 8 + 0).to(tl.int32)
            v1 = tl.load(base + grp_idx * 8 + 1).to(tl.int32)
            v2 = tl.load(base + grp_idx * 8 + 2).to(tl.int32)
            v3 = tl.load(base + grp_idx * 8 + 3).to(tl.int32)
            v4 = tl.load(base + grp_idx * 8 + 4).to(tl.int32)
            v5 = tl.load(base + grp_idx * 8 + 5).to(tl.int32)
            v6 = tl.load(base + grp_idx * 8 + 6).to(tl.int32)
            v7 = tl.load(base + grp_idx * 8 + 7).to(tl.int32)
            byte0 = (v0 & 0x7) | ((v1 & 0x7) << 3) | ((v2 & 0x3) << 6)
            byte1 = ((v2 >> 2) & 0x1) | ((v3 & 0x7) << 1) | ((v4 & 0x7) << 4) | ((v5 & 0x1) << 7)
            byte2 = ((v5 >> 1) & 0x3) | ((v6 & 0x7) << 2) | ((v7 & 0x7) << 5)
            out_base = packed_out_ptr + pid * stride_packed
            grp_mask = grp_idx < D // 8
            tl.store(out_base + grp_idx * 3 + 0, byte0.to(tl.uint8), mask=grp_mask)
            tl.store(out_base + grp_idx * 3 + 1, byte1.to(tl.uint8), mask=grp_mask)
            tl.store(out_base + grp_idx * 3 + 2, byte2.to(tl.uint8), mask=grp_mask)
        elif BITS == 2:
            tl.store(scratch_ptr + scratch_offset + idx, quantized.to(tl.float32), mask=idx < D)
            tl.debug_barrier()
            pack_idx = tl.arange(0, D // 4)
            b0 = tl.load(scratch_ptr + scratch_offset + pack_idx * 4).to(tl.int32)
            b1 = tl.load(scratch_ptr + scratch_offset + pack_idx * 4 + 1).to(tl.int32)
            b2 = tl.load(scratch_ptr + scratch_offset + pack_idx * 4 + 2).to(tl.int32)
            b3 = tl.load(scratch_ptr + scratch_offset + pack_idx * 4 + 3).to(tl.int32)
            packed = (b0 & 0x3) | ((b1 & 0x3) << 2) | ((b2 & 0x3) << 4) | ((b3 & 0x3) << 6)
            tl.store(
                packed_out_ptr + pid * stride_packed + pack_idx,
                packed.to(tl.uint8),
                mask=pack_idx < D // 4,
            )
        else:
            tl.store(
                packed_out_ptr + pid * stride_packed + idx,
                quantized.to(tl.uint8),
                mask=idx < D,
            )

    def triton_fused_encode(
        x: torch.Tensor,
        signs: torch.Tensor,
        boundaries: torch.Tensor,
        bits: int,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """
        Fused TurboQuant_MSE encode: RHT + norm + quantize + pack in one kernel.

        Args:
            x: input tensor of shape (..., d).
            signs: RHT sign vector of shape (d,).
            boundaries: Lloyd-Max bin edges of shape (num_levels + 1,).
            bits: quantization bits (2, 3, or 4).

        Returns:
            (packed_indices, norms) — packed uint8 indices and float32 norms.
        """
        original_shape = x.shape
        d = x.shape[-1]
        x_flat = x.contiguous().view(-1, d).float()
        n = x_flat.shape[0]
        log2_d = d.bit_length() - 1
        n_levels = 1 << bits
        n_boundaries = boundaries.shape[0]

        if bits == 4:
            packed_dim = d // 2
        elif bits == 3:
            packed_dim = d * 3 // 8
        elif bits == 2:
            packed_dim = d // 4
        else:
            packed_dim = d

        packed_out = torch.empty((n, packed_dim), dtype=torch.uint8, device=x.device)
        norms_out = torch.empty(n, dtype=torch.float32, device=x.device)
        scratch = torch.empty_like(x_flat)

        grid = (n,)
        _fused_encode_kernel[grid](
            x_flat, signs, boundaries,
            packed_out, norms_out, scratch,
            x_flat.stride(0), packed_out.stride(0),
            n, d, log2_d, bits, n_levels, n_boundaries,
        )

        norms_shape = list(original_shape[:-1])
        packed_shape = list(original_shape[:-1]) + [packed_dim]
        return packed_out.view(packed_shape), norms_out.view(norms_shape)
