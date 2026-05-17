"""PolarQuant: optimal Gaussian weight quantization via Hadamard rotation.

Pipeline:
    1. Per-block L2 normalize (block_size must be a power of 2).
    2. Walsh-Hadamard rotation -> coordinates ~ N(0, 1/d).
    3. Lloyd-Max optimal scalar quantization for N(0, 1).
    4. Optional 1-bit QJL residual sign correction.

Storage layout: int8 codes + fp16 per-block norms (+ 1-bit QJL signs).
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from scipy.stats import norm

# Import the canonical xorshift32 helper (sibling of the polarquant/ package).
_HERE = Path(__file__).resolve().parent
_QUANT_DIR = _HERE.parent
if str(_QUANT_DIR) not in sys.path:
    sys.path.insert(0, str(_QUANT_DIR))
from polar_xorshift32 import polar_xorshift32_signs  # noqa: E402

# Pre-computed Lloyd-Max centroids for N(0,1). Keyed by bits; entries stay
# None until first use (computed on demand by ``_ensure_centroids``).
_GAUSSIAN_CENTROIDS: dict[int, torch.Tensor | None] = {
    2: torch.tensor([-1.5104, -0.4528, 0.4528, 1.5104]),
    3: torch.tensor(
        [-2.1520, -1.3440, -0.7560, -0.2451, 0.2451, 0.7560, 1.3440, 2.1520]
    ),
    4: None,
    5: None,
    6: None,
}

_HADAMARD_CACHE: dict[int, torch.Tensor] = {}

# Magnitude of the QJL residual correction along the random projection
# direction. Small enough to never overshoot the Lloyd-Max cell.
_QJL_CORRECTION_MAGNITUDE = 0.5

# Deterministic seed for the per-block random sign vector used by the QJL
# correction. The encoder and decoder must agree on it.
_QJL_SEED = 42


def _compute_lloyd_max_centroids(n_levels: int, n_iter: int = 100) -> torch.Tensor:
    """Iteratively solve for MSE-optimal scalar quantizer levels for N(0,1).

    Conditional expectation in [a, b] for X ~ N(0,1):
        E[X | a < X < b] = (phi(a) - phi(b)) / (Phi(b) - Phi(a))
    """
    boundaries = np.linspace(-4, 4, n_levels + 1)
    boundaries[0] = -np.inf
    boundaries[-1] = np.inf

    centroids = np.zeros(n_levels)
    for _ in range(n_iter):
        for i in range(n_levels):
            a, b = boundaries[i], boundaries[i + 1]
            prob = norm.cdf(b) - norm.cdf(a)
            if prob > 1e-10:
                centroids[i] = (norm.pdf(a) - norm.pdf(b)) / prob
            else:
                centroids[i] = (a + b) / 2

        new_boundaries = np.zeros(n_levels + 1)
        new_boundaries[0] = -np.inf
        new_boundaries[-1] = np.inf
        for i in range(1, n_levels):
            new_boundaries[i] = (centroids[i - 1] + centroids[i]) / 2
        boundaries = new_boundaries

    return torch.tensor(centroids, dtype=torch.float32)


def _ensure_centroids(bits: int) -> torch.Tensor:
    if bits not in _GAUSSIAN_CENTROIDS:
        raise ValueError(
            f"PolarQuant supports bits in {sorted(_GAUSSIAN_CENTROIDS)}; got {bits}"
        )
    cached = _GAUSSIAN_CENTROIDS[bits]
    if cached is None:
        cached = _compute_lloyd_max_centroids(1 << bits)
        _GAUSSIAN_CENTROIDS[bits] = cached
    return cached


def _hadamard_matrix(n: int, device: torch.device | None = None) -> torch.Tensor:
    """Walsh-Hadamard matrix of size n (power of 2), normalized so H @ H.T == I."""
    if n & (n - 1) != 0:
        raise ValueError(f"Hadamard size must be a power of 2; got {n}")
    cached = _HADAMARD_CACHE.get(n)
    if cached is None:
        if n == 1:
            cached = torch.tensor([[1.0]])
        else:
            h = _hadamard_matrix(n // 2)
            cached = torch.cat(
                [torch.cat([h, h], 1), torch.cat([h, -h], 1)], 0
            ) / math.sqrt(2)
        _HADAMARD_CACHE[n] = cached
    if device is not None:
        return cached.to(device)
    return cached


@dataclass
class PolarQuantResult:
    """Result of PolarQuant compression for one tensor."""

    codes: torch.Tensor          # int8, length n_elements
    norms: torch.Tensor          # fp16, length n_blocks
    bits: int
    block_size: int
    shape: torch.Size
    n_elements: int
    use_qjl: bool
    qjl_signs: torch.Tensor | None = None  # uint8, length n_blocks


def polar_quantize(
    weight: torch.Tensor,
    bits: int = 4,
    block_size: int = 128,
    use_qjl: bool = True,
) -> PolarQuantResult:
    """Encode ``weight`` into PolarQuant codes."""
    centroids = _ensure_centroids(bits).to(weight.device)
    H = _hadamard_matrix(block_size, weight.device)

    flat = weight.detach().float().flatten()
    n = flat.numel()
    pad = (block_size - n % block_size) % block_size
    if pad > 0:
        flat = F.pad(flat, (0, pad))
    blocks = flat.view(-1, block_size)

    norms = blocks.norm(dim=1, keepdim=True).clamp(min=1e-10)
    blocks_norm = blocks / norms
    blocks_rot = blocks_norm @ H

    # After rotation each coord is ~ N(0, 1/sqrt(d)); scale to N(0, 1)
    # so the Lloyd-Max centroids apply directly.
    scale = math.sqrt(block_size)
    blocks_scaled = blocks_rot * scale

    diffs = blocks_scaled.unsqueeze(-1) - centroids.unsqueeze(0).unsqueeze(0)
    codes = diffs.abs().argmin(dim=-1).to(torch.int8)

    qjl_signs: torch.Tensor | None = None
    if use_qjl:
        recon_scaled = centroids[codes.long()]
        residual = blocks_scaled - recon_scaled
        random_signs = torch.from_numpy(
            polar_xorshift32_signs(block_size, _QJL_SEED)
        ).to(dtype=torch.float32, device=weight.device)
        projections = (residual * random_signs.unsqueeze(0)).sum(dim=1)
        qjl_signs = (projections >= 0).to(torch.uint8)

    return PolarQuantResult(
        codes=codes.flatten()[:n],
        norms=norms.squeeze(1).to(torch.float16),
        bits=bits,
        block_size=block_size,
        shape=weight.shape,
        n_elements=n,
        use_qjl=use_qjl,
        qjl_signs=qjl_signs,
    )


def polar_dequantize(
    result: PolarQuantResult, device: torch.device | None = None
) -> torch.Tensor:
    """Decode a PolarQuant payload back to fp16."""
    if device is None:
        device = result.codes.device

    centroids = _ensure_centroids(result.bits).to(device)
    H = _hadamard_matrix(result.block_size, device)

    bs = result.block_size
    n = result.n_elements
    pad = (bs - n % bs) % bs
    codes = result.codes.to(device).long()
    if pad > 0:
        codes = F.pad(codes, (0, pad))
    blocks_codes = codes.view(-1, bs)

    recon_scaled = centroids[blocks_codes]

    if result.use_qjl and result.qjl_signs is not None:
        random_signs = torch.from_numpy(
            polar_xorshift32_signs(bs, _QJL_SEED)
        ).to(dtype=torch.float32, device=device)
        correction_dir = random_signs.unsqueeze(0) / math.sqrt(bs)
        correction_sign = result.qjl_signs.float().to(device) * 2 - 1
        recon_scaled = recon_scaled + (
            _QJL_CORRECTION_MAGNITUDE
            * correction_sign.unsqueeze(1)
            * correction_dir
        )

    scale = math.sqrt(bs)
    recon_rot = recon_scaled / scale
    recon_norm = recon_rot @ H
    norms = result.norms.float().to(device)
    recon = recon_norm * norms.unsqueeze(1)

    return recon.flatten()[:n].view(result.shape).half()
