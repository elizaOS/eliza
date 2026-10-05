"""Repository-root report paths, matching packages/scripts/lib/test-output.ts."""

from pathlib import Path

from .repository import monorepo_root


def test_output_path(producer: str, *, workspace_root: Path | None = None) -> Path:
    root = monorepo_root(workspace_root or Path(__file__).resolve().parents[1])
    return root / "test-results" / producer
