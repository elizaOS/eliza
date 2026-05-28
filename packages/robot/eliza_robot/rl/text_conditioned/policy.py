"""Inference wrapper for a trained text-conditioned policy.

Used by the bridge's `policy.start` / `policy.tick` handlers (and by the
real-robot evidence sweep) to load a checkpoint and emit 24-D joint
targets given (text instruction, proprioception).

The wrapper is intentionally agnostic to the training framework: it expects an
`alberta_policy.npz` (Alberta streaming controller), `policy.zip`
(stable-baselines3), or `policy_brax.pkl` (Brax-PPO) alongside
`manifest.json`. The right loader is picked from the manifest's `regime` field.
"""

from __future__ import annotations

import json
import re
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
    profile_id: str = "hiwonder-ainex"
    proprio_dim: int | None = None
    text_dim: int | None = None
    output_dim: int = 24
    critic_obs_dim: int | None = None
    policy_obs_key: str = "state"
    value_obs_key: str = "state"
    encoder_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    ckpt: str = "policy.zip"
    policy_hidden_layer_sizes: tuple[int, ...] = (512, 256, 128)
    value_hidden_layer_sizes: tuple[int, ...] = (512, 256, 128)
    normalize_observations: bool = True
    action_scale: float | None = None


def _load_manifest(ckpt_dir: Path, *, strict: bool = False) -> CheckpointManifest:
    raw = json.loads((ckpt_dir / "manifest.json").read_text())
    if strict:
        missing = [
            key
            for key in ("profile_id", "output_dim", "curriculum_version")
            if raw.get(key) is None
        ]
        if missing:
            raise ValueError(
                f"checkpoint manifest {ckpt_dir / 'manifest.json'} is missing "
                f"required production field(s): {', '.join(missing)}"
            )
    return CheckpointManifest(
        regime=raw["regime"],
        curriculum_version=int(raw["curriculum_version"]),
        pca_dim=int(raw["pca_dim"]),
        active_tasks=list(raw.get("active_tasks", [])),
        obs_dim=int(raw["obs_dim"]),
        action_dim=int(raw["action_dim"]),
        profile_id=raw.get("profile_id", "hiwonder-ainex"),
        proprio_dim=raw.get("proprio_dim"),
        text_dim=raw.get("text_dim"),
        output_dim=int(raw.get("output_dim", raw.get("action_dim", 24))),
        critic_obs_dim=(
            int(raw["critic_obs_dim"]) if raw.get("critic_obs_dim") is not None else None
        ),
        policy_obs_key=raw.get("policy_obs_key", "state"),
        value_obs_key=raw.get("value_obs_key", "state"),
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
        action_scale=(
            float(raw["action_scale"]) if raw.get("action_scale") is not None else None
        ),
    )


def _normalize_task_text(text: str) -> str:
    text = text.lower().replace("_", " ").replace("-", " ")
    return re.sub(r"\s+", " ", text).strip()


def _fallback_task_match(
    text: str,
    *,
    active_tasks: list[str],
    embeddings: dict[str, TaskEmbedding],
) -> tuple[str, float]:
    candidates = [task for task in (active_tasks or list(embeddings)) if task in embeddings]
    if not candidates:
        raise ValueError("checkpoint/curriculum has no task embeddings")

    normalized_text = _normalize_task_text(text)
    for candidate in candidates:
        embedding = embeddings[candidate]
        aliases = [candidate, *embedding.variants]
        for alias in aliases:
            normalized = _normalize_task_text(alias)
            if not normalized:
                continue
            tokens = normalized.split()
            if normalized == normalized_text or normalized in normalized_text:
                return candidate, 1.0
            if tokens and all(token in normalized_text for token in tokens):
                return candidate, 0.9
    return candidates[0], 0.0


