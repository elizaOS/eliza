# mypy: disable-error-code="call-arg"
"""Action-conditioned one-step world models.

The first promoted environment-prediction surface is intentionally small:
predict the next observation delta, reward, and discount from the current
observation and action. This is enough to support GVF-style environment
prediction and guarded Dyna-style dream updates without committing the core API
to a large latent dynamics architecture too early.
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float

from alberta_framework.core.multi_head_learner import (
    AnyOptimizer,
    MultiHeadMLPLearner,
    MultiHeadMLPState,
    MultiHeadMLPUpdateResult,
)
from alberta_framework.core.normalizers import (
    EMANormalizerState,
    Normalizer,
    WelfordNormalizerState,
)
from alberta_framework.core.optimizers import Bounder
from alberta_framework.core.types import TraceMode


@dataclasses.dataclass(frozen=True)
class ActionConditionedWorldModelConfig:
    """Configuration for :class:`ActionConditionedWorldModel`.

    Args:
        observation_dim: Flat observation dimensionality.
        n_actions: Number of discrete actions.
        gamma: Maximum environment discount used for clipping predicted
            discounts.
        observation_scale: Per-observation-dimension scale for normalized delta
            targets. When ``None``, all dimensions use scale ``1``.
        reward_scale: Scalar reward target scale.
        hidden_sizes: Shared MLP trunk sizes. Use ``()`` for a linear model.
        step_size: Base learner step-size when ``optimizer`` is omitted.
        sparsity: Sparse initialization fraction for MLP weights.
        leaky_relu_slope: Negative slope for hidden activations.
        use_layer_norm: Whether to use parameterless layer normalization.
        trace_mode: Eligibility trace mode passed to the underlying learner.
        utility_decay: Hidden-unit utility EMA decay.
        error_decay: EMA decay for real one-step model error diagnostics.
        observation_clip_margin: Margin around observed min/max bounds used
            when producing imagined next observations.
        max_delta_scale: Clip predicted normalized deltas to this absolute
            magnitude before rescaling. This guards dream rollouts.
        include_action_interactions: Whether to append observation-by-action
            product features to the model input. This lets a linear world model
            represent simple action-conditioned slopes without requiring a
            nonlinear trunk.
    """

    observation_dim: int
    n_actions: int
    gamma: float = 0.99
    observation_scale: tuple[float, ...] | None = None
    reward_scale: float = 1.0
    predict_delta: bool = True
    hidden_sizes: tuple[int, ...] = (64, 64)
    step_size: float = 0.03
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    trace_mode: TraceMode = TraceMode.ACCUMULATING
    utility_decay: float = 0.99
    error_decay: float = 0.99
    observation_clip_margin: float = 0.05
    max_delta_scale: float = 5.0
    include_action_interactions: bool = False

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "ActionConditionedWorldModelConfig"
        payload["hidden_sizes"] = list(self.hidden_sizes)
        payload["trace_mode"] = self.trace_mode.value
        if self.observation_scale is not None:
            payload["observation_scale"] = list(self.observation_scale)
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ActionConditionedWorldModelConfig:
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
class ActionConditionedWorldModelState:
    """State for :class:`ActionConditionedWorldModel`."""

    learner_state: MultiHeadMLPState
    observation_min: Float[Array, " observation_dim"]
    observation_max: Float[Array, " observation_dim"]
    reward_min: Float[Array, ""]
    reward_max: Float[Array, ""]
    model_error_ema: Float[Array, ""]
    step_count: Array


@chex.dataclass(frozen=True)
class WorldModelPrediction:
    """Decoded world-model prediction."""

    next_observation: Float[Array, " observation_dim"]
    reward: Float[Array, ""]
    raw_predictions: Float[Array, " model_heads"]
    discount: Float[Array, ""]


@chex.dataclass(frozen=True)
class WorldModelUpdateResult:
    """Result from one real transition update."""

    state: Any
    prediction: WorldModelPrediction
    targets: Float[Array, " model_heads"]
    errors: Float[Array, " model_heads"]
    per_head_metrics: Float[Array, "model_heads 3"]
    prediction_error: Float[Array, ""]
    observation_mse: Float[Array, ""]
    reward_error: Float[Array, ""]
    next_observation_errors: Float[Array, " observation_dim"]
    discount_error: Float[Array, ""]
    learner_result: MultiHeadMLPUpdateResult


@chex.dataclass(frozen=True)
class ActionConditionedWorldModelLearningResult:
    """Result from scan-based action-conditioned world-model learning."""

    state: ActionConditionedWorldModelState
    next_observation_predictions: Float[Array, "num_steps observation_dim"]
    reward_predictions: Float[Array, " num_steps"]
    discount_predictions: Float[Array, " num_steps"]
    raw_predictions: Float[Array, "num_steps model_heads"]
    targets: Float[Array, "num_steps model_heads"]
    errors: Float[Array, "num_steps model_heads"]
    prediction_errors: Float[Array, " num_steps"]
    observation_mse: Float[Array, " num_steps"]
    reward_errors: Float[Array, " num_steps"]
    next_observation_errors: Float[Array, "num_steps observation_dim"]
    discount_errors: Float[Array, " num_steps"]
    per_head_metrics: Float[Array, "num_steps model_heads metrics"]


class ActionConditionedWorldModel:
    """One-step model for ``(observation, action) -> (next_obs, reward, discount)``.

    The model predicts normalized observation deltas rather than raw next
    observations, which avoids spending model capacity on the identity map and
    makes one-step dynamics errors easier to compare across channels.
    """

    def __init__(
        self,
        config: ActionConditionedWorldModelConfig,
        optimizer: AnyOptimizer | None = None,
        bounder: Bounder | None = None,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        head_optimizer: AnyOptimizer | None = None,
    ):
        """Initialize the world model."""
        self._validate_config(config)
        self._config = config
        self._observation_scale = (
            tuple(1.0 for _ in range(config.observation_dim))
            if config.observation_scale is None
            else tuple(config.observation_scale)
        )
        self._learner = MultiHeadMLPLearner(
            n_heads=config.observation_dim + 2,
            hidden_sizes=config.hidden_sizes,
            optimizer=optimizer,
            step_size=config.step_size,
            bounder=bounder,
            gamma=0.0,
            lamda=0.0,
            normalizer=normalizer,
            sparsity=config.sparsity,
            leaky_relu_slope=config.leaky_relu_slope,
            use_layer_norm=config.use_layer_norm,
            head_optimizer=head_optimizer,
            trace_mode=config.trace_mode,
            utility_decay=config.utility_decay,
        )

    @property
    def config(self) -> ActionConditionedWorldModelConfig:
        """Model configuration."""
        return self._config

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying multi-head learner."""
        return self._learner

    @property
    def input_dim(self) -> int:
        """World-model input dimension."""
        base_dim = self._config.observation_dim + self._config.n_actions
        if self._config.include_action_interactions:
            return base_dim + self._config.observation_dim * self._config.n_actions
        return base_dim

    @property
    def n_heads(self) -> int:
        """Number of prediction heads."""
        return self._config.observation_dim + 2

    def to_config(self) -> dict[str, Any]:
        """Serialize model configuration and learner components."""
        learner_cfg = self._learner.to_config()
        return {
            "type": "ActionConditionedWorldModel",
            "config": self._config.to_config(),
            "learner": learner_cfg,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ActionConditionedWorldModel:
        """Reconstruct from :meth:`to_config` output.

        This restores constructor-level model hyperparameters. Optimizer,
        bounder, and normalizer objects are represented in the nested learner
        config, so this path mirrors their serialized settings where supported.
        """
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        payload = dict(config)
        payload.pop("type", None)
        model_config = ActionConditionedWorldModelConfig.from_config(payload["config"])
        learner_cfg = dict(payload["learner"])
        optimizer = optimizer_from_config(learner_cfg["optimizer"])
        bounder_cfg = learner_cfg.get("bounder")
        normalizer_cfg = learner_cfg.get("normalizer")
        head_opt_cfg = learner_cfg.get("head_optimizer")
        return cls(
            config=model_config,
            optimizer=optimizer,
            bounder=bounder_from_config(bounder_cfg) if bounder_cfg is not None else None,
            normalizer=(
                normalizer_from_config(normalizer_cfg)
                if normalizer_cfg is not None
                else None
            ),
            head_optimizer=(
                optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
            ),
        )

    def init(self, key: Array) -> ActionConditionedWorldModelState:
        """Initialize model state."""
        obs_dim = self._config.observation_dim
        return ActionConditionedWorldModelState(
            learner_state=self._learner.init(self.input_dim, key),
            observation_min=jnp.full((obs_dim,), jnp.inf, dtype=jnp.float32),
            observation_max=jnp.full((obs_dim,), -jnp.inf, dtype=jnp.float32),
            reward_min=jnp.array(jnp.inf, dtype=jnp.float32),
            reward_max=jnp.array(-jnp.inf, dtype=jnp.float32),
            model_error_ema=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def input_features(self, observation: Array, action: Array) -> Array:
        """Return ``concat(observation, one_hot(action))``."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        action_one_hot = jax.nn.one_hot(
            action.astype(jnp.int32),
            self._config.n_actions,
            dtype=jnp.float32,
        )
        if self._config.include_action_interactions:
            interactions = (obs[:, None] * action_one_hot[None, :]).reshape((-1,))
            return jnp.concatenate([obs, action_one_hot, interactions], axis=0)
        return jnp.concatenate([obs, action_one_hot], axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def encode_action(self, action: Array) -> Array:
        """Return the one-hot action code used by the model."""
        return jax.nn.one_hot(
            action.astype(jnp.int32),
            self._config.n_actions,
            dtype=jnp.float32,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def targets(
        self,
        observation: Array,
        reward: Array,
        discount: Array,
        next_observation: Array,
    ) -> Array:
        """Build normalized ``[delta_obs, reward, discount]`` targets."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        next_obs = jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        obs_scale = jnp.asarray(self._observation_scale, dtype=jnp.float32)
        safe_scale = jnp.maximum(obs_scale, jnp.asarray(1e-6, dtype=jnp.float32))
        normalized_delta = jnp.where(
            self._config.predict_delta,
            (next_obs - obs) / safe_scale,
            next_obs / safe_scale,
        )
        reward_target = jnp.reshape(
            jnp.asarray(reward, dtype=jnp.float32) / self._config.reward_scale,
            (1,),
        )
        discount_target = jnp.reshape(jnp.asarray(discount, dtype=jnp.float32), (1,))
        return jnp.concatenate([normalized_delta, reward_target, discount_target], axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: ActionConditionedWorldModelState,
        observation: Array,
        action: Array,
    ) -> WorldModelPrediction:
        """Predict the next observation, reward, and discount."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        inputs = self.input_features(obs, action)
        raw_predictions = self._learner.predict(state.learner_state, inputs)

        obs_scale = jnp.asarray(self._observation_scale, dtype=jnp.float32)
        normalized_delta = jnp.clip(
            raw_predictions[: self._config.observation_dim],
            -self._config.max_delta_scale,
            self._config.max_delta_scale,
        )
        next_observation = jnp.where(
            self._config.predict_delta,
            obs + normalized_delta * obs_scale,
            normalized_delta * obs_scale,
        )

        has_bounds = state.step_count > 0
        low = state.observation_min - self._config.observation_clip_margin
        high = state.observation_max + self._config.observation_clip_margin
        clipped_next = jnp.clip(next_observation, low, high)
        next_observation = jnp.where(has_bounds, clipped_next, next_observation)

        reward = raw_predictions[self._config.observation_dim] * self._config.reward_scale
        reward_low = state.reward_min - self._config.observation_clip_margin
        reward_high = state.reward_max + self._config.observation_clip_margin
        clipped_reward = jnp.clip(reward, reward_low, reward_high)
        reward = jnp.where(has_bounds, clipped_reward, reward)

        discount = jnp.clip(
            raw_predictions[self._config.observation_dim + 1],
            0.0,
            self._config.gamma,
        )

        return WorldModelPrediction(
            next_observation=next_observation,
            reward=reward,
            raw_predictions=raw_predictions,
            discount=discount,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: ActionConditionedWorldModelState,
        observation: Array,
        action: Array,
        reward: Array,
        discount_or_next_observation: Array,
        next_observation: Array | None = None,
    ) -> WorldModelUpdateResult:
        """Update from one real transition."""
        if next_observation is None:
            discount = jnp.asarray(self._config.gamma, dtype=jnp.float32)
            next_observation = discount_or_next_observation
        else:
            discount = discount_or_next_observation
        prediction = self.predict(state, observation, action)
        targets = self.targets(observation, reward, discount, next_observation)
        inputs = self.input_features(observation, action)
        learner_result = self._learner.update(state.learner_state, inputs, targets)

        next_obs = jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        reward_arr = jnp.asarray(reward, dtype=jnp.float32)
        discount_arr = jnp.asarray(discount, dtype=jnp.float32)

        observation_mse = jnp.mean((prediction.next_observation - next_obs) ** 2)
        reward_error = prediction.reward - reward_arr
        discount_error = prediction.discount - discount_arr
        next_observation_errors = prediction.next_observation - next_obs
        prediction_error = observation_mse + reward_error**2 + discount_error**2

        error_decay = jnp.asarray(self._config.error_decay, dtype=jnp.float32)
        next_error_ema = jnp.where(
            state.step_count == 0,
            prediction_error,
            error_decay * state.model_error_ema + (1.0 - error_decay) * prediction_error,
        )

        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        observed_stack_min = jnp.minimum(obs, next_obs)
        observed_stack_max = jnp.maximum(obs, next_obs)
        new_state = ActionConditionedWorldModelState(
            learner_state=learner_result.state,
            observation_min=jnp.minimum(state.observation_min, observed_stack_min),
            observation_max=jnp.maximum(state.observation_max, observed_stack_max),
            reward_min=jnp.minimum(state.reward_min, reward_arr),
            reward_max=jnp.maximum(state.reward_max, reward_arr),
            model_error_ema=next_error_ema,
            step_count=state.step_count + 1,
        )

        return WorldModelUpdateResult(
            state=new_state,
            prediction=prediction,
            targets=targets,
            errors=learner_result.errors,
            per_head_metrics=learner_result.per_head_metrics,
            prediction_error=prediction_error,
            observation_mse=observation_mse,
            reward_error=reward_error,
            next_observation_errors=next_observation_errors,
            discount_error=discount_error,
            learner_result=learner_result,
        )

    def _validate_config(self, config: ActionConditionedWorldModelConfig) -> None:
        if config.observation_dim <= 0:
            raise ValueError("observation_dim must be positive")
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if not 0.0 <= config.gamma <= 1.0:
            raise ValueError("gamma must be in [0, 1]")
        if config.observation_scale is not None:
            if len(config.observation_scale) != config.observation_dim:
                raise ValueError("observation_scale length must equal observation_dim")
            if any(scale <= 0.0 for scale in config.observation_scale):
                raise ValueError("observation_scale values must be positive")
        if config.reward_scale <= 0.0:
            raise ValueError("reward_scale must be positive")
        if any(size <= 0 for size in config.hidden_sizes):
            raise ValueError("hidden_sizes must contain only positive widths")
        if not 0.0 <= config.utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")
        if not 0.0 <= config.error_decay < 1.0:
            raise ValueError("error_decay must be in [0, 1)")
        if config.observation_clip_margin < 0.0:
            raise ValueError("observation_clip_margin must be non-negative")
        if config.max_delta_scale <= 0.0:
            raise ValueError("max_delta_scale must be positive")


def run_action_conditioned_world_model_learning_loop(
    model: ActionConditionedWorldModel,
    state: ActionConditionedWorldModelState,
    observations: Float[Array, "num_steps observation_dim"],
    actions: Array,
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps observation_dim"],
    discounts: Float[Array, " num_steps"] | None = None,
) -> ActionConditionedWorldModelLearningResult:
    """Run online one-step model learning over transition arrays."""
    if discounts is None:
        discounts = jnp.full_like(
            rewards,
            jnp.asarray(model.config.gamma, dtype=jnp.float32),
        )

    def _scan_fn(
        carry: ActionConditionedWorldModelState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[ActionConditionedWorldModelState, tuple[Array, ...]]:
        obs, action, reward, discount, next_obs = inputs
        result = model.update(carry, obs, action, reward, discount, next_obs)
        return result.state, (
            result.prediction.next_observation,
            result.prediction.reward,
            result.prediction.discount,
            result.prediction.raw_predictions,
            result.targets,
            result.errors,
            result.prediction_error,
            result.observation_mse,
            result.reward_error,
            result.next_observation_errors,
            result.discount_error,
            result.per_head_metrics,
        )

    final_state, (
        next_observation_predictions,
        reward_predictions,
        discount_predictions,
        raw_predictions,
        targets,
        errors,
        prediction_errors,
        observation_mse,
        reward_errors,
        next_observation_errors,
        discount_errors,
        per_head_metrics,
    ) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, actions, rewards, discounts, next_observations),
    )
    return ActionConditionedWorldModelLearningResult(
        state=final_state,
        next_observation_predictions=next_observation_predictions,
        reward_predictions=reward_predictions,
        discount_predictions=discount_predictions,
        raw_predictions=raw_predictions,
        targets=targets,
        errors=errors,
        prediction_errors=prediction_errors,
        observation_mse=observation_mse,
        reward_errors=reward_errors,
        next_observation_errors=next_observation_errors,
        discount_errors=discount_errors,
        per_head_metrics=per_head_metrics,
    )


__all__ = [
    "ActionConditionedWorldModel",
    "ActionConditionedWorldModelConfig",
    "ActionConditionedWorldModelLearningResult",
    "ActionConditionedWorldModelState",
    "OneStepWorldModel",
    "WorldModelConfig",
    "WorldModelLearningResult",
    "WorldModelPrediction",
    "WorldModelState",
    "WorldModelUpdateResult",
    "run_action_conditioned_world_model_learning_loop",
    "run_world_model_learning_loop",
]


@dataclasses.dataclass(frozen=True)
class WorldModelConfig:
    """Configuration for the Step 8 one-step world model.

    This compatibility surface predicts reward and next observation from
    ``concat(observation, action_encoding)``. It intentionally has no discount
    head; use :class:`ActionConditionedWorldModel` when dream rollouts need a
    learned discount/termination prediction.
    """

    observation_dim: int
    n_actions: int | None = 2
    action_dim: int = 1
    hidden_sizes: tuple[int, ...] = (64,)
    step_size: float = 0.05
    sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    predict_delta: bool = False
    utility_decay: float = 0.99

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "WorldModelConfig"
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> WorldModelConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        if "hidden_sizes" in payload:
            payload["hidden_sizes"] = tuple(payload["hidden_sizes"])
        return cls(**payload)


@chex.dataclass(frozen=True)
class WorldModelState:
    """State for :class:`OneStepWorldModel`."""

    learner_state: MultiHeadMLPState
    step_count: Array


@chex.dataclass(frozen=True)
class WorldModelLearningResult:
    """Scan result for :func:`run_world_model_learning_loop`."""

    state: WorldModelState
    reward_predictions: Float[Array, " num_steps"]
    next_observation_predictions: Float[Array, "num_steps observation_dim"]
    reward_errors: Float[Array, " num_steps"]
    next_observation_errors: Float[Array, "num_steps observation_dim"]
    per_head_metrics: Float[Array, "num_steps model_heads 3"]


class OneStepWorldModel:
    """Step 8 one-step environment predictor.

    Predicts one scalar reward head and one head per next-observation channel.
    Discrete actions are one-hot encoded; continuous/vector actions are passed
    through directly when ``n_actions=None``.
    """

    def __init__(
        self,
        config: WorldModelConfig,
        optimizer: AnyOptimizer | None = None,
        bounder: Bounder | None = None,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        head_optimizer: AnyOptimizer | None = None,
    ):
        """Initialize the model."""
        self._validate_config(config)
        self._config = config
        self._action_feature_dim = (
            config.n_actions if config.n_actions is not None else config.action_dim
        )
        self._learner = MultiHeadMLPLearner(
            n_heads=config.observation_dim + 1,
            hidden_sizes=config.hidden_sizes,
            optimizer=optimizer,
            step_size=config.step_size,
            bounder=bounder,
            gamma=0.0,
            lamda=0.0,
            normalizer=normalizer,
            sparsity=config.sparsity,
            leaky_relu_slope=config.leaky_relu_slope,
            use_layer_norm=config.use_layer_norm,
            head_optimizer=head_optimizer,
            utility_decay=config.utility_decay,
        )

    @property
    def config(self) -> WorldModelConfig:
        """Model configuration."""
        return self._config

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying learner."""
        return self._learner

    @property
    def input_dim(self) -> int:
        """Encoded input dimensionality."""
        return self._config.observation_dim + self._action_feature_dim

    def to_config(self) -> dict[str, Any]:
        """Serialize model configuration."""
        return {
            "type": "OneStepWorldModel",
            "config": self._config.to_config(),
            "learner": self._learner.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> OneStepWorldModel:
        """Reconstruct from :meth:`to_config` output."""
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        payload = dict(config)
        payload.pop("type", None)
        model_config = WorldModelConfig.from_config(payload["config"])
        learner_cfg = dict(payload["learner"])
        optimizer = optimizer_from_config(learner_cfg["optimizer"])
        bounder_cfg = learner_cfg.get("bounder")
        normalizer_cfg = learner_cfg.get("normalizer")
        head_opt_cfg = learner_cfg.get("head_optimizer")
        return cls(
            model_config,
            optimizer=optimizer,
            bounder=bounder_from_config(bounder_cfg) if bounder_cfg is not None else None,
            normalizer=(
                normalizer_from_config(normalizer_cfg)
                if normalizer_cfg is not None
                else None
            ),
            head_optimizer=(
                optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
            ),
        )

    def init(self, key: Array) -> WorldModelState:
        """Initialize model state."""
        return WorldModelState(
            learner_state=self._learner.init(self.input_dim, key),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def encode_action(self, action: Array) -> Array:
        """Encode a discrete or vector action."""
        if self._config.n_actions is not None:
            return jax.nn.one_hot(
                action.astype(jnp.int32),
                self._config.n_actions,
                dtype=jnp.float32,
            )
        return jnp.asarray(action, dtype=jnp.float32).reshape((self._config.action_dim,))

    @functools.partial(jax.jit, static_argnums=(0,))
    def input_features(self, observation: Array, action: Array) -> Array:
        """Return ``concat(observation, encoded_action)``."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        return jnp.concatenate([obs, self.encode_action(action)], axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def targets(self, observation: Array, reward: Array, next_observation: Array) -> Array:
        """Build ``[reward, next_obs_or_delta]`` targets."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        next_obs = jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        obs_target = next_obs - obs if self._config.predict_delta else next_obs
        return jnp.concatenate(
            [jnp.reshape(jnp.asarray(reward, dtype=jnp.float32), (1,)), obs_target],
            axis=0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: WorldModelState,
        observation: Array,
        action: Array,
    ) -> WorldModelPrediction:
        """Predict reward and next observation."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        raw_predictions = self._learner.predict(
            state.learner_state,
            self.input_features(obs, action),
        )
        reward = raw_predictions[0]
        obs_prediction = raw_predictions[1:]
        next_observation = (
            obs + obs_prediction if self._config.predict_delta else obs_prediction
        )
        return WorldModelPrediction(
            next_observation=next_observation,
            reward=reward,
            raw_predictions=raw_predictions,
            discount=jnp.array(jnp.nan, dtype=jnp.float32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: WorldModelState,
        observation: Array,
        action: Array,
        reward: Array,
        next_observation: Array,
    ) -> WorldModelUpdateResult:
        """Update from one real transition."""
        prediction = self.predict(state, observation, action)
        targets = self.targets(observation, reward, next_observation)
        learner_result = self._learner.update(
            state.learner_state,
            self.input_features(observation, action),
            targets,
        )
        next_obs = jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        reward_arr = jnp.asarray(reward, dtype=jnp.float32)
        next_observation_errors = prediction.next_observation - next_obs
        reward_error = prediction.reward - reward_arr
        observation_mse = jnp.nanmean(next_observation_errors**2)
        prediction_error = jnp.nanmean(learner_result.errors**2)
        new_state = WorldModelState(
            learner_state=learner_result.state,
            step_count=state.step_count + 1,
        )
        return WorldModelUpdateResult(
            state=new_state,
            prediction=prediction,
            targets=targets,
            errors=learner_result.errors,
            per_head_metrics=learner_result.per_head_metrics,
            prediction_error=prediction_error,
            observation_mse=observation_mse,
            reward_error=reward_error,
            next_observation_errors=next_observation_errors,
            discount_error=jnp.array(jnp.nan, dtype=jnp.float32),
            learner_result=learner_result,
        )

    def _validate_config(self, config: WorldModelConfig) -> None:
        if config.observation_dim <= 0:
            raise ValueError("observation_dim must be positive")
        if config.n_actions is not None and config.n_actions <= 0:
            raise ValueError("n_actions must be positive when provided")
        if config.n_actions is None and config.action_dim <= 0:
            raise ValueError("action_dim must be positive for vector actions")
        if any(size <= 0 for size in config.hidden_sizes):
            raise ValueError("hidden_sizes must contain only positive widths")
        if not 0.0 <= config.utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")


def run_world_model_learning_loop(
    model: OneStepWorldModel,
    state: WorldModelState,
    observations: Array,
    actions: Array,
    rewards: Array,
    next_observations: Array,
) -> WorldModelLearningResult:
    """Run one-step world-model learning with ``jax.lax.scan``."""

    def step_fn(
        carry: WorldModelState,
        inputs: tuple[Array, Array, Array, Array],
    ) -> tuple[WorldModelState, tuple[Array, Array, Array, Array, Array]]:
        obs, action, reward, next_obs = inputs
        result = model.update(carry, obs, action, reward, next_obs)
        return result.state, (
            result.prediction.reward,
            result.prediction.next_observation,
            result.reward_error,
            result.next_observation_errors,
            result.per_head_metrics,
        )

    final_state, (
        reward_predictions,
        next_observation_predictions,
        reward_errors,
        next_observation_errors,
        per_head_metrics,
    ) = jax.lax.scan(step_fn, state, (observations, actions, rewards, next_observations))
    return WorldModelLearningResult(
        state=final_state,
        reward_predictions=reward_predictions,
        next_observation_predictions=next_observation_predictions,
        reward_errors=reward_errors,
        next_observation_errors=next_observation_errors,
        per_head_metrics=per_head_metrics,
    )
