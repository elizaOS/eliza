"""Import-path bootstrap for sibling benchmark adapters.

LifeOpsBench is often run directly from ``suites/lifeops-bench`` instead of
through the orchestrator. The orchestrator injects ``harnesses/eliza`` /
``harnesses/hermes`` / ``harnesses/openclaw`` onto ``PYTHONPATH``; this helper
mirrors that behavior for direct CLI runs.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

_ADAPTER_PACKAGES: dict[str, tuple[str, str]] = {
    "eliza": ("eliza", "eliza_adapter"),
    "hermes": ("hermes", "hermes_adapter"),
    "openclaw": ("openclaw", "openclaw_adapter"),
    "smithers": ("smithers", "smithers_adapter"),
}


def ensure_benchmark_adapter_importable(name: str) -> None:
    """Make one harness adapter importable from a repo checkout."""
    try:
        harness_dir, package_name = _ADAPTER_PACKAGES[name]
    except KeyError as exc:
        raise ValueError(f"unknown benchmark adapter {name!r}") from exc

    if importlib.util.find_spec(package_name) is not None:
        importlib.import_module(package_name)
        return

    repo_root = Path(__file__).resolve().parents[4]
    candidate = repo_root / "harnesses" / harness_dir
    if (candidate / package_name).is_dir():
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)


def ensure_benchmark_adapters_importable(*names: str) -> None:
    """Make multiple harness adapters importable."""
    for name in names:
        ensure_benchmark_adapter_importable(name)


__all__ = [
    "ensure_benchmark_adapter_importable",
    "ensure_benchmark_adapters_importable",
]
