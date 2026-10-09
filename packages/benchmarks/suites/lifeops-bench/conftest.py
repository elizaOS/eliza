"""Pytest bootstrap: put the repo root and its parent on sys.path.

The harness adapters (``hermes_adapter.client`` and friends) lazily import
from the top-level ``benchmarks`` package, which resolves only when the
checkout's *parent* directory is on ``sys.path`` and the checkout is named
``benchmarks`` (the repo convention — see the root README). The repo root
itself is also added so ``lib``/``framework`` helpers resolve when tests are
run from inside this suite directory.
"""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
for _path in (_REPO_ROOT, _REPO_ROOT.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
