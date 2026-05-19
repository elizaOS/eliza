"""Wave skill — scripted keyframe playback from ``ACTION_LIBRARY``.

Imports ``eliza_robot.bridge.isaaclab`` (ported in W3.1). When that module
is not present this skill is unimportable; that is the accepted failure
mode until the bridge port lands.
"""

from __future__ import annotations

import time

import numpy as np

from eliza_robot.bridge.isaaclab.actions import ACTION_LIBRARY
from eliza_robot.bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
from eliza_robot.bridge.isaaclab.joint_map import JOINT_NAMES
from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus


class WaveSkill(BaseSkill):
    """Wave hand using keyframes from ``ACTION_LIBRARY["wave"]``."""

    name = "wave"
    action_dim = 24
    requires_rl = False

    def __init__(self, profile_id: str = "hiwonder-ainex") -> None:
        self.profile_id = profile_id
        self._sequence = ACTION_LIBRARY["wave"]
        self._start_time: float = 0.0
        self._total_duration: float = sum(
            kf.duration_sec for kf in self._sequence.keyframes
        )

    def reset(self, params: SkillParams | None = None) -> None:
        self._start_time = time.monotonic()

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        elapsed = time.monotonic() - self._start_time

        if elapsed >= self._total_duration:
            positions = dict(STAND_JOINT_POSITIONS)
            action = np.array([positions.get(n, 0.0) for n in JOINT_NAMES], dtype=np.float32)
            return action, SkillStatus.COMPLETED

        t = 0.0
        prev_positions = dict(STAND_JOINT_POSITIONS)
        for kf in self._sequence.keyframes:
            if t + kf.duration_sec > elapsed:
                alpha = (elapsed - t) / kf.duration_sec
                positions = {}
                for name in JOINT_NAMES:
                    start = prev_positions.get(name, 0.0)
                    end = kf.positions.get(name, start)
                    positions[name] = start + alpha * (end - start)
                break
            t += kf.duration_sec
            prev_positions = dict(kf.positions)
        else:
            positions = dict(STAND_JOINT_POSITIONS)

        action = np.array([positions.get(n, 0.0) for n in JOINT_NAMES], dtype=np.float32)
        return action, SkillStatus.RUNNING
