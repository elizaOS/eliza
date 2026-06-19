# mypy: disable-error-code="call-arg"
"""Latent action-conditioned world model with surprise diagnostics.

This module is a low-dimensional, online analogue of JEPA/LeWM-style latent
prediction. It intentionally starts with a fixed random encoder so the first
research question is about predictive latent dynamics, surprise, and dream
selection rather than unstable joint representation learning.
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float

from alberta_framework.core.multi_head_learner import (
    AnyOptimizer,
    MultiHeadMLPLearner,
    MultiHeadMLPState,
    MultiHeadMLPUpdateResult,
)
from alberta_framework.core.optimizers import Bounder
from alberta_framework.core.types import TraceMode


@dataclasses.dataclass(frozen=True)
class LatentWorldModelConfig:
    """Configuration for :class:`LatentWorldModel`.

    The encoder is fixed in this first version. Anti-collapse is therefore a
    diagnostic and gate, not yet a representation-learning gradient.
    """

    observation_dim: int
    n_actions: int
    latent_dim: int = 8
    gamma: float = 0.99
    observation_scale: tuple[float, ...] | None = None
    reward_scale: float = 1.0
    encoder_scale: float = 1.0
    encoder_bias_scale: float = 0.0
    predict_delta: bool = True
    hidden_sizes: tuple[int, ...] = (64,)
    step_size: float = 0.03
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    trace_mode: TraceMode = TraceMode.ACCUMULATING
    utility_decay: float = 0.99
    surprise_decay: float = 0.99
    collapse_decay: float = 0.99
    min_latent_std: float = 0.05
    max_latent_delta: float = 5.0
    include_action_interactions: bool = False

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "LatentWorldModelConfig"
        payload["hidden_sizes"] = list(self.hidden_sizes)
        payload["trace_mode"] = self.trace_mode.value
        if self.observation_scale is not None:
            payload["observation_scale"] = list(self.observation_scale)
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> LatentWorldModelConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        if "hidden_sizes" in payload:
            payload["hidden_sizes"] = tuple(payload["hidden_sizes"])
        if "observation_scale" in payload and payload["observation_scale"] is not None:
            payload["observation_scale"] = tuple(payload["observation_scale"])
        if "trace_mode" in payload:
            payload["trace_mode"] = TraceMode(payload["trace_mode"])
        return cls(**payload)


@chex.dataclass(frozen=True)
class LatentWorldModelState:
    """Immutable state for :class:`LatentWorldModel`."""

    encoder_matrix: Float[Array, "observation_dim latent_dim"]
    encoder_bias: Float[Array, " latent_dim"]
    learner_state: MultiHeadMLPState
    latent_mean_ema: Float[Array, " latent_dim"]
    latent_var_ema: Float[Array, " latent_dim"]
    surprise_ema: Float[Array, ""]
    prediction_error_ema: Float[Array, ""]
    collapse_score_ema: Float[Array, ""]
    step_count: Array


@chex.dataclass(frozen=True)
class LatentWorldModelPrediction:
    """Decoded latent dynamics prediction."""

    latent: Float[Array, " latent_dim"]
    next_latent: Float[Array, " latent_dim"]
    reward: Float[Array, ""]
    discount: Float[Array, ""]
    raw_predictions: Float[Array, " model_heads"]


@chex.dataclass(frozen=True)
class LatentWorldModelUpdateResult:
    """Result from one real latent-dynamics update."""

    state: LatentWorldModelState
    prediction: LatentWorldModelPrediction
    target_next_latent: Float[Array, " latent_dim"]
    targets: Float[Array, " model_heads"]
    errors: Float[Array, " model_heads"]
    surprise: Float[Array, ""]
    reward_error: Float[Array, ""]
    discount_error: Float[Array, ""]
    prediction_error: Float[Array, ""]
    latent_std_mean: Float[Array, ""]
    collapse_score: Float[Array, ""]
    per_head_metrics: Float[Array, "model_heads 3"]
    learner_result: MultiHeadMLPUpdateResult


@chex.dataclass(frozen=True)
class LatentWorldModelLearningResult:
    """Scan result for latent world-model learning."""

    state: LatentWorldModelState
    latent_predictions: Float[Array, "num_steps latent_dim"]
    next_latent_predictions: Float[Array, "num_steps latent_dim"]
    reward_predictions: Float[Array, " num_steps"]
    discount_predictions: Float[Array, " num_steps"]
    target_next_latents: Float[Array, "num_steps latent_dim"]
    surprises: Float[Array, " num_steps"]
    prediction_errors: Float[Array, " num_steps"]
    reward_errors: Float[Array, " num_steps"]
    discount_errors: Float[Array, " num_steps"]
    latent_std_means: Float[Array, " num_steps"]
    collapse_scores: Float[Array, " num_steps"]
    per_head_metrics: Float[Array, "num_steps model_heads metrics"]


class LatentWorldModel:
    """Fixed-encoder latent model for ``(z_t, a_t) -> (z_{t+1}, r, gamma)``."""

    def __init__(
        self,
        config: LatentWorldModelConfig,
        optimizer: AnyOptimizer | None = None,
        bounder: Bounder | None = None,
        head_optimizer: AnyOptimizer | None = None,
    ):
        """Initialize the latent world model."""
        self._validate_config(config)
        self._config = config
        self._observation_scale = (
            tuple(1.0 for _ in range(config.observation_dim))
            if config.observation_scale is None
            else tuple(config.observation_scale)
        )
        self._learner = MultiHeadMLPLearner(
            n_heads=config.latent_dim + 2,
            hidden_sizes=config.hidden_sizes,
            optimizer=optimizer,
            step_size=config.step_size,
            bounder=bounder,
            gamma=0.0,
            lamda=0.0,
            sparsity=config.sparsity,
            leaky_relu_slope=config.leaky_relu_slope,
            use_layer_norm=config.use_layer_norm,
            head_optimizer=head_optimizer,
            trace_mode=config.trace_mode,
            utility_decay=config.utility_decay,
        )

    @property
    def config(self) -> LatentWorldModelConfig:
        """Model configuration."""
        return self._config

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying multi-head predictor."""
        return self._learner

    @property
    def input_dim(self) -> int:
        """Latent predictor input dimension."""
        base_dim = self._config.latent_dim + self._config.n_actions
        if self._config.include_action_interactions:
            return base_dim + self._config.latent_dim * self._config.n_actions
        return base_dim

    @property
    def n_heads(self) -> int:
        """Number of prediction heads."""
        return self._config.latent_dim + 2

    def to_config(self) -> dict[str, Any]:
        """Serialize model configuration and learner components."""
        return {
            "type": "LatentWorldModel",
            "config": self._config.to_config(),
            "learner": self._learner.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> LatentWorldModel:
        """Reconstruct from :meth:`to_config` output."""
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        payload = dict(config)
        payload.pop("type", None)
        model_config = LatentWorldModelConfig.from_config(payload["config"])
        learner_cfg = dict(payload["learner"])
        optimizer = optimizer_from_config(learner_cfg["optimizer"])
        bounder_cfg = learner_cfg.get("bounder")
        head_opt_cfg = learner_cfg.get("head_optimizer")
        return cls(
            model_config,
            optimizer=optimizer,
            bounder=bounder_from_config(bounder_cfg) if bounder_cfg is not None else None,
            head_optimizer=(
                optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
            ),
        )

    def init(self, key: Array) -> LatentWorldModelState:
        """Initialize fixed encoder and predictor state."""
        encoder_key, bias_key, learner_key = jr.split(key, 3)
        obs_dim = self._config.observation_dim
        latent_dim = self._config.latent_dim
        encoder_matrix = (
            jr.normal(encoder_key, (obs_dim, latent_dim), dtype=jnp.float32)
            * self._config.encoder_scale
            / jnp.sqrt(jnp.asarray(obs_dim, dtype=jnp.float32))
        )
        encoder_bias = (
            jr.uniform(
                bias_key,
                (latent_dim,),
                minval=-self._config.encoder_bias_scale,
                maxval=self._config.encoder_bias_scale,
                dtype=jnp.float32,
            )
            if self._config.encoder_bias_scale > 0.0
            else jnp.zeros((latent_dim,), dtype=jnp.float32)
        )
        return LatentWorldModelState(
            encoder_matrix=encoder_matrix,
            encoder_bias=encoder_bias,
            learner_state=self._learner.init(self.input_dim, learner_key),
            latent_mean_ema=jnp.zeros((latent_dim,), dtype=jnp.float32),
            latent_var_ema=jnp.zeros((latent_dim,), dtype=jnp.float32),
            surprise_ema=jnp.array(0.0, dtype=jnp.float32),
            prediction_error_ema=jnp.array(0.0, dtype=jnp.float32),
            collapse_score_ema=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def encode(
        self,
        state: LatentWorldModelState,
        observation: Array,
    ) -> Float[Array, " latent_dim"]:
        """Encode one observation into the fixed latent space."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        scale = jnp.asarray(self._observation_scale, dtype=jnp.float32)
        scaled = obs / jnp.maximum(scale, jnp.asarray(1e-6, dtype=jnp.float32))
        return jnp.tanh(scaled @ state.encoder_matrix + state.encoder_bias)

    @functools.partial(jax.jit, static_argnums=(0,))
    def input_features_from_latent(
        self,
        latent: Array,
        action: Array,
    ) -> Float[Array, " input_dim"]:
        """Return ``concat(latent, one_hot(action), optional interactions)``."""
        z = jnp.asarray(latent, dtype=jnp.float32).reshape((self._config.latent_dim,))
        action_one_hot = jax.nn.one_hot(
            action.astype(jnp.int32),
            self._config.n_actions,
            dtype=jnp.float32,
        )
        features = [z, action_one_hot]
        if self._config.include_action_interactions:
            interactions = (z[:, None] * action_one_hot[None, :]).reshape((-1,))
            features.append(interactions)
        return jnp.concatenate(features, axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def input_features(
        self,
        state: LatentWorldModelState,
        observation: Array,
        action: Array,
    ) -> Float[Array, " input_dim"]:
        """Encode observation and return latent predictor inputs."""
        return cast(
            Array,
            self.input_features_from_latent(self.encode(state, observation), action),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def targets(
        self,
        state: LatentWorldModelState,
        observation: Array,
        reward: Array,
        discount: Array,
        next_observation: Array,
    ) -> Float[Array, " model_heads"]:
        """Build ``[next_latent_or_delta, reward, discount]`` targets."""
        latent = self.encode(state, observation)
        next_latent = self.encode(state, next_observation)
        latent_target = jnp.where(
            self._config.predict_delta,
            next_latent - latent,
            next_latent,
        )
        reward_target = jnp.reshape(
            jnp.asarray(reward, dtype=jnp.float32) / self._config.reward_scale,
            (1,),
        )
        discount_target = jnp.reshape(jnp.asarray(discount, dtype=jnp.float32), (1,))
        return jnp.concatenate([latent_target, reward_target, discount_target], axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict_from_latent(
        self,
        state: LatentWorldModelState,
        latent: Array,
        action: Array,
    ) -> LatentWorldModelPrediction:
        """Predict the next latent, reward, and discount from a latent state."""
        z = jnp.asarray(latent, dtype=jnp.float32).reshape((self._config.latent_dim,))
        raw_predictions = self._learner.predict(
            state.learner_state,
            self.input_features_from_latent(z, action),
        )
        latent_part = jnp.clip(
            raw_predictions[: self._config.latent_dim],
            -self._config.max_latent_delta,
            self._config.max_latent_delta,
        )
        next_latent = jnp.where(
            self._config.predict_delta,
            z + latent_part,
            latent_part,
        )
        reward = raw_predictions[self._config.latent_dim] * self._config.reward_scale
        discount = jnp.clip(
            raw_predictions[self._config.latent_dim + 1],
            0.0,
            self._config.gamma,
        )
        return LatentWorldModelPrediction(
            latent=z,
            next_latent=next_latent,
            reward=reward,
            discount=discount,
            raw_predictions=raw_predictions,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: LatentWorldModelState,
        observation: Array,
        action: Array,
    ) -> LatentWorldModelPrediction:
        """Predict from raw observation by first encoding it."""
        return cast(
            LatentWorldModelPrediction,
            self.predict_from_latent(state, self.encode(state, observation), action),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: LatentWorldModelState,
        observation: Array,
        action: Array,
        reward: Array,
        discount: Array,
        next_observation: Array,
    ) -> LatentWorldModelUpdateResult:
        """Update from one real transition."""
        prediction = self.predict(state, observation, action)
        targets = self.targets(state, observation, reward, discount, next_observation)
        learner_result = self._learner.update(
            state.learner_state,
            self.input_features_from_latent(prediction.latent, action),
            targets,
        )
        target_next_latent = self.encode(state, next_observation)
        surprise = jnp.mean((prediction.next_latent - target_next_latent) ** 2)
        reward_error = prediction.reward - jnp.asarray(reward, dtype=jnp.float32)
        discount_error = prediction.discount - jnp.asarray(discount, dtype=jnp.float32)
        prediction_error = surprise + reward_error**2 + discount_error**2

        collapse_decay = jnp.asarray(self._config.collapse_decay, dtype=jnp.float32)
        surprise_decay = jnp.asarray(self._config.surprise_decay, dtype=jnp.float32)
        first = state.step_count == 0
        next_mean = jnp.where(
            first,
            target_next_latent,
            collapse_decay * state.latent_mean_ema
            + (1.0 - collapse_decay) * target_next_latent,
        )
        centered = target_next_latent - next_mean
        next_var = jnp.where(
            first,
            centered**2,
            collapse_decay * state.latent_var_ema + (1.0 - collapse_decay) * centered**2,
        )
        latent_std = jnp.sqrt(jnp.maximum(next_var, jnp.asarray(1e-8, dtype=jnp.float32)))
        latent_std_mean = jnp.mean(latent_std)
        collapse_score = jnp.mean(
            (latent_std < jnp.asarray(self._config.min_latent_std, dtype=jnp.float32)).astype(
                jnp.float32
            )
        )
        next_surprise_ema = jnp.where(
            first,
            surprise,
            surprise_decay * state.surprise_ema + (1.0 - surprise_decay) * surprise,
        )
        next_prediction_error_ema = jnp.where(
            first,
            prediction_error,
            surprise_decay * state.prediction_error_ema
            + (1.0 - surprise_decay) * prediction_error,
        )
        next_collapse_score_ema = jnp.where(
            first,
            collapse_score,
            collapse_decay * state.collapse_score_ema + (1.0 - collapse_decay) * collapse_score,
        )

        new_state = LatentWorldModelState(
            encoder_matrix=state.encoder_matrix,
            encoder_bias=state.encoder_bias,
            learner_state=learner_result.state,
            latent_mean_ema=next_mean,
            latent_var_ema=next_var,
            surprise_ema=next_surprise_ema,
            prediction_error_ema=next_prediction_error_ema,
            collapse_score_ema=next_collapse_score_ema,
            step_count=state.step_count + 1,
        )
        return LatentWorldModelUpdateResult(
            state=new_state,
            prediction=prediction,
            target_next_latent=target_next_latent,
            targets=targets,
            errors=learner_result.errors,
            surprise=surprise,
            reward_error=reward_error,
            discount_error=discount_error,
            prediction_error=prediction_error,
            latent_std_mean=latent_std_mean,
            collapse_score=collapse_score,
            per_head_metrics=learner_result.per_head_metrics,
            learner_result=learner_result,
        )

    def _validate_config(self, config: LatentWorldModelConfig) -> None:
        if config.observation_dim <= 0:
            raise ValueError("observation_dim must be positive")
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if config.latent_dim <= 0:
            raise ValueError("latent_dim must be positive")
        if not 0.0 <= config.gamma <= 1.0:
            raise ValueError("gamma must be in [0, 1]")
        if config.observation_scale is not None:
            if len(config.observation_scale) != config.observation_dim:
                raise ValueError("observation_scale length must equal observation_dim")
            if any(scale <= 0.0 for scale in config.observation_scale):
                raise ValueError("observation_scale values must be positive")
        if config.reward_scale <= 0.0:
            raise ValueError("reward_scale must be positive")
        if config.encoder_scale <= 0.0:
            raise ValueError("encoder_scale must be positive")
        if config.encoder_bias_scale < 0.0:
            raise ValueError("encoder_bias_scale must be non-negative")
        if any(size <= 0 for size in config.hidden_sizes):
            raise ValueError("hidden_sizes must contain only positive widths")
        if not 0.0 <= config.utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")
        if not 0.0 <= config.surprise_decay < 1.0:
            raise ValueError("surprise_decay must be in [0, 1)")
        if not 0.0 <= config.collapse_decay < 1.0:
            raise ValueError("collapse_decay must be in [0, 1)")
        if config.min_latent_std < 0.0:
            raise ValueError("min_latent_std must be non-negative")
        if config.max_latent_delta <= 0.0:
            raise ValueError("max_latent_delta must be positive")


def run_latent_world_model_learning_loop(
    model: LatentWorldModel,
    state: LatentWorldModelState,
    observations: Float[Array, "num_steps observation_dim"],
    actions: Array,
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps observation_dim"],
    discounts: Float[Array, " num_steps"] | None = None,
) -> LatentWorldModelLearningResult:
    """Run online latent world-model learning over transition arrays."""
    if discounts is None:
        discounts = jnp.full_like(
            rewards,
            jnp.asarray(model.config.gamma, dtype=jnp.float32),
        )

    def _scan_fn(
        carry: LatentWorldModelState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[LatentWorldModelState, tuple[Array, ...]]:
        obs, action, reward, discount, next_obs = inputs
        result = model.update(carry, obs, action, reward, discount, next_obs)
        return result.state, (
            result.prediction.latent,
            result.prediction.next_latent,
            result.prediction.reward,
            result.prediction.discount,
            result.target_next_latent,
            result.surprise,
            result.prediction_error,
            result.reward_error,
            result.discount_error,
            result.latent_std_mean,
            result.collapse_score,
            result.per_head_metrics,
        )

    final_state, (
        latent_predictions,
        next_latent_predictions,
        reward_predictions,
        discount_predictions,
        target_next_latents,
        surprises,
        prediction_errors,
        reward_errors,
        discount_errors,
        latent_std_means,
        collapse_scores,
        per_head_metrics,
    ) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, actions, rewards, discounts, next_observations),
    )
    return LatentWorldModelLearningResult(
        state=final_state,
        latent_predictions=latent_predictions,
        next_latent_predictions=next_latent_predictions,
        reward_predictions=reward_predictions,
        discount_predictions=discount_predictions,
        target_next_latents=target_next_latents,
        surprises=surprises,
        prediction_errors=prediction_errors,
        reward_errors=reward_errors,
        discount_errors=discount_errors,
        latent_std_means=latent_std_means,
        collapse_scores=collapse_scores,
        per_head_metrics=per_head_metrics,
    )


__all__ = [
    "LatentWorldModel",
    "LatentWorldModelConfig",
    "LatentWorldModelLearningResult",
    "LatentWorldModelPrediction",
    "LatentWorldModelState",
    "LatentWorldModelUpdateResult",
    "run_latent_world_model_learning_loop",
]
