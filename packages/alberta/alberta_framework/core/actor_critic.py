"""Actor-critic control with discrete and continuous policies.

This module provides the Step 4b control cores for daemon-style use:
``ActorCriticAgent`` for discrete (softmax) actions and
``ContinuousActorCriticAgent`` for continuous (diagonal-Gaussian) actions.
Both share the same linear-critic AC(lambda) semantics, separate eligibility
traces, and pure single-step APIs compatible with ``jax.jit`` and
``jax.lax.scan``.

The Horde-backed critic integration point is the scalar ``value``/TD-error
path in ``update``: replace the linear critic estimate and critic trace update
with a GVF value adapter that exposes ``value(state, obs)`` and
``update(state, reward, discount, obs)`` while preserving the actor's
advantage signal. That adapter is intentionally left out of this core slice so
the linear AC(lambda) semantics remain explicit and covered by focused tests.
"""

from __future__ import annotations

import dataclasses
import functools
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.optimizers import Bounder, bounder_from_config


@dataclasses.dataclass(frozen=True)
class ActorCriticConfig:
    """Configuration for a linear softmax actor-critic agent.

    Attributes:
        n_actions: Number of discrete actions.
        gamma: Discount factor.
        actor_step_size: Step-size for policy parameters.
        critic_step_size: Step-size for value parameters.
        actor_lamda: Eligibility trace decay for the actor.
        critic_lamda: Eligibility trace decay for the critic.
        temperature: Softmax temperature. Values below 1 sharpen the policy.
    """

    n_actions: int
    gamma: float = 0.99
    actor_step_size: float = 0.01
    critic_step_size: float = 0.05
    actor_lamda: float = 0.9
    critic_lamda: float = 0.9
    temperature: float = 1.0

    def to_config(self) -> dict[str, Any]:
        """Serialize this configuration to a dictionary."""
        return {
            "n_actions": self.n_actions,
            "gamma": self.gamma,
            "actor_step_size": self.actor_step_size,
            "critic_step_size": self.critic_step_size,
            "actor_lamda": self.actor_lamda,
            "critic_lamda": self.critic_lamda,
            "temperature": self.temperature,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ActorCriticConfig:
        """Reconstruct an ``ActorCriticConfig`` from a dictionary."""
        return cls(**config)


@chex.dataclass(frozen=True)
class ActorCriticState:
    """Immutable state for a linear actor-critic agent.

    Attributes:
        actor_weights: Policy weight matrix, shape ``(n_actions, feature_dim)``.
        actor_bias: Policy bias vector, shape ``(n_actions,)``.
        critic_weights: Value weight vector, shape ``(feature_dim,)``.
        critic_bias: Scalar value bias.
        actor_trace_weights: Eligibility trace for actor weights.
        actor_trace_bias: Eligibility trace for actor bias.
        critic_trace_weights: Eligibility trace for critic weights.
        critic_trace_bias: Eligibility trace for critic bias.
        last_observation: Previous observation ``s_t``.
        last_action: Previous action ``a_t``.
        rng_key: Random key used for action sampling.
        step_count: Number of update steps taken.
    """

    actor_weights: Float[Array, "n_actions feature_dim"]
    actor_bias: Float[Array, " n_actions"]
    critic_weights: Float[Array, " feature_dim"]
    critic_bias: Float[Array, ""]
    actor_trace_weights: Float[Array, "n_actions feature_dim"]
    actor_trace_bias: Float[Array, " n_actions"]
    critic_trace_weights: Float[Array, " feature_dim"]
    critic_trace_bias: Float[Array, ""]
    last_observation: Float[Array, " feature_dim"]
    last_action: Int[Array, ""]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class ActorCriticUpdateResult:
    """Result from one actor-critic transition update.

    Attributes:
        state: Updated agent state.
        action: Next action selected for the new observation.
        policy: Policy probabilities at the new observation.
        value: Value estimate at the previous observation.
        next_value: Value estimate at the new observation.
        td_error: One-step TD error.
        bound_metric: Mean bounder metric, or 1.0 when no bounder is used.
    """

    state: ActorCriticState
    action: Int[Array, ""]
    policy: Float[Array, " n_actions"]
    value: Float[Array, ""]
    next_value: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]


@chex.dataclass(frozen=True)
class ActorCriticArrayResult:
    """Result from scan-based actor-critic learning on arrays.

    Attributes:
        state: Final agent state.
        actions: Per-step actions, shape ``(num_steps,)``.
        policies: Per-step policy probabilities, shape ``(num_steps, n_actions)``.
        values: Per-step previous-state value estimates, shape ``(num_steps,)``.
        td_errors: Per-step TD errors, shape ``(num_steps,)``.
    """

    state: ActorCriticState
    actions: Int[Array, " num_steps"]
    policies: Float[Array, "num_steps n_actions"]
    values: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]


