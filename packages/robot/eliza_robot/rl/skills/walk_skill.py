"""Walk skill — wraps a trained locomotion policy for deployment.

This is the original PyTorch-backed walking skill kept for back-compat
with the test suite. Prefer ``BraxWalkSkill`` for Brax/JAX checkpoints.
"""

from __future__ import annotations

import numpy as np
import torch

from eliza_robot.rl.skills.base import BaseSkill, SkillParams, SkillStatus

NUM_LEG_JOINTS = 12


class WalkSkill(BaseSkill):
    """Walk using a trained locomotion policy.

    Falls back to zero actions if no checkpoint is loaded.
    """

    name = "walk"
    action_dim = NUM_LEG_JOINTS
    requires_rl = True

    def __init__(
        self,
        checkpoint_path: str | None = None,
        device: str = "cpu",
        profile_id: str = "hiwonder-ainex",
    ) -> None:
        self.profile_id = profile_id
        self._device = torch.device(device)
        self._model: torch.nn.Module | None = None
        self._params = SkillParams()
        self._step = 0

        if checkpoint_path:
            self.load_checkpoint(checkpoint_path)

    def reset(self, params: SkillParams | None = None) -> None:
        self._params = params or SkillParams()
        self._step = 0

    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        self._step += 1

        if self._params.duration_sec > 0:
            elapsed = self._step * 0.02  # 50 Hz policy
            if elapsed >= self._params.duration_sec:
                return np.zeros(self.action_dim, dtype=np.float32), SkillStatus.COMPLETED

        if self._model is None:
            return np.zeros(self.action_dim, dtype=np.float32), SkillStatus.RUNNING

        with torch.no_grad():
            obs_t = torch.from_numpy(obs).float().unsqueeze(0).to(self._device)
            action = self._model.actor(obs_t)
            action = torch.clamp(action, -1.0, 1.0)

        return action.squeeze(0).cpu().numpy(), SkillStatus.RUNNING

    def load_checkpoint(self, path: str) -> None:
        """Load a trained locomotion checkpoint.

        Supports legacy PyTorch checkpoints. For Brax checkpoints use
        ``BraxWalkSkill`` which goes through
        ``eliza_robot.sim.mujoco.inference.load_policy``.
        """
        ckpt = torch.load(path, map_location=self._device, weights_only=False)
        if "model" in ckpt:
            model = ckpt["model"]
            if isinstance(model, dict):
                return None
            model.eval()
            self._model = model
