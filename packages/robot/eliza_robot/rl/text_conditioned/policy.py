"""Inference wrapper for a trained text-conditioned policy.

Used by the bridge's `policy.start` / `policy.tick` handlers (and by the
real-robot evidence sweep) to load a checkpoint and emit 24-D joint
targets given (text instruction, proprioception).

The wrapper is intentionally agnostic to the training framework: it
expects a `policy.zip` (stable-baselines3) OR a `policy_brax.pkl`
(Brax-PPO) alongside `manifest.json`. The right loader is picked from
the manifest's `regime` field.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from eliza_robot.rl.text_conditioned.encoder import (
    TaskEmbedding,
    build_task_embeddings,
    project_text,
)


@dataclass
class CheckpointManifest:
    regime: str
    curriculum_version: int
    pca_dim: int
    active_tasks: list[str]
    obs_dim: int
    action_dim: int
    encoder_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    ckpt: str = "policy.zip"


def _load_manifest(ckpt_dir: Path) -> CheckpointManifest:
    raw = json.loads((ckpt_dir / "manifest.json").read_text())
    return CheckpointManifest(
        regime=raw["regime"],
        curriculum_version=int(raw["curriculum_version"]),
        pca_dim=int(raw["pca_dim"]),
        active_tasks=list(raw.get("active_tasks", [])),
        obs_dim=int(raw["obs_dim"]),
        action_dim=int(raw["action_dim"]),
        encoder_model=raw.get(
            "encoder_model", "sentence-transformers/all-MiniLM-L6-v2"
        ),
        ckpt=raw.get("ckpt", "policy.zip"),
    )


class TextConditionedPolicy:
    """Loads a checkpoint and exposes `act(text, proprio) -> 24-D action`."""

    def __init__(self, ckpt_dir: str | Path) -> None:
        self.ckpt_dir = Path(ckpt_dir)
        self.manifest = _load_manifest(self.ckpt_dir)
        self._embeddings: dict[str, TaskEmbedding] = build_task_embeddings(
            pca_dim=self.manifest.pca_dim
        )
        self._policy_cache_text: str | None = None
        self._cached_task_embed: np.ndarray | None = None
        self._cached_task_id: str | None = None
        self._model = self._load_model()

    # ------------------------------------------------------------------
    def _load_model(self):
        if self.manifest.regime.startswith("smoke_sb3"):
            from stable_baselines3 import PPO

            return PPO.load(str(self.ckpt_dir / self.manifest.ckpt), device="cpu")
        # Add Brax-PPO checkpoint loader when --full path lands.
        raise NotImplementedError(
            f"unsupported regime in manifest: {self.manifest.regime}"
        )

    # ------------------------------------------------------------------
    def resolve_task(self, text: str) -> tuple[str, np.ndarray, float]:
        """Map free-form text to (task_id, task_embed, similarity)."""
        if text == self._policy_cache_text and self._cached_task_embed is not None:
            assert self._cached_task_id is not None
            return self._cached_task_id, self._cached_task_embed, 1.0
        task_id, embed, sim = project_text(text, embeddings=self._embeddings)
        self._policy_cache_text = text
        self._cached_task_embed = embed.astype(np.float32)
        self._cached_task_id = task_id
        return task_id, self._cached_task_embed, float(sim)

    def act(
        self,
        text: str,
        proprio: np.ndarray,
        deterministic: bool = True,
    ) -> tuple[np.ndarray, str]:
        """Returns (action, matched_task_id). `proprio` may be padded internally
        to match the policy's expected obs dim.
        """
        _, task_embed, _ = self.resolve_task(text)
        proprio_dim = self.manifest.obs_dim - task_embed.shape[0]
        if proprio.shape[0] < proprio_dim:
            proprio = np.concatenate([
                proprio.astype(np.float32),
                np.zeros(proprio_dim - proprio.shape[0], dtype=np.float32),
            ])
        elif proprio.shape[0] > proprio_dim:
            proprio = proprio[:proprio_dim].astype(np.float32)
        obs = np.concatenate([proprio.astype(np.float32), task_embed])
        action, _ = self._model.predict(obs, deterministic=deterministic)
        return np.asarray(action, dtype=np.float32), self._cached_task_id or ""

    @property
    def active_tasks(self) -> list[str]:
        return list(self.manifest.active_tasks)
