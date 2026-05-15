"""Test path bootstrap for the local CompactBench harness."""

from __future__ import annotations

import sys
from pathlib import Path


COMPACTBENCH_ROOT = Path(__file__).resolve().parents[1]
BENCHMARKS_ROOT = COMPACTBENCH_ROOT.parent

for path in (
    COMPACTBENCH_ROOT,
    COMPACTBENCH_ROOT / "external" / "compactbench-suites" / "src",
    BENCHMARKS_ROOT / "hermes-adapter",
    BENCHMARKS_ROOT / "openclaw-adapter",
):
    path_str = str(path)
    if path.exists() and path_str not in sys.path:
        sys.path.insert(0, path_str)
