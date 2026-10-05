"""Resolve one explicit result archive without silently mixing historical stores."""

import os
from pathlib import Path

from benchmarks.lib.output import test_output_path


class LegacyResultStoreError(RuntimeError):
    """The operator must select or migrate a retired result archive explicitly."""


def result_store_root(workspace_root: Path) -> Path:
    override = os.environ.get("BENCHMARK_RESULTS_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    target = test_output_path("benchmark-orchestrator", workspace_root=workspace_root)
    for legacy in (
        workspace_root / "benchmark_results",
        workspace_root / "suites" / "benchmark_results",
    ):
        if legacy.is_dir() and next(legacy.iterdir(), None) is not None:
            raise LegacyResultStoreError(
                f"Legacy benchmark results exist at {legacy}. Archive or migrate that "
                f"directory explicitly, or set BENCHMARK_RESULTS_DIR={legacy} to read/resume it. "
                f"The default is {target}; no artifacts were moved or combined."
            )
    return target
