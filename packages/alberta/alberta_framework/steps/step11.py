# mypy: disable-error-code="attr-defined,call-arg"
"""Production-facing Step 11 OaK facade.

Step 11 of the Alberta Plan introduces the OaK (Options and Knowledge)
architecture.  OaK extends the STOMP progression from Step 10 with three
additional mechanisms:

1. **Utility tracking** — online EMA utility scores for each option.
2. **Curation** — low-utility options are detected and replaced with new
   subtasks targeting higher-utility state features.
3. **Option keyboard** — a real-valued chord vector blends option Q-functions
   into a composite Q-vector over primitive actions, enabling exponentially
   many behaviours from a finite option set.

This facade exposes a minimal, stable surface over the core
:class:`~alberta_framework.core.oak.OaKAgent` implementation.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Sutton (RLC 2025). "The OaK Architecture: A Vision of SuperIntelligence."
    Barreto et al. (2019). "The Option Keyboard: Combining Skills in RL."
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.oak import (
    KeyboardChordLearnerConfig,
    KeyboardChordLearnerState,
    OaKAgent,
    OaKArrayResult,
    OaKConfig,
    OaKState,
    OaKUpdateResult,
    init_keyboard_chord_learner,
    keyboard_action,
    keyboard_q_values,
    learned_feature_subtask_specs,
    update_keyboard_chord_learner,
)
from alberta_framework.core.options import STOMPConfig, SubtaskSpec


@dataclass(frozen=True)
class Step11OaKConfig:
    """Configuration for the production Step 11 OaK facade.

    Thin wrapper around :class:`~alberta_framework.core.oak.OaKConfig` with
    standard dict serialization consistent with Steps 1–10.

    Args:
        subtask_specs: Feature-reaching subtask definitions.
        observation_dim: Flat observation dimensionality.
        n_primitive_actions: Number of primitive discrete actions.
        base_step_size: Step-size for the extended base Q-function.
        base_avg_reward_step_size: Average-reward rate step-size for base.
        base_trace_decay: Eligibility trace decay for base agent.
        option_step_size: Step-size for intra-option Q-functions.
        option_avg_reward_step_size: Per-option average-reward step-size.
        option_trace_decay: Trace decay for intra-option Q-functions.
        option_gamma: Discount within option execution.
        option_model_decay: EMA decay for option outcome model updates.
        option_model_step_size: Step-size for next-state delta predictor.
        epsilon_base: Exploration rate for extended action selection.
        epsilon_option: Exploration rate for intra-option selection.
        utility_ema_decay: EMA decay for per-option utility tracking.
        curation_threshold: Utility threshold below which curation fires.
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
    utility_ema_decay: float = 0.99
    curation_threshold: float = 0.0

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "type": "Step11OaKConfig",
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
            "utility_ema_decay": self.utility_ema_decay,
            "curation_threshold": self.curation_threshold,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> Step11OaKConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        specs_raw = data.pop("subtask_specs", [])
        specs = tuple(SubtaskSpec(**s) for s in specs_raw)
        return cls(subtask_specs=specs, **data)

    def to_oak_config(self) -> OaKConfig:
        """Convert to the core :class:`OaKConfig`."""
        stomp = STOMPConfig(
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
        )
        return OaKConfig(
            stomp=stomp,
            utility_ema_decay=self.utility_ema_decay,
            curation_threshold=self.curation_threshold,
        )


@dataclass(frozen=True)
class Step11SmokeResult:
    """Summary returned by :func:`run_step11_smoke`."""

    config: Step11OaKConfig
    steps: int
    seed: int
    td_errors_shape: tuple[int, ...]
    average_rewards_shape: tuple[int, ...]
    primitive_actions_shape: tuple[int, ...]
    utility_emas_shape: tuple[int, ...]
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
            "utility_emas_shape": list(self.utility_emas_shape),
            "finite": self.finite,
            "option_termination_count": self.option_termination_count,
            "agent_config": self.agent_config,
        }