class ActorCriticAgent:
    """Linear actor-critic agent with a discrete softmax policy.

    The actor is a softmax over linear logits and the critic is a scalar
    linear value function. Both components maintain accumulating eligibility
    traces and update at every time step from the same TD error.

    The implemented objective is the continuing or episodic AC(lambda)
    semi-gradient update. For transition ``S_t, A_t, R_{t+1}, S_{t+1}``, the
    critic forms ``delta_t = R_{t+1} + gamma_t V(S_{t+1}) - V(S_t)`` and
    updates value parameters along accumulating traces
    ``e^v_t = gamma_t lambda_v e^v_{t-1} + grad V(S_t)``. The actor updates
    linear softmax logits in the policy-gradient direction
    ``delta_t e^pi_t``, with
    ``e^pi_t = gamma_t lambda_pi e^pi_{t-1} + grad log pi(A_t | S_t)``.
    Because logits are divided by ``temperature`` before the softmax,
    ``grad log pi`` includes the corresponding ``1 / temperature`` factor.
    """

    def __init__(
        self,
        config: ActorCriticConfig,
        bounder: Bounder | None = None,
    ):
        """Initialize the actor-critic agent.

        Args:
            config: Actor-critic hyperparameters.
            bounder: Optional update bounder compatible with the framework
                ``Bounder`` ABC. When present, actor and critic proposed steps
                are bounded independently using the TD error.
        """
        if config.n_actions <= 0:
            raise ValueError("n_actions must be positive")
        if config.temperature <= 0:
            raise ValueError("temperature must be positive")
        self._config = config
        self._bounder = bounder

    @property
    def config(self) -> ActorCriticConfig:
        """Actor-critic configuration."""
        return self._config

    @property
    def bounder(self) -> Bounder | None:
        """Optional update bounder."""
        return self._bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "ActorCriticAgent",
            "config": self._config.to_config(),
            "bounder": self._bounder.to_config() if self._bounder is not None else None,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ActorCriticAgent:
        """Reconstruct an ``ActorCriticAgent`` from a dictionary."""
        config = dict(config)
        config.pop("type", None)
        ac_config = ActorCriticConfig.from_config(config.pop("config"))
        bounder_config = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_config) if bounder_config else None
        return cls(config=ac_config, bounder=bounder)

    def init(self, feature_dim: int, key: Array) -> ActorCriticState:
        """Initialize actor and critic state.

        Args:
            feature_dim: Input feature dimension.
            key: JAX random key.

        Returns:
            Initial immutable actor-critic state.
        """
        zeros_actor = jnp.zeros((self._config.n_actions, feature_dim), dtype=jnp.float32)
        zeros_policy_bias = jnp.zeros((self._config.n_actions,), dtype=jnp.float32)
        zeros_critic = jnp.zeros((feature_dim,), dtype=jnp.float32)
        return ActorCriticState(  # type: ignore[call-arg]
            actor_weights=zeros_actor,
            actor_bias=zeros_policy_bias,
            critic_weights=zeros_critic,
            critic_bias=jnp.array(0.0, dtype=jnp.float32),
            actor_trace_weights=zeros_actor,
            actor_trace_bias=zeros_policy_bias,
            critic_trace_weights=zeros_critic,
            critic_trace_bias=jnp.array(0.0, dtype=jnp.float32),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.array(-1, dtype=jnp.int32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy(
        self,
        state: ActorCriticState,
        observation: Array,
    ) -> Float[Array, " n_actions"]:
        """Compute softmax action probabilities for one observation."""
        logits = state.actor_weights @ observation + state.actor_bias
        return jax.nn.softmax(logits / self._config.temperature)

    @functools.partial(jax.jit, static_argnums=(0,))
    def value(self, state: ActorCriticState, observation: Array) -> Float[Array, ""]:
        """Compute the critic value estimate for one observation."""
        return jnp.dot(state.critic_weights, observation) + state.critic_bias

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: ActorCriticState,
        observation: Array,
    ) -> tuple[Int[Array, ""], Array, Float[Array, " n_actions"]]:
        """Sample one action from the current softmax policy.

        Args:
            state: Current agent state.
            observation: Input feature vector.

        Returns:
            Tuple ``(action, new_rng_key, probabilities)``.
        """
        key, sample_key = jr.split(state.rng_key)
        probs = self.policy(state, observation)
        action = jr.categorical(sample_key, jnp.log(jnp.maximum(probs, 1e-8))).astype(
            jnp.int32
        )
        return action, key, probs

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: ActorCriticState,
        observation: Array,
    ) -> tuple[ActorCriticState, Int[Array, ""], Float[Array, " n_actions"]]:
        """Select and store the first action for a new stream or episode."""
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
        state: ActorCriticState,
        reward: Array,
        observation: Array,
        terminated: Array | None = None,
        discount: Array | None = None,
    ) -> ActorCriticUpdateResult:
        """Update actor and critic from one transition.

        The transition is ``(state.last_observation, state.last_action,
        reward, observation)`` plus either a scalar transition ``discount`` or
        the legacy ``terminated`` flag. A next action is sampled and stored in
        the returned state for the following update.

        Args:
            state: Current agent state with a valid previous observation/action.
            reward: Scalar reward.
            observation: Next observation.
            terminated: Backward-compatible scalar terminal flag. Non-zero
                maps to transition discount ``0``; false maps to
                ``config.gamma``. Ignored when ``discount`` is provided.
            discount: Optional scalar per-transition discount ``gamma_t``.
                Use this for continuing logs, variable discounts, time-limit
                truncation semantics, and pre-collected trajectories.

        Returns:
            ``ActorCriticUpdateResult`` containing the updated state and metrics.
        """
        cfg = self._config
        prev_obs = state.last_observation
        action = state.last_action

        old_policy = self.policy(state, prev_obs)
        value = self.value(state, prev_obs)
        next_value = self.value(state, observation)
        if discount is None:
            if terminated is None:
                discount = jnp.array(cfg.gamma, dtype=jnp.float32)
            else:
                discount = jnp.where(terminated, 0.0, cfg.gamma)
        discount = jnp.asarray(discount, dtype=jnp.float32)
        bootstrap = discount * next_value
        td_error = reward + bootstrap - value

        one_hot = jax.nn.one_hot(action, cfg.n_actions, dtype=jnp.float32)
        actor_grad_bias = (one_hot - old_policy) / cfg.temperature
        actor_grad_weights = actor_grad_bias[:, None] * prev_obs[None, :]

        actor_decay = discount * cfg.actor_lamda
        critic_decay = discount * cfg.critic_lamda
        actor_trace_weights = actor_decay * state.actor_trace_weights + actor_grad_weights
        actor_trace_bias = actor_decay * state.actor_trace_bias + actor_grad_bias
        critic_trace_weights = critic_decay * state.critic_trace_weights + prev_obs
        critic_trace_bias = critic_decay * state.critic_trace_bias + 1.0

        actor_steps: tuple[Array, ...] = (
            cfg.actor_step_size * td_error * actor_trace_weights,
            cfg.actor_step_size * td_error * actor_trace_bias,
        )
        critic_steps: tuple[Array, ...] = (
            cfg.critic_step_size * td_error * critic_trace_weights,
            cfg.critic_step_size * td_error * critic_trace_bias,
        )
        actor_metric = jnp.array(1.0, dtype=jnp.float32)
        critic_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._bounder is not None:
            actor_steps, actor_metric = self._bounder.bound(
                actor_steps,
                td_error,
                (state.actor_weights, state.actor_bias),
            )
            critic_steps, critic_metric = self._bounder.bound(
                critic_steps,
                td_error,
                (state.critic_weights, state.critic_bias),
            )

        carry_traces = discount != 0.0
        stored_actor_trace_weights = jnp.where(
            carry_traces, actor_trace_weights, jnp.zeros_like(actor_trace_weights)
        )
        stored_actor_trace_bias = jnp.where(
            carry_traces, actor_trace_bias, jnp.zeros_like(actor_trace_bias)
        )
        stored_critic_trace_weights = jnp.where(
            carry_traces, critic_trace_weights, jnp.zeros_like(critic_trace_weights)
        )
        stored_critic_trace_bias = jnp.where(
            carry_traces, critic_trace_bias, jnp.zeros_like(critic_trace_bias)
        )
        updated = state.replace(  # type: ignore[attr-defined]
            actor_weights=state.actor_weights + actor_steps[0],
            actor_bias=state.actor_bias + actor_steps[1],
            critic_weights=state.critic_weights + critic_steps[0],
            critic_bias=state.critic_bias + critic_steps[1],
            actor_trace_weights=stored_actor_trace_weights,
            actor_trace_bias=stored_actor_trace_bias,
            critic_trace_weights=stored_critic_trace_weights,
            critic_trace_bias=stored_critic_trace_bias,
            step_count=state.step_count + 1,
        )
        next_action, key, next_policy = self.select_action(updated, observation)
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )

        return ActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            policy=next_policy,
            value=value,
            next_value=next_value,
            td_error=td_error,
            bound_metric=(actor_metric + critic_metric) / 2.0,
        )


