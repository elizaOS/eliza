"""QJL training-side helpers — projection construction + quantize.

Strongly-typed numpy helpers for the recipe and tests. Layout is the
canonical ``(head_dim, proj_dim)`` row-major form mandated by the kernel
references at:

  * ``eliza/packages/native-plugins/qjl-cpu/include/qjl/qjl.h``
  * ``eliza/packages/native-plugins/qjl-cpu/src/qjl_quantize_ref.c``
  * ``eliza/packages/native-plugins/qjl-cpu/src/qjl_score_ref.c``
  * ``eliza/packages/inference/verify/qjl_polar_ref.c`` (verify harness)

The ``block_qjl1_256`` on-cache layout is 32 packed sign bytes (LSB-first
within each byte) followed by a uint16 bf16 norm — 34 bytes total. The
projection matrix is fp32 row-major: row ``i`` of length ``proj_dim``
floats lives at byte offset ``i * proj_dim * 4``. With the canonical
shape ``(128, 256)`` that's a stride of 1024 bytes per row and
131072 bytes (128 KiB) per matrix.

This module has no torch / transformers imports — same constraint as
``_kernel_manifest`` — so the parity tests can run on a CPU-only host
without provisioning the training stack.
"""

from __future__ import annotations

from typing import NewType

import numpy as np
from numpy.typing import NDArray


ProjectionMatrix = NewType("ProjectionMatrix", NDArray[np.float32])
"""(head_dim, proj_dim) row-major fp32. Use ``build_projection_matrix``."""

KeyVector = NewType("KeyVector", NDArray[np.float32])
"""(head_dim,) fp32. One row of K activations for one head, one token."""

PackedSigns = NewType("PackedSigns", NDArray[np.uint8])
"""(proj_dim // 8,) uint8. LSB-first within each byte."""


def build_projection_matrix(
    head_dim: int, proj_dim: int, *, seed: int
) -> ProjectionMatrix:
    """Deterministic ``(head_dim, proj_dim)`` row-major fp32 JL projection.

    Uses numpy's PCG64 stream so the artifact is portable across the
    Python recipe and the parity tests without taking a torch dependency.
    The on-device qjl-cpu kernel ships its own splitmix64 + Box-Muller
    generator; bit-exactness across the two generators is NOT a goal —
    Π is shipped to the device explicitly. The seed pin is a regression
    guard, not a cross-language contract.
    """
    if proj_dim % 8 != 0:
        raise ValueError(f"proj_dim must be byte-aligned; got {proj_dim}")
    rng = np.random.default_rng(seed)
    pi = rng.standard_normal((head_dim, proj_dim), dtype=np.float32)
    return ProjectionMatrix(pi)


def fp32_to_bf16_uint16(x: float) -> int:
    """IEEE fp32 -> bf16 with round-to-nearest-even, returned as uint16.

    Matches ``qjl_fp32_to_bf16`` in the qjl-cpu reference and
    ``eliza_fp32_to_bf16`` in the verify reference.
    """
    f_bits = np.float32(x).view(np.uint32).item()
    lsb = (f_bits >> 16) & 1
    rounded = (f_bits + 0x7FFF + lsb) & 0xFFFFFFFF
    return (rounded >> 16) & 0xFFFF


def quantize_row(
    key: KeyVector, pi: ProjectionMatrix
) -> tuple[PackedSigns, int]:
    """Quantize one head_dim-row through the canonical kernel pipeline.

    Returns (packed_signs, norm_bf16) — exactly the contents of one
    ``block_qjl1_256``: ``packed_signs`` is the ``qs[]`` array,
    ``norm_bf16`` is the trailing uint16. Encoding mirrors
    ``qjl_quantize_row_ref`` byte-for-byte:

      * ``sketch = key @ pi`` -> shape ``(proj_dim,)``
      * ``bit[j] = sketch[j] > 0``
      * pack 8 bits LSB-first into byte ``j // 8``
      * ``norm_bf16 = bf16(||key||_2)``
    """
    if key.ndim != 1:
        raise ValueError(f"key must be 1D (head_dim,); got shape {key.shape}")
    if pi.ndim != 2:
        raise ValueError(f"pi must be 2D (head_dim, proj_dim); got shape {pi.shape}")
    if key.shape[0] != pi.shape[0]:
        raise ValueError(
            f"key.shape[0]={key.shape[0]} does not match pi.shape[0]={pi.shape[0]} "
            f"(canonical layout is (head_dim, proj_dim) row-major)"
        )
    proj_dim = pi.shape[1]
    if proj_dim % 8 != 0:
        raise ValueError(f"proj_dim must be byte-aligned; got {proj_dim}")

    sketch = key @ pi  # (proj_dim,)
    bits = (sketch > 0).astype(np.uint8)

    packed = np.zeros(proj_dim // 8, dtype=np.uint8)
    for j in range(proj_dim):
        if bits[j]:
            packed[j >> 3] |= np.uint8(1 << (j & 7))

    norm = float(np.linalg.norm(key))
    norm_bf16 = fp32_to_bf16_uint16(norm)
    return PackedSigns(packed), norm_bf16
