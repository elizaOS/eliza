"""Kernel manifest fragment helper — zero deps on torch / transformers.

Per packages/training/AGENTS.md §3, every quantization recipe MUST emit a
sidecar manifest fragment recording: kernel target, block layout version,
codebook hash, expected per-block tolerance. The fragment is consumed by
the inference manifest builder at publish time.

This module owns the canonical pin between training-side recipes and the
kernel references in packages/native/plugins/{turboquant-cpu,qjl-cpu,
polarquant-cpu}/. When a kernel constant changes, the matching value here MUST
be bumped in lockstep, otherwise the publish gate's parity tests fail.

The helper has no torch/transformers imports so unit tests can validate
manifest correctness without loading a model.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]


def _sha256_file(relpath: str) -> str:
    path = _REPO_ROOT / relpath
    if not path.is_file():
        raise RuntimeError(f"kernel codebook hash source missing: {path}")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_c_initializer(relpath: str, symbol: str) -> str:
    path = _REPO_ROOT / relpath
    if not path.is_file():
        raise RuntimeError(f"kernel codebook hash source missing: {path}")
    text = path.read_text(encoding="utf-8")
    match = re.search(
        rf"(?:static\s+)?const\s+(?:float|int8_t)\s+{re.escape(symbol)}"
        r"\s*\[[^\]]+\]\s*=\s*\{(?P<body>.*?)\}\s*;",
        text,
        flags=re.DOTALL,
    )
    if match is None:
        raise RuntimeError(f"kernel codebook symbol {symbol!r} missing in {path}")
    normalized = re.sub(r"\s+", " ", match.group(0).strip()).encode("utf-8")
    return hashlib.sha256(normalized).hexdigest()


KERNEL_CODEBOOK_HASH_SOURCES: dict[str, tuple[str, str | None]] = {
    "turbo3": (
        "packages/native/plugins/turboquant-cpu/src/tbq_block_ref.c",
        "TBQ3_CODEBOOK",
    ),
    "turbo4": (
        "packages/native/plugins/turboquant-cpu/src/tbq_block_ref.c",
        "TBQ4_CODEBOOK",
    ),
    "turbo3_tcq": (
        "plugins/plugin-local-inference/native/reference/turbo_kernels.c",
        "ELIZA_TURBO3_TCQ_CODEBOOK",
    ),
    "polar_q4": (
        "packages/native/plugins/polarquant-cpu/include/polarquant/polar_centroids.h",
        "POLAR_Q4_CENTROIDS",
    ),
    # QJL is sign-only: there is no centroid table. Its manifest hash pins the
    # public packed-layout header that defines QJL_PACKED_BYTES, projection
    # dimensions, and qjl_block_qjl1_256.
    "qjl1_256": ("packages/native/plugins/qjl-cpu/include/qjl/qjl.h", None),
}

PINNED_KERNEL_CODEBOOK_SHA256 = {
    "turbo3": "edc3ccfadf06e038e79d9dd763b89a6fb359742521ddf1950fe7b40fe55f0a5e",
    "turbo4": "2e8b3c0c2668f3e2243734a0b679ea57d333b5509fea097122afce8066b959a5",
    "turbo3_tcq": "df82e32eed0df23f5a88fe9afbb077a03e3067c8690dcc55997ad01fb54e96be",
    "polar_q4": "cce740dff7143a258ea01a482a539f2485acc959895e8dbc3ce2945f034ec329",
    "qjl1_256": "84048dea7812cf87e0c002aa2be69443e4228c10b326a9e5b1aa2d3668fbab58",
}


def compute_kernel_codebook_sha256() -> dict[str, str]:
    """Return current sha256 digests from the kernel reference sources."""
    out: dict[str, str] = {}
    for target, (relpath, symbol) in KERNEL_CODEBOOK_HASH_SOURCES.items():
        out[target] = (
            _sha256_file(relpath)
            if symbol is None
            else _sha256_c_initializer(relpath, symbol)
        )
    return out


def assert_kernel_codebook_hashes_current() -> dict[str, str]:
    """Fail loudly if a committed kernel codebook/layout source drifted.

    The manifest must not emit stale hand-written labels. A source constant
    change needs a matching pinned digest update in the same PR so the publish
    gate can prove recipe/kernel parity from content hashes.
    """
    current = compute_kernel_codebook_sha256()
    mismatches = {
        target: (PINNED_KERNEL_CODEBOOK_SHA256[target], observed)
        for target, observed in current.items()
        if PINNED_KERNEL_CODEBOOK_SHA256[target] != observed
    }
    if mismatches:
        detail = ", ".join(
            f"{target}: pinned={pinned} observed={observed}"
            for target, (pinned, observed) in sorted(mismatches.items())
        )
        raise RuntimeError(f"kernel codebook hash drift: {detail}")
    return current


KERNEL_CODEBOOK_SHA256 = assert_kernel_codebook_hashes_current()
KERNEL_CODEBOOK_HASHES = {
    target: f"sha256:{digest}" for target, digest in KERNEL_CODEBOOK_SHA256.items()
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
