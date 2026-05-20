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
    policy_hidden_layer_sizes: tuple[int, ...] = (512, 256, 128)
    value_hidden_layer_sizes: tuple[int, ...] = (512, 256, 128)
    normalize_observations: bool = True


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
        policy_hidden_layer_sizes=tuple(
            raw.get("policy_hidden_layer_sizes", (512, 256, 128))
        ),
        value_hidden_layer_sizes=tuple(
            raw.get("value_hidden_layer_sizes", (512, 256, 128))
        ),
        normalize_observations=bool(raw.get("normalize_observations", True)),
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
        if self.manifest.regime == "brax_ppo":
            return _BraxPPOModelAdapter(
                ckpt_dir=self.ckpt_dir,
                manifest=self.manifest,
            )
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
        *,
        output_dim: int = 24,
    ) -> tuple[np.ndarray, str]:
        """Returns (action, matched_task_id). `proprio` may be padded internally
        to match the policy's expected obs dim.

        For policies that only control a subset of joints (e.g. the
        text_conditioned Brax env trains a 12-D leg-only action), the
        emitted action is right-padded with zeros up to `output_dim` so
        callers can drive a full 24-DoF target without special-casing.
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
        action = np.asarray(action, dtype=np.float32).reshape(-1)
        if action.shape[0] < output_dim:
            action = np.concatenate([
                action, np.zeros(output_dim - action.shape[0], dtype=np.float32)
            ])
        elif action.shape[0] > output_dim:
            action = action[:output_dim]
        return action, self._cached_task_id or ""

    @property
    def active_tasks(self) -> list[str]:
        return list(self.manifest.active_tasks)


# ---------------------------------------------------------------------- brax


class _BraxPPOModelAdapter:
    """Lightweight adapter that mimics SB3's `model.predict(obs, deterministic=)`
    interface using a Brax PPO policy.

    Brax PPO splits the policy into:
      - a `Normalizer` (running mean/var) applied to the obs
      - an MLP that emits (action_mean, log_std) of shape (2 * action_dim,)
      - tanh-squashed Normal sampling at the output

    We reconstruct the same `make_inference_fn` Brax PPO uses during
    training, then call it with the saved params. The brax params object
    we save is `(normalizer_params, policy_params, value_params)`.
    """

    def __init__(self, ckpt_dir: Path, manifest: CheckpointManifest) -> None:
        import functools

        import jax
        import jax.numpy as jp
        from brax.training.acme import running_statistics
        from brax.training.agents.ppo import networks as ppo_networks
        from brax.io import model as brax_model

        params_path = ckpt_dir / manifest.ckpt
        try:
            params = brax_model.load_params(str(params_path))
        except Exception:
            import pickle

            pkl_path = (
                str(params_path)
                if str(params_path).endswith(".pkl")
                else str(params_path) + ".pkl"
            )
            with open(pkl_path, "rb") as f:
                params = pickle.load(f)

        # Build the same network the trainer used.
        preprocess = (
            running_statistics.normalize
            if manifest.normalize_observations
            else lambda x, _: x
        )
        networks = ppo_networks.make_ppo_networks(
            observation_size=manifest.obs_dim,
            action_size=manifest.action_dim,
            preprocess_observations_fn=preprocess,
            policy_hidden_layer_sizes=tuple(manifest.policy_hidden_layer_sizes),
            value_hidden_layer_sizes=tuple(manifest.value_hidden_layer_sizes),
        )
        make_inference_fn = ppo_networks.make_inference_fn(networks)
        self._inference_fn = make_inference_fn(params, deterministic=True)
        self._key = jax.random.PRNGKey(0)
        self._jp = jp

        # Cache the jitted apply for low-latency repeated calls.
        @jax.jit
        def _act(obs, key):
            action, _ = self._inference_fn(obs, key)
            return action

        self._jit_act = _act

    def predict(self, obs, deterministic: bool = True):
        """SB3-compatible signature: returns (action, state)."""
        obs_arr = self._jp.asarray(obs, dtype=self._jp.float32)
        action = self._jit_act(obs_arr, self._key)
        import numpy as np

        return np.asarray(action, dtype=np.float32), None
