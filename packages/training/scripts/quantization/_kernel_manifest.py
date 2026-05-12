"""Kernel manifest fragment helper — zero deps on torch / transformers.

Per packages/training/AGENTS.md §3, every quantization recipe MUST emit a
sidecar manifest fragment recording: kernel target, block layout version,
codebook hash, expected per-block tolerance. The fragment is consumed by
the inference manifest builder at publish time.

This module owns the canonical pin between training-side recipes and the
kernel references in eliza/packages/inference/{reference,verify}/ and
eliza/packages/native-plugins/{qjl-cpu,polarquant-cpu}/. When a kernel
constant changes, the matching value here MUST be bumped in lockstep,
otherwise the publish gate's parity tests fail.

The helper has no torch/transformers imports so unit tests can validate
manifest correctness without loading a model.
"""

from __future__ import annotations


# Codebook hashes pinned to the canonical kernel references.
#
# turbo3/turbo4/turbo3_tcq codebooks live in
#   eliza/packages/inference/reference/turbo_kernels.c
# polar_q4 centroids live in
#   eliza/packages/native-plugins/polarquant-cpu/include/polarquant/polar_centroids.h
# qjl1_256 has no centroid table — it's sign-only — so its "hash" identifies
# the block layout convention rather than a numeric codebook.
#
# Mismatches surface in test_recipes_smoke.py::
#   test_polarquant_centroids_match_c_reference
#   test_polarquant_qjl_correction_magnitude_matches_c
#   test_qjl_block_layout_packing_matches_c_ref
KERNEL_CODEBOOK_HASHES = {
    "turbo3": "turbo_centroids_3bit:8xfp32:seed42:v1",
    "turbo4": "turbo_centroids_4bit:16xfp32:seed42:v1",
    "turbo3_tcq": "turbo3_tcq_codebook:512xfp32:seed42:v1",
    "polar_q4": "polar_q4_centroids:16xfp32:lloyd_max_niter100:v1",
    "qjl1_256": "qjl1_256_layout:34bytes:lsb_first:bf16_norm:v1",
}

# Block layout versions. A non-backward-compatible change to any of these
# layouts MUST bump the version string and force a re-encode of every
# shipped bundle. The version strings are read by the runtime loader.
KERNEL_BLOCK_LAYOUT_VERSIONS = {
    "turbo3": "block_turbo3_0:v1",
    "turbo4": "block_turbo4_0:v1",
    "turbo3_tcq": "block_turbo3_tcq:v1",
    "polar_q4": "block_q4_polar:v1:82bytes:packed",
    "qjl1_256": "block_qjl1_256:v1:34bytes:packed",
}

# Kernel targets per recipe. The runtime checks these against the device's
# kernel capabilities before activating a bundle (see inference/AGENTS.md §6
# manifest schema, kernels.required field).
KERNEL_TARGETS = {
    "turboquant": ["turbo3", "turbo4", "turbo3_tcq"],
    "fused-turboquant": ["turbo3", "turbo4", "turbo3_tcq"],
    "qjl": ["qjl1_256"],
    "polarquant": ["polar_q4"],
}

# Expected per-block tolerance (max-abs reconstruction error vs fp32) at the
# canonical settings. Used by the verify/* harnesses and the publish gate.
# Numbers come from the published papers + the verify/ harness self-test.
KERNEL_PER_BLOCK_TOLERANCE = {
    "turbo3": 5.0e-2,         # 3-bit, 8 levels, post-rotation
    "turbo4": 1.0e-2,         # 4-bit, 16 levels
    "turbo3_tcq": 3.0e-2,     # 3-bit trellis, 512-state Viterbi
    "qjl1_256": 5.0e-2,       # 1-bit JL — sign-only, looser tol
    "polar_q4": 1.0e-3,       # 4-bit Lloyd-Max + Hadamard, near-lossless
}


def kernel_manifest_fragment(method: str) -> dict[str, object]:
    """Build the AGENTS.md §3 sidecar manifest fragment for a recipe.

    Returns a dict carrying:
      - ``kernel_target``: list of kernel names this recipe expects on device
      - ``block_layout_version``: per-target block layout version strings
      - ``codebook_hash``: per-target codebook identifier
      - ``per_block_tolerance``: per-target reconstruction tolerance (fp32)

    The fields are required by the publish gate. A recipe that omits any of
    them is publish-blocking. See AUDIT_2026-05-10.md for the rationale.
    """
    if method not in KERNEL_TARGETS:
        raise ValueError(
            f"kernel_manifest_fragment: unknown method {method!r}; "
            f"known: {sorted(KERNEL_TARGETS)}"
        )
    targets = KERNEL_TARGETS[method]
    return {
        "kernel_target": list(targets),
        "block_layout_version": {t: KERNEL_BLOCK_LAYOUT_VERSIONS[t] for t in targets},
        "codebook_hash": {t: KERNEL_CODEBOOK_HASHES[t] for t in targets},
        "per_block_tolerance": {t: KERNEL_PER_BLOCK_TOLERANCE[t] for t in targets},
    }
