"""Horde-backed actor-critic control.

This module connects the Step 4 softmax policy-gradient actor to the Step 3
``HordeLearner`` critic. The first GVF head is the scalar value critic used for
the actor advantage. Remaining heads are optional auxiliary prediction demons
that update on the same transition.
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
from jaxtyping import Float, Int

from alberta_framework.core.horde import HordeLearner, HordeUpdateResult
from alberta_framework.core.initializers import sparse_init
from alberta_framework.core.multi_head_learner import MultiHeadMLPLearner, MultiHeadMLPState
from alberta_framework.core.optimizers import (
    Autostep,
    Bounder,
    bounder_from_config,
    optimizer_from_config,
)
from alberta_framework.core.types import AutostepParamState, DemonType, MLPParams


@dataclasses.dataclass(frozen=True)
class HordeActorCriticConfig:
    """Configuration for a Horde-backed discrete actor-critic agent.

    Attributes:
        n_actions: Number of discrete actions.
        actor_step_size: Step-size for policy parameters.
        actor_lamda: Eligibility trace decay for the actor.
        temperature: Softmax temperature.
        value_head_index: Horde head used as the scalar critic.
        actor_td_error_clip: Optional absolute clip applied only to the actor's
            policy-gradient TD error. The critic still receives the unclipped
            TD target/error.
    """

    n_actions: int
    actor_step_size: float = 0.01
    actor_lamda: float = 0.9
    temperature: float = 1.0
    value_head_index: int = 0
    actor_td_error_clip: float | None = None

    def to_config(self) -> dict[str, Any]:
        """Serialize this configuration to a dictionary."""
        return dataclasses.asdict(self)

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> HordeActorCriticConfig:
        """Reconstruct a ``HordeActorCriticConfig`` from a dictionary."""
        return cls(**config)


@chex.dataclass(frozen=True)
class HordeActorCriticState:
    """Immutable state for ``HordeActorCriticAgent``.

    Attributes:
        actor_weights: Policy weight matrix, shape ``(n_actions, feature_dim)``.
        actor_bias: Policy bias vector, shape ``(n_actions,)``.
        actor_trace_weights: Eligibility trace for actor weights.
        actor_trace_bias: Eligibility trace for actor bias.
        critic_state: Underlying Horde learner state.
        last_observation: Previous observation ``s_t``.
        last_action: Previous action ``a_t``.
        rng_key: Random key used for action sampling.
        step_count: Number of actor-critic updates taken.
    """

    actor_weights: Float[Array, "n_actions feature_dim"]
    actor_bias: Float[Array, " n_actions"]
    actor_trace_weights: Float[Array, "n_actions feature_dim"]
    actor_trace_bias: Float[Array, " n_actions"]
    critic_state: MultiHeadMLPState
    last_observation: Float[Array, " feature_dim"]
    last_action: Int[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class HordeActorCriticUpdateResult:
    """Result from one Horde-backed actor-critic update."""

    state: HordeActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    value: Float[Array, ""]
    next_value: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]
    critic_result: HordeUpdateResult


@chex.dataclass(frozen=True)
class HordeActorCriticArrayResult:
    """Result from scan-based Horde actor-critic learning."""

    state: HordeActorCriticState
    actions: Int[Array, " num_steps"]
    policies: Float[Array, "num_steps n_actions"]
    values: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]
    critic_td_errors: Float[Array, "num_steps n_demons"]


@dataclasses.dataclass(frozen=True)
class QHordeActorCriticConfig:
    """Configuration for an action-value Horde actor-critic agent.

    The critic uses one Horde control head per action and learns an expected
    SARSA target, while the actor is updated by the taken action's TD error.
    This keeps the policy-gradient actor but gives Step 4 actor-critic the
    same action-conditioned critic interface as the SARSA baseline.
    """

    n_actions: int
    gamma: float = 0.99
    actor_step_size: float = 0.01
    actor_lamda: float = 0.9
    temperature: float = 1.0
    actor_td_error_clip: float | None = None
    critic_target: str = "expected_sarsa"
    actor_update: str = "td_error"

    def to_config(self) -> dict[str, Any]:
        """Serialize this configuration to a dictionary."""
        return dataclasses.asdict(self)

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> QHordeActorCriticConfig:
        """Reconstruct a ``QHordeActorCriticConfig`` from a dictionary."""
        return cls(**config)


@chex.dataclass(frozen=True)
class QHordeActorCriticState:
    """Immutable state for ``QHordeActorCriticAgent``."""

    actor_weights: Float[Array, "n_actions feature_dim"]
    actor_bias: Float[Array, " n_actions"]
    actor_trace_weights: Float[Array, "n_actions feature_dim"]
    actor_trace_bias: Float[Array, " n_actions"]
    critic_state: MultiHeadMLPState
    last_observation: Float[Array, " feature_dim"]
    last_action: Int[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class QHordeActorCriticUpdateResult:
    """Result from one action-value Horde actor-critic update."""

    state: QHordeActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    q_values: Float[Array, " n_actions"]
    next_q_values: Float[Array, " n_actions"]
    target: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]
    critic_result: HordeUpdateResult


class QHordeActorCriticAgent:
    """Softmax actor with an action-value Horde critic.

    The first ``n_actions`` Horde heads must be control demons with externally
    supplied targets. Only the head for the action taken at ``s_t`` is updated
    on each transition; optional prediction demons after the action heads may
    update from supplied cumulants.
    """

    def __init__(
        self,
        config: QHordeActorCriticConfig,
        critic: HordeLearner,
        actor_bounder: Bounder | None = None,
    ) -> None:
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if not 0.0 <= config.gamma <= 1.0:
            raise ValueError("gamma must be in [0, 1]")
        if config.temperature <= 0:
            raise ValueError("temperature must be positive")
        if config.actor_td_error_clip is not None and config.actor_td_error_clip <= 0:
            raise ValueError("actor_td_error_clip must be positive when provided")
        if config.critic_target not in {"expected_sarsa", "sampled_sarsa"}:
            raise ValueError(
                "critic_target must be 'expected_sarsa' or 'sampled_sarsa'"
            )
        if config.actor_update not in {"td_error", "expected_advantage"}:
            raise ValueError(
                "actor_update must be 'td_error' or 'expected_advantage'"
            )
        if critic.n_demons < config.n_actions:
            raise ValueError("critic must have at least one head per action")
        for idx, demon in enumerate(critic.horde_spec.demons[: config.n_actions]):
            if demon.demon_type is not DemonType.CONTROL:
                raise ValueError(f"critic head {idx} must be a control demon")
        self._config = config
        self._critic = critic
        self._actor_bounder = actor_bounder

    @property
    def config(self) -> QHordeActorCriticConfig:
        """Actor configuration."""
        return self._config

    @property
    def critic(self) -> HordeLearner:
        """Underlying action-value Horde critic."""
        return self._critic

    @property
    def actor_bounder(self) -> Bounder | None:
        """Optional actor update bounder."""
        return self._actor_bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "QHordeActorCriticAgent",
            "config": self._config.to_config(),
            "critic": self._critic.to_config(),
            "actor_bounder": (
                self._actor_bounder.to_config()
                if self._actor_bounder is not None
                else None
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> QHordeActorCriticAgent:
        """Reconstruct a ``QHordeActorCriticAgent`` from a dictionary."""
        config = dict(config)
        config.pop("type", None)
        return cls(
            config=QHordeActorCriticConfig.from_config(config["config"]),
            critic=HordeLearner.from_config(config["critic"]),
            actor_bounder=bounder_from_config(config["actor_bounder"])
            if config.get("actor_bounder")
            else None,
        )

    def init(self, feature_dim: int, key: Array) -> QHordeActorCriticState:
        """Initialize actor and Horde critic state."""
        actor_key, critic_key = jr.split(key)
        zeros_actor = jnp.zeros((self._config.n_actions, feature_dim), dtype=jnp.float32)
        zeros_bias = jnp.zeros((self._config.n_actions,), dtype=jnp.float32)
        return QHordeActorCriticState(  # type: ignore[call-arg]
            actor_weights=zeros_actor,
            actor_bias=zeros_bias,
            actor_trace_weights=zeros_actor,
            actor_trace_bias=zeros_bias,
            critic_state=self._critic.init(feature_dim, critic_key),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=actor_key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: QHordeActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities for one observation."""
        logits = state.actor_weights @ observation + state.actor_bias
        return jax.nn.softmax(logits / self._config.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def q_values(self, state: QHordeActorCriticState, observation: Array) -> Array:
        """Compute action values from the first ``n_actions`` Horde heads."""
        values = self._critic.predict(state.critic_state, observation)
        return cast(Array, values[: self._config.n_actions])

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: QHordeActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array, Float[Array, " n_actions"]]:
        """Sample one action from the current softmax policy."""
        key, sample_key = jr.split(state.rng_key)
        probs = self.policy(state, observation)
        action = jr.categorical(sample_key, jnp.log(jnp.maximum(probs, 1e-8))).astype(
            jnp.int32
        )
        return action, key, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: QHordeActorCriticState,
        observation: Array,
    ) -> tuple[QHordeActorCriticState, Int[Array, ""], Float[Array, " n_actions"]]:
        """Select and store the first action for a stream or episode."""
        action, key, probs = self.select_action(state, observation)
        new_state = state.replace(  # type: ignore[attr-defined]
            last_observation=observation,
            last_action=action,
            rng_key=key,
        )
        return new_state, action, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: QHordeActorCriticState,
        reward: Array,
        observation: Array,
        terminated: Array,
        prediction_cumulants: Array | None = None,
    ) -> QHordeActorCriticUpdateResult:
        """Update actor and action-value Horde critic from one transition."""
        cfg = self._config
        prev_obs = state.last_observation
        old_policy = self.policy(state, prev_obs)
        next_policy = self.policy(state, observation)
        sampled_next_action, sampled_key, sampled_policy = self.select_action(
            state,
            observation,
        )
        q_previous = self.q_values(state, prev_obs)
        q_next = self.q_values(state, observation)
        effective_gamma = jnp.where(terminated, 0.0, cfg.gamma)
        next_value = (
            q_next[sampled_next_action]
            if cfg.critic_target == "sampled_sarsa"
            else jnp.dot(next_policy, q_next)
        )
        target = jnp.asarray(reward, dtype=jnp.float32) + effective_gamma * next_value
        q_old = q_previous[state.last_action]
        td_error = target - q_old

        cumulants = jnp.full(self._critic.n_demons, jnp.nan, dtype=jnp.float32)
        cumulants = cumulants.at[state.last_action].set(target)
        if prediction_cumulants is not None:
            cumulants = cumulants.at[cfg.n_actions :].set(prediction_cumulants)
        critic_result = self._critic.update(
            state.critic_state,
            prev_obs,
            cumulants,
            observation,
        )

        actor_td_error = (
            td_error
            if cfg.actor_td_error_clip is None
            else jnp.clip(td_error, -cfg.actor_td_error_clip, cfg.actor_td_error_clip)
        )
        one_hot = jax.nn.one_hot(state.last_action, cfg.n_actions, dtype=jnp.float32)
        sampled_actor_grad_bias = (one_hot - old_policy) / cfg.temperature
        state_value = jnp.dot(old_policy, q_previous)
        expected_actor_grad_bias = old_policy * (q_previous - state_value) / cfg.temperature
        actor_grad_bias = (
            expected_actor_grad_bias
            if cfg.actor_update == "expected_advantage"
            else sampled_actor_grad_bias
        )
        actor_grad_weights = actor_grad_bias[:, None] * prev_obs[None, :]
        actor_decay = effective_gamma * cfg.actor_lamda
        actor_trace_weights = actor_decay * state.actor_trace_weights + actor_grad_weights
        actor_trace_bias = actor_decay * state.actor_trace_bias + actor_grad_bias
        actor_scale = (
            jnp.array(1.0, dtype=jnp.float32)
            if cfg.actor_update == "expected_advantage"
            else actor_td_error
        )
        actor_steps: tuple[Array, ...] = (
            cfg.actor_step_size * actor_scale * actor_trace_weights,
            cfg.actor_step_size * actor_scale * actor_trace_bias,
        )
        bound_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._actor_bounder is not None:
            actor_steps, bound_metric = self._actor_bounder.bound(
                actor_steps,
                actor_td_error,
                (state.actor_weights, state.actor_bias),
            )
        carry_traces = effective_gamma != 0.0
        updated = state.replace(  # type: ignore[attr-defined]
            actor_weights=state.actor_weights + actor_steps[0],
            actor_bias=state.actor_bias + actor_steps[1],
            actor_trace_weights=jnp.where(
                carry_traces, actor_trace_weights, jnp.zeros_like(actor_trace_weights)
            ),
            actor_trace_bias=jnp.where(
                carry_traces, actor_trace_bias, jnp.zeros_like(actor_trace_bias)
            ),
            critic_state=critic_result.state,
            step_count=state.step_count + 1,
        )
        next_action, key, policy = (
            (sampled_next_action, sampled_key, sampled_policy)
            if cfg.critic_target == "sampled_sarsa"
            else self.select_action(updated, observation)
        )
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )
        return QHordeActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            policy=policy,
            q_values=q_previous,
            next_q_values=q_next,
            target=target,
            td_error=td_error,
            bound_metric=bound_metric,
            critic_result=critic_result,
        )


