from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest

from benchmarks.orchestrator.locking import BenchmarkLockError, exclusive_file_lock


def test_nested_same_lock_rejects_without_poisoning_owner(tmp_path: Path) -> None:
    path = tmp_path / "publication.lock"
    with exclusive_file_lock(path):
        with pytest.raises(BenchmarkLockError, match="already held"):
            with exclusive_file_lock(path.parent / "." / path.name):
                pytest.fail("nested acquisition must be rejected")
        with exclusive_file_lock(tmp_path / "different.lock"):
            pass
    with exclusive_file_lock(path):
        pass


def test_failed_owner_releases_lock_to_waiting_thread(tmp_path: Path) -> None:
    path = tmp_path / "publication.lock"
    waiting = Event()
    acquired = Event()

    def contender() -> None:
        waiting.set()
        with exclusive_file_lock(path):
            acquired.set()

    with ThreadPoolExecutor(max_workers=1) as pool:
        with pytest.raises(ValueError, match="owner failed"):
            with exclusive_file_lock(path):
                future = pool.submit(contender)
                assert waiting.wait(5)
                assert not acquired.is_set()
                raise ValueError("owner failed")
        future.result(timeout=5)
        assert acquired.is_set()
