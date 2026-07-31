"""Deterministic unit tests for the archive-only fixture preflight
(fixture_guard.py) — real tmp-dir task layouts, no Docker and no model."""

from pathlib import Path

import pytest

from elizaos_terminal_bench.fixture_guard import (
    ARCHIVE_ONLY_FIXTURES,
    MissingArchiveFixtureError,
    require_task_fixtures,
)


def test_unguarded_task_passes(tmp_path: Path) -> None:
    task_dir = tmp_path / "hello-world"
    task_dir.mkdir()
    require_task_fixtures(task_dir)


def test_missing_fixture_raises_named_error(tmp_path: Path) -> None:
    task_dir = tmp_path / "fmri-encoding-r"
    task_dir.mkdir()
    with pytest.raises(MissingArchiveFixtureError) as excinfo:
        require_task_fixtures(task_dir)
    message = str(excinfo.value)
    assert "fMRIdata.RData" in message
    assert "#16290" in message
    assert "eliza-archive" in message
    # Typed as FileNotFoundError so existing ENOENT handling still applies.
    assert isinstance(excinfo.value, FileNotFoundError)
    assert excinfo.value.task_id == "fmri-encoding-r"


def test_present_fixture_passes(tmp_path: Path) -> None:
    task_dir = tmp_path / "fmri-encoding-r"
    task_dir.mkdir()
    (task_dir / "fMRIdata.RData").write_bytes(b"stub")
    require_task_fixtures(task_dir)


def test_partial_fixtures_name_only_the_missing(tmp_path: Path) -> None:
    task_dir = tmp_path / "video-processing"
    (task_dir / "tests").mkdir(parents=True)
    (task_dir / "example_video.mp4").write_bytes(b"stub")
    with pytest.raises(MissingArchiveFixtureError) as excinfo:
        require_task_fixtures(task_dir)
    message = str(excinfo.value)
    assert "tests/test_video.mp4" in message
    assert "example_video.mp4" not in message.replace("tests/test_video.mp4", "")


def test_inventory_matches_real_task_dirs() -> None:
    tasks_root = Path(__file__).resolve().parents[1] / "tasks"
    for task_id in ARCHIVE_ONLY_FIXTURES:
        assert (tasks_root / task_id / "task.yaml").is_file(), (
            f"fixture_guard inventory names unknown task '{task_id}'"
        )
