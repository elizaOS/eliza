"""Resolve the standalone result store without silently mixing legacy artifacts."""
from pathlib import Path


class LegacyResultStoreError(RuntimeError):
    """A caller must explicitly archive or migrate results from the retired path."""


def result_store_root(workspace_root: Path) -> Path:
    legacy = workspace_root / "suites" / "benchmark_results"
    if legacy.is_dir() and next(legacy.iterdir(), None) is not None:
        raise LegacyResultStoreError(
            f"Legacy benchmark results exist at {legacy}. Archive or migrate that "
            f"directory explicitly before running or resuming in "
            f"{workspace_root / 'benchmark_results'}; no artifacts were moved or combined."
        )
    return workspace_root / "benchmark_results"
