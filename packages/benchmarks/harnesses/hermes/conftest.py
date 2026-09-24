"""Pytest bootstrap for the hermes harness test suite.

The adapter modules import shared code as ``benchmarks.lib.*`` and suite
helpers as ``benchmarks.<suite>.*``. In this standalone repo the checkout root
is the ``benchmarks`` package and the suites live under ``suites/``, so the
package is registered here explicitly (with ``suites/`` on its search path)
regardless of the directory name the repo was cloned into. The harness root is
also placed on ``sys.path`` so ``hermes_adapter`` imports resolve when pytest
runs from anywhere.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]

if "benchmarks" not in sys.modules:
    _spec = importlib.util.spec_from_file_location(
        "benchmarks",
        _REPO_ROOT / "__init__.py",
        submodule_search_locations=[str(_REPO_ROOT), str(_REPO_ROOT / "suites")],
    )
    assert _spec is not None and _spec.loader is not None
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["benchmarks"] = _module
    _spec.loader.exec_module(_module)

_HARNESS_ROOT = Path(__file__).resolve().parent
if str(_HARNESS_ROOT) not in sys.path:
    sys.path.insert(0, str(_HARNESS_ROOT))

# Repo root on sys.path so the ``suites.*`` / ``lib.*`` top-level namespace
# imports used inside the suites also resolve.
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(1, str(_REPO_ROOT))
