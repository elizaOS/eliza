"""Turn skill — locomotion policy with yaw-only velocity commands."""

from __future__ import annotations

import numpy as np

from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus
from eliza_robot.rl.skills.walk_skill import NUM_LEG_JOINTS, WalkSkill


class TurnSkill(BaseSkill):
    """Turn in place using the locomotion policy with yaw commands.

    Reuses the walk policy but overrides the velocity command to yaw-only.
    """

    name = "turn"
    action_dim = NUM_LEG_JOINTS
    requires_rl = True

    def __init__(
        self,
        checkpoint_path: str | None = None,
        device: str = "cpu",
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self._walk = WalkSkill(
            checkpoint_path=checkpoint_path,
            device=device,
            profile_id=profile_id,
        )
        self._params = SkillParams()
        self._step = 0

    def reset(self, params: SkillParams | None = None) -> None:
        self._params = params or SkillParams()
        self._walk.reset(self._params)
        self._step = 0

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * 0.02
            if elapsed >= self._params.duration_sec:
                return np.zeros(self.action_dim, dtype=np.float32), SkillStatus.COMPLETED

        obs_modified = obs.copy()
        yaw_rate = self._params.direction * self._params.speed * 0.5
        obs_modified[9] = 0.0
        obs_modified[10] = 0.0
        obs_modified[11] = yaw_rate

        return self._walk.get_action(obs_modified)

    def load_checkpoint(self, path: str) -> None:
        self._walk.load_checkpoint(path)
