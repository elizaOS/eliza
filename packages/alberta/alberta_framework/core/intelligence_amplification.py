# mypy: disable-error-code="attr-defined,call-arg,no-any-return"
"""Core types and algorithms for Intelligence Amplification (Alberta Plan Step 12).

Step 12 — "Prototype-IA: Intelligence Amplification" — shifts from autonomous
agent to *augmenting a partner agent's intelligence*.  The IA agent observes
the same environment as the partner and provides two complementary streams of
augmentation:

**Exo-cerebellum** — A multi-output online linear predictor that continuously
learns to predict future observation features from the current observation.  The
prediction vector is broadcast to the partner so it can use anticipated future
state information as augmented features.  This implements the "sensorimotor
predictions" concept from Pilarski & Sutton's communicative capital work
(Mathewson et al. 2023).

**Exo-cortex** — An :class:`~alberta_framework.core.oak.OaKAgent` that observes
the partner's states and rewards, learning its own Q-function over the same
environment.  It broadcasts an action recommendation at each step by taking the
argmax of its current Q-values.  The partner can accept or ignore the
recommendation.

Together, the :class:`IAAgent` provides at every step:
* A prediction vector ``predictions`` of shape ``(n_demons,)`` — future feature
  estimates from the exo-cerebellum.
* An action recommendation ``recommendation`` of shape ``()`` — the cortex's
  greedy action choice.
* An augmented observation ``augmented_obs`` of shape
  ``(obs_dim + n_demons,)`` = ``concat(partner_obs, predictions)``, ready to
  drop into the partner's feature pipeline.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Mathewson et al. (2023). "Communicative Capital: A Key Resource for
        Human-Machine Shared Agency." *Neural Computing & Applications* 35(23).
"""

from __future__ import annotations

import dataclasses
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.oak import OaKAgent, OaKConfig, OaKState, _default_stomp_config

# ---------------------------------------------------------------------------
# Exo-cerebellum
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ExoCerebellumConfig:
    """Configuration for the exo-cerebellum online predictor.

    Each demon i predicts ``next_obs[i % obs_dim]`` from the current
    observation using a linear TD(0) update.

    Args:
        n_demons: Number of prediction heads.
        obs_dim: Flat observation dimensionality.
        step_size: Learning rate for weight updates.
    """

    n_demons: int = 4
    obs_dim: int = 4
    step_size: float = 0.05

    def __post_init__(self) -> None:
        if self.n_demons <= 0:
            raise ValueError("n_demons must be positive")
        if self.obs_dim <= 0:
            raise ValueError("obs_dim must be positive")
        if self.step_size <= 0.0:
            raise ValueError("step_size must be positive")

    def to_config(self) -> dict[str, Any]:
        return {"type": "ExoCerebellumConfig", **dataclasses.asdict(self)}

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> ExoCerebellumConfig:
        data = dict(payload)
        data.pop("type", None)
        return cls(**data)


@chex.dataclass(frozen=True)
class ExoCerebellumState:
    """State of the exo-cerebellum predictor.

    Attributes:
        weights: Linear prediction weights; shape ``(n_demons, obs_dim)``.
        step_count: Number of update steps taken.
    """

    weights: Float[Array, "n_demons obs_dim"]
    step_count: Int[Array, ""]