class TextConditionedPolicy:
    """Loads a checkpoint and exposes `act(text, proprio) -> 24-D action`."""

    def __init__(self, ckpt_dir: str | Path, *, strict_manifest: bool = False) -> None:
        self.ckpt_dir = Path(ckpt_dir)
        self.manifest = _load_manifest(self.ckpt_dir, strict=strict_manifest)
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
        if self.manifest.regime == "numpy_linear_rl_smoke":
            return _NumpyLinearPolicyModelAdapter(self.ckpt_dir / self.manifest.ckpt)
        if self.manifest.regime == "alberta_streaming":
            return _AlbertaStreamingModelAdapter(self.ckpt_dir)
        raise NotImplementedError(
            f"unsupported regime in manifest: {self.manifest.regime}"
        )

    # ------------------------------------------------------------------
    def resolve_task(self, text: str) -> tuple[str, np.ndarray, float]:
        """Map free-form text to (task_id, task_embed, similarity)."""
        if text == self._policy_cache_text and self._cached_task_embed is not None:
            assert self._cached_task_id is not None
            return self._cached_task_id, self._cached_task_embed, 1.0
        if text in self._embeddings:
            task_id = text
            embed = self._embeddings[text].reduced_embed
            sim = 1.0
        else:
            try:
                task_id, embed, sim = project_text(text, embeddings=self._embeddings)
            except ModuleNotFoundError:
                task_id, sim = _fallback_task_match(
                    text,
                    active_tasks=self.manifest.active_tasks,
                    embeddings=self._embeddings,
                )
                embed = self._embeddings[task_id].reduced_embed
        text_dim = int(self.manifest.text_dim or self.manifest.pca_dim)
        embed = _pad_or_trim(np.asarray(embed, dtype=np.float32), text_dim)
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
        output_dim: int | None = None,
    ) -> tuple[np.ndarray, str]:
        """Returns (action, matched_task_id). `proprio` may be padded internally
        to match the policy's expected obs dim.

        For policies that only control a subset of joints (e.g. the
        text_conditioned Brax env trains a 12-D leg-only action), the
        emitted action is right-padded with zeros up to `output_dim` so
        callers can drive a full 24-DoF target without special-casing.
        """
        _, task_embed, _ = self.resolve_task(text)
        output_dim = int(output_dim or self.manifest.output_dim)
        proprio_dim = int(self.manifest.proprio_dim or (self.manifest.obs_dim - task_embed.shape[0]))
        model_obs_dim = int(getattr(self._model, "observation_dim", self.manifest.obs_dim))
        task_embed = _pad_or_trim(task_embed, max(0, model_obs_dim - proprio_dim))
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

        import jax
        import jax.numpy as jp
        from brax.io import model as brax_model
        from brax.training.acme import running_statistics
        from brax.training.agents.ppo import networks as ppo_networks

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

        self.observation_dim = manifest.obs_dim
        try:
            normalizer_mean = getattr(params[0], "mean", None)
            if isinstance(normalizer_mean, dict) and manifest.policy_obs_key in normalizer_mean:
                self.observation_dim = int(normalizer_mean[manifest.policy_obs_key].shape[0])
        except Exception:
            pass

        # Build the same network the trainer used.
        preprocess = (
            running_statistics.normalize
            if manifest.normalize_observations
            else lambda x, _: x
        )
        asymmetric_obs = manifest.value_obs_key != manifest.policy_obs_key
        critic_obs_dim = int(manifest.critic_obs_dim or manifest.obs_dim)
        if self.observation_dim != manifest.obs_dim:
            critic_obs_dim = max(
                self.observation_dim,
                critic_obs_dim - (manifest.obs_dim - self.observation_dim),
            )
        observation_size = (
            {
                manifest.policy_obs_key: self.observation_dim,
                manifest.value_obs_key: critic_obs_dim,
            }
            if asymmetric_obs
            else self.observation_dim
        )
        networks = ppo_networks.make_ppo_networks(
            observation_size=observation_size,
            action_size=manifest.action_dim,
            preprocess_observations_fn=preprocess,
            policy_hidden_layer_sizes=tuple(manifest.policy_hidden_layer_sizes),
            value_hidden_layer_sizes=tuple(manifest.value_hidden_layer_sizes),
            policy_obs_key=manifest.policy_obs_key,
            value_obs_key=manifest.value_obs_key,
        )
        make_inference_fn = ppo_networks.make_inference_fn(networks)
        self._inference_fn = make_inference_fn(params, deterministic=True)
        self._key = jax.random.PRNGKey(0)
        self._jp = jp

        # Cache the jitted apply for low-latency repeated calls.
        @jax.jit
        def _act(obs, key):
            model_obs = {manifest.policy_obs_key: obs} if asymmetric_obs else obs
            action, _ = self._inference_fn(model_obs, key)
            return action

        self._jit_act = _act

    def predict(self, obs, deterministic: bool = True):
        """SB3-compatible signature: returns (action, state)."""
        obs_arr = self._jp.asarray(obs, dtype=self._jp.float32)
        action = self._jit_act(obs_arr, self._key)
        import numpy as np

        return np.asarray(action, dtype=np.float32), None