class HordeActorCriticAgent:
    """Discrete AC(lambda) actor using a Step 3 Horde/GVF critic.

    The actor uses the policy-gradient AC(lambda) update
    ``theta += alpha * delta * e``. The advantage ``delta`` is supplied by the
    configured Horde value head. The critic update is delegated entirely to
    ``HordeLearner.update()``, preserving per-head trace decay and auxiliary
    prediction demons.
    """

    def __init__(
        self,
        config: HordeActorCriticConfig,
        critic: HordeLearner,
        actor_bounder: Bounder | None = None,
    ):
        """Initialize the agent.

        Args:
            config: Actor hyperparameters.
            critic: Horde learner. The configured value head must exist and be
                a prediction GVF; additional heads are auxiliary predictions.
            actor_bounder: Optional ObGD-style or compatible bounder applied to
                the actor's proposed policy-gradient step.
        """
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if config.temperature <= 0:
            raise ValueError("temperature must be positive")
        if config.actor_td_error_clip is not None and config.actor_td_error_clip <= 0:
            raise ValueError("actor_td_error_clip must be positive when provided")
        if not 0 <= config.value_head_index < critic.n_demons:
            raise ValueError("value_head_index must reference an existing demon")
        value_demon = critic.horde_spec.demons[config.value_head_index]
        if value_demon.demon_type is not DemonType.PREDICTION:
            raise ValueError("value critic head must be a prediction GVF")
        self._config = config
        self._critic = critic
        self._actor_bounder = actor_bounder

    @property
    def config(self) -> HordeActorCriticConfig:
        """Actor configuration."""
        return self._config

    @property
    def critic(self) -> HordeLearner:
        """Underlying Horde critic."""
        return self._critic

    @property
    def actor_bounder(self) -> Bounder | None:
        """Optional actor update bounder."""
        return self._actor_bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "HordeActorCriticAgent",
            "config": self._config.to_config(),
            "critic": self._critic.to_config(),
            "actor_bounder": (
                self._actor_bounder.to_config()
                if self._actor_bounder is not None
                else None
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> HordeActorCriticAgent:
        """Reconstruct a ``HordeActorCriticAgent`` from a dictionary."""
        config = dict(config)
        config.pop("type", None)
        return cls(
            config=HordeActorCriticConfig.from_config(config["config"]),
            critic=HordeLearner.from_config(config["critic"]),
            actor_bounder=bounder_from_config(config["actor_bounder"])
            if config.get("actor_bounder")
            else None,
        )

    def init(self, feature_dim: int, key: Array) -> HordeActorCriticState:
        """Initialize actor and Horde critic state."""
        actor_key, critic_key = jr.split(key)
        zeros_actor = jnp.zeros((self._config.n_actions, feature_dim), dtype=jnp.float32)
        zeros_bias = jnp.zeros((self._config.n_actions,), dtype=jnp.float32)
        return HordeActorCriticState(  # type: ignore[call-arg]
            actor_weights=zeros_actor,
            actor_bias=zeros_bias,
            actor_trace_weights=zeros_actor,
            actor_trace_bias=zeros_bias,
            critic_state=self._critic.init(feature_dim, critic_key),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=actor_key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: HordeActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities for one observation."""
        logits = state.actor_weights @ observation + state.actor_bias
        return jax.nn.softmax(logits / self._config.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def values(self, state: HordeActorCriticState, observation: Array) -> Array:
        """Compute all Horde critic predictions for one observation."""
        return cast(Array, self._critic.predict(state.critic_state, observation))

    @functools.partial(jax.jit, static_argnums=(0,))
    def value(
        self,
        state: HordeActorCriticState,
        observation: Array,
    ) -> Float[Array, ""]:
        """Compute the configured scalar value head prediction."""
        return cast(
            Float[Array, ""],
            self.values(state, observation)[self._config.value_head_index],
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: HordeActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array, Float[Array, " n_actions"]]:
        """Sample one action from the current softmax policy."""
        key, sample_key = jr.split(state.rng_key)
        probs = self.policy(state, observation)
        action = jr.categorical(sample_key, jnp.log(jnp.maximum(probs, 1e-8))).astype(
            jnp.int32
        )
        return action, key, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: HordeActorCriticState,
        observation: Array,
    ) -> tuple[HordeActorCriticState, Int[Array, ""], Float[Array, " n_actions"]]:
        """Select and store the first action for a stream or episode."""
        action, key, probs = self.select_action(state, observation)
        new_state = state.replace(  # type: ignore[attr-defined]
            last_observation=observation,
            last_action=action,
            rng_key=key,
        )
        return new_state, action, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: HordeActorCriticState,
        reward: Array,
        observation: Array,
        auxiliary_cumulants: Array | None = None,
        discount: Array | None = None,
    ) -> HordeActorCriticUpdateResult:
        """Update actor and Horde critic from one transition.

        The actor follows the AC(lambda) policy-gradient update
        ``theta += alpha * delta_t * e_t``, where ``delta_t`` is the TD error
        from the configured Horde value head and
        ``e_t = gamma_t * lambda * e_{t-1} + grad log pi(A_t | S_t)``. When an
        actor bounder is configured, the proposed actor step is scaled by the
        same ``Bounder`` interface used elsewhere in the framework.

        Args:
            state: Current state with a valid previous observation/action.
            reward: Scalar reward cumulant for the value head.
            observation: Next observation.
            auxiliary_cumulants: Optional cumulants for all non-value heads,
                ordered by Horde head index with the value head removed.
            discount: Optional scalar per-transition value-head discount. When
                omitted, the value head's configured demon gamma is used.

        Returns:
            ``HordeActorCriticUpdateResult`` with actor and critic metrics.
        """
        cfg = self._config
        prev_obs = state.last_observation
        old_policy = self.policy(state, prev_obs)
        value = self.value(state, prev_obs)
        next_value = self.value(state, observation)
        value_gamma = self._critic.horde_spec.gammas[cfg.value_head_index]
        value_discount = (
            value_gamma
            if discount is None
            else jnp.asarray(discount, dtype=jnp.float32)
        )

        if auxiliary_cumulants is None:
            auxiliary_cumulants = jnp.zeros(
                (self._critic.n_demons - 1,), dtype=jnp.float32
            )
        auxiliary_cumulants = jnp.asarray(auxiliary_cumulants, dtype=jnp.float32)
        cumulants_before = auxiliary_cumulants[: cfg.value_head_index]
        cumulants_after = auxiliary_cumulants[cfg.value_head_index :]
        cumulants = jnp.concatenate(
            (
                cumulants_before,
                jnp.asarray(reward, dtype=jnp.float32)[None],
                cumulants_after,
            )
        )
        if discount is None:
            critic_result = self._critic.update(
                state.critic_state,
                prev_obs,
                cumulants,
                observation,
            )
        else:
            discounts = self._critic.horde_spec.gammas.at[cfg.value_head_index].set(
                value_discount
            )
            critic_result = self._critic.update_with_discounts(
                state.critic_state,
                prev_obs,
                cumulants,
                observation,
                discounts,
            )
        td_error = critic_result.td_errors[cfg.value_head_index]
        actor_td_error = (
            td_error
            if cfg.actor_td_error_clip is None
            else jnp.clip(td_error, -cfg.actor_td_error_clip, cfg.actor_td_error_clip)
        )

        one_hot = jax.nn.one_hot(state.last_action, cfg.n_actions, dtype=jnp.float32)
        actor_grad_bias = (one_hot - old_policy) / cfg.temperature
        actor_grad_weights = actor_grad_bias[:, None] * prev_obs[None, :]
        actor_decay = value_discount * cfg.actor_lamda
        actor_trace_weights = actor_decay * state.actor_trace_weights + actor_grad_weights
        actor_trace_bias = actor_decay * state.actor_trace_bias + actor_grad_bias
        actor_steps: tuple[Array, ...] = (
            cfg.actor_step_size * actor_td_error * actor_trace_weights,
            cfg.actor_step_size * actor_td_error * actor_trace_bias,
        )
        bound_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._actor_bounder is not None:
            actor_steps, bound_metric = self._actor_bounder.bound(
                actor_steps,
                actor_td_error,
                (state.actor_weights, state.actor_bias),
            )
        carry_traces = value_discount != 0.0

        updated = state.replace(  # type: ignore[attr-defined]
            actor_weights=state.actor_weights + actor_steps[0],
            actor_bias=state.actor_bias + actor_steps[1],
            actor_trace_weights=jnp.where(
                carry_traces, actor_trace_weights, jnp.zeros_like(actor_trace_weights)
            ),
            actor_trace_bias=jnp.where(
                carry_traces, actor_trace_bias, jnp.zeros_like(actor_trace_bias)
            ),
            critic_state=critic_result.state,
            step_count=state.step_count + 1,
        )
        next_action, key, next_policy = self.select_action(updated, observation)
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )
        return HordeActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            policy=next_policy,
            value=value,
            next_value=next_value,
            td_error=td_error,
            bound_metric=bound_metric,
            critic_result=critic_result,
        )


def run_horde_actor_critic_from_arrays(
    agent: HordeActorCriticAgent,
    state: HordeActorCriticState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
    actions: Int[Array, " num_steps"] | None = None,
    auxiliary_cumulants: Float[Array, "num_steps n_aux"] | None = None,
    discounts: Float[Array, " num_steps"] | None = None,
) -> HordeActorCriticArrayResult:
    """Run Horde actor-critic updates over arrays with ``jax.lax.scan``.

    This loop is scan-compatible for fixed-shape arrays. It uses the Horde's
    fixed per-head ``gamma`` values; variable per-transition discounts remain a
    future extension to ``HordeLearner.update`` itself.
    """
    if actions is None:
        actions = jnp.full_like(rewards, -1, dtype=jnp.int32)
        use_fixed_actions = False
    else:
        use_fixed_actions = True
    if auxiliary_cumulants is None:
        auxiliary_cumulants = jnp.zeros(
            (rewards.shape[0], agent.critic.n_demons - 1),
            dtype=jnp.float32,
        )
    if discounts is None:
        discounts = jnp.full_like(
            rewards,
            agent.critic.horde_spec.gammas[agent.config.value_head_index],
            dtype=jnp.float32,
        )

    def _scan_fn(
        carry: HordeActorCriticState,
        inputs: tuple[Array, Array, Array, Array, Array, Array],
    ) -> tuple[HordeActorCriticState, tuple[Array, Array, Array, Array, Array]]:
        obs, reward, next_obs, fixed_action, aux, transition_discount = inputs
        if use_fixed_actions:
            started_state = carry.replace(  # type: ignore[attr-defined]
                last_observation=obs,
                last_action=fixed_action.astype(jnp.int32),
            )
            current_action = fixed_action.astype(jnp.int32)
        else:
            started_state, current_action, _policy = agent.start(carry, obs)
        result = agent.update(
            started_state,
            reward,
            next_obs,
            aux,
            transition_discount,
        )
        return result.state, (
            current_action,
            result.policy,
            result.value,
            result.td_error,
            result.critic_result.td_errors,
        )

    final_state, (out_actions, policies, values, td_errors, critic_td_errors) = (
        jax.lax.scan(
            _scan_fn,
            state,
            (
                observations,
                rewards,
                next_observations,
                actions,
                auxiliary_cumulants,
                discounts,
            ),
        )
    )
    return HordeActorCriticArrayResult(  # type: ignore[call-arg]
        state=final_state,
        actions=out_actions,
        policies=policies,
        values=values,
        td_errors=td_errors,
        critic_td_errors=critic_td_errors,
    )


# =============================================================================
# Nonlinear MLP actor-critic — canonical Step 4
# =============================================================================


def _nlhac_log_prob(
    actor_params: tuple[
        tuple[Array, ...], tuple[Array, ...], Array, Array
    ],
    obs: Array,
    action: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
    temperature: float,
    actor_epsilon: float,
) -> Array:
    """Log pi(action | obs) for an MLP softmax policy.

    ``actor_params`` is ``(trunk_weights, trunk_biases, head_w, head_b)``
    where ``head_w`` has shape ``(n_actions, H_last)`` and ``head_b`` shape
    ``(n_actions,)``.  When no hidden layers are used, the trunk is empty and
    ``H_last`` equals the input feature dimension.
    """
    trunk_weights, trunk_biases, head_w, head_b = actor_params
    hidden = MultiHeadMLPLearner._trunk_forward(
        trunk_weights, trunk_biases, obs, leaky_relu_slope, use_layer_norm
    )
    logits = head_w @ hidden + head_b
    probs = jax.nn.softmax(logits / temperature)
    n_actions = probs.shape[0]
    mixed_probs = (1.0 - actor_epsilon) * probs + actor_epsilon / n_actions
    return jnp.log(jnp.maximum(mixed_probs[action], 1e-8))


_nlhac_grad = jax.grad(_nlhac_log_prob, argnums=0)


def _nlqhac_expected_advantage_objective(
    actor_params: tuple[
        tuple[Array, ...], tuple[Array, ...], Array, Array
    ],
    obs: Array,
    advantages: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
    temperature: float,
) -> Array:
    """Expected action-value advantage under the MLP policy.

    ``advantages`` is treated as a constant critic signal. Differentiating this
    objective gives ``sum_a grad pi(a|s) A(s,a)``, the all-action analogue of
    the sampled policy-gradient update.
    """
    trunk_weights, trunk_biases, head_w, head_b = actor_params
    hidden = MultiHeadMLPLearner._trunk_forward(
        trunk_weights, trunk_biases, obs, leaky_relu_slope, use_layer_norm
    )
    logits = head_w @ hidden + head_b
    probs = jax.nn.softmax(logits / temperature)
    return jnp.dot(probs, advantages)


_nlqhac_expected_advantage_grad = jax.grad(
    _nlqhac_expected_advantage_objective, argnums=0
)


def _clip_nlhac_actor_grads(
    grad_trunk_w: tuple[Array, ...],
    grad_trunk_b: tuple[Array, ...],
    grad_head_w: Array,
    grad_head_b: Array,
    max_norm: float | None,
) -> tuple[tuple[Array, ...], tuple[Array, ...], Array, Array]:
    """Clip one actor policy-gradient PyTree by global norm when requested."""
    if max_norm is None:
        return grad_trunk_w, grad_trunk_b, grad_head_w, grad_head_b
    squared_norm = jnp.sum(jnp.square(grad_head_w)) + jnp.sum(jnp.square(grad_head_b))
    for grad in (*grad_trunk_w, *grad_trunk_b):
        squared_norm = squared_norm + jnp.sum(jnp.square(grad))
    norm = jnp.sqrt(squared_norm)
    scale = jnp.minimum(1.0, jnp.asarray(max_norm, dtype=jnp.float32) / (norm + 1e-8))
    return (
        tuple(scale * grad for grad in grad_trunk_w),
        tuple(scale * grad for grad in grad_trunk_b),
        scale * grad_head_w,
        scale * grad_head_b,
    )


@dataclasses.dataclass(frozen=True)
class NonlinearHordeActorCriticConfig:
    """Configuration for an MLP actor with a Step 3 Horde critic.

    Attributes:
        n_actions: Number of discrete actions.
        actor_lamda: Eligibility-trace decay for the actor.
        temperature: Softmax temperature (lower = more greedy).
        value_head_index: Horde head used as the scalar critic.
        hidden_sizes: MLP actor hidden-layer widths. ``()`` gives linear.
        actor_sparsity: Sparse-init fraction for actor weights.
        leaky_relu_slope: LeakyReLU negative slope.
        use_layer_norm: Whether to apply parameterless layer norm.
        actor_epsilon: Uniform policy-mixture floor used for both action
            selection and policy-gradient log-probability. ``0.0`` recovers
            the pure softmax actor.
        actor_td_error_normalizer_decay: Optional EMA decay for normalizing
            the actor-only TD error by its recent absolute magnitude. The
            critic update and reported TD error are unchanged.
        actor_td_error_clip: Optional absolute clip applied only to the actor's
            policy-gradient TD error.
        actor_gradient_clip_norm: Optional global-norm clip applied to the
            actor policy gradient before eligibility-trace accumulation.
    """

    n_actions: int
    actor_lamda: float = 0.9
    temperature: float = 0.5
    value_head_index: int = 0
    hidden_sizes: tuple[int, ...] = (64,)
    actor_sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    actor_epsilon: float = 0.0
    actor_td_error_normalizer_decay: float | None = None
    actor_td_error_clip: float | None = None
    actor_gradient_clip_norm: float | None = None

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        d = dataclasses.asdict(self)
        d["hidden_sizes"] = list(self.hidden_sizes)
        return d

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> NonlinearHordeActorCriticConfig:
        """Reconstruct from :meth:`to_config` output."""
        c = dict(cfg)
        c["hidden_sizes"] = tuple(c["hidden_sizes"])
        return cls(**c)


@chex.dataclass(frozen=True)
class NonlinearHordeActorCriticState:
    """Immutable state for the MLP actor + Horde critic agent.

    Attributes:
        actor_trunk: Trunk weight/bias params (empty for linear actor).
        actor_head_w: Output layer weights, shape ``(n_actions, H_last)``.
        actor_head_b: Output layer biases, shape ``(n_actions,)``.
        actor_trunk_traces: Interleaved trace arrays ``(w0_tr, b0_tr, …)``.
        actor_head_trace_w: Trace for ``actor_head_w``.
        actor_head_trace_b: Trace for ``actor_head_b``.
        actor_trunk_opt_states: Interleaved Autostep states ``(w0_opt, b0_opt, …)``.
        actor_head_opt_w: Optimizer state for ``actor_head_w``.
        actor_head_opt_b: Optimizer state for ``actor_head_b``.
        actor_td_error_normalizer: EMA scale for actor-only TD-error
            normalization.
        critic_state: Underlying Horde learner state.
        last_observation: Previous observation for the next update call.
        last_action: Previous action index.
        rng_key: JAX random key.
        step_count: Number of updates taken.
    """

    actor_trunk: MLPParams
    actor_head_w: Float[Array, "n_actions h_last"]
    actor_head_b: Float[Array, " n_actions"]
    actor_trunk_traces: tuple[Array, ...]
    actor_head_trace_w: Float[Array, "n_actions h_last"]
    actor_head_trace_b: Float[Array, " n_actions"]
    actor_trunk_opt_states: tuple[AutostepParamState, ...]
    actor_head_opt_w: AutostepParamState
    actor_head_opt_b: AutostepParamState
    actor_td_error_normalizer: Float[Array, ""]
    critic_state: MultiHeadMLPState
    last_observation: Float[Array, " feature_dim"]
    last_action: Int[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class NonlinearHordeActorCriticUpdateResult:
    """Result from one nonlinear Horde actor-critic update."""

    state: NonlinearHordeActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    value: Float[Array, ""]
    next_value: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]
    critic_result: HordeUpdateResult


@chex.dataclass(frozen=True)
class NonlinearHordeActorCriticArrayResult:
    """Result from a scan-based nonlinear Horde actor-critic loop."""

    state: NonlinearHordeActorCriticState
    actions: Int[Array, " num_steps"]
    policies: Float[Array, "num_steps n_actions"]
    values: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]
    critic_td_errors: Float[Array, "num_steps n_demons"]


class NonlinearHordeActorCriticAgent:
    """MLP policy-gradient actor with a Step 3 Horde/GVF critic.

    This is the canonical nonlinear Step 4 agent.  The actor is an MLP whose
    policy gradient is computed by ``jax.grad`` through the full softmax
    forward pass.  The critic is delegated unchanged to a
    :class:`~alberta_framework.core.horde.HordeLearner`.

    The update rule is AC(lambda) with MLP actor:

    ``delta = R + gamma * V(S') - V(S)``

    ``e_t = gamma * lambda * e_{t-1} + grad_theta log pi(A_t | S_t; theta)``

    ``theta += alpha * delta * e_t``

    where ``grad_theta log pi`` is computed through the full MLP, including
    the trunk, via ``jax.grad``.
    """

    def __init__(
        self,
        config: NonlinearHordeActorCriticConfig,
        critic: HordeLearner,
        actor_optimizer: Autostep | None = None,
        actor_bounder: Bounder | None = None,
    ) -> None:
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if config.temperature <= 0:
            raise ValueError("temperature must be positive")
        if not 0.0 <= config.actor_epsilon < 1.0:
            raise ValueError("actor_epsilon must be in [0, 1)")
        if (
            config.actor_td_error_normalizer_decay is not None
            and not 0.0 <= config.actor_td_error_normalizer_decay < 1.0
        ):
            raise ValueError(
                "actor_td_error_normalizer_decay must be in [0, 1)"
            )
        if config.actor_td_error_clip is not None and config.actor_td_error_clip <= 0:
            raise ValueError("actor_td_error_clip must be positive when provided")
        if (
            config.actor_gradient_clip_norm is not None
            and config.actor_gradient_clip_norm <= 0
        ):
            raise ValueError(
                "actor_gradient_clip_norm must be positive when provided"
            )
        if not 0 <= config.value_head_index < critic.n_demons:
            raise ValueError(
                f"value_head_index {config.value_head_index} out of range "
                f"for {critic.n_demons} demon(s)"
            )
        value_demon = critic.horde_spec.demons[config.value_head_index]
        if value_demon.demon_type != DemonType.PREDICTION:
            raise ValueError("value critic head must be a prediction GVF")
        self._config = config
        self._critic = critic
        self._actor_optimizer = (
            actor_optimizer if actor_optimizer is not None else Autostep(initial_step_size=0.01)
        )
        self._actor_bounder = actor_bounder

    @property
    def config(self) -> NonlinearHordeActorCriticConfig:
        """Agent configuration."""
        return self._config

    @property
    def critic(self) -> HordeLearner:
        """Underlying Horde critic."""
        return self._critic

    @property
    def actor_optimizer(self) -> Autostep:
        """Per-weight actor optimizer."""
        return self._actor_optimizer

    @property
    def actor_bounder(self) -> Bounder | None:
        """Optional actor update bounder."""
        return self._actor_bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent."""
        return {
            "type": "NonlinearHordeActorCriticAgent",
            "config": self._config.to_config(),
            "critic": self._critic.to_config(),
            "actor_optimizer": self._actor_optimizer.to_config(),
            "actor_bounder": (
                self._actor_bounder.to_config()
                if self._actor_bounder is not None
                else None
            ),
        }

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> NonlinearHordeActorCriticAgent:
        """Reconstruct from :meth:`to_config` output."""
        cfg = dict(cfg)
        cfg.pop("type", None)
        actor_opt: Autostep | None = None
        if cfg.get("actor_optimizer"):
            actor_opt = cast(Autostep, optimizer_from_config(cfg["actor_optimizer"]))
        return cls(
            config=NonlinearHordeActorCriticConfig.from_config(cfg["config"]),
            critic=HordeLearner.from_config(cfg["critic"]),
            actor_optimizer=actor_opt,
            actor_bounder=bounder_from_config(cfg["actor_bounder"])
            if cfg.get("actor_bounder")
            else None,
        )

    def init(self, feature_dim: int, key: Array) -> NonlinearHordeActorCriticState:
        """Initialize MLP actor and Horde critic state.

        Args:
            feature_dim: Input observation dimension.
            key: JAX random key split between actor and critic.

        Returns:
            Zeroed initial state with sparse-initialized actor weights.
        """
        actor_key, critic_key = jr.split(key)
        cfg = self._config
        trunk_weights: list[Array] = []
        trunk_biases: list[Array] = []
        trunk_traces: list[Array] = []
        trunk_opt_states: list[AutostepParamState] = []

        in_dim = feature_dim
        for h in cfg.hidden_sizes:
            subkey, actor_key = jr.split(actor_key)
            w = sparse_init(subkey, (h, in_dim), sparsity=cfg.actor_sparsity)
            b = jnp.zeros((h,), dtype=jnp.float32)
            trunk_weights.append(w)
            trunk_biases.append(b)
            trunk_traces.extend([jnp.zeros_like(w), jnp.zeros_like(b)])
            trunk_opt_states.append(self._actor_optimizer.init_for_shape(w.shape))
            trunk_opt_states.append(self._actor_optimizer.init_for_shape(b.shape))
            in_dim = h

        subkey, actor_key = jr.split(actor_key)
        actor_head_w = sparse_init(subkey, (cfg.n_actions, in_dim), sparsity=cfg.actor_sparsity)
        actor_head_b = jnp.zeros((cfg.n_actions,), dtype=jnp.float32)

        return NonlinearHordeActorCriticState(  # type: ignore[call-arg]
            actor_trunk=MLPParams(  # type: ignore[call-arg]
                {"weights": tuple(trunk_weights), "biases": tuple(trunk_biases)}
            ),
            actor_head_w=actor_head_w,
            actor_head_b=actor_head_b,
            actor_trunk_traces=tuple(trunk_traces),
            actor_head_trace_w=jnp.zeros_like(actor_head_w),
            actor_head_trace_b=jnp.zeros_like(actor_head_b),
            actor_trunk_opt_states=tuple(trunk_opt_states),
            actor_head_opt_w=self._actor_optimizer.init_for_shape(actor_head_w.shape),
            actor_head_opt_b=self._actor_optimizer.init_for_shape(actor_head_b.shape),
            actor_td_error_normalizer=jnp.array(0.0, dtype=jnp.float32),
            critic_state=self._critic.init(feature_dim, critic_key),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=actor_key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities for one observation."""
        cfg = self._config
        hidden = MultiHeadMLPLearner._trunk_forward(
            state.actor_trunk.weights,
            state.actor_trunk.biases,
            observation,
            cfg.leaky_relu_slope,
            cfg.use_layer_norm,
        )
        logits = state.actor_head_w @ hidden + state.actor_head_b
        probs = jax.nn.softmax(logits / cfg.temperature)
        return (
            (1.0 - cfg.actor_epsilon) * probs
            + cfg.actor_epsilon / cfg.n_actions
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def value(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> Float[Array, ""]:
        """Compute the critic value estimate."""
        preds = self._critic.predict(state.critic_state, observation)
        return cast(Float[Array, ""], preds[self._config.value_head_index])

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array, Float[Array, " n_actions"]]:
        """Sample one action from the current softmax policy."""
        key, sample_key = jr.split(state.rng_key)
        probs = self.policy(state, observation)
        action = jr.categorical(
            sample_key, jnp.log(jnp.maximum(probs, 1e-8))
        ).astype(jnp.int32)
        return action, key, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> tuple[
        NonlinearHordeActorCriticState, Int[Array, ""], Float[Array, " n_actions"]
    ]:
        """Select and store the first action for a stream or episode."""
        action, key, probs = self.select_action(state, observation)
        new_state = state.replace(  # type: ignore[attr-defined]
            last_observation=observation,
            last_action=action,
            rng_key=key,
        )
        return new_state, action, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: NonlinearHordeActorCriticState,
        reward: Array,
        observation: Array,
        auxiliary_cumulants: Array | None = None,
        discount: Array | None = None,
    ) -> NonlinearHordeActorCriticUpdateResult:
        """Update MLP actor and Horde critic from one transition.

        Args:
            state: Current state with a valid previous observation/action.
            reward: Scalar reward for the value head.
            observation: Next observation.
            auxiliary_cumulants: Optional cumulants for non-value heads.
            discount: Optional per-transition value-head discount.

        Returns:
            :class:`NonlinearHordeActorCriticUpdateResult`.
        """
        cfg = self._config
        prev_obs = state.last_observation
        value = self.value(state, prev_obs)
        next_value = self.value(state, observation)

        value_gamma = self._critic.horde_spec.gammas[cfg.value_head_index]
        value_discount = (
            value_gamma
            if discount is None
            else jnp.asarray(discount, dtype=jnp.float32)
        )

        if auxiliary_cumulants is None:
            auxiliary_cumulants = jnp.zeros(
                (self._critic.n_demons - 1,), dtype=jnp.float32
            )
        auxiliary_cumulants = jnp.asarray(auxiliary_cumulants, dtype=jnp.float32)
        idx = cfg.value_head_index
        cumulants_before = auxiliary_cumulants[:idx]
        cumulants_after = auxiliary_cumulants[idx:]
        cumulants = jnp.concatenate(
            (cumulants_before, jnp.asarray(reward, dtype=jnp.float32)[None], cumulants_after)
        )

        if discount is None:
            critic_result = self._critic.update(
                state.critic_state, prev_obs, cumulants, observation
            )
        else:
            discounts = self._critic.horde_spec.gammas.at[idx].set(value_discount)
            critic_result = self._critic.update_with_discounts(
                state.critic_state, prev_obs, cumulants, observation, discounts
            )
        td_error = critic_result.td_errors[idx]
        actor_td_error = (
            td_error
            if cfg.actor_td_error_clip is None
            else jnp.clip(td_error, -cfg.actor_td_error_clip, cfg.actor_td_error_clip)
        )
        actor_td_error_normalizer = state.actor_td_error_normalizer
        if cfg.actor_td_error_normalizer_decay is not None:
            decay = jnp.asarray(
                cfg.actor_td_error_normalizer_decay, dtype=jnp.float32
            )
            actor_td_error_normalizer = (
                decay * actor_td_error_normalizer
                + (1.0 - decay) * jnp.abs(actor_td_error)
            )
            actor_td_error = actor_td_error / jnp.maximum(
                actor_td_error_normalizer, 1e-3
            )

        # Policy gradient via jax.grad through the full MLP forward pass
        actor_params = (
            state.actor_trunk.weights,
            state.actor_trunk.biases,
            state.actor_head_w,
            state.actor_head_b,
        )
        grads = _nlhac_grad(
            actor_params,
            prev_obs,
            state.last_action,
            cfg.leaky_relu_slope,
            cfg.use_layer_norm,
            cfg.temperature,
            cfg.actor_epsilon,
        )
        grad_trunk_w, grad_trunk_b, grad_head_w, grad_head_b = grads
        grad_trunk_w, grad_trunk_b, grad_head_w, grad_head_b = (
            _clip_nlhac_actor_grads(
                grad_trunk_w,
                grad_trunk_b,
                grad_head_w,
                grad_head_b,
                cfg.actor_gradient_clip_norm,
            )
        )

        actor_decay = value_discount * cfg.actor_lamda
        n_hidden = len(cfg.hidden_sizes)

        new_trunk_traces: list[Array] = []
        for i in range(n_hidden):
            new_trunk_traces.append(actor_decay * state.actor_trunk_traces[2 * i] + grad_trunk_w[i])
            new_trunk_traces.append(
                actor_decay * state.actor_trunk_traces[2 * i + 1] + grad_trunk_b[i]
            )

        new_head_trace_w = actor_decay * state.actor_head_trace_w + grad_head_w
        new_head_trace_b = actor_decay * state.actor_head_trace_b + grad_head_b

        # Per-weight Autostep updates: step = alpha_i * z_i; caller applies error * step
        new_trunk_opt_states: list[AutostepParamState] = []
        trunk_w_steps: list[Array] = []
        trunk_b_steps: list[Array] = []
        for i in range(n_hidden):
            raw_w, new_opt_w = self._actor_optimizer.update_from_gradient(
                state.actor_trunk_opt_states[2 * i], new_trunk_traces[2 * i], error=actor_td_error
            )
            raw_b, new_opt_b = self._actor_optimizer.update_from_gradient(
                state.actor_trunk_opt_states[2 * i + 1],
                new_trunk_traces[2 * i + 1],
                error=actor_td_error,
            )
            new_trunk_opt_states.extend([new_opt_w, new_opt_b])
            trunk_w_steps.append(actor_td_error * raw_w)
            trunk_b_steps.append(actor_td_error * raw_b)

        raw_head_w, new_head_opt_w = self._actor_optimizer.update_from_gradient(
            state.actor_head_opt_w, new_head_trace_w, error=actor_td_error
        )
        raw_head_b, new_head_opt_b = self._actor_optimizer.update_from_gradient(
            state.actor_head_opt_b, new_head_trace_b, error=actor_td_error
        )
        head_w_step = actor_td_error * raw_head_w
        head_b_step = actor_td_error * raw_head_b

        bound_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._actor_bounder is not None:
            flat_steps = (
                *trunk_w_steps,
                *trunk_b_steps,
                head_w_step,
                head_b_step,
            )
            flat_params = (
                *state.actor_trunk.weights,
                *state.actor_trunk.biases,
                state.actor_head_w,
                state.actor_head_b,
            )
            bounded_steps, bound_metric = self._actor_bounder.bound(
                flat_steps,
                actor_td_error,
                flat_params,
            )
            trunk_w_steps = list(bounded_steps[:n_hidden])
            trunk_b_steps = list(bounded_steps[n_hidden : 2 * n_hidden])
            head_w_step = bounded_steps[2 * n_hidden]
            head_b_step = bounded_steps[2 * n_hidden + 1]

        new_trunk_weights = tuple(
            w + step for w, step in zip(state.actor_trunk.weights, trunk_w_steps)
        )
        new_trunk_biases = tuple(
            b + step for b, step in zip(state.actor_trunk.biases, trunk_b_steps)
        )
        new_head_w = state.actor_head_w + head_w_step
        new_head_b = state.actor_head_b + head_b_step

        carry_traces = value_discount != 0.0
        zeroed_trunk_traces = tuple(
            jnp.where(carry_traces, t, jnp.zeros_like(t)) for t in new_trunk_traces
        )

        updated = state.replace(  # type: ignore[attr-defined]
            actor_trunk=MLPParams(  # type: ignore[call-arg]
                {"weights": new_trunk_weights, "biases": new_trunk_biases}
            ),
            actor_head_w=new_head_w,
            actor_head_b=new_head_b,
            actor_trunk_traces=zeroed_trunk_traces,
            actor_head_trace_w=jnp.where(
                carry_traces, new_head_trace_w, jnp.zeros_like(new_head_trace_w)
            ),
            actor_head_trace_b=jnp.where(
                carry_traces, new_head_trace_b, jnp.zeros_like(new_head_trace_b)
            ),
            actor_trunk_opt_states=tuple(new_trunk_opt_states),
            actor_head_opt_w=new_head_opt_w,
            actor_head_opt_b=new_head_opt_b,
            actor_td_error_normalizer=actor_td_error_normalizer,
            critic_state=critic_result.state,
            step_count=state.step_count + 1,
        )
        next_action, key, next_policy = self.select_action(updated, observation)
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )
        return NonlinearHordeActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            policy=next_policy,
            value=value,
            next_value=next_value,
            td_error=td_error,
            bound_metric=bound_metric,
            critic_result=critic_result,
        )


def run_nonlinear_horde_actor_critic_from_arrays(
    agent: NonlinearHordeActorCriticAgent,
    state: NonlinearHordeActorCriticState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    next_observations: Float[Array, "num_steps feature_dim"],
    auxiliary_cumulants: Float[Array, "num_steps n_aux"] | None = None,
    discounts: Float[Array, " num_steps"] | None = None,
) -> NonlinearHordeActorCriticArrayResult:
    """Scan-based nonlinear Horde actor-critic loop.

    Args:
        agent: Nonlinear Horde actor-critic agent.
        state: Initial state (must have been primed via :meth:`start`).
        observations: Observations at each step, shape ``(T, D)``.
        rewards: Scalar rewards, shape ``(T,)``.
        next_observations: Next observations, shape ``(T, D)``.
        auxiliary_cumulants: Optional per-step auxiliary cumulants.
        discounts: Optional per-step value-head discounts.

    Returns:
        :class:`NonlinearHordeActorCriticArrayResult`.
    """
    if auxiliary_cumulants is None:
        auxiliary_cumulants = jnp.zeros(
            (rewards.shape[0], agent.critic.n_demons - 1), dtype=jnp.float32
        )
    if discounts is None:
        discounts = jnp.full_like(
            rewards,
            agent.critic.horde_spec.gammas[agent.config.value_head_index],
        )

    def _scan_fn(
        carry: NonlinearHordeActorCriticState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[
        NonlinearHordeActorCriticState,
        tuple[Array, Array, Array, Array, Array],
    ]:
        obs, reward, next_obs, aux, disc = inputs
        started, current_action, _policy = agent.start(carry, obs)
        result = agent.update(started, reward, next_obs, aux, disc)
        return result.state, (
            current_action,
            result.policy,
            result.value,
            result.td_error,
            result.critic_result.td_errors,
        )

    final_state, (out_actions, policies, values, td_errors, critic_td_errors) = (
        jax.lax.scan(
            _scan_fn,
            state,
            (observations, rewards, next_observations, auxiliary_cumulants, discounts),
        )
    )
    return NonlinearHordeActorCriticArrayResult(  # type: ignore[call-arg]
        state=final_state,
        actions=out_actions,
        policies=policies,
        values=values,
        td_errors=td_errors,
        critic_td_errors=critic_td_errors,
    )


@dataclasses.dataclass(frozen=True)
class NonlinearQHordeActorCriticConfig:
    """Configuration for an MLP actor with an action-value Horde critic."""

    n_actions: int
    gamma: float = 0.99
    actor_lamda: float = 0.9
    temperature: float = 0.5
    hidden_sizes: tuple[int, ...] = (64,)
    actor_sparsity: float = 0.9
    leaky_relu_slope: float = 0.01
    use_layer_norm: bool = True
    actor_td_error_clip: float | None = None
    actor_gradient_clip_norm: float | None = None
    critic_target: str = "expected_sarsa"
    actor_update: str = "td_error"

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        config = dataclasses.asdict(self)
        config["hidden_sizes"] = list(self.hidden_sizes)
        return config

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> NonlinearQHordeActorCriticConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload["hidden_sizes"] = tuple(payload["hidden_sizes"])
        return cls(**payload)


@chex.dataclass(frozen=True)
class NonlinearQHordeActorCriticUpdateResult:
    """Result from one nonlinear action-value Horde actor-critic update."""

    state: NonlinearHordeActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    q_values: Float[Array, " n_actions"]
    next_q_values: Float[Array, " n_actions"]
    target: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]
    critic_result: HordeUpdateResult


class NonlinearQHordeActorCriticAgent:
    """MLP policy-gradient actor with an action-value Step 3 Horde critic."""

    def __init__(
        self,
        config: NonlinearQHordeActorCriticConfig,
        critic: HordeLearner,
        actor_optimizer: Autostep | None = None,
        actor_bounder: Bounder | None = None,
    ) -> None:
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if not 0.0 <= config.gamma <= 1.0:
            raise ValueError("gamma must be in [0, 1]")
        if config.temperature <= 0:
            raise ValueError("temperature must be positive")
        if config.actor_td_error_clip is not None and config.actor_td_error_clip <= 0:
            raise ValueError("actor_td_error_clip must be positive when provided")
        if (
            config.actor_gradient_clip_norm is not None
            and config.actor_gradient_clip_norm <= 0
        ):
            raise ValueError(
                "actor_gradient_clip_norm must be positive when provided"
            )
        if config.critic_target not in {"expected_sarsa", "sampled_sarsa"}:
            raise ValueError(
                "critic_target must be 'expected_sarsa' or 'sampled_sarsa'"
            )
        if config.actor_update not in {"td_error", "expected_advantage"}:
            raise ValueError(
                "actor_update must be 'td_error' or 'expected_advantage'"
            )
        if critic.n_demons < config.n_actions:
            raise ValueError("critic must have at least one head per action")
        for idx, demon in enumerate(critic.horde_spec.demons[: config.n_actions]):
            if demon.demon_type is not DemonType.CONTROL:
                raise ValueError(f"critic head {idx} must be a control demon")
        self._config = config
        self._critic = critic
        self._actor_optimizer = (
            actor_optimizer
            if actor_optimizer is not None
            else Autostep(initial_step_size=0.01)
        )
        self._actor_bounder = actor_bounder

    @property
    def config(self) -> NonlinearQHordeActorCriticConfig:
        """Agent configuration."""
        return self._config

    @property
    def critic(self) -> HordeLearner:
        """Underlying action-value Horde critic."""
        return self._critic

    @property
    def actor_optimizer(self) -> Autostep:
        """Per-weight actor optimizer."""
        return self._actor_optimizer

    @property
    def actor_bounder(self) -> Bounder | None:
        """Optional actor update bounder."""
        return self._actor_bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "NonlinearQHordeActorCriticAgent",
            "config": self._config.to_config(),
            "critic": self._critic.to_config(),
            "actor_optimizer": self._actor_optimizer.to_config(),
            "actor_bounder": (
                self._actor_bounder.to_config()
                if self._actor_bounder is not None
                else None
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> NonlinearQHordeActorCriticAgent:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        actor_opt: Autostep | None = None
        if payload.get("actor_optimizer"):
            actor_opt = cast(Autostep, optimizer_from_config(payload["actor_optimizer"]))
        return cls(
            config=NonlinearQHordeActorCriticConfig.from_config(payload["config"]),
            critic=HordeLearner.from_config(payload["critic"]),
            actor_optimizer=actor_opt,
            actor_bounder=bounder_from_config(payload["actor_bounder"])
            if payload.get("actor_bounder")
            else None,
        )

    def init(self, feature_dim: int, key: Array) -> NonlinearHordeActorCriticState:
        """Initialize MLP actor and action-value Horde critic state."""
        actor_key, critic_key = jr.split(key)
        cfg = self._config
        trunk_weights: list[Array] = []
        trunk_biases: list[Array] = []
        trunk_traces: list[Array] = []
        trunk_opt_states: list[AutostepParamState] = []
        in_dim = feature_dim
        for hidden_dim in cfg.hidden_sizes:
            subkey, actor_key = jr.split(actor_key)
            weight = sparse_init(
                subkey,
                (hidden_dim, in_dim),
                sparsity=cfg.actor_sparsity,
            )
            bias = jnp.zeros((hidden_dim,), dtype=jnp.float32)
            trunk_weights.append(weight)
            trunk_biases.append(bias)
            trunk_traces.extend([jnp.zeros_like(weight), jnp.zeros_like(bias)])
            trunk_opt_states.append(self._actor_optimizer.init_for_shape(weight.shape))
            trunk_opt_states.append(self._actor_optimizer.init_for_shape(bias.shape))
            in_dim = hidden_dim

        subkey, actor_key = jr.split(actor_key)
        actor_head_w = sparse_init(
            subkey,
            (cfg.n_actions, in_dim),
            sparsity=cfg.actor_sparsity,
        )
        actor_head_b = jnp.zeros((cfg.n_actions,), dtype=jnp.float32)
        return NonlinearHordeActorCriticState(  # type: ignore[call-arg]
            actor_trunk=MLPParams(  # type: ignore[call-arg]
                {"weights": tuple(trunk_weights), "biases": tuple(trunk_biases)}
            ),
            actor_head_w=actor_head_w,
            actor_head_b=actor_head_b,
            actor_trunk_traces=tuple(trunk_traces),
            actor_head_trace_w=jnp.zeros_like(actor_head_w),
            actor_head_trace_b=jnp.zeros_like(actor_head_b),
            actor_trunk_opt_states=tuple(trunk_opt_states),
            actor_head_opt_w=self._actor_optimizer.init_for_shape(actor_head_w.shape),
            actor_head_opt_b=self._actor_optimizer.init_for_shape(actor_head_b.shape),
            actor_td_error_normalizer=jnp.array(0.0, dtype=jnp.float32),
            critic_state=self._critic.init(feature_dim, critic_key),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=actor_key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities for one observation."""
        cfg = self._config
        hidden = MultiHeadMLPLearner._trunk_forward(
            state.actor_trunk.weights,
            state.actor_trunk.biases,
            observation,
            cfg.leaky_relu_slope,
            cfg.use_layer_norm,
        )
        logits = state.actor_head_w @ hidden + state.actor_head_b
        return jax.nn.softmax(logits / cfg.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def q_values(self, state: NonlinearHordeActorCriticState, observation: Array) -> Array:
        """Compute action values from the first ``n_actions`` Horde heads."""
        values = self._critic.predict(state.critic_state, observation)
        return cast(Array, values[: self._config.n_actions])

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array, Float[Array, " n_actions"]]:
        """Sample one action from the current softmax policy."""
        key, sample_key = jr.split(state.rng_key)
        probs = self.policy(state, observation)
        action = jr.categorical(
            sample_key, jnp.log(jnp.maximum(probs, 1e-8))
        ).astype(jnp.int32)
        return action, key, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: NonlinearHordeActorCriticState,
        observation: Array,
    ) -> tuple[
        NonlinearHordeActorCriticState, Int[Array, ""], Float[Array, " n_actions"]
    ]:
        """Select and store the first action for a stream or episode."""
        action, key, probs = self.select_action(state, observation)
        return state.replace(  # type: ignore[attr-defined]
            last_observation=observation,
            last_action=action,
            rng_key=key,
        ), action, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: NonlinearHordeActorCriticState,
        reward: Array,
        observation: Array,
        terminated: Array,
        prediction_cumulants: Array | None = None,
    ) -> NonlinearQHordeActorCriticUpdateResult:
        """Update actor and action-value Horde critic from one transition."""
        cfg = self._config
        prev_obs = state.last_observation
        next_policy = self.policy(state, observation)
        sampled_next_action, sampled_key, sampled_policy = self.select_action(
            state,
            observation,
        )
        q_previous = self.q_values(state, prev_obs)
        q_next = self.q_values(state, observation)
        effective_gamma = jnp.where(terminated, 0.0, cfg.gamma)
        next_value = (
            q_next[sampled_next_action]
            if cfg.critic_target == "sampled_sarsa"
            else jnp.dot(next_policy, q_next)
        )
        target = jnp.asarray(reward, dtype=jnp.float32) + effective_gamma * next_value
        td_error = target - q_previous[state.last_action]

        cumulants = jnp.full(self._critic.n_demons, jnp.nan, dtype=jnp.float32)
        cumulants = cumulants.at[state.last_action].set(target)
        if prediction_cumulants is not None:
            cumulants = cumulants.at[cfg.n_actions :].set(prediction_cumulants)
        critic_result = self._critic.update(
            state.critic_state,
            prev_obs,
            cumulants,
            observation,
        )

        actor_td_error = (
            td_error
            if cfg.actor_td_error_clip is None
            else jnp.clip(td_error, -cfg.actor_td_error_clip, cfg.actor_td_error_clip)
        )
        actor_params = (
            state.actor_trunk.weights,
            state.actor_trunk.biases,
            state.actor_head_w,
            state.actor_head_b,
        )
        if cfg.actor_update == "expected_advantage":
            policy = self.policy(state, prev_obs)
            state_value = jnp.dot(policy, q_previous)
            advantages = q_previous - state_value
            grads = _nlqhac_expected_advantage_grad(
                actor_params,
                prev_obs,
                advantages,
                cfg.leaky_relu_slope,
                cfg.use_layer_norm,
                cfg.temperature,
            )
            actor_signal = jnp.array(1.0, dtype=jnp.float32)
        else:
            grads = _nlhac_grad(
                actor_params,
                prev_obs,
                state.last_action,
                cfg.leaky_relu_slope,
                cfg.use_layer_norm,
                cfg.temperature,
                0.0,
            )
            actor_signal = actor_td_error
        grad_trunk_w, grad_trunk_b, grad_head_w, grad_head_b = grads
        grad_trunk_w, grad_trunk_b, grad_head_w, grad_head_b = (
            _clip_nlhac_actor_grads(
                grad_trunk_w,
                grad_trunk_b,
                grad_head_w,
                grad_head_b,
                cfg.actor_gradient_clip_norm,
            )
        )

        actor_decay = effective_gamma * cfg.actor_lamda
        n_hidden = len(cfg.hidden_sizes)
        new_trunk_traces: list[Array] = []
        for i in range(n_hidden):
            new_trunk_traces.append(
                actor_decay * state.actor_trunk_traces[2 * i] + grad_trunk_w[i]
            )
            new_trunk_traces.append(
                actor_decay * state.actor_trunk_traces[2 * i + 1] + grad_trunk_b[i]
            )
        new_head_trace_w = actor_decay * state.actor_head_trace_w + grad_head_w
        new_head_trace_b = actor_decay * state.actor_head_trace_b + grad_head_b

        new_trunk_opt_states: list[AutostepParamState] = []
        trunk_w_steps: list[Array] = []
        trunk_b_steps: list[Array] = []
        for i in range(n_hidden):
            raw_w, new_opt_w = self._actor_optimizer.update_from_gradient(
                state.actor_trunk_opt_states[2 * i],
                new_trunk_traces[2 * i],
                error=actor_signal,
            )
            raw_b, new_opt_b = self._actor_optimizer.update_from_gradient(
                state.actor_trunk_opt_states[2 * i + 1],
                new_trunk_traces[2 * i + 1],
                error=actor_signal,
            )
            new_trunk_opt_states.extend([new_opt_w, new_opt_b])
            trunk_w_steps.append(actor_signal * raw_w)
            trunk_b_steps.append(actor_signal * raw_b)

        raw_head_w, new_head_opt_w = self._actor_optimizer.update_from_gradient(
            state.actor_head_opt_w, new_head_trace_w, error=actor_signal
        )
        raw_head_b, new_head_opt_b = self._actor_optimizer.update_from_gradient(
            state.actor_head_opt_b, new_head_trace_b, error=actor_signal
        )
        head_w_step = actor_signal * raw_head_w
        head_b_step = actor_signal * raw_head_b

        bound_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._actor_bounder is not None:
            bounded_steps, bound_metric = self._actor_bounder.bound(
                (*trunk_w_steps, *trunk_b_steps, head_w_step, head_b_step),
                actor_td_error,
                (
                    *state.actor_trunk.weights,
                    *state.actor_trunk.biases,
                    state.actor_head_w,
                    state.actor_head_b,
                ),
            )
            trunk_w_steps = list(bounded_steps[:n_hidden])
            trunk_b_steps = list(bounded_steps[n_hidden : 2 * n_hidden])
            head_w_step = bounded_steps[2 * n_hidden]
            head_b_step = bounded_steps[2 * n_hidden + 1]

        carry_traces = effective_gamma != 0.0
        updated = state.replace(  # type: ignore[attr-defined]
            actor_trunk=MLPParams(  # type: ignore[call-arg]
                {
                    "weights": tuple(
                        w + step
                        for w, step in zip(state.actor_trunk.weights, trunk_w_steps)
                    ),
                    "biases": tuple(
                        b + step
                        for b, step in zip(state.actor_trunk.biases, trunk_b_steps)
                    ),
                }
            ),
            actor_head_w=state.actor_head_w + head_w_step,
            actor_head_b=state.actor_head_b + head_b_step,
            actor_trunk_traces=tuple(
                jnp.where(carry_traces, trace, jnp.zeros_like(trace))
                for trace in new_trunk_traces
            ),
            actor_head_trace_w=jnp.where(
                carry_traces, new_head_trace_w, jnp.zeros_like(new_head_trace_w)
            ),
            actor_head_trace_b=jnp.where(
                carry_traces, new_head_trace_b, jnp.zeros_like(new_head_trace_b)
            ),
            actor_trunk_opt_states=tuple(new_trunk_opt_states),
            actor_head_opt_w=new_head_opt_w,
            actor_head_opt_b=new_head_opt_b,
            critic_state=critic_result.state,
            step_count=state.step_count + 1,
        )
        next_action, key, policy = (
            (sampled_next_action, sampled_key, sampled_policy)
            if cfg.critic_target == "sampled_sarsa"
            else self.select_action(updated, observation)
        )
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )
        return NonlinearQHordeActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            policy=policy,
            q_values=q_previous,
            next_q_values=q_next,
            target=target,
            td_error=td_error,
            bound_metric=bound_metric,
            critic_result=critic_result,
        )
