"""Pytest bootstrap for the VisualWebBench test suite.

Mirrors ``packages/benchmarks/eliza-adapter/conftest.py``: the tests import
``benchmarks.visualwebbench.*``, which only resolves cleanly when
``packages/`` (the parent of the ``benchmarks`` namespace package) is on
``sys.path``.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGES_ROOT = Path(__file__).resolve().parents[2]
if str(_PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGES_ROOT))