def _pad_or_trim(arr: np.ndarray, dim: int) -> np.ndarray:
    if arr.shape[0] == dim:
        return arr.astype(np.float32)
    if arr.shape[0] > dim:
        return arr[:dim].astype(np.float32)
    return np.concatenate([arr.astype(np.float32), np.zeros(dim - arr.shape[0], dtype=np.float32)])


class _NumpyLinearPolicyModelAdapter:
    def __init__(self, path: Path) -> None:
        raw = json.loads(path.read_text())
        self._weights = np.asarray(raw["weights"], dtype=np.float32)
        self._bias = np.asarray(raw["bias"], dtype=np.float32)

    def predict(self, obs, deterministic: bool = True):
        obs_arr = np.asarray(obs, dtype=np.float32).reshape(-1)
        return obs_arr @ self._weights + self._bias, None


class _AlbertaStreamingModelAdapter:
    """Loads an Alberta streaming controller checkpoint and exposes the
    SB3-style ``predict(obs, deterministic) -> (action, None)`` interface.

    Rebuilds the exact feature map + actor-critic from the manifest's
    ``controller`` block, restores the learned weights from the ``.npz`` snapshot,
    and emits the greedy (policy-mean) action — the same path the continual
    benchmark evaluates.
    """

    def __init__(self, ckpt_dir: Path) -> None:
        from eliza_robot.rl.alberta.agent import (
            AlbertaContinualController,
            AlbertaControllerConfig,
        )
        from eliza_robot.rl.alberta.features import FeatureConfig

        raw = json.loads((ckpt_dir / "manifest.json").read_text())
        c = raw["controller"]
        f = c["features"]
        feature_cfg = FeatureConfig(
            mode=f["mode"],
            embed_dim=int(f["embed_dim"]),
            n_prototypes=int(f["n_prototypes"]),
            gate_hard=bool(f["gate_hard"]),
            gate_temperature=float(f["gate_temperature"]),
            proprio_random_dim=int(f["proprio_random_dim"]),
            random_dim=int(f["random_dim"]),
            scale=float(f["scale"]),
            seed=int(f["seed"]),
        )
        controller_cfg = AlbertaControllerConfig(
            obs_dim=int(raw["obs_dim"]),
            action_dim=int(raw["action_dim"]),
            gamma=float(c["gamma"]),
            actor_step_size=float(c["actor_step_size"]),
            critic_step_size=float(c["critic_step_size"]),
            actor_lamda=float(c["actor_lamda"]),
            critic_lamda=float(c["critic_lamda"]),
            log_sigma_init=float(c["log_sigma_init"]),
            log_sigma_min=float(c["log_sigma_min"]),
            log_sigma_max=float(c["log_sigma_max"]),
            action_low=float(c["action_low"]),
            action_high=float(c["action_high"]),
            obgd_kappa=c["obgd_kappa"],
            normalize=bool(c["normalize"]),
            normalizer_decay=float(c["normalizer_decay"]),
            features=feature_cfg,
            seed=int(f["seed"]),
            decouple_global_bias=bool(c["decouple_global_bias"]),
        )
        self._controller = AlbertaContinualController(controller_cfg)
        snap = dict(np.load(ckpt_dir / raw["ckpt"]))
        self._controller.load_state_dict(snap)

    def predict(self, obs, deterministic: bool = True):
        obs_arr = np.asarray(obs, dtype=np.float32).reshape(-1)
        return self._controller.act_greedy(obs_arr), None