def make_step11_oak_agent(config: Step11OaKConfig | None = None) -> OaKAgent:
    """Create an :class:`OaKAgent` from a :class:`Step11OaKConfig`.

    Args:
        config: Step 11 configuration.  Defaults to one subtask on feature 0.

    Returns:
        Initialized :class:`OaKAgent`.
    """
    if config is None:
        config = Step11OaKConfig(subtask_specs=(SubtaskSpec(feature_index=0),))
    return OaKAgent(config.to_oak_config())


def init_step11_state(
    agent: OaKAgent,
    *,
    key: Array,
    initial_observation: Array,
) -> OaKState:
    """Initialise and prime the Step 11 OaK state.

    Args:
        agent: The :class:`OaKAgent` to initialise.
        key: JAX PRNG key.
        initial_observation: First real observation from the environment.

    Returns:
        Primed :class:`OaKState`.
    """
    init_key, start_key = jr.split(key)
    del start_key
    state = agent.init(init_key)
    obs = jnp.asarray(initial_observation, dtype=jnp.float32)
    return agent.start(state, obs)


def step11_update(
    agent: OaKAgent,
    state: OaKState,
    env_reward: Array,
    next_observation: Array,
) -> OaKUpdateResult:
    """Run one real-time OaK transition.

    Args:
        agent: The OaK agent.
        state: Current agent state.
        env_reward: Scalar environment reward.
        next_observation: Next real observation.

    Returns:
        :class:`OaKUpdateResult` with new state and diagnostics.
    """
    return agent.update(state, env_reward, next_observation)


def run_step11_scan(
    agent: OaKAgent,
    state: OaKState,
    rewards: Array,
    next_observations: Array,
) -> OaKArrayResult:
    """Run OaK over pre-collected continuing transition arrays.

    Args:
        agent: The OaK agent.
        state: Starting agent state.
        rewards: Shape ``(T,)`` float32 environment rewards.
        next_observations: Shape ``(T, obs_dim)`` float32 observations.

    Returns:
        :class:`OaKArrayResult` with per-step diagnostics.
    """
    return agent.scan(state, rewards, next_observations)


def run_step11_smoke(
    config: Step11OaKConfig | None = None,
    *,
    steps: int = 64,
    seed: int = 0,
) -> Step11SmokeResult:
    """Run a deterministic Step 11 OaK integration probe.

    Args:
        config: Step 11 configuration.  Defaults to one subtask on feature 0.
        steps: Number of transition steps to run.
        seed: PRNG seed for reproducibility.

    Returns:
        :class:`Step11SmokeResult` with shape/fineness summary.
    """
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config
    if cfg is None:
        cfg = Step11OaKConfig(subtask_specs=(SubtaskSpec(feature_index=0),))

    agent = make_step11_oak_agent(cfg)
    obs_dim = cfg.observation_dim

    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(data_key, (steps + 1, obs_dim), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])

    state = init_step11_state(agent, key=state_key, initial_observation=observations[0])
    result = run_step11_scan(agent, state, rewards, observations[1:])
    result.td_errors.block_until_ready()

    finite = bool(
        jnp.all(jnp.isfinite(result.td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
        & jnp.all(jnp.isfinite(result.pseudo_rewards))
        & jnp.all(jnp.isfinite(result.utility_emas))
        & jnp.all(result.primitive_actions >= 0)
        & jnp.all(result.primitive_actions < cfg.n_primitive_actions)
    )

    return Step11SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        td_errors_shape=tuple(int(d) for d in result.td_errors.shape),
        average_rewards_shape=tuple(int(d) for d in result.average_rewards.shape),
        primitive_actions_shape=tuple(int(d) for d in result.primitive_actions.shape),
        utility_emas_shape=tuple(int(d) for d in result.utility_emas.shape),
        finite=finite,
        option_termination_count=int(jnp.sum(result.option_terminations)),
        agent_config=agent.to_config(),
    )


__all__ = [
    "KeyboardChordLearnerConfig",
    "KeyboardChordLearnerState",
    "Step11OaKConfig",
    "Step11SmokeResult",
    "init_step11_state",
    "init_keyboard_chord_learner",
    "keyboard_action",
    "keyboard_q_values",
    "learned_feature_subtask_specs",
    "make_step11_oak_agent",
    "run_step11_scan",
    "run_step11_smoke",
    "step11_update",
    "update_keyboard_chord_learner",
]
