"""Compatibility exports for benchmark registry score extractors."""

from __future__ import annotations

from ._monolith import export_public_names

globals().update(export_public_names())

__all__ = [
    name
    for name in globals()
    if name.startswith("_score_from_") or name == "_standard_benchmark_metrics"
]
