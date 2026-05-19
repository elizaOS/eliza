"""MuJoCo simulation for the AiNex robot (eliza_robot.sim.mujoco).

This package was ported from the SSD `training/mujoco/` tree. Asset paths
are resolved via the profile-aware ``_resolve_mjcf`` helper below until the
W1.4 profile manifest system fully subsumes lookups.
"""

from __future__ import annotations

from pathlib import Path

# Package-local directory (where the legacy ROOT_PATH used to point).
_PKG_DIR = Path(__file__).resolve().parent

# Primary profile MJCF directory (W2.2 sibling agent owns this tree).
# packages/robot/eliza_robot/sim/mujoco/__init__.py
#   -> packages/robot/eliza_robot/sim/mujoco
#   -> packages/robot/eliza_robot/sim
#   -> packages/robot/eliza_robot
#   -> packages/robot
_PACKAGE_ROOT = _PKG_DIR.parent.parent.parent
_PROFILE_MJCF_DIR = (
    _PACKAGE_ROOT / "assets" / "profiles" / "hiwonder-ainex" / "mjcf"
)


def _resolve_mjcf(filename: str) -> Path:
    """Resolve an MJCF/XML asset by name.

    Search order:
      1. ``packages/robot/assets/profiles/hiwonder-ainex/mjcf/<filename>``
         (canonical W2.2 location)
      2. ``packages/robot/eliza_robot/sim/mujoco/<filename>`` (fallback for
         files that haven't been migrated into the profile asset dir yet)

    Raises:
        FileNotFoundError: if the asset cannot be located in either path.
    """
    candidates = (
        _PROFILE_MJCF_DIR / filename,
        _PKG_DIR / filename,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    searched = "\n  - ".join(str(c) for c in candidates)
    raise FileNotFoundError(
        f"MJCF asset {filename!r} not found. Searched:\n  - {searched}"
    )


__all__ = ["_resolve_mjcf"]