def run_actor_critic_from_arrays(
    agent: ActorCriticAgent,
    state: ActorCriticState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    terminated: Float[Array, " num_steps"] | None,
    next_observations: Float[Array, "num_steps feature_dim"],
    actions: Int[Array, " num_steps"] | None = None,
    discounts: Float[Array, " num_steps"] | None = None,
) -> ActorCriticArrayResult:
    """Run actor-critic updates over arrays with ``jax.lax.scan``.

    By default the scan is on-policy with respect to the current actor. At each
    row it starts from ``observations[t]``, samples/stores an action, and
    applies the transition ending at ``next_observations[t]``. When ``actions``
    is provided, those fixed behavior actions are used instead, which is the
    path intended for pre-collected logs. When ``discounts`` is provided it is
    used as the per-transition discount; otherwise ``terminated`` is mapped to
    ``0`` or ``agent.config.gamma`` for backward compatibility.

    Args:
        agent: Actor-critic agent.
        state: Initial actor-critic state.
        observations: Current observations, shape ``(num_steps, feature_dim)``.
        rewards: Rewards, shape ``(num_steps,)``.
        terminated: Terminal flags, shape ``(num_steps,)``. Required unless
            ``discounts`` is provided.
        next_observations: Next observations, shape ``(num_steps, feature_dim)``.
        actions: Optional fixed current actions, shape ``(num_steps,)``.
        discounts: Optional transition discounts, shape ``(num_steps,)``.

    Returns:
        ``ActorCriticArrayResult`` with final state and per-step metrics.
    """
    if terminated is None and discounts is None:
        raise ValueError("terminated or discounts must be provided")
    if terminated is None:
        terminated = jnp.zeros_like(rewards, dtype=jnp.bool_)
    if discounts is None:
        discounts = jnp.where(terminated, 0.0, agent.config.gamma).astype(jnp.float32)
    if actions is None:
        actions = jnp.full_like(rewards, -1, dtype=jnp.int32)
        use_fixed_actions = False
    else:
        use_fixed_actions = True

    def _scan_fn(
        carry: ActorCriticState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[ActorCriticState, tuple[Array, Array, Array, Array]]:
        obs, reward, term_discount, next_obs, fixed_action = inputs
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
            discount=term_discount,
        )
        return result.state, (
            current_action,
            result.policy,
            result.value,
            result.td_error,
        )

    final_state, (actions, policies, values, td_errors) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, rewards, discounts, next_observations, actions),
    )
    return ActorCriticArrayResult(  # type: ignore[call-arg]
        state=final_state,
        actions=actions,
        policies=policies,
        values=values,
        td_errors=td_errors,
    )


