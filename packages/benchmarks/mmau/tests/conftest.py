"""Pytest bootstrap for the MMAU test suite.

Adds ``packages/`` to ``sys.path`` so ``benchmarks.mmau`` is importable
regardless of where pytest is invoked from.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGES_ROOT = Path(__file__).resolve().parents[3]
if str(_PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGES_ROOT))
