"""Load the consolidated ``registry.py`` module without import ambiguity."""

from __future__ import annotations

import importlib.util
import sys
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Any


@lru_cache(maxsize=1)
def load_registry_module() -> ModuleType:
    registry_path = Path(__file__).resolve().parents[1] / "registry.py"
    benchmarks_root = str(registry_path.parent)
    packages_root = str(registry_path.parent.parent)
    for path in (benchmarks_root, packages_root):
        if path not in sys.path:
            sys.path.insert(0, path)
    spec = importlib.util.spec_from_file_location("_benchmarks_registry_impl", registry_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load benchmark registry from {registry_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(spec.name, module)
    spec.loader.exec_module(module)
    return module


def export_public_names() -> dict[str, Any]:
    module = load_registry_module()
    names = getattr(module, "__all__", None)
    if names is None:
        names = [
            name
            for name in vars(module)
            if not name.startswith("__")
            and (
                not name.startswith("_")
                or name.startswith("_score_from_")
                or name == "_standard_benchmark_metrics"
            )
        ]
    return {name: getattr(module, name) for name in names if hasattr(module, name)}
