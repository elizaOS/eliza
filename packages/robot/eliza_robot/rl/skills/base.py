"""Abstract skill interface and supporting types.

Ported from `training.rl.skills.base_skill`. The module is named `base`
(rather than `base_skill`) so callers can write
``from eliza_robot.rl.skills.base import BaseSkill``.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum

import numpy as np


class SkillStatus(Enum):
    """Status returned by skill execution."""
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class SkillParams:
    """Parameters passed to a skill on reset/activation."""
    speed: float = 1.0         # Speed multiplier (0..1 for walk).
    direction: float = 0.0     # Direction in radians or normalized (-1 left, +1 right).
    magnitude: float = 1.0     # General-purpose intensity.
    duration_sec: float = 0.0  # Max duration (0 = unlimited / skill decides).

    def to_dict(self) -> dict[str, float]:
        return {
            "speed": self.speed,
            "direction": self.direction,
            "magnitude": self.magnitude,
            "duration_sec": self.duration_sec,
        }


class BaseSkill(ABC):
    """Abstract base for all eliza_robot skills (RL-trained or scripted)."""

    name: str = "unnamed"
    action_dim: int = 12
    requires_rl: bool = False
    profile_id: str = "hiwonder-ainex"

    @abstractmethod
    def reset(self, params: SkillParams | None = None) -> None:
        """Initialize/reset the skill with optional parameters."""
        ...

    @abstractmethod
    def get_action(self, obs: np.ndarray) -> tuple[np.ndarray, SkillStatus]:
        """Compute one step of the skill.

        Args:
            obs: Current observation vector.

        Returns:
            (action, status) — action array and skill status.
        """
        ...

    def load_checkpoint(self, path: str) -> None:
        """Load a trained checkpoint. No-op for scripted skills."""
        return None
