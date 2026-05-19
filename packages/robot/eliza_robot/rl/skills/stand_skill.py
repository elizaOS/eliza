"""Stand skill — static standing pose from ``STAND_JOINT_POSITIONS``.

Depends on ``eliza_robot.bridge.isaaclab`` (W3.1).
"""

from __future__ import annotations

import numpy as np

from eliza_robot.bridge.isaaclab.ainex_cfg import STAND_JOINT_POSITIONS
from eliza_robot.bridge.isaaclab.joint_map import JOINT_NAMES
from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus


class StandSkill(BaseSkill):
    """Hold the robot at the default standing pose."""

    name = "stand"
    action_dim = 24  # full body
    requires_rl = False

    def __init__(self, profile_id: str = "hiwonder-ainex") -> None:
        self.profile_id = profile_id
        self._target = np.array(
            [STAND_JOINT_POSITIONS[n] for n in JOINT_NAMES], dtype=np.float32,
        )

    def reset(self, params: SkillParams | None = None) -> None:
        return None

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        return self._target.copy(), SkillStatus.RUNNING
