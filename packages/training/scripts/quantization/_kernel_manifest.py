"""Kernel manifest fragment helper — zero deps on torch / transformers.

Per packages/training/AGENTS.md §3, every quantization recipe MUST emit a
sidecar manifest fragment recording: kernel target, block layout version,
codebook hash, expected per-block tolerance. The fragment is consumed by
the inference manifest builder at publish time.

This module owns the canonical pin between training-side recipes and the
kernel references in ``plugins/plugin-local-inference/native/{reference,verify}``
and ``packages/native/plugins/{qjl-cpu,polarquant-cpu}``. When a kernel
constant changes, the matching pinned sha256 here MUST be bumped in lockstep,
otherwise recipe sidecar generation fails.

The helper has no torch/transformers imports so unit tests can validate
manifest correctness without loading a model.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]


# Content hashed for each target. QJL has no centroid table; its pin covers the
# public block-layout header that defines the 34-byte qjl1_256 cache record.
KERNEL_CODEBOOK_HASH_SOURCES = {
    "turbo3": ("plugins/plugin-local-inference/native/reference/turbo_kernels.c",),
    "turbo4": ("plugins/plugin-local-inference/native/reference/turbo_kernels.c",),
    "turbo3_tcq": ("plugins/plugin-local-inference/native/reference/turbo_kernels.c",),
    "polar_q4": (
        "packages/native/plugins/polarquant-cpu/include/polarquant/polar_centroids.h",
    ),
    "qjl1_256": ("packages/native/plugins/qjl-cpu/include/qjl/qjl.h",),
}


PINNED_KERNEL_CODEBOOK_SHA256 = {
    "turbo3": "d2fe34ddf270c3de0ea78dc840bf18f8bc9c9175c32489700ed62e70c7a95429",
    "turbo4": "d2fe34ddf270c3de0ea78dc840bf18f8bc9c9175c32489700ed62e70c7a95429",
    "turbo3_tcq": "d2fe34ddf270c3de0ea78dc840bf18f8bc9c9175c32489700ed62e70c7a95429",
    "polar_q4": "6f0e9e204f10df190385e8f0f60055db2adbfabc611ade503be3f888eb04d399",
    "qjl1_256": "84048dea7812cf87e0c002aa2be69443e4228c10b326a9e5b1aa2d3668fbab58",
}

KERNEL_CODEBOOK_HASHES = {
    target: f"sha256:{digest}"
    for target, digest in PINNED_KERNEL_CODEBOOK_SHA256.items()
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

KERNEL_RECIPE_TARGET_CLASSES = {
    "turboquant": "kv-cache",
    "fused-turboquant": "kv-cache",
    "qjl": "kv-cache",
    "polarquant": "weights",
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


def _sha256_sources(relative_paths: tuple[str, ...]) -> str:
    """Hash one or more source files in the order declared for a target."""
    digest = hashlib.sha256()
    for rel in relative_paths:
        path = _REPO_ROOT / rel
        if not path.is_file():
            raise RuntimeError(f"kernel hash source missing: {rel}")
        digest.update(path.read_bytes())
    return digest.hexdigest()


def verify_kernel_codebook_hashes(
    targets: list[str] | tuple[str, ...] | None = None,
) -> dict[str, str]:
    """Return actual source sha256 values, failing if any pin has drifted."""
    selected = list(targets) if targets is not None else sorted(KERNEL_TARGETS_BY_NAME)
    actual: dict[str, str] = {}
    errors: list[str] = []
    for target in selected:
        sources = KERNEL_CODEBOOK_HASH_SOURCES.get(target)
        expected = PINNED_KERNEL_CODEBOOK_SHA256.get(target)
        if sources is None or expected is None:
            errors.append(f"{target}: missing hash source or pinned digest")
            continue
        got = _sha256_sources(sources)
        actual[target] = got
        if got != expected:
            errors.append(f"{target}: expected {expected}, got {got}")
    if errors:
        raise RuntimeError("kernel codebook hash drift: " + "; ".join(errors))
    return actual


KERNEL_TARGETS_BY_NAME = {
    target
    for targets in KERNEL_TARGETS.values()
    for target in targets
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
    verify_kernel_codebook_hashes(tuple(targets))
    return {
        "kernel_target": list(targets),
        "block_layout_version": {t: KERNEL_BLOCK_LAYOUT_VERSIONS[t] for t in targets},
        "codebook_hash": {t: KERNEL_CODEBOOK_HASHES[t] for t in targets},
        "codebook_hash_source": {
            t: list(KERNEL_CODEBOOK_HASH_SOURCES[t]) for t in targets
        },
        "per_block_tolerance": {t: KERNEL_PER_BLOCK_TOLERANCE[t] for t in targets},
        "target_class": KERNEL_RECIPE_TARGET_CLASSES[method],
    }
