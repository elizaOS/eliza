"""eliza_robot.rl — Brax-PPO deployment skills and runtime harnesses.

This subpackage hosts the runtime-side of the RL stack: skill wrappers that
load Brax/JAX checkpoints, the composite (walk + upper-body) policy, the
text-conditioned meta policy, and deploy CLIs that drive the real robot via
the websocket bridge.

Training itself (Brax PPO loop, MuJoCo envs) lives under
`eliza_robot.sim.mujoco`. The skills here consume checkpoints produced by
that training.

Environment variables
---------------------

``ELIZA_ROBOT_CHECKPOINT_DIR``
    Root directory where named checkpoint subdirectories are looked up. Each
    skill resolves its default checkpoint as
    ``<ELIZA_ROBOT_CHECKPOINT_DIR>/<checkpoint_name>``. Defaults to
    ``packages/robot/checkpoints`` (i.e. the gitignored checkpoint store at
    the package root). Override this to point at a Nebius-mounted volume,
    object-storage cache, or an explicit per-environment path.

The directory itself is gitignored. Tiny smoke-test checkpoints used in CI
live under ``packages/robot/checkpoints/_validator/`` — see the README in
that directory.
"""

from __future__ import annotations

import os
from pathlib import Path


def checkpoint_root() -> Path:
    """Return the configured checkpoint root.

    Resolves ``ELIZA_ROBOT_CHECKPOINT_DIR`` if set, otherwise falls back to
    ``packages/robot/checkpoints`` relative to this file's package install
    location.
    """
    env = os.environ.get("ELIZA_ROBOT_CHECKPOINT_DIR")
    if env:
        return Path(env)
    # eliza_robot/rl/__init__.py -> ../../checkpoints (sibling of eliza_robot)
    return Path(__file__).resolve().parents[2] / "checkpoints"


def checkpoint_path(name: str) -> Path:
    """Resolve a named checkpoint subdirectory under the configured root."""
    return checkpoint_root() / name


__all__ = ["checkpoint_root", "checkpoint_path"]
