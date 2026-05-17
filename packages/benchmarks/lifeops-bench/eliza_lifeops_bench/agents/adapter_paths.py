"""Import-path bootstrap for sibling benchmark adapters.

LifeOpsBench is often run directly from ``packages/benchmarks/lifeops-bench``
instead of through the orchestrator. The orchestrator injects
``eliza-adapter`` / ``hermes-adapter`` / ``openclaw-adapter`` onto
``PYTHONPATH``; this helper mirrors that behavior for direct CLI runs.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path

_ADAPTER_PACKAGES: dict[str, tuple[str, str]] = {
    "eliza": ("eliza-adapter", "eliza_adapter"),
    "hermes": ("hermes-adapter", "hermes_adapter"),
    "openclaw": ("openclaw-adapter", "openclaw_adapter"),
}


def ensure_benchmark_adapter_importable(name: str) -> None:
    """Make one sibling benchmark adapter importable from a repo checkout."""
    try:
        source_dir, package_name = _ADAPTER_PACKAGES[name]
    except KeyError as exc:
        raise ValueError(f"unknown benchmark adapter {name!r}") from exc

    try:
        importlib.import_module(package_name)
        return
    except ImportError:
        pass

    benchmarks_dir = Path(__file__).resolve().parents[3]
    candidate = benchmarks_dir / source_dir
    if (candidate / package_name).is_dir():
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)


def ensure_benchmark_adapters_importable(*names: str) -> None:
    """Make multiple sibling benchmark adapters importable."""
    for name in names:
        ensure_benchmark_adapter_importable(name)


__all__ = [
    "ensure_benchmark_adapter_importable",
    "ensure_benchmark_adapters_importable",
]
