"""Cross-process locks for benchmark execution and generated publications.

Benchmark subprocesses may run concurrently, but campaign ordering and shared
``latest`` artifacts are single-writer resources. These locks combine an
in-process reentrant lock with the host's advisory file lock so threads and
separate orchestrator processes obey the same boundary.
"""

from __future__ import annotations

import os
import threading
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from functools import wraps
from pathlib import Path
from typing import ParamSpec, TypeVar

_LOCKS_GUARD = threading.Lock()
_THREAD_LOCKS: dict[Path, threading.RLock] = {}

P = ParamSpec("P")
R = TypeVar("R")


def _thread_lock(path: Path) -> threading.RLock:
    resolved = path.resolve()
    with _LOCKS_GUARD:
        return _THREAD_LOCKS.setdefault(resolved, threading.RLock())


def _acquire_platform_lock(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)


def _release_platform_lock(handle) -> None:
    if os.name == "nt":
        import msvcrt

        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def exclusive_file_lock(path: Path) -> Iterator[None]:
    """Hold a blocking advisory lock for ``path`` until the context exits."""

    path.parent.mkdir(parents=True, exist_ok=True)
    local_lock = _thread_lock(path)
    with local_lock:
        with path.open("a+b") as handle:
            _acquire_platform_lock(handle)
            try:
                yield
            finally:
                _release_platform_lock(handle)


def latest_publication_lock(output_root: Path) -> AbstractContextManager[None]:
    """Serialize writers that rebuild latest/quarantine/viewer artifacts."""

    return exclusive_file_lock(output_root / ".latest-publication.lock")


def campaign_execution_lock(output_root: Path) -> AbstractContextManager[None]:
    """Keep independent cohort campaigns from interleaving benchmarks."""

    return exclusive_file_lock(output_root / ".cohort-execution.lock")


def serialize_on_output_root(
    position: int,
) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorate a function whose output-root argument occupies ``position``."""

    def decorate(function: Callable[P, R]) -> Callable[P, R]:
        @wraps(function)
        def locked(*args: P.args, **kwargs: P.kwargs) -> R:
            raw_root = kwargs.get("output_root")
            if raw_root is None:
                raw_root = args[position]
            with latest_publication_lock(Path(raw_root)):
                return function(*args, **kwargs)

        return locked

    return decorate
