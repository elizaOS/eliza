"""Named action playback for IsaacLab simulation.

Provides joint-trajectory definitions for named actions (wave, stand, kick, etc.)
that clients invoke via the action.play command. In simulation, these are played
back as joint position sequences; on the real robot, they map to action group files.
"""

from __future__ import annotations

from dataclasses import dataclass

from eliza_robot.bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
from eliza_robot.bridge.isaaclab.joint_map import JOINT_NAMES


@dataclass(frozen=True)
class ActionKeyframe:
    """Single keyframe in an action sequence."""

    positions: dict[str, float]
    duration_sec: float


@dataclass(frozen=True)
class ActionSequence:
    """Named action as a sequence of joint keyframes."""

    name: str
    keyframes: tuple[ActionKeyframe, ...]
    loop: bool = False


def _stand_positions() -> dict[str, float]:
    return dict(STAND_JOINT_POSITIONS)


def _zero_positions() -> dict[str, float]:
    return {name: 0.0 for name in JOINT_NAMES}


# Built-in action library.
ACTION_LIBRARY: dict[str, ActionSequence] = {
    "stand": ActionSequence(
        name="stand",
        keyframes=(ActionKeyframe(positions=_stand_positions(), duration_sec=1.0),),
    ),
    "wave": ActionSequence(
        name="wave",
        keyframes=(
            ActionKeyframe(
                positions={**_stand_positions(), "l_sho_pitch": -1.5, "l_sho_roll": 0.0},
                duration_sec=0.5,
            ),
            ActionKeyframe(
                positions={**_stand_positions(), "l_sho_pitch": -1.5, "l_el_yaw": 0.8},
                duration_sec=0.3,
            ),
            ActionKeyframe(
                positions={**_stand_positions(), "l_sho_pitch": -1.5, "l_el_yaw": -0.8},
                duration_sec=0.3,
            ),
            ActionKeyframe(
                positions={**_stand_positions(), "l_sho_pitch": -1.5, "l_el_yaw": 0.8},
                duration_sec=0.3,
            ),
            ActionKeyframe(positions=_stand_positions(), duration_sec=0.5),
        ),
    ),
    "bow": ActionSequence(
        name="bow",
        keyframes=(
            ActionKeyframe(
                positions={**_stand_positions(), "r_hip_pitch": -0.3, "l_hip_pitch": -0.3},
                duration_sec=0.8,
            ),
            ActionKeyframe(positions=_stand_positions(), duration_sec=0.8),
        ),
    ),
    "kick_right": ActionSequence(
        name="kick_right",
        keyframes=(
            # Shift weight to left leg.
            ActionKeyframe(
                positions={**_stand_positions(), "l_hip_roll": -0.1, "r_hip_roll": -0.1},
                duration_sec=0.5,
            ),
            # Lift and extend right leg.
            ActionKeyframe(
                positions={
                    **_stand_positions(),
                    "l_hip_roll": -0.1,
                    "r_hip_roll": -0.1,
                    "r_hip_pitch": -0.5,
                    "r_knee": 0.8,
                },
                duration_sec=0.3,
            ),
            # Kick forward.
            ActionKeyframe(
                positions={
                    **_stand_positions(),
                    "l_hip_roll": -0.1,
                    "r_hip_roll": -0.1,
                    "r_hip_pitch": -0.8,
                    "r_knee": 0.1,
                },
                duration_sec=0.2,
            ),
            # Return to stand.
            ActionKeyframe(positions=_stand_positions(), duration_sec=0.5),
        ),
    ),
    "sit": ActionSequence(
        name="sit",
        keyframes=(
            ActionKeyframe(
                positions={
                    **_stand_positions(),
                    "r_hip_pitch": -1.2,
                    "r_knee": 2.0,
                    "r_ank_pitch": -0.8,
                    "l_hip_pitch": -1.2,
                    "l_knee": 2.0,
                    "l_ank_pitch": -0.8,
                },
                duration_sec=1.5,
            ),
        ),
    ),
    "reset": ActionSequence(
        name="reset",
        keyframes=(ActionKeyframe(positions=_zero_positions(), duration_sec=2.0),),
    ),
}


def get_action(name: str) -> ActionSequence | None:
    """Look up a named action. Returns None if not found."""
    return ACTION_LIBRARY.get(name)


def list_actions() -> list[str]:
    """Return all available action names."""
    return sorted(ACTION_LIBRARY.keys())