class ExoCerebellumAgent:
    """Online multi-output linear predictor for Step 12 IA.

    Demon ``i`` learns to predict ``next_obs[i % obs_dim]`` from the current
    observation via a one-step supervised / TD(0) update:

    ``error = next_obs[i % obs_dim] - weights[i] @ obs``
    ``weights[i] += alpha * error * obs``
    """

    def __init__(self, config: ExoCerebellumConfig) -> None:
        self._config = config
        self._cumulant_indices = jnp.arange(config.n_demons, dtype=jnp.int32) % config.obs_dim

    @property
    def config(self) -> ExoCerebellumConfig:
        return self._config

    def to_config(self) -> dict[str, Any]:
        return self._config.to_config()

    def init(self) -> ExoCerebellumState:
        """Initialise with zero prediction weights."""
        return ExoCerebellumState(
            weights=jnp.zeros(
                (self._config.n_demons, self._config.obs_dim), dtype=jnp.float32
            ),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def predict(self, state: ExoCerebellumState, observation: Array) -> Array:
        """Compute current predictions from an observation.

        Args:
            state: Current cerebellum state.
            observation: Shape ``(obs_dim,)`` float32.

        Returns:
            Shape ``(n_demons,)`` predictions.
        """
        return state.weights @ jnp.asarray(observation, dtype=jnp.float32)

    def update(
        self,
        state: ExoCerebellumState,
        observation: Array,
        next_observation: Array,
    ) -> tuple[ExoCerebellumState, Array, Array]:
        """One-step supervised update for all demons.

        Args:
            state: Current cerebellum state.
            observation: Current observation ``s_t``, shape ``(obs_dim,)``.
            next_observation: Next observation ``s_{t+1}``, shape ``(obs_dim,)``.

        Returns:
            ``(new_state, predictions, errors)`` where predictions are computed
            *before* the weight update, matching the typical RL convention.
        """
        obs = jnp.asarray(observation, dtype=jnp.float32)
        next_obs = jnp.asarray(next_observation, dtype=jnp.float32)
        alpha = jnp.asarray(self._config.step_size, dtype=jnp.float32)

        predictions = state.weights @ obs
        targets = next_obs[self._cumulant_indices]
        errors = targets - predictions
        new_weights = state.weights + alpha * jnp.outer(errors, obs)

        new_state = ExoCerebellumState(
            weights=new_weights,
            step_count=state.step_count + 1,
        )
        return new_state, predictions, errors


# ---------------------------------------------------------------------------
# Exo-cortex (thin wrapper around OaKAgent)
# ---------------------------------------------------------------------------


def _default_oak_config() -> OaKConfig:
    """Default OaK config for the exo-cortex."""
    from alberta_framework.core.oak import OaKConfig  # local to avoid circular at module level

    return OaKConfig(
        stomp=_default_stomp_config(),
        utility_ema_decay=0.99,
        curation_threshold=0.0,
    )


# ExoCortexConfig is just OaKConfig; the type alias makes the Step 12 API clear.
ExoCortexConfig = OaKConfig
ExoCortexState = OaKState


class ExoCortexAgent:
    """Exo-cortex: an OaKAgent that provides action recommendations.

    Learns from the partner's (obs, reward, next_obs) experience and
    broadcasts its greedy action recommendation at each step.
    """

    def __init__(self, config: ExoCortexConfig) -> None:
        self._oak = OaKAgent(config)

    @property
    def config(self) -> ExoCortexConfig:
        return self._oak.config

    @property
    def oak_agent(self) -> OaKAgent:
        return self._oak

    def to_config(self) -> dict[str, Any]:
        return self._oak.to_config()

    def init(self, key: Array) -> ExoCortexState:
        return self._oak.init(key)

    def start(self, state: ExoCortexState, initial_obs: Array) -> ExoCortexState:
        return self._oak.start(state, initial_obs)

    def recommend(self, state: ExoCortexState, observation: Array) -> Int[Array, ""]:
        """Return the greedy primitive action for a given observation."""
        obs = jnp.asarray(observation, dtype=jnp.float32)
        q_vals = self._oak.base_q_values(state, obs)
        n_prim = self._oak.config.n_primitive_actions
        q_prim = q_vals[:n_prim]
        return jnp.argmax(q_prim).astype(jnp.int32)

    def update(
        self,
        state: ExoCortexState,
        partner_reward: Array,
        partner_next_obs: Array,
    ) -> tuple[ExoCortexState, Int[Array, ""], Float[Array, ""]]:
        """Update cortex from partner experience and return recommendation.

        Returns ``(new_state, recommendation, td_error)``.
        """
        result = self._oak.update(state, partner_reward, partner_next_obs)
        recommendation = self.recommend(result.state, partner_next_obs)
        return result.state, recommendation, result.td_error


# ---------------------------------------------------------------------------
# Combined IA agent
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class IAConfig:
    """Configuration for the Intelligence Amplification agent.

    Args:
        cerebellum: Exo-cerebellum configuration.
        cortex: Exo-cortex (OaK) configuration.
    """

    cerebellum: ExoCerebellumConfig = dataclasses.field(
        default_factory=ExoCerebellumConfig
    )
    cortex: ExoCortexConfig = dataclasses.field(default_factory=_default_oak_config)

    def __post_init__(self) -> None:
        if self.cerebellum.obs_dim != self.cortex.observation_dim:
            raise ValueError(
                f"cerebellum.obs_dim ({self.cerebellum.obs_dim}) must equal "
                f"cortex.observation_dim ({self.cortex.observation_dim})"
            )

    @property
    def augmented_obs_dim(self) -> int:
        """Dimension of the concatenated [partner_obs, predictions] vector."""
        return self.cortex.observation_dim + self.cerebellum.n_demons

    def to_config(self) -> dict[str, Any]:
        return {
            "type": "IAConfig",
            "cerebellum": self.cerebellum.to_config(),
            "cortex": self.cortex.to_config(),
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> IAConfig:
        data = dict(payload)
        data.pop("type", None)
        cerebellum = ExoCerebellumConfig.from_config(cast(dict[str, Any], data["cerebellum"]))
        cortex = OaKConfig.from_config(cast(dict[str, Any], data["cortex"]))
        return cls(cerebellum=cerebellum, cortex=cortex)


@chex.dataclass(frozen=True)
class IAState:
    """Combined IA agent state.

    Attributes:
        cerebellum_state: Exo-cerebellum weight state.
        cortex_state: Exo-cortex OaK agent state.
        step_count: Total primitive steps processed.
    """

    cerebellum_state: ExoCerebellumState
    cortex_state: ExoCortexState
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class IAUpdateResult:
    """Result of one IA primitive step.

    Attributes:
        state: New combined IA state.
        predictions: Exo-cerebellum output *before* the weight update;
            shape ``(n_demons,)``.
        cerebellum_errors: Per-demon prediction errors; shape ``(n_demons,)``.
        recommendation: Exo-cortex greedy action recommendation.
        augmented_obs: ``concat(partner_obs, predictions)``; shape
            ``(obs_dim + n_demons,)``.
        cortex_td_error: TD error from the cortex Q-update.
    """

    state: IAState
    predictions: Float[Array, " n_demons"]
    cerebellum_errors: Float[Array, " n_demons"]
    recommendation: Int[Array, ""]
    augmented_obs: Float[Array, " augmented_dim"]
    cortex_td_error: Float[Array, ""]


@chex.dataclass(frozen=True)
class IAArrayResult:
    """Scan result for the IA agent over transition arrays."""

    state: IAState
    predictions: Float[Array, "num_steps n_demons"]
    cerebellum_errors: Float[Array, "num_steps n_demons"]
    recommendations: Int[Array, " num_steps"]
    augmented_obs: Float[Array, "num_steps augmented_dim"]
    cortex_td_errors: Float[Array, " num_steps"]


@dataclasses.dataclass(frozen=True)
class RecommendationProtocolConfig:
    """Configuration for recommendation acceptance/rejection feedback."""

    acceptance_ema_decay: float = 0.95

    def __post_init__(self) -> None:
        if not 0.0 <= self.acceptance_ema_decay < 1.0:
            raise ValueError("acceptance_ema_decay must be in [0, 1)")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        return {
            "type": "RecommendationProtocolConfig",
            "acceptance_ema_decay": self.acceptance_ema_decay,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> RecommendationProtocolConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        return cls(**data)


@chex.dataclass(frozen=True)
class RecommendationProtocolState:
    """State for partner acceptance/rejection feedback."""

    accepted_count: Int[Array, ""]
    rejected_count: Int[Array, ""]
    acceptance_ema: Float[Array, ""]
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class RecommendationProtocolResult:
    """Result of one recommendation feedback event."""

    state: RecommendationProtocolState
    recommendation: Int[Array, ""]
    partner_action: Int[Array, ""]
    effective_action: Int[Array, ""]
    accepted: Array


def init_recommendation_protocol_state() -> RecommendationProtocolState:
    """Initialize recommendation feedback counters."""
    return RecommendationProtocolState(
        accepted_count=jnp.array(0, dtype=jnp.int32),
        rejected_count=jnp.array(0, dtype=jnp.int32),
        acceptance_ema=jnp.array(0.0, dtype=jnp.float32),
        step_count=jnp.array(0, dtype=jnp.int32),
    )


def update_recommendation_protocol(
    config: RecommendationProtocolConfig,
    state: RecommendationProtocolState,
    recommendation: Array,
    partner_action: Array,
) -> RecommendationProtocolResult:
    """Record whether a partner accepted or rejected a recommendation.

    A recommendation is accepted when the partner's executed action equals the
    recommendation.  The effective action is the recommendation on acceptance
    and the partner action on rejection, giving callers a single action stream
    for replay or downstream logging.
    """
    rec = jnp.asarray(recommendation, dtype=jnp.int32)
    action = jnp.asarray(partner_action, dtype=jnp.int32)
    accepted = rec == action
    accepted_i = accepted.astype(jnp.int32)
    rejected_i = (~accepted).astype(jnp.int32)
    accepted_f = accepted.astype(jnp.float32)
    decay = jnp.asarray(config.acceptance_ema_decay, dtype=jnp.float32)
    new_state = RecommendationProtocolState(
        accepted_count=state.accepted_count + accepted_i,
        rejected_count=state.rejected_count + rejected_i,
        acceptance_ema=decay * state.acceptance_ema + (1.0 - decay) * accepted_f,
        step_count=state.step_count + 1,
    )
    return RecommendationProtocolResult(
        state=new_state,
        recommendation=rec,
        partner_action=action,
        effective_action=jnp.where(accepted, rec, action),
        accepted=accepted,
    )


class IAAgent:
    """Alberta Plan Step 12 Intelligence Amplification agent.

    Combines an :class:`ExoCerebellumAgent` and an :class:`ExoCortexAgent` to
    augment a partner's decision-making.  At each step the IA agent:

    1. Computes cerebellum predictions from ``partner_obs``.
    2. Updates the cerebellum weights from ``(partner_obs, partner_next_obs)``.
    3. Updates the cortex OaK Q-function from ``(partner_reward, partner_next_obs)``.
    4. Computes a greedy cortex action recommendation from ``partner_next_obs``.
    5. Returns the augmented observation ``[partner_obs, predictions]``.
    """

    def __init__(self, config: IAConfig) -> None:
        self._config = config
        self._cerebellum = ExoCerebellumAgent(config.cerebellum)
        self._cortex = ExoCortexAgent(config.cortex)

    @property
    def config(self) -> IAConfig:
        return self._config

    @property
    def cerebellum(self) -> ExoCerebellumAgent:
        return self._cerebellum

    @property
    def cortex(self) -> ExoCortexAgent:
        return self._cortex

    def to_config(self) -> dict[str, Any]:
        return self._config.to_config()

    def init(self, key: Array) -> IAState:
        """Initialise IA state."""
        cortex_state = self._cortex.init(key)
        return IAState(
            cerebellum_state=self._cerebellum.init(),
            cortex_state=cortex_state,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def start(self, state: IAState, initial_observation: Array) -> IAState:
        """Prime the IA agent with an initial observation."""
        new_cortex = self._cortex.start(state.cortex_state, initial_observation)
        return cast(IAState, state.replace(cortex_state=new_cortex))

    def update(
        self,
        state: IAState,
        partner_obs: Array,
        partner_reward: Array,
        partner_next_obs: Array,
    ) -> IAUpdateResult:
        """Process one IA step from partner experience.

        Args:
            state: Current IA state.
            partner_obs: Partner's current observation ``s_t``.
            partner_reward: Partner's received reward ``r_{t+1}``.
            partner_next_obs: Partner's next observation ``s_{t+1}``.

        Returns:
            :class:`IAUpdateResult` with augmented observation and diagnostics.
        """
        obs = jnp.asarray(partner_obs, dtype=jnp.float32)
        next_obs = jnp.asarray(partner_next_obs, dtype=jnp.float32)
        reward = jnp.asarray(partner_reward, dtype=jnp.float32)

        # Cerebellum: predict from obs, update from (obs, next_obs)
        new_cerebellum_state, predictions, errors = self._cerebellum.update(
            state.cerebellum_state, obs, next_obs
        )

        # Cortex: update Q from (reward, next_obs), get recommendation
        new_cortex_state, recommendation, td_error = self._cortex.update(
            state.cortex_state, reward, next_obs
        )

        # Augmented observation for the partner
        augmented_obs = jnp.concatenate([obs, predictions])

        new_state = IAState(
            cerebellum_state=new_cerebellum_state,
            cortex_state=new_cortex_state,
            step_count=state.step_count + 1,
        )

        return IAUpdateResult(
            state=new_state,
            predictions=predictions,
            cerebellum_errors=errors,
            recommendation=recommendation,
            augmented_obs=augmented_obs,
            cortex_td_error=td_error,
        )

    def scan(
        self,
        state: IAState,
        partner_obs: Array,
        partner_rewards: Array,
        partner_next_obs: Array,
    ) -> IAArrayResult:
        """Run the IA agent over pre-collected partner transition arrays.

        Args:
            state: Starting IA state.
            partner_obs: Shape ``(T, obs_dim)`` partner observations.
            partner_rewards: Shape ``(T,)`` partner rewards.
            partner_next_obs: Shape ``(T, obs_dim)`` partner next observations.

        Returns:
            :class:`IAArrayResult` with per-step diagnostics.
        """

        def step_fn(
            carry: IAState,
            inputs: tuple[Array, Array, Array],
        ) -> tuple[IAState, tuple[Array, ...]]:
            obs, reward, next_ob = inputs
            result = self.update(carry, obs, reward, next_ob)
            return result.state, (
                result.predictions,
                result.cerebellum_errors,
                result.recommendation,
                result.augmented_obs,
                result.cortex_td_error,
            )

        final_state, (
            predictions,
            cerebellum_errors,
            recommendations,
            augmented_obs,
            cortex_td_errors,
        ) = jax.lax.scan(
            step_fn,
            state,
            (partner_obs, partner_rewards, partner_next_obs),
        )

        return IAArrayResult(
            state=final_state,
            predictions=predictions,
            cerebellum_errors=cerebellum_errors,
            recommendations=recommendations,
            augmented_obs=augmented_obs,
            cortex_td_errors=cortex_td_errors,
        )


__all__ = [
    "ExoCerebellumAgent",
    "ExoCerebellumConfig",
    "ExoCerebellumState",
    "ExoCortexAgent",
    "ExoCortexConfig",
    "ExoCortexState",
    "IAAgent",
    "IAArrayResult",
    "IAConfig",
    "IAState",
    "IAUpdateResult",
    "RecommendationProtocolConfig",
    "RecommendationProtocolResult",
    "RecommendationProtocolState",
    "init_recommendation_protocol_state",
    "update_recommendation_protocol",
]
