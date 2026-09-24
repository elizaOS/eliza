"""Pytest bootstrap for the top-level test suite.

The tests import shared code as ``benchmarks.lib.*`` / ``benchmarks.<suite>.*``.
In this standalone repo the checkout root is the ``benchmarks`` package and the
suites live under ``suites/``, so the package is registered here explicitly
(with ``suites/`` on its search path) regardless of the directory name the
repo was cloned into.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]

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

if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Some tests import suites as top-level packages (e.g. ``orchestrator.cli``).
if str(_REPO_ROOT / "suites") not in sys.path:
    sys.path.insert(1, str(_REPO_ROOT / "suites"))
