# mypy: disable-error-code="attr-defined,call-arg"
"""Production-facing Step 10 STOMP facade.

Step 10 of the Alberta Plan introduces the STOMP progression: SubTasks,
Options, Models, Planning.  This is the first step that enables temporal
abstraction — the agent can execute temporally extended actions (options)
defined by feature-reaching subtasks, learn multi-step outcome models for
each option, and plan at the option level.

Architecture:

* **Subtasks** — Feature-reaching sub-problems with pseudo-rewards.
  Each subtask defines one option.
* **Options** — Temporally extended actions.  Each option has its own
  intra-option differential Q-policy trained with subtask pseudo-rewards.
* **Models** — Per-option outcome models tracking cumulative pseudo-reward,
  expected discount, and next-state delta prediction.  Updated at option
  termination.
* **Planning** — The base agent acts over the extended action space
  {primitives, options}.  When an option is selected, its intra-option
  policy drives primitive actions until the option terminates.

The base control is a linear differential Q-function (average-reward
formulation) over the extended action set, exactly as in Step 6.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Sutton, Precup, & Singh (1999). "Between MDPs and semi-MDPs: A Framework
        for Temporal Abstraction in Reinforcement Learning."
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, cast

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.options import (
    STOMPAgent,
    STOMPArrayResult,
    STOMPConfig,
    STOMPState,
    STOMPUpdateResult,
    SubtaskSpec,
)


@dataclass(frozen=True)
class Step10STOMPConfig:
    """Configuration for the production Step 10 STOMP facade.

    This thin wrapper around :class:`STOMPConfig` adds standard
    dict serialization consistent with the Step 1–9 facades.

    Args:
        subtask_specs: Feature-reaching subtask definitions.  Each entry
            becomes one option.  At least one entry is required at runtime.
        observation_dim: Flat observation dimensionality.
        n_primitive_actions: Number of primitive discrete actions.
        base_step_size: Step-size for the extended base Q-function.
        base_avg_reward_step_size: Average-reward rate step-size for base.
        base_trace_decay: Eligibility trace decay for the base agent.
        option_step_size: Step-size for intra-option Q-functions.
        option_avg_reward_step_size: Per-option average-reward step-size.
        option_trace_decay: Trace decay for intra-option Q-functions.
        option_gamma: Discount within option execution.
        option_model_decay: EMA decay for option outcome model updates.
        option_model_step_size: Step-size for next-state delta predictor.
        epsilon_base: Exploration rate for extended action selection.
        epsilon_option: Exploration rate for intra-option action selection.
        option_target_epsilon: Optional target-policy epsilon for clipped
            intra-option importance sampling. ``None`` matches
            ``epsilon_option`` and recovers on-policy updates.
        option_importance_clip: Maximum per-decision target/behavior ratio for
            intra-option updates.
    """

    subtask_specs: tuple[SubtaskSpec, ...] = ()
    observation_dim: int = 4
    n_primitive_actions: int = 2
    base_step_size: float = 0.05
    base_avg_reward_step_size: float = 0.01
    base_trace_decay: float = 0.0
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

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        payload: dict[str, Any] = {
            "type": "Step10STOMPConfig",
            "subtask_specs": [asdict(s) for s in self.subtask_specs],
            "observation_dim": self.observation_dim,
            "n_primitive_actions": self.n_primitive_actions,
            "base_step_size": self.base_step_size,
            "base_avg_reward_step_size": self.base_avg_reward_step_size,
            "base_trace_decay": self.base_trace_decay,
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
        return payload

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> Step10STOMPConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        specs_raw = data.pop("subtask_specs", [])
        specs = tuple(SubtaskSpec(**s) for s in specs_raw)
        return cls(subtask_specs=specs, **data)

    def to_stomp_config(self) -> STOMPConfig:
        """Convert to the core :class:`STOMPConfig`."""
        return STOMPConfig(
            subtask_specs=self.subtask_specs,
            observation_dim=self.observation_dim,
            n_primitive_actions=self.n_primitive_actions,
            base_step_size=self.base_step_size,
            base_avg_reward_step_size=self.base_avg_reward_step_size,
            base_trace_decay=self.base_trace_decay,
            option_step_size=self.option_step_size,
            option_avg_reward_step_size=self.option_avg_reward_step_size,
            option_trace_decay=self.option_trace_decay,
            option_gamma=self.option_gamma,
            option_model_decay=self.option_model_decay,
            option_model_step_size=self.option_model_step_size,
            epsilon_base=self.epsilon_base,
            epsilon_option=self.epsilon_option,
            option_target_epsilon=self.option_target_epsilon,
            option_importance_clip=self.option_importance_clip,
        )


@dataclass(frozen=True)
class Step10SmokeResult:
    """Summary returned by :func:`run_step10_smoke`."""

    config: Step10STOMPConfig
    steps: int
    seed: int
    td_errors_shape: tuple[int, ...]
    average_rewards_shape: tuple[int, ...]
    primitive_actions_shape: tuple[int, ...]
    executing_options_shape: tuple[int, ...]
    pseudo_rewards_shape: tuple[int, ...]
    finite: bool
    option_termination_count: int
    agent_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "config": self.config.to_config(),
            "steps": self.steps,
            "seed": self.seed,
            "td_errors_shape": list(self.td_errors_shape),
            "average_rewards_shape": list(self.average_rewards_shape),
            "primitive_actions_shape": list(self.primitive_actions_shape),
            "executing_options_shape": list(self.executing_options_shape),
            "pseudo_rewards_shape": list(self.pseudo_rewards_shape),
            "finite": self.finite,
            "option_termination_count": self.option_termination_count,
            "agent_config": self.agent_config,
        }


def make_step10_stomp_agent(config: Step10STOMPConfig | None = None) -> STOMPAgent:
    """Create a :class:`STOMPAgent` from a :class:`Step10STOMPConfig`.

    Args:
        config: Step 10 configuration.  Defaults to
            :class:`Step10STOMPConfig` with one default subtask if *None*.

    Returns:
        Initialized :class:`STOMPAgent`.
    """
    if config is None:
        config = Step10STOMPConfig(
            subtask_specs=(SubtaskSpec(feature_index=0),),
        )
    return STOMPAgent(config.to_stomp_config())


def init_step10_state(
    agent: STOMPAgent,
    *,
    key: Array,
    initial_observation: Array,
) -> STOMPState:
    """Initialize and prime the Step 10 STOMP state.

    Args:
        agent: The :class:`STOMPAgent` to initialize.
        key: JAX PRNG key.
        initial_observation: First real observation from the environment.
            Shape must match ``agent.config.observation_dim``.

    Returns:
        Primed :class:`STOMPState` with ``base_last_obs`` set.
    """
    init_key, start_key = jr.split(key)
    state = agent.init(init_key)
    obs = jnp.asarray(initial_observation, dtype=jnp.float32)
    return cast(STOMPState, agent.start(state, obs))


def step10_update(
    agent: STOMPAgent,
    state: STOMPState,
    env_reward: Array,
    next_observation: Array,
) -> STOMPUpdateResult:
    """Run one real-time STOMP transition.

    Delegates directly to :meth:`STOMPAgent.update`.

    Args:
        agent: The STOMP agent.
        state: Current agent state.
        env_reward: Scalar environment reward.
        next_observation: Next real observation from the environment.

    Returns:
        :class:`STOMPUpdateResult` containing the new state and diagnostics.
    """
    return cast(STOMPUpdateResult, agent.update(state, env_reward, next_observation))


def run_step10_scan(
    agent: STOMPAgent,
    state: STOMPState,
    rewards: Array,
    next_observations: Array,
) -> STOMPArrayResult:
    """Run the STOMP agent over pre-collected continuing transition arrays.

    JIT-compiled via :meth:`STOMPAgent.scan` / ``jax.lax.scan``.

    Args:
        agent: The STOMP agent.
        state: Starting agent state.
        rewards: Shape ``(T,)`` float32 environment rewards.
        next_observations: Shape ``(T, obs_dim)`` float32 observations.

    Returns:
        :class:`STOMPArrayResult` with per-step diagnostics arrays.
    """
    return agent.scan(state, rewards, next_observations)


def run_step10_smoke(
    config: Step10STOMPConfig | None = None,
    *,
    steps: int = 64,
    seed: int = 0,
) -> Step10SmokeResult:
    """Run a deterministic Step 10 STOMP integration probe.

    Generates a random stream, runs the STOMP scan, and verifies that all
    outputs are finite and correctly shaped.

    Args:
        config: Step 10 configuration.  Defaults to one subtask on feature 0.
        steps: Number of transition steps to run.
        seed: PRNG seed for reproducibility.

    Returns:
        :class:`Step10SmokeResult` with shape/fineness summary.
    """
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config
    if cfg is None:
        cfg = Step10STOMPConfig(
            subtask_specs=(SubtaskSpec(feature_index=0),),
        )

    agent = make_step10_stomp_agent(cfg)
    obs_dim = cfg.observation_dim

    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(data_key, (steps + 1, obs_dim), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])

    state = init_step10_state(agent, key=state_key, initial_observation=observations[0])
    result = run_step10_scan(agent, state, rewards, observations[1:])
    result.td_errors.block_until_ready()

    finite = bool(
        jnp.all(jnp.isfinite(result.td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
        & jnp.all(jnp.isfinite(result.pseudo_rewards))
        & jnp.all(result.primitive_actions >= 0)
        & jnp.all(result.primitive_actions < cfg.n_primitive_actions)
    )

    return Step10SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        td_errors_shape=tuple(int(d) for d in result.td_errors.shape),
        average_rewards_shape=tuple(int(d) for d in result.average_rewards.shape),
        primitive_actions_shape=tuple(int(d) for d in result.primitive_actions.shape),
        executing_options_shape=tuple(int(d) for d in result.executing_options.shape),
        pseudo_rewards_shape=tuple(int(d) for d in result.pseudo_rewards.shape),
        finite=finite,
        option_termination_count=int(jnp.sum(result.option_terminations)),
        agent_config=agent.to_config(),
    )


__all__ = [
    "Step10SmokeResult",
    "Step10STOMPConfig",
    "init_step10_state",
    "make_step10_stomp_agent",
    "run_step10_scan",
    "run_step10_smoke",
    "step10_update",
]
