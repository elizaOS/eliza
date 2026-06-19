"""Pytest bootstrap: add packages/ to sys.path so benchmarks.lib resolves.

``hermes_adapter.client`` and other benchmark adapters import from
``benchmarks.lib.*``, which is a namespace package rooted at ``packages/``.
When pytest is run from the repo root (``python -m pytest
packages/benchmarks/lifeops-bench/tests/``), the ``packages/`` ancestor
isn't on sys.path automatically, so adapters that lazily import
``benchmarks.lib`` raise ModuleNotFoundError at test time.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGES_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGES_ROOT))
