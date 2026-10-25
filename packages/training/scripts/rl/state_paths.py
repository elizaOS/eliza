"""Resolves Python training state paths with the elizaOS runtime precedence.

The join helper mirrors Node's platform `path.join`: rooted or drive-qualified
later segments stay beneath the chosen base instead of replacing it.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Protocol


class _PathOperations(Protocol):
    sep: str

    def abspath(self, path: str) -> str: ...

    def isabs(self, path: str) -> bool: ...

    def normpath(self, path: str) -> str: ...


def _runtime_join(path_operations: _PathOperations, *parts: str) -> str:
    populated = [part for part in parts if part]
    return path_operations.normpath(path_operations.sep.join(populated) or ".")


def resolve_state_dir(
    env: Mapping[str, str] | None = None,
    *,
    get_home: Callable[[], str] | None = None,
    path_operations: _PathOperations = os.path,
) -> str:
    """Apply `ELIZA_STATE_DIR` → XDG → home state-directory precedence."""

    active_env = os.environ if env is None else env
    home = get_home() if get_home is not None else str(Path.home())
    configured = active_env.get("ELIZA_STATE_DIR", "").strip()
    if configured:
        if configured == "~" or configured.startswith(("~/", "~\\")):
            configured = f"{home}{configured[1:]}"
        return path_operations.abspath(configured)

    namespace = active_env.get("ELIZA_NAMESPACE", "").strip() or "eliza"
    xdg_state_home = active_env.get("XDG_STATE_HOME", "").strip()
    if xdg_state_home:
        base = (
            xdg_state_home
            if path_operations.isabs(xdg_state_home)
            else _runtime_join(path_operations, home, xdg_state_home)
        )
    else:
        base = _runtime_join(path_operations, home, ".local", "state")
    return _runtime_join(path_operations, base, namespace)


def resolve_trajectory_dir(env: Mapping[str, str] | None = None) -> str:
    """Apply the native recorder override before the shared state root."""

    active_env = os.environ if env is None else env
    explicit = active_env.get("ELIZA_TRAJECTORY_DIR", "").strip()
    if explicit:
        return explicit
    return _runtime_join(os.path, resolve_state_dir(active_env), "trajectories")


def default_trajectory_dir() -> str:
    """Return the active native trajectory recorder directory."""

    return resolve_trajectory_dir()


def default_curriculum_checkpoint_path() -> str:
    """Return the mutable curriculum checkpoint outside the checkout."""

    return _runtime_join(
        os.path,
        resolve_state_dir(),
        "training",
        "curriculum_state.json",
    )
