"""Pytest bootstrap: register the repo checkout as the ``benchmarks`` package.

The tests import ``benchmarks.nl2repo.*`` and ``benchmarks.orchestrator.*``.
In this standalone repo the checkout root is the ``benchmarks`` package and the
suites live under ``suites/``, so the package is registered here explicitly
(with ``suites/`` on its search path) regardless of the directory name the
repo was cloned into.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]

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