# ---------------------------------------------------------------------------
# Continuous-action actor-critic (Step 4 preview)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class ContinuousActorCriticConfig:
    """Configuration for a continuous-action linear actor-critic.

    The actor models a diagonal-Gaussian policy ``a ~ N(mu(s), sigma^2)`` with
    a linear mean ``mu(s) = W_mu s + b_mu`` and a per-dimension log-standard-
    deviation parameter ``log_sigma`` (state-independent). Action samples are
    optionally clipped to ``[action_low, action_high]`` after sampling. The
    critic is a scalar linear value function ``V(s) = w_v . s + b_v``. Both
    actor and critic carry their own accumulating eligibility traces and share
    the same TD error.

    Attributes:
        action_dim: Dimensionality of the continuous action vector.
        gamma: Discount factor.
        actor_step_size: Step-size for the actor mean and log-sigma parameters.
        critic_step_size: Step-size for the critic value parameters.
        actor_lamda: Eligibility trace decay for the actor.
        critic_lamda: Eligibility trace decay for the critic.
        log_sigma_init: Initial value for ``log_sigma`` per action dimension.
        log_sigma_min: Lower bound clamp on ``log_sigma`` after each update.
        log_sigma_max: Upper bound clamp on ``log_sigma`` after each update.
        action_low: Lower bound for action clipping. ``None`` disables clipping.
        action_high: Upper bound for action clipping. ``None`` disables clipping.
    """

    action_dim: int
    gamma: float = 0.99
    actor_step_size: float = 0.001
    critic_step_size: float = 0.05
    actor_lamda: float = 0.9
    critic_lamda: float = 0.9
    log_sigma_init: float = -0.5
    log_sigma_min: float = -5.0
    log_sigma_max: float = 2.0
    action_low: float | None = None
    action_high: float | None = None

    def to_config(self) -> dict[str, Any]:
        """Serialize this configuration to a dictionary."""
        return {
            "action_dim": self.action_dim,
            "gamma": self.gamma,
            "actor_step_size": self.actor_step_size,
            "critic_step_size": self.critic_step_size,
            "actor_lamda": self.actor_lamda,
            "critic_lamda": self.critic_lamda,
            "log_sigma_init": self.log_sigma_init,
            "log_sigma_min": self.log_sigma_min,
            "log_sigma_max": self.log_sigma_max,
            "action_low": self.action_low,
            "action_high": self.action_high,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ContinuousActorCriticConfig:
        """Reconstruct a ``ContinuousActorCriticConfig`` from a dictionary."""
        return cls(**config)


@chex.dataclass(frozen=True)
class ContinuousActorCriticState:
    """Immutable state for a continuous-action linear actor-critic.

    Attributes:
        mean_weights: Mean head weights, shape ``(action_dim, feature_dim)``.
        mean_bias: Mean head bias, shape ``(action_dim,)``.
        log_sigma: Per-dimension log-standard-deviation, shape ``(action_dim,)``.
        critic_weights: Value weight vector, shape ``(feature_dim,)``.
        critic_bias: Scalar value bias.
        mean_trace_weights: Trace for mean weights.
        mean_trace_bias: Trace for mean bias.
        log_sigma_trace: Trace for ``log_sigma``.
        critic_trace_weights: Trace for critic weights.
        critic_trace_bias: Trace for critic bias.
        last_observation: Previous observation ``s_t``.
        last_action: Previous (continuous) action vector ``a_t``.
        rng_key: Random key used for action sampling.
        step_count: Number of update steps taken.
    """

    mean_weights: Float[Array, "action_dim feature_dim"]
    mean_bias: Float[Array, " action_dim"]
    log_sigma: Float[Array, " action_dim"]
    critic_weights: Float[Array, " feature_dim"]
    critic_bias: Float[Array, ""]
    mean_trace_weights: Float[Array, "action_dim feature_dim"]
    mean_trace_bias: Float[Array, " action_dim"]
    log_sigma_trace: Float[Array, " action_dim"]
    critic_trace_weights: Float[Array, " feature_dim"]
    critic_trace_bias: Float[Array, ""]
    last_observation: Float[Array, " feature_dim"]
    last_action: Float[Array, " action_dim"]
    rng_key: Array
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class ContinuousActorCriticUpdateResult:
    """Result from one continuous actor-critic transition update.

    Attributes:
        state: Updated agent state.
        action: Next action vector sampled at the new observation.
        mean: Mean of the policy at the new observation.
        sigma: Standard deviation of the policy.
        value: Value estimate at the previous observation.
        next_value: Value estimate at the new observation.
        td_error: One-step TD error.
        bound_metric: Mean bounder metric, or 1.0 when no bounder is used.
    """

    state: ContinuousActorCriticState
    action: Float[Array, " action_dim"]
    mean: Float[Array, " action_dim"]
    sigma: Float[Array, " action_dim"]
    value: Float[Array, ""]
    next_value: Float[Array, ""]
    td_error: Float[Array, ""]
    bound_metric: Float[Array, ""]


@chex.dataclass(frozen=True)
class ContinuousActorCriticArrayResult:
    """Result from scan-based continuous actor-critic learning on arrays.

    Attributes:
        state: Final agent state.
        actions: Per-step actions, shape ``(num_steps, action_dim)``.
        means: Per-step policy means, shape ``(num_steps, action_dim)``.
        sigmas: Per-step policy standard deviations, shape ``(num_steps, action_dim)``.
        values: Per-step previous-state value estimates, shape ``(num_steps,)``.
        td_errors: Per-step TD errors, shape ``(num_steps,)``.
    """

    state: ContinuousActorCriticState
    actions: Float[Array, "num_steps action_dim"]
    means: Float[Array, "num_steps action_dim"]
    sigmas: Float[Array, "num_steps action_dim"]
    values: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]


