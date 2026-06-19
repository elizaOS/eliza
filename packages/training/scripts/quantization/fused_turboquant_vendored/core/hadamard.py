"""
Randomized Hadamard Transform (RHT) — batched PyTorch implementation.

Provides O(d log d) rotation via Fast Walsh-Hadamard Transform + random sign flip,
replacing the O(d²) dense QR rotation used by all other TurboQuant implementations.

The key difference from naive FWHT: every butterfly stage operates on the ENTIRE batch
simultaneously as a single torch operation, so the 8 Python loop iterations (for d=256)
each launch one large efficient GPU kernel rather than thousands of tiny ones.
"""

from __future__ import annotations

import torch
import torch.nn as nn


def _validate_power_of_two(d: int, name: str = "d") -> None:
    if d < 1 or (d & (d - 1)) != 0:
        raise ValueError(f"{name} must be a power of 2, got {d}")


def fwht(x: torch.Tensor) -> torch.Tensor:
    """
    Fast Walsh-Hadamard Transform (unnormalized).

    Each butterfly stage reshapes the full batch tensor and does a single
    vectorized add/sub, so the GPU stays saturated even though there's a
    Python loop of log₂(d) iterations.

    Args:
        x: tensor of shape (..., d) where d is a power of 2.

    Returns:
        Transformed tensor of the same shape, divided by √d for orthonormality.
    """
    d = x.shape[-1]
    _validate_power_of_two(d)
    leading = x.shape[:-1]
    h = 1
    while h < d:
        x = x.view(*leading, d // (2 * h), 2, h)
        a = x[..., 0, :]
        b = x[..., 1, :]
        x = torch.stack([a + b, a - b], dim=-2)
        x = x.view(*leading, d)
        h *= 2
    return x * (d ** -0.5)


def inverse_fwht(x: torch.Tensor) -> torch.Tensor:
    """Inverse FWHT. Since H is symmetric and orthogonal, H⁻¹ = H (up to normalization)."""
    return fwht(x)


def generate_rht_signs(d: int, seed: int = 0, device: torch.device | str = "cpu") -> torch.Tensor:
    """Generate deterministic random ±1 sign vector for RHT."""
    gen = torch.Generator(device="cpu").manual_seed(seed)
    signs = torch.randint(0, 2, (d,), generator=gen, dtype=torch.float32) * 2 - 1
    return signs.to(device)


def randomized_hadamard(
    x: torch.Tensor,
    signs: torch.Tensor,
) -> torch.Tensor:
    """
    Randomized Hadamard Transform: y = (H · D) · x / √d

    where D = diag(signs) is random sign flip, H is the Hadamard matrix.

    This is mathematically equivalent to a random orthogonal rotation on the
    unit sphere S^{d-1}, producing the same Beta-distributed coordinates that
    TurboQuant requires, but using only O(d log d) operations and O(d) storage.

    Args:
        x: tensor of shape (..., d).
        signs: tensor of shape (d,) with values ±1.

    Returns:
        Rotated tensor of shape (..., d).
    """
    return fwht(x * signs)


def inverse_randomized_hadamard(
    y: torch.Tensor,
    signs: torch.Tensor,
) -> torch.Tensor:
    """
    Inverse RHT: x = D^T · H^T · y = D · H · y  (both D and H are involutions).
    """
    return inverse_fwht(y) * signs


def dense_qr_rotation(d: int, seed: int = 0, device: torch.device | str = "cpu") -> torch.Tensor:
    """
    Generate a dense random orthogonal matrix via QR decomposition.

    This is what every other TurboQuant implementation uses. Provided here
    as a baseline for benchmarking against RHT.

    Memory: O(d²) — for d=256, that's 256 KB per layer.
    Compute: O(d²) per vector — 65,536 multiplies for d=256.
    """
    gen = torch.Generator(device="cpu").manual_seed(seed)
    random_matrix = torch.randn(d, d, generator=gen)
    q, _ = torch.linalg.qr(random_matrix)
    return q.to(device)


class RHTRotation(nn.Module):
    """
    Randomized Hadamard rotation layer with persistent sign vector.

    Uses the fused Triton kernel when available (single GPU launch for all
    butterfly stages). Falls back to batched PyTorch FWHT otherwise.
    """

    def __init__(self, dim: int, seed: int = 0, device: torch.device | str = "cpu"):
        super().__init__()
        _validate_power_of_two(dim)
        self.dim = dim
        self.register_buffer("signs", generate_rht_signs(dim, seed=seed, device=device))
        self._use_triton = False
        self._try_enable_triton()

    def _try_enable_triton(self) -> None:
        import os
        if os.environ.get("FUSED_TURBOQUANT_DISABLE_TRITON", "").lower() in (
            "1", "true", "yes",
        ):
            self._use_triton = False
            return
        from quantization.fused_turboquant_vendored.kernels.triton_rht import is_triton_available
        if is_triton_available() and self.signs.is_cuda:
            self._use_triton = True

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self._use_triton and x.is_cuda:
            from quantization.fused_turboquant_vendored.kernels.triton_rht import triton_rht
            return triton_rht(x, self.signs, inverse=False)
        return randomized_hadamard(x, self.signs)

    def inverse(self, y: torch.Tensor) -> torch.Tensor:
        if self._use_triton and y.is_cuda:
            from quantization.fused_turboquant_vendored.kernels.triton_rht import triton_rht
            return triton_rht(y, self.signs, inverse=True)
        return inverse_randomized_hadamard(y, self.signs)

    def to(self, *args, **kwargs):
        result = super().to(*args, **kwargs)
        result._try_enable_triton()
        return result

    def extra_repr(self) -> str:
        backend = "Triton fused" if self._use_triton else "PyTorch batched"
        return f"dim={self.dim}, backend={backend}, storage={self.dim} signs ({self.dim * 4} bytes)"


class DenseQRRotation(nn.Module):
    """Dense QR rotation layer — baseline for comparison. Stores full d×d matrix."""

    def __init__(self, dim: int, seed: int = 0, device: torch.device | str = "cpu"):
        super().__init__()
        self.dim = dim
        self.register_buffer("matrix", dense_qr_rotation(dim, seed=seed, device=device))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x @ self.matrix.T

    def inverse(self, y: torch.Tensor) -> torch.Tensor:
        return y @ self.matrix

    def extra_repr(self) -> str:
        mem = self.dim * self.dim * 4
        return f"dim={self.dim}, storage={self.dim}×{self.dim} matrix ({mem:,} bytes)"
