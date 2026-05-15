"""Tests for the context-bench CLI wrapper."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_run_benchmark_module():
    module_path = Path(__file__).resolve().parents[1] / "run_benchmark.py"
    spec = importlib.util.spec_from_file_location("context_bench_run_benchmark", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load run_benchmark.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_adapter_import_paths_are_present_and_idempotent() -> None:
    """ContextBench can import all supported harness adapters repeatedly."""
    module = _load_run_benchmark_module()

    expected = [
        str(module.BENCHMARK_DIR.resolve()),
        *(str(path.resolve()) for path in module.ADAPTER_DIRS if path.is_dir()),
    ]
    before = {path: sys.path.count(path) for path in expected}

    module._ensure_context_bench_import_paths()

    for path in expected:
        assert path in sys.path
        assert sys.path.count(path) == before[path]
