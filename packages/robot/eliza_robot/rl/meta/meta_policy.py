"""Meta-policy network: text embedding + robot state → skill selection + params.

Input: ``text_embedding(384) + robot_state(12) = 396``
  → ``Linear(396, 256) → ELU``
  → ``Linear(256, 128) → ELU``
  → ``skill_head: Linear(128, num_skills)`` (logits)
  → ``param_head: Linear(128, 4) → Tanh`` (``[speed, dir, mag, dur]``)
"""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
import torch.nn as nn

from eliza_robot.rl.meta.text_encoder import EMBEDDING_DIM

# Default robot state dim (12 leg joint positions).
ROBOT_STATE_DIM = 12

# Default number of skills.
DEFAULT_NUM_SKILLS = 5  # stand, walk, turn, wave, bow

# Skill param output dim.
PARAM_DIM = 4  # speed, direction, magnitude, duration


class MetaPolicyNetwork(nn.Module):
    """Neural meta-policy that selects skills and parameters from text + state."""

    def __init__(
        self,
        text_dim: int = EMBEDDING_DIM,
        state_dim: int = ROBOT_STATE_DIM,
        num_skills: int = DEFAULT_NUM_SKILLS,
        hidden_dims: tuple[int, int] = (256, 128),
    ):
        super().__init__()
        self.text_dim = text_dim
        self.state_dim = state_dim
        self.num_skills = num_skills

        input_dim = text_dim + state_dim

        self.shared = nn.Sequential(
            nn.Linear(input_dim, hidden_dims[0]),
            nn.ELU(),
            nn.Linear(hidden_dims[0], hidden_dims[1]),
            nn.ELU(),
        )

        self.skill_head = nn.Linear(hidden_dims[1], num_skills)
        self.param_head = nn.Sequential(
            nn.Linear(hidden_dims[1], PARAM_DIM),
            nn.Tanh(),
        )

    def forward(
        self, text_emb: torch.Tensor, state: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Forward pass.

        Args:
            text_emb: ``(N, text_dim)`` text embeddings.
            state: ``(N, state_dim)`` robot state.

        Returns:
            ``(skill_logits, params)`` where ``skill_logits`` is ``(N, num_skills)``
            raw logits and ``params`` is ``(N, 4)`` in ``[-1, 1]`` →
            ``[speed, direction, magnitude, duration]``.
        """
        x = torch.cat([text_emb, state], dim=-1)
        h = self.shared(x)
        skill_logits = self.skill_head(h)
        params = self.param_head(h)
        return skill_logits, params

    def predict(
        self, text_emb: torch.Tensor, state: torch.Tensor,
    ) -> tuple[int, dict[str, float]]:
        """Predict skill index and denormalized params for a single input."""
        if text_emb.dim() == 1:
            text_emb = text_emb.unsqueeze(0)
        if state.dim() == 1:
            state = state.unsqueeze(0)

        with torch.no_grad():
            logits, params = self.forward(text_emb, state)
            skill_idx = int(logits.argmax(dim=-1).item())
            p = params.squeeze(0)
            param_dict = {
                "speed": (p[0].item() + 1.0) / 2.0,       # [0, 1]
                "direction": p[1].item() * 3.14,            # [-π, π]
                "magnitude": (p[2].item() + 1.0) / 2.0,     # [0, 1]
                "duration_sec": (p[3].item() + 1.0) * 2.5,  # [0, 5]
            }

        return skill_idx, param_dict


class MetaPolicy:
    """High-level meta-policy combining text encoder + NN + skill registry."""

    def __init__(
        self,
        skill_names: list[str],
        text_dim: int = EMBEDDING_DIM,
        state_dim: int = ROBOT_STATE_DIM,
        device: str = "cpu",
    ):
        self.skill_names = skill_names
        self.device = torch.device(device)

        self.network = MetaPolicyNetwork(
            text_dim=text_dim,
            state_dim=state_dim,
            num_skills=len(skill_names),
        ).to(self.device)

    def select_skill(
        self,
        text_emb: np.ndarray,
        robot_state: np.ndarray,
    ) -> tuple[str, dict[str, float]]:
        """Select a skill from text embedding and robot state."""
        t_emb = torch.from_numpy(text_emb).float().to(self.device)
        t_state = torch.from_numpy(robot_state).float().to(self.device)

        skill_idx, params = self.network.predict(t_emb, t_state)
        skill_name = self.skill_names[skill_idx]

        return skill_name, params

    def load_checkpoint(self, path: str) -> None:
        ckpt = torch.load(path, map_location=self.device, weights_only=False)
        self.network.load_state_dict(ckpt["model"])
        self.network.eval()

    def save_checkpoint(self, path: str, extra: dict[str, Any] | None = None) -> None:
        state = {"model": self.network.state_dict(), "skill_names": self.skill_names}
        if extra:
            state.update(extra)
        torch.save(state, path)