class ContinuousActorCriticAgent:
    """Linear continuous-action actor-critic with a diagonal-Gaussian policy.

    The actor parameterises a diagonal Gaussian
    ``pi(a | s) = N(mu(s), diag(sigma^2))`` with linear mean
    ``mu(s) = W_mu s + b_mu`` and a state-independent log-sigma vector. The
    critic is a scalar linear value function. Both components carry their own
    accumulating eligibility traces and update at every time step from the
    same TD error, mirroring the discrete ``ActorCriticAgent``.

    Policy gradient. With a Gaussian policy, the score function is

    ``grad_{mu_i} log pi(a | s) = (a_i - mu_i) / sigma_i^2``,

    ``grad_{log_sigma_i} log pi(a | s) = (a_i - mu_i)^2 / sigma_i^2 - 1``.

    These gradients enter the actor traces and are scaled by the TD error
    when applied. ``log_sigma`` is optionally clamped after each update for
    numerical stability and to prevent collapse.
    """

    def __init__(
        self,
        config: ContinuousActorCriticConfig,
        bounder: Bounder | None = None,
    ):
        """Initialize the continuous actor-critic agent.

        Args:
            config: Continuous actor-critic hyperparameters.
            bounder: Optional update bounder compatible with the framework
                ``Bounder`` ABC. When present, actor and critic proposed steps
                are bounded independently using the TD error.
        """
        if config.action_dim <= 0:
            raise ValueError("action_dim must be positive")
        if config.log_sigma_min > config.log_sigma_max:
            raise ValueError("log_sigma_min must be <= log_sigma_max")
        self._config = config
        self._bounder = bounder

    @property
    def config(self) -> ContinuousActorCriticConfig:
        """Continuous actor-critic configuration."""
        return self._config

    @property
    def bounder(self) -> Bounder | None:
        """Optional update bounder."""
        return self._bounder

    def to_config(self) -> dict[str, Any]:
        """Serialize this agent to a dictionary."""
        return {
            "type": "ContinuousActorCriticAgent",
            "config": self._config.to_config(),
            "bounder": self._bounder.to_config() if self._bounder is not None else None,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ContinuousActorCriticAgent:
        """Reconstruct a ``ContinuousActorCriticAgent`` from a dictionary."""
        config = dict(config)
        config.pop("type", None)
        ac_config = ContinuousActorCriticConfig.from_config(config.pop("config"))
        bounder_config = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_config) if bounder_config else None
        return cls(config=ac_config, bounder=bounder)

    def init(self, feature_dim: int, key: Array) -> ContinuousActorCriticState:
        """Initialize actor and critic state.

        Args:
            feature_dim: Input feature dimension.
            key: JAX random key.

        Returns:
            Initial immutable continuous actor-critic state.
        """
        cfg = self._config
        zeros_mean = jnp.zeros((cfg.action_dim, feature_dim), dtype=jnp.float32)
        zeros_mean_bias = jnp.zeros((cfg.action_dim,), dtype=jnp.float32)
        log_sigma = jnp.full(
            (cfg.action_dim,),
            cfg.log_sigma_init,
            dtype=jnp.float32,
        )
        zeros_critic = jnp.zeros((feature_dim,), dtype=jnp.float32)
        return ContinuousActorCriticState(  # type: ignore[call-arg]
            mean_weights=zeros_mean,
            mean_bias=zeros_mean_bias,
            log_sigma=log_sigma,
            critic_weights=zeros_critic,
            critic_bias=jnp.array(0.0, dtype=jnp.float32),
            mean_trace_weights=zeros_mean,
            mean_trace_bias=zeros_mean_bias,
            log_sigma_trace=jnp.zeros_like(log_sigma),
            critic_trace_weights=zeros_critic,
            critic_trace_bias=jnp.array(0.0, dtype=jnp.float32),
            last_observation=jnp.zeros((feature_dim,), dtype=jnp.float32),
            last_action=jnp.zeros((cfg.action_dim,), dtype=jnp.float32),
            rng_key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def policy_params(
        self,
        state: ContinuousActorCriticState,
        observation: Array,
    ) -> tuple[Float[Array, " action_dim"], Float[Array, " action_dim"]]:
        """Compute Gaussian policy mean and standard deviation for one observation."""
        mean = state.mean_weights @ observation + state.mean_bias
        sigma = jnp.exp(state.log_sigma)
        return mean, sigma

    @functools.partial(jax.jit, static_argnums=(0,))
    def value(
        self,
        state: ContinuousActorCriticState,
        observation: Array,
    ) -> Float[Array, ""]:
        """Compute the critic value estimate for one observation."""
        return jnp.dot(state.critic_weights, observation) + state.critic_bias

    def _maybe_clip_action(self, action: Array) -> Array:
        cfg = self._config
        if cfg.action_low is None and cfg.action_high is None:
            return action
        low = -jnp.inf if cfg.action_low is None else cfg.action_low
        high = jnp.inf if cfg.action_high is None else cfg.action_high
        return jnp.clip(action, low, high)

    @functools.partial(jax.jit, static_argnums=(0,))
    def select_action(
        self,
        state: ContinuousActorCriticState,
        observation: Array,
    ) -> tuple[
        Float[Array, " action_dim"],
        Array,
        Float[Array, " action_dim"],
        Float[Array, " action_dim"],
    ]:
        """Sample one action from the current Gaussian policy.

        Args:
            state: Current agent state.
            observation: Input feature vector.

        Returns:
            Tuple ``(action, new_rng_key, mean, sigma)`` where ``action`` is
            optionally clipped to the configured action bounds.
        """
        key, sample_key = jr.split(state.rng_key)
        mean, sigma = self.policy_params(state, observation)
        noise = jr.normal(sample_key, shape=mean.shape, dtype=jnp.float32)
        raw_action = mean + sigma * noise
        action = self._maybe_clip_action(raw_action)
        return action, key, mean, sigma

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(
        self,
        state: ContinuousActorCriticState,
        observation: Array,
    ) -> tuple[
        ContinuousActorCriticState,
        Float[Array, " action_dim"],
        Float[Array, " action_dim"],
        Float[Array, " action_dim"],
    ]:
        """Select and store the first action for a new stream or episode."""
        action, key, mean, sigma = self.select_action(state, observation)
        new_state = state.replace(  # type: ignore[attr-defined]
            last_observation=observation,
            last_action=action,
            rng_key=key,
        )
        return new_state, action, mean, sigma

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: ContinuousActorCriticState,
        reward: Array,
        observation: Array,
        terminated: Array | None = None,
        discount: Array | None = None,
    ) -> ContinuousActorCriticUpdateResult:
        """Update actor and critic from one transition.

        The transition is ``(state.last_observation, state.last_action,
        reward, observation)`` plus either a scalar transition ``discount`` or
        the legacy ``terminated`` flag. A next action is sampled and stored in
        the returned state for the following update.

        Args:
            state: Current agent state with a valid previous observation/action.
            reward: Scalar reward.
            observation: Next observation.
            terminated: Backward-compatible scalar terminal flag. Non-zero
                maps to transition discount ``0``; false maps to
                ``config.gamma``. Ignored when ``discount`` is provided.
            discount: Optional scalar per-transition discount ``gamma_t``.

        Returns:
            ``ContinuousActorCriticUpdateResult`` containing the updated state.
        """
        cfg = self._config
        prev_obs = state.last_observation
        action = state.last_action

        prev_mean, prev_sigma = self.policy_params(state, prev_obs)
        value = self.value(state, prev_obs)
        next_value = self.value(state, observation)
        if discount is None:
            if terminated is None:
                discount = jnp.array(cfg.gamma, dtype=jnp.float32)
            else:
                discount = jnp.where(terminated, 0.0, cfg.gamma)
        discount = jnp.asarray(discount, dtype=jnp.float32)
        bootstrap = discount * next_value
        td_error = reward + bootstrap - value

        sigma_sq = prev_sigma * prev_sigma + 1e-8
        diff = action - prev_mean
        # Gaussian score function (per-dimension):
        #   grad log pi w.r.t. mean   = diff / sigma^2
        #   grad log pi w.r.t. log_sigma = diff^2 / sigma^2 - 1
        mean_grad_bias = diff / sigma_sq
        mean_grad_weights = mean_grad_bias[:, None] * prev_obs[None, :]
        log_sigma_grad = (diff * diff) / sigma_sq - 1.0

        actor_decay = discount * cfg.actor_lamda
        critic_decay = discount * cfg.critic_lamda
        mean_trace_weights = actor_decay * state.mean_trace_weights + mean_grad_weights
        mean_trace_bias = actor_decay * state.mean_trace_bias + mean_grad_bias
        log_sigma_trace = actor_decay * state.log_sigma_trace + log_sigma_grad
        critic_trace_weights = critic_decay * state.critic_trace_weights + prev_obs
        critic_trace_bias = critic_decay * state.critic_trace_bias + 1.0

        actor_steps: tuple[Array, ...] = (
            cfg.actor_step_size * td_error * mean_trace_weights,
            cfg.actor_step_size * td_error * mean_trace_bias,
            cfg.actor_step_size * td_error * log_sigma_trace,
        )
        critic_steps: tuple[Array, ...] = (
            cfg.critic_step_size * td_error * critic_trace_weights,
            cfg.critic_step_size * td_error * critic_trace_bias,
        )
        actor_metric = jnp.array(1.0, dtype=jnp.float32)
        critic_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._bounder is not None:
            actor_steps, actor_metric = self._bounder.bound(
                actor_steps,
                td_error,
                (state.mean_weights, state.mean_bias, state.log_sigma),
            )
            critic_steps, critic_metric = self._bounder.bound(
                critic_steps,
                td_error,
                (state.critic_weights, state.critic_bias),
            )

        carry_traces = discount != 0.0
        stored_mean_trace_weights = jnp.where(
            carry_traces, mean_trace_weights, jnp.zeros_like(mean_trace_weights)
        )
        stored_mean_trace_bias = jnp.where(
            carry_traces, mean_trace_bias, jnp.zeros_like(mean_trace_bias)
        )
        stored_log_sigma_trace = jnp.where(
            carry_traces, log_sigma_trace, jnp.zeros_like(log_sigma_trace)
        )
        stored_critic_trace_weights = jnp.where(
            carry_traces, critic_trace_weights, jnp.zeros_like(critic_trace_weights)
        )
        stored_critic_trace_bias = jnp.where(
            carry_traces, critic_trace_bias, jnp.zeros_like(critic_trace_bias)
        )
        new_log_sigma = jnp.clip(
            state.log_sigma + actor_steps[2],
            cfg.log_sigma_min,
            cfg.log_sigma_max,
        )
        updated = state.replace(  # type: ignore[attr-defined]
            mean_weights=state.mean_weights + actor_steps[0],
            mean_bias=state.mean_bias + actor_steps[1],
            log_sigma=new_log_sigma,
            critic_weights=state.critic_weights + critic_steps[0],
            critic_bias=state.critic_bias + critic_steps[1],
            mean_trace_weights=stored_mean_trace_weights,
            mean_trace_bias=stored_mean_trace_bias,
            log_sigma_trace=stored_log_sigma_trace,
            critic_trace_weights=stored_critic_trace_weights,
            critic_trace_bias=stored_critic_trace_bias,
            step_count=state.step_count + 1,
        )
        next_action, key, next_mean, next_sigma = self.select_action(updated, observation)
        new_state = updated.replace(
            last_observation=observation,
            last_action=next_action,
            rng_key=key,
        )

        return ContinuousActorCriticUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            action=next_action,
            mean=next_mean,
            sigma=next_sigma,
            value=value,
            next_value=next_value,
            td_error=td_error,
            bound_metric=(actor_metric + critic_metric) / 2.0,
        )


