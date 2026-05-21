"""Capability probe for the vendored trainer.

Used by `packages/training/scripts/kokoro/finetune_kokoro.py` to decide
whether the host can run the full-finetune path, and by tests to skip
real-training cases when deps are absent.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parent.parent
"""The vendored kokoro_training root (one level above this adapter)."""


@dataclass(frozen=True)
class VendorEnvironment:
    """Snapshot of which vendor deps are usable on the current host.

    `available` is True iff every required dep imports cleanly. A False
    `available` with a populated `missing` list is the supported path
    for CPU-only / smoke-only environments — callers should fall back
    to the synthetic-smoke variant.
    """

    available: bool
    missing: tuple[str, ...]
    has_cuda: bool
    has_mps: bool
    vendor_root: Path


_REQUIRED_MODULES: tuple[str, ...] = (
    "torch",
    "torchaudio",
    "numpy",
    "soundfile",
    "librosa",
    "g2p_en",
    "tqdm",
)


def probe_vendor_environment() -> VendorEnvironment:
    """Probe whether the vendored trainer can actually run on this host.

    Returns a `VendorEnvironment` describing the result. Never raises.
    """
    missing: list[str] = []
    for mod in _REQUIRED_MODULES:
        try:
            importlib.import_module(mod)
        except Exception:  # noqa: BLE001 - probe must be exception-proof
            missing.append(mod)

    has_cuda = False
    has_mps = False
    if "torch" not in missing:
        torch = importlib.import_module("torch")
        try:
            has_cuda = bool(torch.cuda.is_available())
        except Exception:  # noqa: BLE001
            has_cuda = False
        try:
            has_mps = bool(torch.backends.mps.is_available())
        except Exception:  # noqa: BLE001
            has_mps = False

    return VendorEnvironment(
        available=not missing,
        missing=tuple(missing),
        has_cuda=has_cuda,
        has_mps=has_mps,
        vendor_root=VENDOR_ROOT,
    )
