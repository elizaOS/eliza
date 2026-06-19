"""Canonical xorshift32 PRNG for the PolarQuant QJL residual sign vector.

This is the Python port of the C reference implementation that lives in:

    eliza/packages/native-plugins/polarquant-cpu/src/polar_qjl.c
    eliza/packages/inference/verify/qjl_polar_ref.c          (eliza_polar_qjl_signs)

Per packages/training/AGENTS.md S3 ("kernel side wins") the C reference is
canonical. The Python recipe must produce a sign sequence that is bit-exact
with what the on-device decoder will compute. xorshift32 was chosen on the C
side because:

    - it has a 32-bit state (trivially portable across CPU / Metal / Vulkan /
      CUDA kernels);
    - it produces a deterministic, version-stable bit stream;
    - the algorithm fits in 3 shifts + 3 xors per step, easy to inline.

The C inner loop is:

    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    out[i] = (state & 1u) ? +1.0f : -1.0f;

The state must be non-zero (xorshift collapses to 0). Seed 0 is rewritten to 1
in both C sources. We do the same here.

Seed 42 is the canonical value used by both C reference files and is mirrored
in :data:`polarquant.polar_quant._QJL_SEED`.
"""

from __future__ import annotations

import numpy as np

# Mask used to keep all arithmetic in uint32 space. xorshift32 relies on
# overflow at 2^32; numpy uint32 already wraps at that boundary, but explicit
# masking documents the intent and protects against accidental promotion to
# int64 if anyone refactors the loop into Python ints.
_UINT32_MASK = np.uint32(0xFFFFFFFF)


def polar_xorshift32_state_seq(n: int, seed: int) -> np.ndarray:
    """Return ``n`` consecutive xorshift32 states starting from ``seed``.

    The first emitted state is the result of one full xorshift32 step applied
    to ``seed`` (matching the C loop which advances the state before reading
    the LSB on iteration 0). Seed 0 is rewritten to 1 to match the C guard.
    """
    if n < 0:
        raise ValueError(f"n must be non-negative; got {n}")

    state = np.uint32(seed & 0xFFFFFFFF)
    if state == np.uint32(0):
        state = np.uint32(1)

    out = np.empty(n, dtype=np.uint32)
    # Suppress the harmless overflow warning that fires on `state << 13` when
    # the high bits are set: xorshift32 *requires* wraparound, that's the
    # whole point. We mask back into uint32 at every step.
    with np.errstate(over="ignore"):
        for i in range(n):
            state = np.uint32((state ^ (state << np.uint32(13))) & _UINT32_MASK)
            state = np.uint32((state ^ (state >> np.uint32(17))) & _UINT32_MASK)
            state = np.uint32((state ^ (state << np.uint32(5))) & _UINT32_MASK)
            out[i] = state
    return out


def polar_xorshift32_signs(n: int, seed: int = 42) -> np.ndarray:
    """Return a length-``n`` int8 array of +1/-1 signs.

    Bit-exact with ``polar_qjl_signs`` /  ``eliza_polar_qjl_signs`` in the C
    references. ``seed`` defaults to ``42`` (POLAR_QJL_SEED).
    """
    states = polar_xorshift32_state_seq(n, seed)
    # LSB == 1 -> +1, LSB == 0 -> -1, matching the C ternary on (state & 1u).
    signs = np.where(states & np.uint32(1), np.int8(1), np.int8(-1))
    return signs.astype(np.int8, copy=False)
