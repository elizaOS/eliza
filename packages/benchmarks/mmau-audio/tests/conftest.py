"""Pytest bootstrap for the MMAU test suite.

Adds the package root to ``sys.path`` so ``elizaos_mmau_audio`` is importable
regardless of where pytest is invoked from.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]
if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))
