"""
Lloyd-Max optimal scalar quantizer for Beta-distributed coordinates.

After random rotation (RHT or dense QR), each coordinate of a unit vector
on S^{d-1} has PDF proportional to (1-z²)^((d-3)/2) for z in [-1, 1].

The codebook is computed using a grid-based Lloyd-Max algorithm (same approach
as Dejan.ai's implementation): represent the distribution as a dense weighted
grid, then iterate assignment + centroid updates until convergence.

The codebook is precomputed once for a given (dim, bits) pair and reused
for all vectors — zero per-block normalization constants needed.
"""

from __future__ import annotations

import math
from functools import lru_cache

import numpy as np
import torch


def compute_lloyd_max_codebook(
    dim: int,
    bits: int,
    max_iterations: int = 300,
    num_grid_points: int = 50000,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Compute optimal Lloyd-Max quantization levels using a dense grid approach.

    Creates a weighted grid representing the coordinate PDF, then runs
    standard Lloyd-Max iteration: assign grid points to nearest centroid,
    update centroid as weighted mean, repeat.

    Args:
        dim: vector dimension d.
        bits: quantization bits (2^bits levels).
        max_iterations: iteration count.
        num_grid_points: grid density for PDF approximation.

    Returns:
        (boundaries, levels) as numpy arrays.
    """
    num_levels = 1 << bits
    exponent = (dim - 3) / 2.0

    sigma = 1.0 / math.sqrt(dim)
    lo = max(-1.0, -6.0 * sigma)
    hi = min(1.0, 6.0 * sigma)
    grid = np.linspace(lo, hi, num_grid_points)

    weights = np.maximum(1.0 - grid**2, 0.0) ** exponent
    weights /= weights.sum()

    cdf = np.cumsum(weights)
    quantiles = np.linspace(0, 1, num_levels + 1)
    boundaries = np.interp(quantiles, cdf, grid)
    boundaries[0] = lo
    boundaries[-1] = hi

    levels = np.zeros(num_levels)
    for i in range(num_levels):
        mask = (grid >= boundaries[i]) & (grid < boundaries[i + 1])
        if i == num_levels - 1:
            mask = (grid >= boundaries[i]) & (grid <= boundaries[i + 1])
        w = weights[mask]
        if w.sum() > 0:
            levels[i] = np.average(grid[mask], weights=w)
        else:
            levels[i] = (boundaries[i] + boundaries[i + 1]) / 2.0

    for _ in range(max_iterations):
        for i in range(1, num_levels):
            boundaries[i] = (levels[i - 1] + levels[i]) / 2.0

        for i in range(num_levels):
            mask = (grid >= boundaries[i]) & (grid < boundaries[i + 1])
            if i == num_levels - 1:
                mask = (grid >= boundaries[i]) & (grid <= boundaries[i + 1])
            w = weights[mask]
            if w.sum() > 0:
                levels[i] = np.average(grid[mask], weights=w)
            else:
                levels[i] = (boundaries[i] + boundaries[i + 1]) / 2.0

    return boundaries, levels


class LloydMaxQuantizer:
    """
    Precomputed Lloyd-Max scalar quantizer for TurboQuant.

    The codebook only depends on (dim, bits) and can be shared across all
    layers, heads, and tokens — zero per-block overhead.
    """

    def __init__(self, dim: int, bits: int = 4, device: torch.device | str = "cpu"):
        self.dim = dim
        self.bits = bits
        self.num_levels = 1 << bits

        boundaries_np, levels_np = _get_cached_codebook(dim, bits)

        self.boundaries = torch.tensor(boundaries_np, dtype=torch.float32, device=device)
        self.levels = torch.tensor(levels_np, dtype=torch.float32, device=device)

    def quantize(self, x: torch.Tensor) -> torch.Tensor:
        """
        Map continuous values to quantization indices.

        Args:
            x: normalized coordinate values in roughly [-1, 1].

        Returns:
            Integer indices in [0, num_levels - 1], same shape as x.
        """
        indices = torch.bucketize(x, self.boundaries) - 1
        return indices.clamp(0, self.num_levels - 1).to(torch.uint8)

    def dequantize(self, indices: torch.Tensor) -> torch.Tensor:
        """Map quantization indices back to reconstruction levels."""
        return self.levels[indices.long()]

    def to(self, device: torch.device | str) -> "LloydMaxQuantizer":
        self.boundaries = self.boundaries.to(device)
        self.levels = self.levels.to(device)
        return self


@lru_cache(maxsize=32)
def _get_cached_codebook(dim: int, bits: int) -> tuple[np.ndarray, np.ndarray]:
    """Cache codebook computation — same (dim, bits) always yields same result."""
    return compute_lloyd_max_codebook(dim, bits)
