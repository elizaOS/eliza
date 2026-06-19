# mypy: disable-error-code="attr-defined,call-arg"
"""Core types and algorithms for the STOMP progression (Alberta Plan Step 10).

The STOMP progression (SubTasks, Options, Models, Planning) introduces
temporally extended actions (options) to the continuing agent architecture.
Each option is defined by a subtask — a feature-reaching sub-problem with its
own pseudo-reward and termination condition.  Solving each subtask produces an
intra-option policy (an option).  Online experience with each option trains a
multi-step outcome model.  The top-level agent can then plan with option models
the same way it plans with one-step environment models.

This module provides JAX-compatible, scan-friendly implementations of all four
STOMP components.  All shapes are statically fixed so that JIT compilation and
``jax.lax.scan`` work without recompilation per step.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Sutton, Precup, & Singh (1999). "Between MDPs and semi-MDPs: A Framework
        for Temporal Abstraction in Reinforcement Learning." AIJ.
    Precup (2000). "Temporal Abstraction in Reinforcement Learning." PhD thesis.
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

from alberta_framework.core.multi_head_learner import MultiHeadMLPLearner, MultiHeadMLPState

# ---------------------------------------------------------------------------
# Subtask specification (Python-level; JAX arrays extracted for scan use)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class SubtaskSpec:
    """Defines one subtask as a linear feature-reaching pseudo-reward.

    The pseudo-reward is ``pseudo_reward_scale * observation[feature_index]``.
    The option terminates when the pseudo-reward reaches ``threshold`` or when
    ``max_option_steps`` primitive actions have been executed.

    Args:
        feature_index: Index of the observation feature the option drives toward.
        threshold: Pseudo-reward value at which the option is considered
            complete.  Must be positive; choose relative to the feature scale.
        pseudo_reward_scale: Multiplicative scale for the pseudo-reward signal.
        max_option_steps: Hard cap on option duration to prevent infinite loops.
    """

    feature_index: int
    threshold: float = 0.5
    pseudo_reward_scale: float = 1.0
    max_option_steps: int = 8

    def __post_init__(self) -> None:
        """Validate subtask specification."""
        if self.feature_index < 0:
            raise ValueError("feature_index must be non-negative")
        if self.threshold <= 0.0:
            raise ValueError("threshold must be positive")
        if self.max_option_steps < 1:
            raise ValueError("max_option_steps must be at least 1")


@dataclasses.dataclass(frozen=True)
class STOMPSpecArrays:
    """JAX arrays extracted from a list of :class:`SubtaskSpec` for scan use.

    All arrays have shape ``(n_options,)`` or a compatible leading dimension.
    """

    feature_indices: Int[Array, " n_options"]
    thresholds: Float[Array, " n_options"]
    pseudo_reward_scales: Float[Array, " n_options"]
    max_option_steps: Int[Array, " n_options"]

    @staticmethod
    def from_specs(specs: list[SubtaskSpec]) -> STOMPSpecArrays:
        """Build JAX arrays from a list of :class:`SubtaskSpec`."""
        if not specs:
            raise ValueError("at least one SubtaskSpec required")
        return STOMPSpecArrays(
            feature_indices=jnp.array([s.feature_index for s in specs], dtype=jnp.int32),
            thresholds=jnp.array([s.threshold for s in specs], dtype=jnp.float32),
            pseudo_reward_scales=jnp.array(
                [s.pseudo_reward_scale for s in specs], dtype=jnp.float32
            ),
            max_option_steps=jnp.array([s.max_option_steps for s in specs], dtype=jnp.int32),
        )

    def to_list(self) -> list[SubtaskSpec]:
        """Recover a list of :class:`SubtaskSpec` from this array collection."""
        n = int(self.feature_indices.shape[0])
        return [
            SubtaskSpec(
                feature_index=int(self.feature_indices[i]),
                threshold=float(self.thresholds[i]),
                pseudo_reward_scale=float(self.pseudo_reward_scales[i]),
                max_option_steps=int(self.max_option_steps[i]),
            )
            for i in range(n)
        ]


# ---------------------------------------------------------------------------
# Intra-option policy state (batched over options)
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class IntraOptionPoliciesState:
    """Linear differential Q-policies for all options.

    Weights are stored batched over options so that a single indexed update
    can be expressed as a masked scatter inside ``jax.lax.scan``.

    Attributes:
        q_weights: Shape ``(n_options, n_primitive_actions, observation_dim)``.
        traces: Accumulating eligibility traces; same shape as ``q_weights``.
        average_rewards: Per-option differential reward rates; shape
            ``(n_options,)``.
    """

    q_weights: Float[Array, "n_options n_actions obs_dim"]
    traces: Float[Array, "n_options n_actions obs_dim"]
    average_rewards: Float[Array, " n_options"]


# ---------------------------------------------------------------------------
# Option outcome model state (batched over options)
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class OptionModelsState:
    """Online outcome models for all options.

    Each option model represents the expected multi-step return of executing
    the option from a state, decomposed into:

    * expected cumulative pseudo-reward (EMA over completed option runs),
    * expected option discount ``γ^T`` where ``T`` is the option duration,
    * a linear predictor for the expected next-state delta.

    Attributes:
        cumreward_ema: Shape ``(n_options,)``.  EMA of observed cumulative
            pseudo-reward per option execution.
        discount_ema: Shape ``(n_options,)``.  EMA of ``γ^T`` observed at
            option termination.
        next_state_weights: Shape ``(n_options, obs_dim, obs_dim)``.  Linear
            weights predicting ``Δobs = next_obs - start_obs`` from ``start_obs``.
        n_completions: Shape ``(n_options,)`` int32.  Number of times each
            option has successfully terminated.
    """

    cumreward_ema: Float[Array, " n_options"]
    discount_ema: Float[Array, " n_options"]
    next_state_weights: Float[Array, "n_options obs_dim obs_dim"]
    n_completions: Int[Array, " n_options"]


# ---------------------------------------------------------------------------
# Full STOMP agent state
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class STOMPState:
    """Combined state for the full STOMP agent.

    The base control is a differential Q-function over the *extended*
    action set ``{a_0, …, a_{K-1}, o_0, …, o_{N-1}}`` where K is the number
    of primitive actions and N is the number of options.  When
    ``STOMPConfig.base_hidden_sizes`` is empty the base Q is linear (one head
    per extended action); when non-empty it is a shared-trunk MLP.

    Attributes:
        base_learner_state: Extended Q-function state (MultiHeadMLPLearner
            with ``n_heads = K + N``).
        base_average_reward: Scalar continuing reward rate for base agent.
        base_last_obs: Most recent observation seen by the base agent.
        base_last_action: Last extended action index taken (0..K+N-1).
        rng_key: JAX PRNG key.
        option_policies: Batched intra-option policies.
        option_models: Batched option outcome models.
        executing_option: Scalar int32; −1 means no option is executing.
        option_start_obs: Observation at the start of the current option.
        option_last_intra_action: Primitive action taken on the previous
            intra-option step (for option Q-update).
        option_cumreward: Accumulated pseudo-reward in the current option.
        option_discount: Accumulated discount ``∏ γ`` in current option.
        option_steps: Number of primitive steps taken inside current option.
        step_count: Total primitive steps taken by the agent.
    """

    base_learner_state: MultiHeadMLPState
    base_average_reward: Float[Array, ""]
    base_last_obs: Float[Array, " obs_dim"]
    base_last_action: Int[Array, ""]
    rng_key: Array
    option_policies: IntraOptionPoliciesState
    option_models: OptionModelsState
    executing_option: Int[Array, ""]
    option_start_obs: Float[Array, " obs_dim"]
    option_last_intra_action: Int[Array, ""]
    option_cumreward: Float[Array, ""]
    option_discount: Float[Array, ""]
    option_steps: Int[Array, ""]
    step_count: Int[Array, ""]


# ---------------------------------------------------------------------------
# Update-result types
# ---------------------------------------------------------------------------


@chex.dataclass(frozen=True)
class STOMPUpdateResult:
    """Result of one primitive STOMP transition."""

    state: STOMPState
    td_error: Float[Array, ""]
    average_reward: Float[Array, ""]
    primitive_action: Int[Array, ""]
    executing_option: Int[Array, ""]
    option_terminated: Array
    pseudo_reward: Float[Array, ""]
    option_importance_ratio: Float[Array, ""]


@chex.dataclass(frozen=True)
class STOMPArrayResult:
    """Result of a scan-based STOMP run over transition arrays."""

    state: STOMPState
    td_errors: Float[Array, " num_steps"]
    average_rewards: Float[Array, " num_steps"]
    primitive_actions: Int[Array, " num_steps"]
    executing_options: Int[Array, " num_steps"]
    option_terminations: Array
    pseudo_rewards: Float[Array, " num_steps"]
    option_importance_ratios: Float[Array, " num_steps"]


# ---------------------------------------------------------------------------
# Helper: pseudo-reward and termination conditions
# ---------------------------------------------------------------------------


def compute_pseudo_reward(
    spec_arrays: STOMPSpecArrays,
    option_idx: Array,
    observation: Array,
) -> Float[Array, ""]:
    """Compute pseudo-reward for one option given an observation."""
    feat_idx = spec_arrays.feature_indices[option_idx]
    scale = spec_arrays.pseudo_reward_scales[option_idx]
    return scale * observation[feat_idx]


def check_option_terminated(
    spec_arrays: STOMPSpecArrays,
    option_idx: Array,
    observation: Array,
    option_steps: Array,
) -> Array:
    """Return True if the option should terminate."""
    pseudo_r = compute_pseudo_reward(spec_arrays, option_idx, observation)
    goal_reached = pseudo_r >= spec_arrays.thresholds[option_idx]
    max_exceeded = option_steps >= spec_arrays.max_option_steps[option_idx]
    return goal_reached | max_exceeded


# ---------------------------------------------------------------------------
# Core update functions
# ---------------------------------------------------------------------------


def _q_values_for_obs(q_weights: Array, observation: Array) -> Array:
    """Compute Q(s, ·) = q_weights @ obs for all actions."""
    return q_weights @ observation


def _select_action_epsilon_greedy(
    q_weights: Array,
    observation: Array,
    key: Array,
    epsilon: float,
    n_actions: int,
) -> tuple[Array, Array]:
    """ε-greedy action selection with Gumbel tie-breaking."""
    key, explore_key, noise_key = jr.split(key, 3)
    q_vals = _q_values_for_obs(q_weights, observation)
    greedy = jnp.argmax(q_vals + 1e-6 * jr.gumbel(noise_key, (n_actions,))).astype(
        jnp.int32
    )
    random_action = jr.randint(explore_key, (), 0, n_actions).astype(jnp.int32)
    explore = jr.uniform(key) < jnp.asarray(epsilon, dtype=jnp.float32)
    action = jnp.where(explore, random_action, greedy)
    return action, key


def _select_action_epsilon_greedy_from_q(
    q_vals: Array,
    key: Array,
    epsilon: float,
    n_actions: int,
) -> tuple[Array, Array]:
    """ε-greedy action selection from pre-computed Q values."""
    key, explore_key, noise_key = jr.split(key, 3)
    greedy = jnp.argmax(q_vals + 1e-6 * jr.gumbel(noise_key, (n_actions,))).astype(
        jnp.int32
    )
    random_action = jr.randint(explore_key, (), 0, n_actions).astype(jnp.int32)
    explore = jr.uniform(key) < jnp.asarray(epsilon, dtype=jnp.float32)
    action = jnp.where(explore, random_action, greedy)
    return action, key


def _epsilon_greedy_action_probabilities(q_values: Array, epsilon: Array) -> Array:
    """Return epsilon-greedy probabilities with uniform tie handling."""
    q = jnp.asarray(q_values, dtype=jnp.float32)
    n_actions = q.shape[0]
    eps = jnp.asarray(epsilon, dtype=jnp.float32)
    max_q = jnp.max(q)
    greedy_mask = jnp.isclose(q, max_q, atol=1e-6, rtol=0.0).astype(jnp.float32)
    n_greedy = jnp.maximum(jnp.sum(greedy_mask), jnp.array(1.0, dtype=jnp.float32))
    return eps / n_actions + (1.0 - eps) * greedy_mask / n_greedy


def _clipped_epsilon_greedy_importance_ratio(
    q_weights: Array,
    observation: Array,
    action: Array,
    *,
    behavior_epsilon: float,
    target_epsilon: float,
    clip: float,
) -> Array:
    """Return clipped target/behavior probability ratio for one action."""
    q_values = _q_values_for_obs(q_weights, observation)
    behavior = _epsilon_greedy_action_probabilities(
        q_values,
        jnp.asarray(behavior_epsilon, dtype=jnp.float32),
    )
    target = _epsilon_greedy_action_probabilities(
        q_values,
        jnp.asarray(target_epsilon, dtype=jnp.float32),
    )
    selected_behavior = behavior[action]
    selected_target = target[action]
    ratio = selected_target / jnp.maximum(
        selected_behavior,
        jnp.asarray(1.0e-6, dtype=jnp.float32),
    )
    return jnp.minimum(ratio, jnp.asarray(clip, dtype=jnp.float32))


def _differential_q_update(
    q_weights: Array,
    traces: Array,
    average_reward: Array,
    last_obs: Array,
    last_action: Array,
    reward: Array,
    next_obs: Array,
    *,
    step_size: float,
    avg_reward_step_size: float,
    trace_decay: float,
    n_actions: int,
) -> tuple[Array, Array, Array, Array]:
    """One differential SARSA Q-update step.

    Returns (new_q_weights, new_traces, new_average_reward, td_error).
    """
    alpha = jnp.asarray(step_size, dtype=jnp.float32)
    beta = jnp.asarray(avg_reward_step_size, dtype=jnp.float32)
    lam = jnp.asarray(trace_decay, dtype=jnp.float32)

    q_prev = q_weights[last_action] @ last_obs
    q_next = jnp.max(_q_values_for_obs(q_weights, next_obs))
    td_error = reward - average_reward + q_next - q_prev

    action_mask = jax.nn.one_hot(last_action, n_actions, dtype=jnp.float32)
    new_traces = lam * traces + action_mask[:, None] * last_obs[None, :]
    delta_w = alpha * td_error * new_traces
    new_q_weights = q_weights + delta_w
    new_average_reward = average_reward + beta * td_error
    return new_q_weights, new_traces, new_average_reward, td_error


def _differential_semidp_q_update(
    q_weights: Array,
    traces: Array,
    average_reward: Array,
    last_obs: Array,
    last_action: Array,
    reward: Array,
    next_obs: Array,
    *,
    step_size: float,
    avg_reward_step_size: float,
    trace_decay: float,
    n_actions: int,
    duration: Array,
    discount: Array,
) -> tuple[Array, Array, Array, Array]:
    """Differential Q-update supporting semi-MDP option returns.

    Extends :func:`_differential_q_update` to correctly account for
    multi-step option duration and cumulative discount:

    .. code-block::

        td = R_o - avg_r * T_o + γ_o * V(s') - Q(s, o)

    For primitive steps pass ``duration=1, discount=1`` to recover the
    standard single-step update exactly.

    Args:
        duration: Effective number of primitive steps the option ran (T_o).
            ``1`` for primitive actions.
        discount: Cumulative per-step discount across the option (γ^{T_o}).
            ``1.0`` for primitive actions.

    Returns:
        ``(new_q_weights, new_traces, new_average_reward, td_error)``.
    """
    alpha = jnp.asarray(step_size, dtype=jnp.float32)
    beta = jnp.asarray(avg_reward_step_size, dtype=jnp.float32)
    lam = jnp.asarray(trace_decay, dtype=jnp.float32)
    t_o = jnp.asarray(duration, dtype=jnp.float32)
    gamma_o = jnp.asarray(discount, dtype=jnp.float32)

    q_prev = q_weights[last_action] @ last_obs
    q_next = jnp.max(_q_values_for_obs(q_weights, next_obs))
    # Semi-MDP Bellman target: deduct avg_r for t_o steps, scale V(s') by γ_o
    td_error = reward - average_reward * t_o + gamma_o * q_next - q_prev

    action_mask = jax.nn.one_hot(last_action, n_actions, dtype=jnp.float32)
    new_traces = lam * traces + action_mask[:, None] * last_obs[None, :]
    delta_w = alpha * td_error * new_traces
    new_q_weights = q_weights + delta_w
    new_average_reward = average_reward + beta * td_error
    return new_q_weights, new_traces, new_average_reward, td_error


def _update_option_model(
    models: OptionModelsState,
    option_idx: Array,
    start_obs: Array,
    cumreward: Array,
    discount: Array,
    end_obs: Array,
    *,
    model_decay: float,
    model_step_size: float,
) -> OptionModelsState:
    """Update the model for one option from a completed trajectory."""
    decay = jnp.asarray(model_decay, dtype=jnp.float32)
    lr = jnp.asarray(model_step_size, dtype=jnp.float32)

    new_cumreward = decay * models.cumreward_ema + (1.0 - decay) * cumreward
    new_discount = decay * models.discount_ema + (1.0 - decay) * discount

    predicted_delta = models.next_state_weights[option_idx] @ start_obs
    actual_delta = end_obs - start_obs
    delta_error = actual_delta - predicted_delta
    ns_update = lr * jnp.outer(delta_error, start_obs)

    mask = (jnp.arange(models.cumreward_ema.shape[0], dtype=jnp.int32) == option_idx).astype(
        jnp.float32
    )
    new_ns_weights = models.next_state_weights + mask[:, None, None] * ns_update[None, :, :]
    new_completions = models.n_completions + mask.astype(jnp.int32)

    return OptionModelsState(
        cumreward_ema=jnp.where(mask, new_cumreward, models.cumreward_ema),
        discount_ema=jnp.where(mask, new_discount, models.discount_ema),
        next_state_weights=new_ns_weights,
        n_completions=new_completions,
    )


def _update_intra_option_policy(
    option_policies: IntraOptionPoliciesState,
    option_idx: Array,
    last_obs: Array,
    last_intra_action: Array,
    pseudo_reward: Array,
    next_obs: Array,
    terminated: Array,
    *,
    step_size: float,
    avg_reward_step_size: float,
    trace_decay: float,
    n_primitive_actions: int,
    importance_ratio: Array,
) -> tuple[IntraOptionPoliciesState, Array]:
    """Update the intra-option Q-function for one option."""
    q_i = option_policies.q_weights[option_idx]
    traces_i = option_policies.traces[option_idx]
    avg_r_i = option_policies.average_rewards[option_idx]
    terminal_discount = jnp.where(terminated, 0.0, 1.0).astype(jnp.float32)

    q_prev = q_i[last_intra_action] @ last_obs
    q_next = jnp.max(_q_values_for_obs(q_i, next_obs)) * terminal_discount
    td_error = pseudo_reward - avg_r_i + q_next - q_prev

    alpha = jnp.asarray(step_size, dtype=jnp.float32)
    beta = jnp.asarray(avg_reward_step_size, dtype=jnp.float32)
    lam = jnp.asarray(trace_decay, dtype=jnp.float32) * terminal_discount
    rho = jnp.asarray(importance_ratio, dtype=jnp.float32)

    action_mask = jax.nn.one_hot(last_intra_action, n_primitive_actions, dtype=jnp.float32)
    new_traces_i = rho * (lam * traces_i + action_mask[:, None] * last_obs[None, :])
    new_q_i = q_i + alpha * td_error * new_traces_i
    new_avg_r_i = avg_r_i + beta * rho * td_error

    n_opts = option_policies.average_rewards.shape[0]
    option_mask = jnp.arange(n_opts, dtype=jnp.int32) == option_idx

    new_q_weights = option_policies.q_weights.at[option_idx].set(new_q_i)
    new_traces = option_policies.traces.at[option_idx].set(new_traces_i)
    new_avg_rewards = jnp.where(option_mask, new_avg_r_i, option_policies.average_rewards)

    return IntraOptionPoliciesState(
        q_weights=new_q_weights,
        traces=new_traces,
        average_rewards=new_avg_rewards,
    ), td_error


# ---------------------------------------------------------------------------
# Configuration (Python-level, not a JAX type)
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class STOMPConfig:
    """Configuration for the STOMP agent.

    Args:
        subtask_specs: List of subtask specifications (one per option).
        observation_dim: Flat observation dimensionality.
        n_primitive_actions: Number of primitive discrete actions.
        base_step_size: Step-size for the base extended Q-function.
        base_avg_reward_step_size: Average-reward rate step-size for base.
        base_trace_decay: Eligibility trace decay for the base agent.
        option_step_size: Step-size for intra-option Q-functions.
        option_avg_reward_step_size: Per-option average-reward rate step-size.
        option_trace_decay: Trace decay for intra-option Q-functions.
        option_gamma: Discount within option execution.
        option_model_decay: EMA decay for option outcome model updates.
        option_model_step_size: Step-size for next-state delta predictor.
        epsilon_base: Exploration rate for the base extended action selection.
        epsilon_option: Exploration rate for intra-option action selection.
    """

    subtask_specs: tuple[SubtaskSpec, ...] = ()
    observation_dim: int = 4
    n_primitive_actions: int = 2
    base_step_size: float = 0.05
    base_avg_reward_step_size: float = 0.01
    base_trace_decay: float = 0.0
    base_hidden_sizes: tuple[int, ...] = ()
    option_step_size: float = 0.05
    option_avg_reward_step_size: float = 0.01
    option_trace_decay: float = 0.0
    option_gamma: float = 0.99
    option_model_decay: float = 0.95
    option_model_step_size: float = 0.1
    epsilon_base: float = 0.1
    epsilon_option: float = 0.1
    option_target_epsilon: float | None = None
    option_importance_clip: float = 10.0

    def __post_init__(self) -> None:
        """Validate configuration."""
        if self.observation_dim <= 0:
            raise ValueError("observation_dim must be positive")
        if self.n_primitive_actions <= 0:
            raise ValueError("n_primitive_actions must be positive")
        for spec in self.subtask_specs:
            if spec.feature_index >= self.observation_dim:
                raise ValueError(
                    f"SubtaskSpec.feature_index={spec.feature_index} >= "
                    f"observation_dim={self.observation_dim}"
                )
        if self.option_target_epsilon is not None and not (
            0.0 <= self.option_target_epsilon <= 1.0
        ):
            raise ValueError("option_target_epsilon must be in [0, 1] when provided")
        if self.option_importance_clip <= 0.0:
            raise ValueError("option_importance_clip must be positive")

    @property
    def n_options(self) -> int:
        """Number of options."""
        return len(self.subtask_specs)

    @property
    def n_total_actions(self) -> int:
        """Total extended action count (primitive + options)."""
        return self.n_primitive_actions + self.n_options

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dictionary."""
        return {
            "type": "STOMPConfig",
            "subtask_specs": [
                dataclasses.asdict(s) for s in self.subtask_specs
            ],
            "observation_dim": self.observation_dim,
            "n_primitive_actions": self.n_primitive_actions,
            "base_step_size": self.base_step_size,
            "base_avg_reward_step_size": self.base_avg_reward_step_size,
            "base_trace_decay": self.base_trace_decay,
            "base_hidden_sizes": list(self.base_hidden_sizes),
            "option_step_size": self.option_step_size,
            "option_avg_reward_step_size": self.option_avg_reward_step_size,
            "option_trace_decay": self.option_trace_decay,
            "option_gamma": self.option_gamma,
            "option_model_decay": self.option_model_decay,
            "option_model_step_size": self.option_model_step_size,
            "epsilon_base": self.epsilon_base,
            "epsilon_option": self.epsilon_option,
            "option_target_epsilon": self.option_target_epsilon,
            "option_importance_clip": self.option_importance_clip,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> STOMPConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        specs_raw = payload.pop("subtask_specs", [])
        specs = tuple(SubtaskSpec(**s) for s in specs_raw)
        if "base_hidden_sizes" in payload:
            payload["base_hidden_sizes"] = tuple(payload["base_hidden_sizes"])
        return cls(subtask_specs=specs, **payload)


# ---------------------------------------------------------------------------
# STOMP agent
# ---------------------------------------------------------------------------


class STOMPAgent:
    """Alberta Plan Step 10 STOMP agent.

    Combines a continuing base control agent (extended Q over primitive and
    option actions) with N intra-option policies and N option outcome models,
    one per :class:`SubtaskSpec`.

    The base agent uses differential Q-learning (average-reward formulation)
    over the extended action set.  Intra-option policies similarly use
    differential Q-learning with subtask pseudo-rewards.  Option models are
    updated online after each option termination.
    """

    def __init__(self, config: STOMPConfig):
        """Initialize the STOMP agent with a given configuration."""
        if config.n_options == 0:
            raise ValueError("STOMPAgent requires at least one subtask/option")
        self._config = config
        self._spec_arrays = STOMPSpecArrays.from_specs(list(config.subtask_specs))
        self._base_learner = MultiHeadMLPLearner(
            n_heads=config.n_total_actions,
            hidden_sizes=config.base_hidden_sizes,
            step_size=config.base_step_size,
            gamma=0.0,
            lamda=0.0,
            per_head_gamma_lamda=(config.base_trace_decay,) * config.n_total_actions,
            sparsity=0.0,
        )

    @property
    def config(self) -> STOMPConfig:
        """Agent configuration."""
        return self._config

    @property
    def spec_arrays(self) -> STOMPSpecArrays:
        """JAX arrays derived from subtask specifications."""
        return self._spec_arrays

    @property
    def base_learner(self) -> MultiHeadMLPLearner:
        """Underlying base Q-function learner."""
        return self._base_learner

    def base_q_values(self, state: STOMPState, observation: Array) -> Array:
        """Compute Q-values for all extended actions from a STOMPState."""
        return self._base_learner.predict(state.base_learner_state, observation)

    def to_config(self) -> dict[str, Any]:
        """Serialize agent configuration."""
        return self._config.to_config()

    def init(self, key: Array) -> STOMPState:
        """Initialize agent state for a given observation dimensionality."""
        obs_dim = self._config.observation_dim
        n_prim = self._config.n_primitive_actions
        n_opt = self._config.n_options

        policy_key, learner_key, option_key = jr.split(key, 3)
        scale = 0.01
        base_learner_state = self._base_learner.init(obs_dim, learner_key)
        option_q_weights = scale * jr.normal(
            option_key, (n_opt, n_prim, obs_dim), dtype=jnp.float32
        )

        obs_zero = jnp.zeros(obs_dim, dtype=jnp.float32)
        return STOMPState(
            base_learner_state=base_learner_state,
            base_average_reward=jnp.array(0.0, dtype=jnp.float32),
            base_last_obs=obs_zero,
            base_last_action=jnp.array(0, dtype=jnp.int32),
            rng_key=policy_key,
            option_policies=IntraOptionPoliciesState(
                q_weights=option_q_weights,
                traces=jnp.zeros((n_opt, n_prim, obs_dim), dtype=jnp.float32),
                average_rewards=jnp.zeros(n_opt, dtype=jnp.float32),
            ),
            option_models=OptionModelsState(
                cumreward_ema=jnp.zeros(n_opt, dtype=jnp.float32),
                discount_ema=jnp.ones(n_opt, dtype=jnp.float32),
                next_state_weights=jnp.zeros((n_opt, obs_dim, obs_dim), dtype=jnp.float32),
                n_completions=jnp.zeros(n_opt, dtype=jnp.int32),
            ),
            executing_option=jnp.array(-1, dtype=jnp.int32),
            option_start_obs=obs_zero,
            option_last_intra_action=jnp.array(0, dtype=jnp.int32),
            option_cumreward=jnp.array(0.0, dtype=jnp.float32),
            option_discount=jnp.array(1.0, dtype=jnp.float32),
            option_steps=jnp.array(0, dtype=jnp.int32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def start(self, state: STOMPState, initial_observation: Array) -> STOMPState:
        """Prime the agent with an initial observation before the first update."""
        obs = jnp.asarray(initial_observation, dtype=jnp.float32).reshape(
            (self._config.observation_dim,)
        )
        key = state.rng_key
        q_vals = self._base_learner.predict(state.base_learner_state, obs)
        action, key = _select_action_epsilon_greedy_from_q(
            q_vals, key, self._config.epsilon_base, self._config.n_total_actions
        )
        return cast(
            STOMPState,
            state.replace(
                base_last_obs=obs,
                base_last_action=action,
                rng_key=key,
            ),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: STOMPState,
        env_reward: Array,
        next_observation: Array,
    ) -> STOMPUpdateResult:
        """Process one real-time transition update.

        The function:

        1. Determines whether an option is currently executing.
        2. If executing: advances the intra-option policy and checks termination.
           On termination, updates the option outcome model and base Q-function
           using the accumulated option return.
        3. If not executing: updates the base Q-function and selects the next
           extended action (primitive or option).
        4. Returns diagnostics for logging.
        """
        cfg = self._config
        spec = self._spec_arrays
        obs = jnp.asarray(next_observation, dtype=jnp.float32).reshape(
            (cfg.observation_dim,)
        )
        reward = jnp.asarray(env_reward, dtype=jnp.float32)

        is_executing = state.executing_option >= 0
        option_idx = jnp.maximum(state.executing_option, jnp.array(0, dtype=jnp.int32))

        # Compute pseudo-reward for the currently-executing (or notional) option
        pseudo_r = compute_pseudo_reward(spec, option_idx, obs)
        target_epsilon = (
            cfg.epsilon_option
            if cfg.option_target_epsilon is None
            else cfg.option_target_epsilon
        )
        option_importance_ratio = _clipped_epsilon_greedy_importance_ratio(
            state.option_policies.q_weights[option_idx],
            state.base_last_obs,
            state.option_last_intra_action,
            behavior_epsilon=cfg.epsilon_option,
            target_epsilon=target_epsilon,
            clip=cfg.option_importance_clip,
        )

        # Option termination check
        new_option_steps = state.option_steps + 1
        option_terminates = check_option_terminated(spec, option_idx, obs, new_option_steps)

        # --- Intra-option policy update (only active when executing) ---
        new_option_policies, option_td = _update_intra_option_policy(
            state.option_policies,
            option_idx,
            state.base_last_obs,
            state.option_last_intra_action,
            pseudo_r,
            obs,
            option_terminates,
            step_size=cfg.option_step_size,
            avg_reward_step_size=cfg.option_avg_reward_step_size,
            trace_decay=cfg.option_trace_decay,
            n_primitive_actions=cfg.n_primitive_actions,
            importance_ratio=option_importance_ratio,
        )

        # Accumulate option trajectory stats
        new_option_cumreward = state.option_cumreward + pseudo_r
        new_option_discount = state.option_discount * jnp.asarray(cfg.option_gamma, jnp.float32)

        # --- Option model update (only on termination while executing) ---
        should_update_model = is_executing & option_terminates

        def do_update_model(_: None) -> OptionModelsState:
            return _update_option_model(
                state.option_models,
                option_idx,
                state.option_start_obs,
                new_option_cumreward,
                new_option_discount,
                obs,
                model_decay=cfg.option_model_decay,
                model_step_size=cfg.option_model_step_size,
            )

        def skip_update_model(_: None) -> OptionModelsState:
            return state.option_models

        new_option_models = jax.lax.cond(
            should_update_model, do_update_model, skip_update_model, None
        )

        # --- Base Q-function update ---
        # Use environment reward when primitive; use option pseudo-reward when option terminates.
        base_reward = jnp.where(
            is_executing & option_terminates,
            new_option_cumreward,
            reward,
        )
        # Semi-MDP corrections: duration=T_o, discount=γ_o for option termination;
        # duration=1, discount=1.0 for primitive steps (recovers standard update).
        base_duration = jnp.where(
            is_executing & option_terminates,
            jnp.asarray(new_option_steps, dtype=jnp.float32),
            jnp.array(1.0, dtype=jnp.float32),
        )
        base_discount = jnp.where(
            is_executing & option_terminates,
            new_option_discount,
            jnp.array(1.0, dtype=jnp.float32),
        )
        # Only update base Q on: (a) primitive steps, or (b) option termination
        should_update_base = (~is_executing) | (is_executing & option_terminates)
        n_total = cfg.n_total_actions
        beta = jnp.asarray(cfg.base_avg_reward_step_size, dtype=jnp.float32)

        def do_base_update(_: None) -> tuple[MultiHeadMLPState, Array, Array]:
            next_q_vals = self._base_learner.predict(state.base_learner_state, obs)
            max_next_q = base_discount * jnp.max(next_q_vals)
            td_target = base_reward - state.base_average_reward * base_duration + max_next_q
            targets = jnp.full(n_total, jnp.nan, dtype=jnp.float32).at[
                state.base_last_action
            ].set(td_target)
            result = self._base_learner.update(
                state.base_learner_state, state.base_last_obs, targets
            )
            td_err = result.errors[state.base_last_action]
            new_avg_reward = state.base_average_reward + beta * td_err
            return result.state, new_avg_reward, td_err

        def skip_base_update(_: None) -> tuple[MultiHeadMLPState, Array, Array]:
            prev_q = self._base_learner.predict(
                state.base_learner_state, state.base_last_obs
            )
            next_q = self._base_learner.predict(state.base_learner_state, obs)
            td = jnp.max(next_q) - prev_q[state.base_last_action]
            return state.base_learner_state, state.base_average_reward, td

        new_base_learner_state, new_avg_r, base_td = jax.lax.cond(
            should_update_base, do_base_update, skip_base_update, None
        )

        # --- Select next extended action ---
        # After primitive or option termination: select from extended action space.
        # During option execution (not terminating): use intra-option policy.
        key = state.rng_key
        key, ext_key, intra_key = jr.split(key, 3)

        ext_q_vals = self._base_learner.predict(new_base_learner_state, obs)
        extended_action, _ = _select_action_epsilon_greedy_from_q(
            ext_q_vals, ext_key, cfg.epsilon_base, cfg.n_total_actions
        )
        intra_action, _ = _select_action_epsilon_greedy(
            new_option_policies.q_weights[option_idx],
            obs,
            intra_key,
            cfg.epsilon_option,
            cfg.n_primitive_actions,
        )

        next_select_extended = (~is_executing) | (is_executing & option_terminates)

        # The actual primitive action dispatched to the environment:
        # If primitive extended action: use extended_action directly.
        # If option extended action: use intra-option policy action.
        new_executing_option = jnp.where(
            is_executing & (~option_terminates),
            option_idx,
            jnp.where(
                next_select_extended
                & (extended_action >= jnp.asarray(cfg.n_primitive_actions, jnp.int32)),
                extended_action - cfg.n_primitive_actions,
                jnp.array(-1, dtype=jnp.int32),
            ),
        )
        is_starting_option = (
            next_select_extended
            & (extended_action >= jnp.asarray(cfg.n_primitive_actions, jnp.int32))
        )

        # Primitive action sent to environment
        primitive_action = jnp.where(
            is_starting_option | (is_executing & (~option_terminates)),
            intra_action,
            extended_action,
        )
        primitive_action = jnp.minimum(
            primitive_action,
            jnp.asarray(cfg.n_primitive_actions - 1, dtype=jnp.int32),
        )

        # Reset option tracking on termination or new option start
        new_option_start_obs = jnp.where(is_starting_option, obs, state.option_start_obs)
        new_option_cumreward = jnp.where(
            (is_executing & option_terminates) | is_starting_option,
            jnp.array(0.0, dtype=jnp.float32),
            new_option_cumreward,
        )
        new_option_discount = jnp.where(
            (is_executing & option_terminates) | is_starting_option,
            jnp.array(1.0, dtype=jnp.float32),
            new_option_discount,
        )
        new_option_steps = jnp.where(
            (is_executing & option_terminates) | is_starting_option,
            jnp.array(0, dtype=jnp.int32),
            new_option_steps,
        )

        new_state = STOMPState(
            base_learner_state=new_base_learner_state,
            base_average_reward=new_avg_r,
            base_last_obs=obs,
            base_last_action=jnp.where(
                next_select_extended, extended_action, state.base_last_action
            ),
            rng_key=key,
            option_policies=new_option_policies,
            option_models=new_option_models,
            executing_option=new_executing_option,
            option_start_obs=new_option_start_obs,
            option_last_intra_action=jnp.where(
                is_executing & (~option_terminates),
                intra_action,
                state.option_last_intra_action,
            ),
            option_cumreward=new_option_cumreward,
            option_discount=new_option_discount,
            option_steps=new_option_steps,
            step_count=state.step_count + 1,
        )
        return STOMPUpdateResult(
            state=new_state,
            td_error=base_td,
            average_reward=new_avg_r,
            primitive_action=primitive_action,
            executing_option=new_executing_option,
            option_terminated=is_executing & option_terminates,
            pseudo_reward=jnp.where(is_executing, pseudo_r, jnp.array(0.0, dtype=jnp.float32)),
            option_importance_ratio=option_importance_ratio,
        )

    def scan(
        self,
        state: STOMPState,
        env_rewards: Array,
        next_observations: Array,
    ) -> STOMPArrayResult:
        """Run STOMP over pre-collected continuing transition arrays via scan."""

        def step_fn(
            carry: STOMPState,
            inputs: tuple[Array, Array],
        ) -> tuple[STOMPState, tuple[Array, ...]]:
            reward, next_obs = inputs
            result = self.update(carry, reward, next_obs)
            return result.state, (
                result.td_error,
                result.average_reward,
                result.primitive_action,
                result.executing_option,
                result.option_terminated,
                result.pseudo_reward,
                result.option_importance_ratio,
            )

        final_state, (
            td_errors,
            average_rewards,
            primitive_actions,
            executing_options,
            option_terminations,
            pseudo_rewards,
            option_importance_ratios,
        ) = jax.lax.scan(step_fn, state, (env_rewards, next_observations))
        return STOMPArrayResult(
            state=final_state,
            td_errors=td_errors,
            average_rewards=average_rewards,
            primitive_actions=primitive_actions,
            executing_options=executing_options,
            option_terminations=option_terminations,
            pseudo_rewards=pseudo_rewards,
            option_importance_ratios=option_importance_ratios,
        )


def subtasks_from_feature_scores(
    feature_scores: Float[Array, " feature_dim"] | list[float],
    *,
    top_k: int = 2,
    threshold: float = 0.5,
    pseudo_reward_scale: float = 1.0,
    max_option_steps: int = 16,
    min_score: float = 0.0,
) -> list[SubtaskSpec]:
    """Create SubtaskSpecs for the top-K highest-scoring features.

    This is the auto-discovery pathway for Step 10 STOMP: instead of
    hand-specifying subtasks, caller computes a per-feature relevance score
    (e.g. from ``compute_feature_relevance``) and this function converts the
    top-ranked features into ``SubtaskSpec`` objects.

    The feature scores may come from any source:
    - ``jnp.sum(relevance.weight_relevance, axis=0)`` for path-norm relevance
    - Per-head weight norms for a specific prediction target
    - Domain-specific utility signal

    Args:
        feature_scores: 1-D array or list of per-feature importance scores.
            Higher score = more relevant feature → higher-priority subtask.
        top_k: Number of subtasks to create. Selects features with the
            ``top_k`` highest scores.
        threshold: Pseudo-reward threshold for subtask completion. The option
            terminates when ``pseudo_reward_scale * obs[feature_index] >= threshold``.
        pseudo_reward_scale: Multiplier for the feature value in the
            pseudo-reward signal.
        max_option_steps: Maximum primitive steps per option execution.
        min_score: Features with score below this value are excluded even if
            they would otherwise be in the top-K. Set to 0.0 to keep all.

    Returns:
        List of up to ``top_k`` :class:`SubtaskSpec` objects sorted by
        descending feature score. May be shorter than ``top_k`` if fewer
        features exceed ``min_score``.

    Example:
        Build subtasks from a HordeLearner's weight relevance::

            relevance = compute_feature_relevance(horde_state.learner_state)
            agg_scores = jnp.sum(relevance.weight_relevance, axis=0)
            specs = subtasks_from_feature_scores(agg_scores, top_k=3)
            stomp_config = Step10STOMPConfig(subtask_specs=tuple(specs), ...)
    """
    import numpy as _np

    scores = _np.asarray(feature_scores, dtype=_np.float32)
    eligible = [i for i in range(len(scores)) if float(scores[i]) >= min_score]
    eligible.sort(key=lambda i: float(scores[i]), reverse=True)
    selected = eligible[:top_k]

    return [
        SubtaskSpec(
            feature_index=int(i),
            threshold=threshold,
            pseudo_reward_scale=pseudo_reward_scale,
            max_option_steps=max_option_steps,
        )
        for i in selected
    ]


__all__ = [
    "IntraOptionPoliciesState",
    "OptionModelsState",
    "STOMPAgent",
    "STOMPArrayResult",
    "STOMPConfig",
    "STOMPSpecArrays",
    "STOMPState",
    "STOMPUpdateResult",
    "SubtaskSpec",
    "check_option_terminated",
    "compute_pseudo_reward",
    "subtasks_from_feature_scores",
]
