# mypy: disable-error-code="call-arg"
"""Guarded self-simulation helpers.

Dreaming is deliberately separated from world-model learning. The world model
learns only from real transitions; this module decides whether a predicted
transition is safe enough to expose to a control learner.
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any, Literal, Protocol, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.behavior_model import (
    BehaviorModel,
    BehaviorModelState,
    floor_and_renormalize_probabilities,
    selected_action_probabilities,
)
from alberta_framework.core.world_model import (
    ActionConditionedWorldModel,
    ActionConditionedWorldModelState,
)
from alberta_framework.core.world_model import (
    WorldModelPrediction as ActionWorldModelPrediction,
)


@dataclasses.dataclass(frozen=True)
class DreamingConfig:
    """Configuration for guarded model-generated transitions.

    Args:
        warmup_steps: Real model updates required before any dream can be
            accepted.
        max_model_error_ema: Maximum allowed world-model real-transition error
            EMA. Set high for smoke experiments; tune from real-error quantiles
            for serious runs.
        max_uncertainty: Maximum allowed external uncertainty estimate, e.g.
            ensemble disagreement. Single-model callers can pass ``0``.
        min_discount: Lower discount clamp for synthetic transitions.
        max_discount: Upper discount clamp for synthetic transitions. When
            ``None``, the world model's ``gamma`` is used.
    """

    warmup_steps: int = 100
    max_model_error_ema: float = 1.0
    max_uncertainty: float = 1.0
    min_discount: float = 0.0
    max_discount: float | None = None
    rollout_horizon: int = 1
    confidence_threshold: float = 0.0
    max_model_error: float = 1.0e30
    discount_floor: float = 0.0
    stop_on_terminal: bool = True

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "DreamingConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DreamingConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        return cls(**payload)


@chex.dataclass(frozen=True)
class DreamTransition:
    """One synthetic transition proposed by a world model."""

    observation: Float[Array, " observation_dim"]
    action: Int[Array, ""]
    reward: Float[Array, ""]
    discount: Float[Array, ""]
    next_observation: Float[Array, " observation_dim"]


@chex.dataclass(frozen=True)
class DreamProposal:
    """A guarded dream transition plus diagnostics."""

    transition: DreamTransition
    prediction: ActionWorldModelPrediction
    accepted: Array
    reject_code: Int[Array, ""]
    uncertainty: Float[Array, ""]


@chex.dataclass(frozen=True)
class RecentObservationBufferState:
    """Fixed-size ring buffer for real-state dream anchors."""

    observations: Float[Array, "capacity observation_dim"]
    size: Int[Array, ""]
    index: Int[Array, ""]


@dataclasses.dataclass(frozen=True)
class DreamSelectionConfig:
    """Configuration for selecting useful imagined or replay candidates.

    ``surprise`` should measure prediction error or novelty. ``utility`` can be
    reward, positive TD error, value improvement, or another task-relevant
    benefit. The score is deliberately simple so experiments can audit exactly
    why a candidate was selected.
    """

    max_items: int = 1
    surprise_weight: float = 1.0
    utility_weight: float = 1.0
    confidence_weight: float = 0.0
    model_error_weight: float = 1.0
    min_surprise: float = 0.0
    min_utility: float = -1.0e30
    min_confidence: float = 0.0
    max_model_error: float = 1.0e30

    def __post_init__(self) -> None:
        """Validate scalar configuration."""
        if self.max_items <= 0:
            raise ValueError("max_items must be positive")
        if self.min_confidence < 0.0:
            raise ValueError("min_confidence must be non-negative")
        if self.max_model_error < 0.0:
            raise ValueError("max_model_error must be non-negative")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "DreamSelectionConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DreamSelectionConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        return cls(**payload)


@chex.dataclass(frozen=True)
class DreamSelectionResult:
    """Scores and selected indices for a candidate dream set."""

    selected_indices: Int[Array, " max_items"]
    scores: Float[Array, " num_candidates"]
    accepted: Array
    selected_mask: Array


class GuardedDreamer:
    """Propose short, real-state-anchored dream transitions."""

    # Reject-code constants. Kept numeric so the proposal remains JAX-friendly.
    ACCEPT = 0
    REJECT_WARMUP = 1
    REJECT_MODEL_ERROR = 2
    REJECT_UNCERTAINTY = 3
    REJECT_NONFINITE = 4

    def __init__(self, config: DreamingConfig | None = None):
        """Initialize a guarded dream proposer."""
        self._config = config or DreamingConfig()
        if self._config.warmup_steps < 0:
            raise ValueError("warmup_steps must be non-negative")
        if self._config.max_model_error_ema < 0.0:
            raise ValueError("max_model_error_ema must be non-negative")
        if self._config.max_uncertainty < 0.0:
            raise ValueError("max_uncertainty must be non-negative")
        if self._config.min_discount < 0.0:
            raise ValueError("min_discount must be non-negative")
        if self._config.max_discount is not None and self._config.max_discount < 0.0:
            raise ValueError("max_discount must be non-negative")

    @property
    def config(self) -> DreamingConfig:
        """Dreaming guard configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize to a dictionary."""
        return {"type": "GuardedDreamer", "config": self._config.to_config()}

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> GuardedDreamer:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        return cls(DreamingConfig.from_config(payload["config"]))

    @functools.partial(jax.jit, static_argnums=(0, 1))
    def propose(
        self,
        model: ActionConditionedWorldModel,
        model_state: ActionConditionedWorldModelState,
        observation: Array,
        action: Array,
        uncertainty: Array | None = None,
    ) -> DreamProposal:
        """Return a guarded synthetic transition proposal.

        The transition is always returned, but callers should use ``accepted``
        to decide whether to update a control learner from it.
        """
        if uncertainty is None:
            uncertainty = jnp.array(0.0, dtype=jnp.float32)
        uncertainty_arr = jnp.asarray(uncertainty, dtype=jnp.float32)
        prediction = model.predict(model_state, observation, action)
        max_discount = (
            model.config.gamma
            if self._config.max_discount is None
            else self._config.max_discount
        )
        discount = jnp.clip(
            prediction.discount,
            self._config.min_discount,
            max_discount,
        )
        transition = DreamTransition(
            observation=jnp.asarray(observation, dtype=jnp.float32).reshape(
                (model.config.observation_dim,)
            ),
            action=jnp.asarray(action, dtype=jnp.int32),
            reward=prediction.reward,
            discount=discount,
            next_observation=prediction.next_observation,
        )

        enough_data = model_state.step_count >= self._config.warmup_steps
        low_error = model_state.model_error_ema <= self._config.max_model_error_ema
        low_uncertainty = uncertainty_arr <= self._config.max_uncertainty
        finite = (
            jnp.all(jnp.isfinite(transition.observation))
            & jnp.isfinite(transition.reward)
            & jnp.isfinite(transition.discount)
            & jnp.all(jnp.isfinite(transition.next_observation))
        )
        accepted = enough_data & low_error & low_uncertainty & finite
        reject_code = jnp.where(
            accepted,
            self.ACCEPT,
            jnp.where(
                ~enough_data,
                self.REJECT_WARMUP,
                jnp.where(
                    ~low_error,
                    self.REJECT_MODEL_ERROR,
                    jnp.where(~low_uncertainty, self.REJECT_UNCERTAINTY, self.REJECT_NONFINITE),
                ),
            ),
        ).astype(jnp.int32)

        return DreamProposal(
            transition=transition,
            prediction=prediction,
            accepted=accepted,
            reject_code=reject_code,
            uncertainty=uncertainty_arr,
        )


class BehaviorModelDreamPolicy:
    """Adapter from :class:`BehaviorModel` to the dream behavior protocol."""

    def __init__(self, model: BehaviorModel):
        """Initialize the adapter."""
        self._model = model

    @property
    def model(self) -> BehaviorModel:
        """Wrapped behavior model."""
        return self._model

    def sample_action(
        self,
        state: BehaviorModelState,
        observation: Array,
        key: Array,
    ) -> DreamBehaviorModelPrediction:
        """Sample an imagined action without mutating real behavior state."""
        probabilities = floor_and_renormalize_probabilities(
            self._model.predict_probabilities(state, observation),
            min_probability=self._model.config.min_probability,
        )
        action = jr.categorical(key, jnp.log(probabilities)).astype(jnp.int32)
        action_prob = selected_action_probabilities(
            probabilities,
            action,
            min_probability=self._model.config.min_probability,
        )
        return DreamBehaviorModelPrediction(
            action=action,
            action_probability=action_prob,
            log_probability=jnp.log(action_prob),
        )


def score_dream_candidates(
    surprises: Array,
    utilities: Array,
    *,
    confidences: Array | None = None,
    model_errors: Array | None = None,
    valid: Array | None = None,
    config: DreamSelectionConfig | None = None,
) -> DreamSelectionResult:
    """Score and select surprising/useful candidate dreams.

    Candidates that fail hard gates get score ``-inf`` and cannot be selected
    unless every candidate is rejected, in which case the returned mask remains
    false for those indices.
    """
    cfg = config or DreamSelectionConfig()
    surprise_arr = jnp.ravel(jnp.asarray(surprises, dtype=jnp.float32))
    utility_arr = jnp.ravel(jnp.asarray(utilities, dtype=jnp.float32))
    if surprise_arr.shape != utility_arr.shape:
        raise ValueError("surprises and utilities must have the same shape")
    confidence_arr = (
        jnp.ones_like(surprise_arr)
        if confidences is None
        else jnp.ravel(jnp.asarray(confidences, dtype=jnp.float32))
    )
    error_arr = (
        jnp.zeros_like(surprise_arr)
        if model_errors is None
        else jnp.ravel(jnp.asarray(model_errors, dtype=jnp.float32))
    )
    valid_arr = (
        jnp.ones_like(surprise_arr, dtype=jnp.bool_)
        if valid is None
        else jnp.ravel(jnp.asarray(valid, dtype=jnp.bool_))
    )
    if confidence_arr.shape != surprise_arr.shape:
        raise ValueError("confidences must match surprises")
    if error_arr.shape != surprise_arr.shape:
        raise ValueError("model_errors must match surprises")
    if valid_arr.shape != surprise_arr.shape:
        raise ValueError("valid must match surprises")

    accepted = (
        valid_arr
        & (surprise_arr >= jnp.asarray(cfg.min_surprise, dtype=jnp.float32))
        & (utility_arr >= jnp.asarray(cfg.min_utility, dtype=jnp.float32))
        & (confidence_arr >= jnp.asarray(cfg.min_confidence, dtype=jnp.float32))
        & (error_arr <= jnp.asarray(cfg.max_model_error, dtype=jnp.float32))
    )
    raw_scores = (
        cfg.surprise_weight * surprise_arr
        + cfg.utility_weight * utility_arr
        + cfg.confidence_weight * confidence_arr
        - cfg.model_error_weight * error_arr
    )
    scores = jnp.where(accepted, raw_scores, -jnp.inf)
    selected_indices = jnp.argsort(-scores)[: cfg.max_items].astype(jnp.int32)
    selected_accepted = accepted[selected_indices]
    selected_mask = jnp.zeros_like(accepted).at[selected_indices].set(selected_accepted)
    return DreamSelectionResult(
        selected_indices=selected_indices,
        scores=scores,
        accepted=accepted,
        selected_mask=selected_mask,
    )


class RecentObservationBuffer:
    """Fixed-size buffer for anchoring dreams in recently observed states."""

    def __init__(self, capacity: int, observation_dim: int):
        """Initialize the buffer shape."""
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        if observation_dim <= 0:
            raise ValueError("observation_dim must be positive")
        self._capacity = capacity
        self._observation_dim = observation_dim

    @property
    def capacity(self) -> int:
        """Maximum number of observations retained."""
        return self._capacity

    @property
    def observation_dim(self) -> int:
        """Observation dimensionality."""
        return self._observation_dim

    def init(self) -> RecentObservationBufferState:
        """Return an empty buffer state."""
        return RecentObservationBufferState(
            observations=jnp.zeros(
                (self._capacity, self._observation_dim),
                dtype=jnp.float32,
            ),
            size=jnp.array(0, dtype=jnp.int32),
            index=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def add(
        self,
        state: RecentObservationBufferState,
        observation: Array,
    ) -> RecentObservationBufferState:
        """Insert one observation into the ring buffer."""
        obs = jnp.asarray(observation, dtype=jnp.float32).reshape(
            (self._observation_dim,)
        )
        next_observations = state.observations.at[state.index].set(obs)
        return RecentObservationBufferState(
            observations=next_observations,
            size=jnp.minimum(state.size + 1, self._capacity).astype(jnp.int32),
            index=((state.index + 1) % self._capacity).astype(jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def sample(
        self,
        state: RecentObservationBufferState,
        key: Array,
    ) -> tuple[Array, Array]:
        """Sample one retained observation.

        Returns the sampled observation and the sampled index. If the buffer is
        empty, index ``0`` and the zero observation are returned.
        """
        sample_size = jnp.maximum(state.size, 1)
        idx = jr.randint(key, (), 0, sample_size).astype(jnp.int32)
        return state.observations[idx], idx


class DreamBehaviorModel(Protocol):
    """Minimal behavior model protocol for rollout-level self-simulation."""

    def sample_action(
        self,
        state: Any,
        observation: Array,
        key: Array,
    ) -> DreamBehaviorModelPrediction:
        """Sample or choose an imagined action."""
        ...


class DreamWorldModel(Protocol):
    """Minimal world model protocol for rollout-level self-simulation."""

    def predict(
        self,
        state: Any,
        observation: Array,
        action: Array,
        key: Array,
    ) -> DreamWorldModelPrediction:
        """Predict one imagined transition."""
        ...


@dataclasses.dataclass(frozen=True)
class DreamRolloutConfig:
    """Configuration for bounded short model rollouts.

    This config complements :class:`DreamingConfig`, which guards one-step
    proposals from the concrete action-conditioned world model.
    """

    rollout_horizon: int = 1
    confidence_threshold: float = 0.0
    max_model_error: float = 1.0e30
    discount_floor: float = 0.0
    stop_on_terminal: bool = True

    def __post_init__(self) -> None:
        """Validate scalar configuration."""
        if self.rollout_horizon < 1:
            raise ValueError("rollout_horizon must be positive")
        if self.confidence_threshold < 0.0:
            raise ValueError("confidence_threshold must be non-negative")
        if self.max_model_error < 0.0:
            raise ValueError("max_model_error must be non-negative")
        if self.discount_floor < 0.0:
            raise ValueError("discount_floor must be non-negative")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        payload = dataclasses.asdict(self)
        payload["type"] = "DreamRolloutConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DreamRolloutConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        return cls(**payload)


@chex.dataclass(frozen=True)
class DreamBehaviorModelPrediction:
    """Action prediction used by rollout-level dreaming."""

    action: Array
    action_probability: Float[Array, ""]
    log_probability: Float[Array, ""]


@chex.dataclass(frozen=True)
class DreamWorldModelPrediction:
    """World-model prediction used by rollout-level dreaming."""

    next_observation: Array
    reward: Float[Array, ""]
    discount: Float[Array, ""]
    terminated: Array
    confidence: Float[Array, ""]
    model_error: Float[Array, ""]


BehaviorModelPrediction = DreamBehaviorModelPrediction
WorldModelPrediction = DreamWorldModelPrediction


@chex.dataclass(frozen=True)
class DreamRolloutState:
    """State carried through an imagined rollout."""

    observation: Array
    rng_key: Array
    active: Array
    cumulative_confidence: Float[Array, ""]
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class ImaginedTransition:
    """Transition generated by a world model and behavior model."""

    observation: Array
    action: Array
    reward: Float[Array, ""]
    next_observation: Array
    discount: Float[Array, ""]
    terminated: Array
    confidence: Float[Array, ""]
    model_error: Float[Array, ""]
    behavior_probability: Float[Array, ""]
    valid: Array
    step_index: Int[Array, ""]


@chex.dataclass(frozen=True)
class DreamRolloutResult:
    """Result from a bounded imagined rollout."""

    state: DreamRolloutState
    transitions: ImaginedTransition


@chex.dataclass(frozen=True)
class DreamSupervisedTrainingItem:
    """Supervised item derived from an imagined transition."""

    inputs: Array
    targets: Array
    weights: Float[Array, ""]


@chex.dataclass(frozen=True)
class DreamGVFTrainingItem:
    """GVF/Horde-style item derived from imagined transitions."""

    observations: Array
    cumulants: Array
    next_observations: Array
    discounts: Array
    weights: Array


@chex.dataclass(frozen=True)
class DreamSARSATrainingItem:
    """SARSA-style item derived from imagined transitions."""

    observations: Array
    actions: Array
    rewards: Array
    next_observations: Array
    discounts: Array
    next_actions: Array
    weights: Array


class ActionConditionedDreamWorld:
    """Adapter from :class:`ActionConditionedWorldModel` to rollout protocol."""

    def __init__(
        self,
        model: ActionConditionedWorldModel,
        *,
        confidence: float = 1.0,
    ):
        """Initialize the adapter."""
        self._model = model
        self._confidence = confidence

    def predict(
        self,
        state: ActionConditionedWorldModelState,
        observation: Array,
        action: Array,
        key: Array,
    ) -> DreamWorldModelPrediction:
        """Predict one dream transition from the wrapped model."""
        del key
        prediction = self._model.predict(state, observation, action)
        return DreamWorldModelPrediction(
            next_observation=prediction.next_observation,
            reward=prediction.reward,
            discount=prediction.discount,
            terminated=prediction.discount <= 0.0,
            confidence=jnp.asarray(self._confidence, dtype=jnp.float32),
            model_error=state.model_error_ema,
        )


def init_dream_rollout_state(
    observation: Array,
    key: Array,
    *,
    active: bool = True,
) -> DreamRolloutState:
    """Create an initial rollout state from a real observation."""
    return DreamRolloutState(
        observation=jnp.asarray(observation),
        rng_key=key,
        active=jnp.asarray(active, dtype=jnp.bool_),
        cumulative_confidence=jnp.array(1.0, dtype=jnp.float32),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def dream_one_step(
    world_model: DreamWorldModel,
    world_state: Any,
    behavior_model: DreamBehaviorModel,
    behavior_state: Any,
    rollout_state: DreamRolloutState,
    config: DreamRolloutConfig | None = None,
) -> tuple[DreamRolloutState, ImaginedTransition]:
    """Generate one imagined transition without mutating real environment state."""
    cfg = config or DreamRolloutConfig()
    key, action_key, model_key = jr.split(rollout_state.rng_key, 3)
    behavior_prediction = behavior_model.sample_action(
        behavior_state,
        rollout_state.observation,
        action_key,
    )
    world_prediction = world_model.predict(
        world_state,
        rollout_state.observation,
        behavior_prediction.action,
        model_key,
    )
    confidence_ok = world_prediction.confidence >= jnp.asarray(
        cfg.confidence_threshold,
        dtype=jnp.float32,
    )
    error_ok = world_prediction.model_error <= jnp.asarray(
        cfg.max_model_error,
        dtype=jnp.float32,
    )
    discount_terminal = world_prediction.discount <= jnp.asarray(
        cfg.discount_floor,
        dtype=jnp.float32,
    )
    terminated = jnp.logical_or(world_prediction.terminated, discount_terminal)
    valid = jnp.logical_and(rollout_state.active, jnp.logical_and(confidence_ok, error_ok))
    next_active = jnp.logical_and(valid, jnp.logical_not(terminated))
    if not cfg.stop_on_terminal:
        next_active = valid
    next_observation = jnp.where(
        valid,
        world_prediction.next_observation,
        rollout_state.observation,
    )
    next_state = DreamRolloutState(
        observation=next_observation,
        rng_key=key,
        active=next_active,
        cumulative_confidence=jnp.where(
            valid,
            rollout_state.cumulative_confidence * world_prediction.confidence,
            rollout_state.cumulative_confidence,
        ),
        step_count=rollout_state.step_count + 1,
    )
    transition = ImaginedTransition(
        observation=rollout_state.observation,
        action=behavior_prediction.action,
        reward=jnp.squeeze(jnp.asarray(world_prediction.reward, dtype=jnp.float32)),
        next_observation=world_prediction.next_observation,
        discount=jnp.squeeze(jnp.asarray(world_prediction.discount, dtype=jnp.float32)),
        terminated=terminated,
        confidence=jnp.squeeze(jnp.asarray(world_prediction.confidence, dtype=jnp.float32)),
        model_error=jnp.squeeze(jnp.asarray(world_prediction.model_error, dtype=jnp.float32)),
        behavior_probability=jnp.squeeze(
            jnp.asarray(behavior_prediction.action_probability, dtype=jnp.float32)
        ),
        valid=valid,
        step_index=rollout_state.step_count,
    )
    return next_state, transition


def dream_rollout(
    world_model: DreamWorldModel,
    world_state: Any,
    behavior_model: DreamBehaviorModel,
    behavior_state: Any,
    rollout_state: DreamRolloutState,
    config: DreamRolloutConfig,
) -> DreamRolloutResult:
    """Generate a bounded short rollout using ``jax.lax.scan``."""

    def step_fn(
        carry: DreamRolloutState,
        _: Array,
    ) -> tuple[DreamRolloutState, ImaginedTransition]:
        return dream_one_step(
            world_model,
            world_state,
            behavior_model,
            behavior_state,
            carry,
            config,
        )

    final_state, transitions = jax.lax.scan(
        step_fn,
        rollout_state,
        jnp.arange(config.rollout_horizon, dtype=jnp.int32),
    )
    return DreamRolloutResult(state=final_state, transitions=transitions)


def slice_imagined_transition(
    transitions: ImaginedTransition,
    index: int,
) -> ImaginedTransition:
    """Select one transition from a time-leading rollout."""
    return cast(
        ImaginedTransition,
        jax.tree_util.tree_map(lambda value: value[index], transitions),
    )


def action_features(action: Array, n_actions: int | None = None) -> Array:
    """Return float action features for training-item conversion."""
    if n_actions is None:
        return jnp.ravel(jnp.asarray(action, dtype=jnp.float32))
    if n_actions < 1:
        raise ValueError("n_actions must be positive when provided")
    action_index = jnp.squeeze(jnp.asarray(action, dtype=jnp.int32))
    return jax.nn.one_hot(action_index, n_actions, dtype=jnp.float32)


def imagined_transition_to_supervised_item(
    transition: ImaginedTransition,
    *,
    n_actions: int | None = None,
    target: Literal["next_observation", "reward", "reward_next_observation"] = (
        "next_observation"
    ),
) -> DreamSupervisedTrainingItem:
    """Convert one imagined transition to a supervised model-learning item."""
    inputs = jnp.concatenate(
        [
            jnp.ravel(jnp.asarray(transition.observation, dtype=jnp.float32)),
            action_features(transition.action, n_actions),
        ],
        axis=0,
    )
    reward = jnp.reshape(jnp.asarray(transition.reward, dtype=jnp.float32), (1,))
    next_observation = jnp.ravel(
        jnp.asarray(transition.next_observation, dtype=jnp.float32)
    )
    if target == "next_observation":
        targets = next_observation
    elif target == "reward":
        targets = reward
    elif target == "reward_next_observation":
        targets = jnp.concatenate([reward, next_observation], axis=0)
    else:
        raise ValueError(f"unknown supervised target {target!r}")
    return DreamSupervisedTrainingItem(
        inputs=inputs,
        targets=targets,
        weights=jnp.asarray(transition.valid, dtype=jnp.float32),
    )


def imagined_transition_to_gvf_item(
    transition: ImaginedTransition,
    cumulants: Array | None = None,
) -> DreamGVFTrainingItem:
    """Convert one imagined transition to a GVF/Horde update item."""
    cumulant_array = (
        jnp.reshape(jnp.asarray(transition.reward, dtype=jnp.float32), (1,))
        if cumulants is None
        else jnp.ravel(jnp.asarray(cumulants, dtype=jnp.float32))
    )
    return DreamGVFTrainingItem(
        observations=transition.observation,
        cumulants=cumulant_array,
        next_observations=transition.next_observation,
        discounts=jnp.reshape(jnp.asarray(transition.discount, dtype=jnp.float32), (1,)),
        weights=jnp.reshape(jnp.asarray(transition.valid, dtype=jnp.float32), (1,)),
    )


def imagined_rollout_to_gvf_items(
    rollout: DreamRolloutResult,
    cumulants: Array | None = None,
) -> DreamGVFTrainingItem:
    """Convert a rollout to time-leading GVF/Horde arrays."""
    transitions = rollout.transitions
    cumulant_array = (
        jnp.reshape(jnp.asarray(transitions.reward, dtype=jnp.float32), (-1, 1))
        if cumulants is None
        else jnp.asarray(cumulants, dtype=jnp.float32)
    )
    return DreamGVFTrainingItem(
        observations=transitions.observation,
        cumulants=cumulant_array,
        next_observations=transitions.next_observation,
        discounts=jnp.asarray(transitions.discount, dtype=jnp.float32),
        weights=jnp.asarray(transitions.valid, dtype=jnp.float32),
    )


def imagined_rollout_to_sarsa_items(
    rollout: DreamRolloutResult,
    bootstrap_action: Array | None = None,
) -> DreamSARSATrainingItem:
    """Convert a rollout to SARSA-style arrays with shifted next actions."""
    transitions = rollout.transitions
    actions = transitions.action
    if bootstrap_action is None:
        next_actions = jnp.concatenate([actions[1:], jnp.zeros_like(actions[-1:])], axis=0)
        weights = jnp.asarray(transitions.valid, dtype=jnp.float32)
        weights = weights.at[-1].set(0.0)
    else:
        bootstrap = jnp.expand_dims(jnp.asarray(bootstrap_action, dtype=actions.dtype), axis=0)
        next_actions = jnp.concatenate([actions[1:], bootstrap], axis=0)
        weights = jnp.asarray(transitions.valid, dtype=jnp.float32)
    return DreamSARSATrainingItem(
        observations=transitions.observation,
        actions=actions,
        rewards=jnp.asarray(transitions.reward, dtype=jnp.float32),
        next_observations=transitions.next_observation,
        discounts=jnp.asarray(transitions.discount, dtype=jnp.float32),
        next_actions=next_actions,
        weights=weights,
    )


__all__ = [
    "ActionConditionedDreamWorld",
    "BehaviorModelPrediction",
    "BehaviorModelDreamPolicy",
    "DreamBehaviorModel",
    "DreamBehaviorModelPrediction",
    "DreamGVFTrainingItem",
    "DreamProposal",
    "DreamRolloutConfig",
    "DreamRolloutResult",
    "DreamRolloutState",
    "DreamSARSATrainingItem",
    "DreamSelectionConfig",
    "DreamSelectionResult",
    "DreamSupervisedTrainingItem",
    "DreamTransition",
    "DreamWorldModel",
    "DreamWorldModelPrediction",
    "DreamingConfig",
    "GuardedDreamer",
    "ImaginedTransition",
    "RecentObservationBuffer",
    "RecentObservationBufferState",
    "WorldModelPrediction",
    "action_features",
    "dream_one_step",
    "dream_rollout",
    "imagined_rollout_to_gvf_items",
    "imagined_rollout_to_sarsa_items",
    "imagined_transition_to_gvf_item",
    "imagined_transition_to_supervised_item",
    "init_dream_rollout_state",
    "score_dream_candidates",
    "slice_imagined_transition",
]
