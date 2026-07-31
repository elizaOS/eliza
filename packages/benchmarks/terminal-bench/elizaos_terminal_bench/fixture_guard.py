"""Fail-closed preflight for archive-only Terminal-Bench task fixtures.

A handful of vendored task fixtures (large binaries and datasets) were never
committed to this repository — they were delivered by the global artifact sync
(`sync-artifacts.mjs`), which is retired (issue #16290). Without the sync there
is no in-repo producer for these files, so a run that reaches one of them would
die with a bare ENOENT deep inside a Docker build or file-staging step. This
module names the missing file up front instead: environments call
``require_task_fixtures(task_dir)`` before building or staging a task, and it
raises :class:`MissingArchiveFixtureError` with the retirement context and the
recovery path (elizaOS/eliza-archive) when a required fixture is absent.
"""

from __future__ import annotations

from pathlib import Path

# Task-relative fixture paths that only ever existed via the retired artifact
# sync (the deleted `.gitignore` sync block is the authoritative inventory).
ARCHIVE_ONLY_FIXTURES: dict[str, tuple[str, ...]] = {
    "build-pov-ray": ("tests/reference_illum1.png",),
    "causal-inference-r": ("task-deps/data.csv",),
    "download-youtube": ("tests/long_trunks.mp4",),
    "financial-document-processor": (
        "documents/1t2tala7.jpg",
        "documents/53lc58dr.jpg",
        "documents/sg65kxvf.jpg",
        "documents/ujv6oh9s.jpg",
    ),
    "fmri-encoding-r": ("fMRIdata.RData",),
    "gcode-to-text": ("text.gcode.gz",),
    "reshard-c4-data": ("tests/files_hashes.json",),
    "sqlite-with-gcov": ("vendor/sqlite-fossil-release.tar.gz",),
    "train-fasttext": ("tests/private_test.txt",),
    "video-processing": ("example_video.mp4", "tests/test_video.mp4"),
    "weighted-max-sat-solver": ("test_instance.wcnf",),
}


class MissingArchiveFixtureError(FileNotFoundError):
    """A task requires an archive-only fixture that is not present on disk."""

    def __init__(self, task_id: str, missing: list[Path]) -> None:
        self.task_id = task_id
        self.missing = missing
        listing = "\n".join(f"  - {path}" for path in missing)
        super().__init__(
            f"Terminal-Bench task '{task_id}' requires fixture file(s) that are not in "
            f"the repository:\n{listing}\n"
            "These fixtures were previously delivered by the global artifact sync, "
            "which is retired (elizaOS/eliza#16290) and has no in-repo producer. "
            "To run this task, restore the file(s) from the archive: "
            "elizaOS/eliza-archive release 'dev-artifacts' (eliza-dev-artifacts.tar.gz), "
            "or the develop-old/main-old branches, then place them at the paths above."
        )


def require_task_fixtures(task_dir: Path) -> None:
    """Raise :class:`MissingArchiveFixtureError` if ``task_dir`` is a task known
    to depend on archive-only fixtures and any of them are missing."""
    required = ARCHIVE_ONLY_FIXTURES.get(task_dir.name)
    if not required:
        return
    missing = [task_dir / rel for rel in required if not (task_dir / rel).is_file()]
    if missing:
        raise MissingArchiveFixtureError(task_dir.name, missing)
