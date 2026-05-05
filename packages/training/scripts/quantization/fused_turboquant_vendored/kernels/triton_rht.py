"""
Fused Triton kernel for Randomized Hadamard Transform.

Performs the entire RHT (sign flip + all butterfly stages + normalization)
in a single GPU kernel launch. The output buffer doubles as scratch space
during butterfly stages, eliminating the separate n*d scratch allocation
that naive implementations require.

Each Triton program processes one vector. The butterfly stages are statically
unrolled at compile time via tl.static_range. Lightweight debug_barrier()
calls between stages handle cross-warp synchronization within each block.
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
    def _rht_kernel(
        x_ptr,
        signs_ptr,
        out_ptr,
        stride_row,
        N,
        D: tl.constexpr,
        LOG2_D: tl.constexpr,
        INVERSE: tl.constexpr,
    ):
        """
        Fused RHT: sign_flip -> all FWHT butterfly stages -> normalize.
        For INVERSE mode: FWHT -> sign_flip (reverse order).

        The output buffer serves as scratch during butterfly stages.
        No separate scratch allocation is needed.
        """
        pid = tl.program_id(0)
        if pid >= N:
            return

        row_offset = pid * stride_row
        idx = tl.arange(0, D)

        x = tl.load(x_ptr + row_offset + idx, mask=idx < D)
        signs = tl.load(signs_ptr + idx, mask=idx < D)

        if not INVERSE:
            x = x * signs

        tl.store(out_ptr + row_offset + idx, x, mask=idx < D)
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

        if INVERSE:
            result = result * signs

        tl.store(out_ptr + row_offset + idx, result, mask=idx < D)

    def triton_rht(
        x: torch.Tensor,
        signs: torch.Tensor,
        inverse: bool = False,
    ) -> torch.Tensor:
        """
        Fused Triton RHT — single kernel launch, zero scratch allocation.

        The output buffer serves as scratch during butterfly stages,
        eliminating the separate n*d scratch tensor.

        Args:
            x: tensor of shape (..., d) where d is a power of 2.
            signs: tensor of shape (d,) with values +/-1.
            inverse: if True, compute inverse RHT.

        Returns:
            Transformed tensor of the same shape.
        """
        original_shape = x.shape
        d = x.shape[-1]
        x_flat = x.contiguous().view(-1, d)
        n = x_flat.shape[0]
        log2_d = d.bit_length() - 1

        out = torch.empty_like(x_flat)

        grid = (n,)
        _rht_kernel[grid](
            x_flat, signs, out,
            x_flat.stride(0),
            n, d, log2_d,
            INVERSE=inverse,
        )

        return out.view(original_shape)


def is_triton_available() -> bool:
    return HAS_TRITON
