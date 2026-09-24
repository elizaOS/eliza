"""Pytest bootstrap: make ``benchmarks.<suite>`` imports resolve from a standalone checkout.

The repo root is the ``benchmarks`` package and suites live under ``suites/``,
so the package is loaded explicitly with ``suites/`` on its search path. This
works regardless of the checkout directory name.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SUITES_DIR = str(_REPO_ROOT / "suites")

if "benchmarks" in sys.modules:
    _pkg = sys.modules["benchmarks"]
    if _SUITES_DIR not in _pkg.__path__:
        _pkg.__path__.append(_SUITES_DIR)
else:
    _spec = importlib.util.spec_from_file_location(
        "benchmarks",
        _REPO_ROOT / "__init__.py",
        submodule_search_locations=[str(_REPO_ROOT), _SUITES_DIR],
    )
    assert _spec is not None and _spec.loader is not None
    _module = importlib.util.module_from_spec(_spec)
    sys.modules["benchmarks"] = _module
    _spec.loader.exec_module(_module)

# The tests drive the eliza harness adapter directly; make it importable from a
# plain checkout (it is an editable install when running under uv).
_ELIZA_HARNESS = str(_REPO_ROOT / "harnesses" / "eliza")
if _ELIZA_HARNESS not in sys.path:
    sys.path.insert(0, _ELIZA_HARNESS)
