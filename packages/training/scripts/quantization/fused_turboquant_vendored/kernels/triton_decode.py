"""
Fused Triton kernel for TurboQuant_MSE decoding.

Performs the entire decode pipeline in a single GPU kernel launch:
    packed input -> unpack -> gather centroids -> denormalize -> inv FWHT -> sign flip -> output

The output buffer doubles as scratch for the butterfly stages, so no
separate scratch allocation is needed for decode.
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
    def _fused_decode_kernel(
        packed_ptr,
        norms_ptr,
        levels_ptr,
        signs_ptr,
        out_ptr,
        stride_packed,
        stride_out,
        N,
        D: tl.constexpr,
        LOG2_D: tl.constexpr,
        BITS: tl.constexpr,
        N_LEVELS: tl.constexpr,
    ):
        pid = tl.program_id(0)
        if pid >= N:
            return

        idx = tl.arange(0, D)
        row_offset = pid * stride_out

        # --- Unpack ---
        if BITS == 4:
            pack_idx = idx // 2
            is_low = (idx % 2) == 0
            packed_val = tl.load(packed_ptr + pid * stride_packed + pack_idx).to(tl.int32)
            unpacked = tl.where(is_low, packed_val & 0xF, (packed_val >> 4) & 0xF)
        elif BITS == 3:
            bit_off = idx * 3
            byte_idx = bit_off >> 3
            bit_shift = bit_off & 7
            packed_total = D * 3 // 8
            row_base = packed_ptr + pid * stride_packed
            b0 = tl.load(row_base + byte_idx, mask=idx < D, other=0).to(tl.int32)
            b1 = tl.load(
                row_base + byte_idx + 1,
                mask=(idx < D) & ((byte_idx + 1) < packed_total),
                other=0,
            ).to(tl.int32)
            unpacked = ((b0 | (b1 << 8)) >> bit_shift) & 0x7
        elif BITS == 2:
            pack_idx = idx // 4
            shift = (idx % 4) * 2
            packed_val = tl.load(packed_ptr + pid * stride_packed + pack_idx).to(tl.int32)
            unpacked = (packed_val >> shift) & 0x3
        else:
            unpacked = tl.load(packed_ptr + pid * stride_packed + idx, mask=idx < D).to(tl.int32)

        # --- Gather centroids ---
        centroid_vals = tl.load(levels_ptr + unpacked, mask=idx < D).to(tl.float32)

        # --- Denormalize ---
        norm = tl.load(norms_ptr + pid)
        denormalized = centroid_vals * norm

        # --- Inverse FWHT (butterfly stages using output as scratch) ---
        tl.store(out_ptr + row_offset + idx, denormalized, mask=idx < D)
        tl.debug_barrier()

        for s in tl.static_range(LOG2_D):
            h = tl.constexpr(1 << s)
            xi = tl.load(out_ptr + row_offset + idx, mask=idx < D)
            xp = tl.load(out_ptr + row_offset + (idx ^ h), mask=(idx ^ h) < D)
            is_even = (idx & h) == 0
            result = tl.where(is_even, xi + xp, xp - xi)
            tl.store(out_ptr + row_offset + idx, result, mask=idx < D)
            tl.debug_barrier()

        result = tl.load(out_ptr + row_offset + idx, mask=idx < D)
        result = result * (1.0 / tl.sqrt(float(D)))

        # --- Sign flip (inverse RHT) ---
        signs = tl.load(signs_ptr + idx, mask=idx < D)
        result = result * signs

        tl.store(out_ptr + row_offset + idx, result, mask=idx < D)

    def triton_fused_decode(
        packed_indices: torch.Tensor,
        norms: torch.Tensor,
        levels: torch.Tensor,
        signs: torch.Tensor,
        bits: int,
        original_dim: int,
    ) -> torch.Tensor:
        """
        Fused TurboQuant_MSE decode: unpack + dequant + denorm + inv RHT in one kernel.

        The output buffer serves as scratch during butterfly stages.

        Args:
            packed_indices: packed uint8 indices.
            norms: float32 norms.
            levels: Lloyd-Max centroids of shape (num_levels,).
            signs: RHT sign vector of shape (d,).
            bits: quantization bits (2, 3, or 4).
            original_dim: the head_dim d.

        Returns:
            Decoded tensor of shape matching the original input.
        """
        d = original_dim
        log2_d = d.bit_length() - 1
        n_levels = 1 << bits

        packed_flat = packed_indices.contiguous().view(-1, packed_indices.shape[-1])
        norms_flat = norms.contiguous().view(-1)
        n = norms_flat.shape[0]

        out = torch.empty((n, d), dtype=torch.float32, device=packed_indices.device)

        grid = (n,)
        _fused_decode_kernel[grid](
            packed_flat, norms_flat, levels, signs, out,
            packed_flat.stride(0), out.stride(0),
            n, d, log2_d, bits, n_levels,
        )

        original_shape = list(norms.shape) + [d]
        return out.view(original_shape)
