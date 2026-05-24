# mypy: disable-error-code="call-arg"
"""Production-facing Step 8 one-step world-model facade."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import asdict, dataclass
from typing import Any, cast

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.world_model import (
    OneStepWorldModel,
    WorldModelConfig,
    WorldModelLearningResult,
    WorldModelState,
    WorldModelUpdateResult,
    run_world_model_learning_loop,
)


@dataclass(frozen=True)
class Step8WorldModelConfig:
    """Config for the Step 8 one-step environment model facade."""

    observation_dim: int = 4
    n_actions: int | None = 2
    action_dim: int = 1
    hidden_sizes: tuple[int, ...] = (64,)
    step_size: float = 0.05
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    predict_delta: bool = False
    utility_decay: float = 0.99

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step8WorldModelConfig:
        """Reconstruct from :meth:`to_dict` output."""
        data = dict(payload)
        hidden_sizes = data.get("hidden_sizes", (64,))
        if isinstance(hidden_sizes, list):
            data["hidden_sizes"] = tuple(int(v) for v in hidden_sizes)
        return cls(**cast(Any, data))

    def to_core_config(self) -> WorldModelConfig:
        """Return the core world-model config."""
        return WorldModelConfig(
            observation_dim=self.observation_dim,
            n_actions=self.n_actions,
            action_dim=self.action_dim,
            hidden_sizes=self.hidden_sizes,
            step_size=self.step_size,
            sparsity=self.sparsity,
            leaky_relu_slope=self.leaky_relu_slope,
            use_layer_norm=self.use_layer_norm,
            predict_delta=self.predict_delta,
            utility_decay=self.utility_decay,
        )


@dataclass(frozen=True)
class Step8SmokeResult:
    """Summary returned by :func:`run_step8_smoke`."""

    config: Step8WorldModelConfig
    steps: int
    seed: int
    reward_predictions_shape: tuple[int, ...]
    next_observation_predictions_shape: tuple[int, ...]
    reward_errors_shape: tuple[int, ...]
    next_observation_errors_shape: tuple[int, ...]
    finite: bool
    model_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["reward_predictions_shape"] = list(self.reward_predictions_shape)
        payload["next_observation_predictions_shape"] = list(
            self.next_observation_predictions_shape
        )
        payload["reward_errors_shape"] = list(self.reward_errors_shape)
        payload["next_observation_errors_shape"] = list(self.next_observation_errors_shape)
        return payload


@dataclass(frozen=True)
class Step8EnsemblePrediction:
    """Aggregate prediction and disagreement from multiple Step 8 models."""

    reward_predictions: Array
    next_observation_predictions: Array
    mean_reward: Array
    mean_next_observation: Array
    reward_disagreement: Array
    next_observation_disagreement: Array
    total_disagreement: Array


def make_step8_world_model(
    config: Step8WorldModelConfig | None = None,
) -> OneStepWorldModel:
    """Create the production Step 8 one-step world model."""
    cfg = config or Step8WorldModelConfig()
    return OneStepWorldModel(cfg.to_core_config())


def init_step8_state(model: OneStepWorldModel, *, key: Array) -> WorldModelState:
    """Initialize Step 8 world-model state."""
    return model.init(key)


def step8_update(
    model: OneStepWorldModel,
    state: WorldModelState,
    observation: Array,
    action: Array,
    reward: Array,
    next_observation: Array,
) -> WorldModelUpdateResult:
    """Run one Step 8 model-learning transition update."""
    return cast(
        WorldModelUpdateResult,
        model.update(state, observation, action, reward, next_observation),
    )


def step8_ensemble_predict(
    model: OneStepWorldModel,
    states: Sequence[WorldModelState],
    observation: Array,
    action: Array,
) -> Step8EnsemblePrediction:
    """Predict with an ensemble of Step 8 states and return disagreement.

    The states are intentionally explicit rather than hidden in a new learner
    object. This keeps ensemble use compatible with existing checkpointing and
    lets downstream systems choose their own bootstrap or seed strategy.
    """
    if not states:
        raise ValueError("states must contain at least one world-model state")
    predictions = [model.predict(state, observation, action) for state in states]
    reward_predictions = jnp.stack([pred.reward for pred in predictions], axis=0)
    next_observation_predictions = jnp.stack(
        [pred.next_observation for pred in predictions],
        axis=0,
    )
    mean_reward = jnp.mean(reward_predictions, axis=0)
    mean_next_observation = jnp.mean(next_observation_predictions, axis=0)
    reward_disagreement = jnp.var(reward_predictions, axis=0)
    next_observation_disagreement = jnp.mean(
        jnp.var(next_observation_predictions, axis=0)
    )
    total_disagreement = reward_disagreement + next_observation_disagreement
    return Step8EnsemblePrediction(
        reward_predictions=reward_predictions,
        next_observation_predictions=next_observation_predictions,
        mean_reward=mean_reward,
        mean_next_observation=mean_next_observation,
        reward_disagreement=reward_disagreement,
        next_observation_disagreement=next_observation_disagreement,
        total_disagreement=total_disagreement,
    )


def run_step8_scan(
    model: OneStepWorldModel,
    state: WorldModelState,
    observations: Array,
    actions: Array,
    rewards: Array,
    next_observations: Array,
) -> WorldModelLearningResult:
    """Run Step 8 world-model learning over transition arrays."""
    return run_world_model_learning_loop(
        model,
        state,
        observations,
        actions,
        rewards,
        next_observations,
    )


def run_step8_smoke(
    config: Step8WorldModelConfig | None = None,
    *,
    steps: int = 32,
    seed: int = 0,
) -> Step8SmokeResult:
    """Run a tiny deterministic Step 8 environment-prediction probe."""
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config or Step8WorldModelConfig()
    if cfg.n_actions is None:
        raise ValueError("run_step8_smoke currently expects discrete actions")

    model = make_step8_world_model(cfg)
    key = jr.key(seed)
    data_key, state_key = jr.split(key)
    observations = jr.normal(data_key, (steps, cfg.observation_dim), dtype=jnp.float32)
    actions = jnp.arange(steps, dtype=jnp.int32) % cfg.n_actions
    action_sign = 2.0 * actions.astype(jnp.float32) - 1.0
    next_observations = observations.at[:, 0].add(0.1 * action_sign)
    rewards = jnp.tanh(next_observations[:, 0])
    state = init_step8_state(model, key=state_key)
    result = run_step8_scan(
        model,
        state,
        observations,
        actions,
        rewards,
        next_observations,
    )
    result.reward_errors.block_until_ready()
    finite = bool(
        jnp.all(jnp.isfinite(result.reward_predictions))
        & jnp.all(jnp.isfinite(result.next_observation_predictions))
        & jnp.all(jnp.isfinite(result.reward_errors))
        & jnp.all(jnp.isfinite(result.next_observation_errors))
    )
    return Step8SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        reward_predictions_shape=tuple(int(dim) for dim in result.reward_predictions.shape),
        next_observation_predictions_shape=tuple(
            int(dim) for dim in result.next_observation_predictions.shape
        ),
        reward_errors_shape=tuple(int(dim) for dim in result.reward_errors.shape),
        next_observation_errors_shape=tuple(
            int(dim) for dim in result.next_observation_errors.shape
        ),
        finite=finite,
        model_config=model.to_config(),
    )
