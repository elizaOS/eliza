"""Compatibility exports for benchmark registry command builders."""

from __future__ import annotations

from ._monolith import export_public_names

globals().update(export_public_names())

__all__ = [
    name
    for name in globals()
    if not name.startswith("_") or name.startswith("_score_from_")
]
