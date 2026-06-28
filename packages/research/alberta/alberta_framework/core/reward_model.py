# mypy: disable-error-code="call-arg"
"""Online reward models for selective model-based updates."""

from __future__ import annotations

import functools
from dataclasses import dataclass
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


@dataclass(frozen=True)
class RLSRewardModelConfig:
    """Configuration for a linear recursive-least-squares reward model.

    Args:
        feature_dim: Number of scalar input features.
        forgetting: Exponential forgetting factor. Values near one favor stable
            estimates; lower values adapt faster to nonstationarity.
        ridge: Initial precision regularizer. Larger values make the initial
            covariance smaller and therefore more conservative.
        error_decay: EMA decay for absolute reward-prediction error diagnostics.
    """

    feature_dim: int
    forgetting: float = 0.995
    ridge: float = 10.0
    error_decay: float = 0.99

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-compatible representation."""
        return {
            "type": "RLSRewardModelConfig",
            "feature_dim": self.feature_dim,
            "forgetting": self.forgetting,
            "ridge": self.ridge,
            "error_decay": self.error_decay,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> RLSRewardModelConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        return cls(**data)


@chex.dataclass(frozen=True)
class RLSRewardModelState:
    """State for :class:`RLSRewardModel`."""

    weights: Float[Array, " feature_dim"]
    covariance: Float[Array, "feature_dim feature_dim"]
    abs_error_ema: Float[Array, ""]
    step_count: Array


@chex.dataclass(frozen=True)
class RLSRewardModelUpdateResult:
    """Result from one reward-model update."""

    state: RLSRewardModelState
    prediction: Float[Array, ""]
    error: Float[Array, ""]
    gain: Float[Array, " feature_dim"]


class RLSRewardModel:
    """Linear RLS scalar reward predictor.

    This model is intentionally narrow: it learns calibrated scalar reward
    predictions from caller-provided features. It is useful when imagined
    updates need reward targets but a shared multi-head dynamics model is too
    biased or too slow to calibrate.
    """

    def __init__(self, config: RLSRewardModelConfig):
        """Initialize the model."""
        self._validate_config(config)
        self._config = config

    @property
    def config(self) -> RLSRewardModelConfig:
        """Model configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize the model configuration."""
        return {
            "type": "RLSRewardModel",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> RLSRewardModel:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        return cls(RLSRewardModelConfig.from_config(data["config"]))

    @functools.partial(jax.jit, static_argnums=(0,))
    def init(self) -> RLSRewardModelState:
        """Initialize model state."""
        feature_dim = self._config.feature_dim
        return RLSRewardModelState(
            weights=jnp.zeros((feature_dim,), dtype=jnp.float32),
            covariance=(
                jnp.eye(feature_dim, dtype=jnp.float32) / self._config.ridge
            ),
            abs_error_ema=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: RLSRewardModelState, features: Array) -> Array:
        """Predict reward from one feature vector."""
        x = jnp.asarray(features, dtype=jnp.float32).reshape((self._config.feature_dim,))
        return jnp.dot(state.weights, x)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: RLSRewardModelState,
        features: Array,
        reward: Array,
    ) -> RLSRewardModelUpdateResult:
        """Update from one real reward observation."""
        x = jnp.asarray(features, dtype=jnp.float32).reshape((self._config.feature_dim,))
        target = jnp.asarray(reward, dtype=jnp.float32)
        prediction = jnp.dot(state.weights, x)
        error = target - prediction
        covariance_features = state.covariance @ x
        forgetting = jnp.asarray(self._config.forgetting, dtype=jnp.float32)
        denominator = forgetting + jnp.dot(x, covariance_features)
        gain = covariance_features / denominator
        next_weights = state.weights + gain * error
        next_covariance = (
            state.covariance - jnp.outer(gain, covariance_features)
        ) / forgetting

        error_decay = jnp.asarray(self._config.error_decay, dtype=jnp.float32)
        abs_error = jnp.abs(error)
        next_abs_error_ema = jnp.where(
            state.step_count == 0,
            abs_error,
            error_decay * state.abs_error_ema + (1.0 - error_decay) * abs_error,
        )
        next_state = RLSRewardModelState(
            weights=next_weights,
            covariance=next_covariance,
            abs_error_ema=next_abs_error_ema,
            step_count=state.step_count + 1,
        )
        return RLSRewardModelUpdateResult(
            state=next_state,
            prediction=prediction,
            error=error,
            gain=gain,
        )

    def _validate_config(self, config: RLSRewardModelConfig) -> None:
        if config.feature_dim <= 0:
            raise ValueError("feature_dim must be positive")
        if not 0.0 < config.forgetting <= 1.0:
            raise ValueError("forgetting must be in (0, 1]")
        if config.ridge <= 0.0:
            raise ValueError("ridge must be positive")
        if not 0.0 <= config.error_decay < 1.0:
            raise ValueError("error_decay must be in [0, 1)")


__all__ = [
    "RLSRewardModel",
    "RLSRewardModelConfig",
    "RLSRewardModelState",
    "RLSRewardModelUpdateResult",
]