def run_continuous_actor_critic_from_arrays(
    agent: ContinuousActorCriticAgent,
    state: ContinuousActorCriticState,
    observations: Float[Array, "num_steps feature_dim"],
    rewards: Float[Array, " num_steps"],
    terminated: Float[Array, " num_steps"] | None,
    next_observations: Float[Array, "num_steps feature_dim"],
    actions: Float[Array, "num_steps action_dim"] | None = None,
    discounts: Float[Array, " num_steps"] | None = None,
) -> ContinuousActorCriticArrayResult:
    """Run continuous actor-critic updates over arrays with ``jax.lax.scan``.

    Mirrors :func:`run_actor_critic_from_arrays` for the continuous-action
    variant. By default the scan is on-policy with respect to the current
    actor; pass ``actions`` to use fixed behavior actions.

    Args:
        agent: Continuous actor-critic agent.
        state: Initial agent state.
        observations: Current observations, shape ``(num_steps, feature_dim)``.
        rewards: Rewards, shape ``(num_steps,)``.
        terminated: Terminal flags, shape ``(num_steps,)``. Required unless
            ``discounts`` is provided.
        next_observations: Next observations, shape ``(num_steps, feature_dim)``.
        actions: Optional fixed current actions, shape ``(num_steps, action_dim)``.
        discounts: Optional transition discounts, shape ``(num_steps,)``.

    Returns:
        ``ContinuousActorCriticArrayResult`` with final state and per-step metrics.
    """
    if terminated is None and discounts is None:
        raise ValueError("terminated or discounts must be provided")
    if terminated is None:
        terminated = jnp.zeros_like(rewards, dtype=jnp.bool_)
    if discounts is None:
        discounts = jnp.where(terminated, 0.0, agent.config.gamma).astype(jnp.float32)
    action_dim = agent.config.action_dim
    if actions is None:
        actions = jnp.zeros((rewards.shape[0], action_dim), dtype=jnp.float32)
        use_fixed_actions = False
    else:
        use_fixed_actions = True

    def _scan_fn(
        carry: ContinuousActorCriticState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[ContinuousActorCriticState, tuple[Array, Array, Array, Array, Array]]:
        obs, reward, term_discount, next_obs, fixed_action = inputs
        if use_fixed_actions:
            started_state = carry.replace(  # type: ignore[attr-defined]
                last_observation=obs,
                last_action=fixed_action.astype(jnp.float32),
            )
            current_action = fixed_action.astype(jnp.float32)
            current_mean, current_sigma = agent.policy_params(started_state, obs)
        else:
            started_state, current_action, current_mean, current_sigma = agent.start(
                carry, obs
            )
        result = agent.update(
            started_state,
            reward,
            next_obs,
            discount=term_discount,
        )
        return result.state, (
            current_action,
            current_mean,
            current_sigma,
            result.value,
            result.td_error,
        )

    final_state, (actions_out, means_out, sigmas_out, values, td_errors) = jax.lax.scan(
        _scan_fn,
        state,
        (observations, rewards, discounts, next_observations, actions),
    )
    return ContinuousActorCriticArrayResult(  # type: ignore[call-arg]
        state=final_state,
        actions=actions_out,
        means=means_out,
        sigmas=sigmas_out,
        values=values,
        td_errors=td_errors,
    )
