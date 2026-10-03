"""Locate the containing runtime checkout without depending on nested Git metadata."""

from pathlib import Path


def monorepo_root(benchmarks_root: Path) -> Path:
    """Return the runtime root for an in-repo benchmark tree or isolated fixture."""
    root = benchmarks_root.resolve()
    if root.name == "benchmarks" and root.parent.name == "packages":
        return root.parent.parent
    return root
