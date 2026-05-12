"""Compatibility wrapper for the consolidated benchmark registry.

The active implementation lives in ``packages/benchmarks/registry.py``. This
package exists only so older imports such as ``benchmarks.registry`` and
``benchmarks.registry.commands`` keep resolving without maintaining a second
copy of the registry.
"""

from __future__ import annotations

from ._monolith import export_public_names

globals().update(export_public_names())

__all__ = [
    name
    for name in globals()
    if not name.startswith("_") or name.startswith("_score_from_")
]
