import subprocess
import sys
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


def test_file_lock_excludes_other_processes_until_owner_releases(tmp_path: Path) -> None:
    path = tmp_path / "publication.lock"
    code = (
        "from pathlib import Path; import sys; "
        "from benchmarks.orchestrator.locking import exclusive_file_lock; "
        "print('ready', flush=True); "
        "lock = exclusive_file_lock(Path(sys.argv[1])); "
        "lock.__enter__(); print('acquired', flush=True); lock.__exit__(None, None, None)"
    )
    process = None
    try:
        with exclusive_file_lock(path):
            process = subprocess.Popen(
                [sys.executable, "-c", code, str(path)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            assert process.stdout is not None
            assert process.stdout.readline().strip() == "ready"
            with pytest.raises(subprocess.TimeoutExpired):
                process.wait(timeout=0.2)
        stdout, stderr = process.communicate(timeout=5)
        assert process.returncode == 0, stderr
        assert stdout.strip() == "acquired"
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.communicate()
