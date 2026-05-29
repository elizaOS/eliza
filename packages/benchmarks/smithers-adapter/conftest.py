"""Pytest bootstrap for the smithers-adapter test suite.

Mirrors hermes-adapter/conftest.py: put ``packages/`` (the top-level
``benchmarks`` namespace) and this adapter root on ``sys.path`` so adapter
tests collect cleanly whether run standalone or as part of the wider suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGES_ROOT = Path(__file__).resolve().parents[2]
if str(_PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGES_ROOT))

_ADAPTER_ROOT = Path(__file__).resolve().parent
if str(_ADAPTER_ROOT) not in sys.path:
    sys.path.insert(0, str(_ADAPTER_ROOT))
