"""Pytest bootstrap for the eliza-adapter test suite.

``eliza_adapter.bfcl`` lazily imports ``benchmarks.bfcl.types``. That import
resolves cleanly only when ``packages/`` (which contains the top-level
``benchmarks`` namespace package) is on ``sys.path``. When pytest is invoked
from inside this adapter directory — or with a tight ``--rootdir`` — that
ancestor isn't picked up automatically, which surfaces as
``ModuleNotFoundError: No module named 'benchmarks'`` at collection time.

Surface that path here so adapter tests work the same way whether they're
run standalone or as part of the wider ``packages/benchmarks`` suite.
"""

from __future__ import annotations

import sys
from pathlib import Path

_PACKAGES_ROOT = Path(__file__).resolve().parents[2]
if str(_PACKAGES_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGES_ROOT))
