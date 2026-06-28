# mypy: disable-error-code="call-arg"
"""Production-facing Step 6 average-reward control facade."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, cast

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.average_reward import (
    DifferentialSARSAAgent,
    DifferentialSARSAArrayResult,
    DifferentialSARSAConfig,
    DifferentialSARSAState,
    DifferentialSARSAUpdateResult,
    run_differential_sarsa_from_arrays,
)


@dataclass(frozen=True)
class Step6DifferentialSARSAConfig:
    """Config for the production Step 6 differential SARSA facade."""

    n_actions: int = 2
    q_step_size: float = 0.05
    average_reward_step_size: float = 0.01
    trace_decay: float = 0.0
    epsilon_start: float = 0.1
    epsilon_end: float = 0.01
    epsilon_decay_steps: int = 0

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step6DifferentialSARSAConfig:
        """Reconstruct from :meth:`to_dict` output."""
        return cls(**cast(Any, payload))

    def to_core_config(self) -> DifferentialSARSAConfig:
        """Return the core differential SARSA config."""
        return DifferentialSARSAConfig(
            n_actions=self.n_actions,
            q_step_size=self.q_step_size,
            average_reward_step_size=self.average_reward_step_size,
            trace_decay=self.trace_decay,
            epsilon_start=self.epsilon_start,
            epsilon_end=self.epsilon_end,
            epsilon_decay_steps=self.epsilon_decay_steps,
        )


@dataclass(frozen=True)
class Step6SmokeResult:
    """Summary returned by :func:`run_step6_smoke`."""

    config: Step6DifferentialSARSAConfig
    steps: int
    seed: int
    q_values_shape: tuple[int, ...]
    td_errors_shape: tuple[int, ...]
    average_rewards_shape: tuple[int, ...]
    actions_shape: tuple[int, ...]
    finite: bool
    agent_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["q_values_shape"] = list(self.q_values_shape)
        payload["td_errors_shape"] = list(self.td_errors_shape)
        payload["average_rewards_shape"] = list(self.average_rewards_shape)
        payload["actions_shape"] = list(self.actions_shape)
        return payload


def make_step6_differential_sarsa_agent(
    config: Step6DifferentialSARSAConfig | None = None,
) -> DifferentialSARSAAgent:
    """Create the production Step 6 differential SARSA agent."""
    cfg = config or Step6DifferentialSARSAConfig()
    return DifferentialSARSAAgent(cfg.to_core_config())


def init_step6_state(
    agent: DifferentialSARSAAgent,
    *,
    feature_dim: int,
    key: Array,
    initial_features: Array,
) -> DifferentialSARSAState:
    """Initialize and prime a differential SARSA state."""
    state = agent.init(feature_dim, key)
    state, _action = agent.start(state, initial_features)
    return cast(DifferentialSARSAState, state)


def step6_update(
    agent: DifferentialSARSAAgent,
    state: DifferentialSARSAState,
    reward: Array,
    next_features: Array,
) -> DifferentialSARSAUpdateResult:
    """Run one continuing differential SARSA transition update."""
    return cast(DifferentialSARSAUpdateResult, agent.update(state, reward, next_features))


def run_step6_scan(
    agent: DifferentialSARSAAgent,
    state: DifferentialSARSAState,
    rewards: Array,
    next_features: Array,
) -> DifferentialSARSAArrayResult:
    """Run Step 6 differential SARSA over pre-collected transition arrays."""
    return run_differential_sarsa_from_arrays(agent, state, rewards, next_features)


def run_step6_smoke(
    config: Step6DifferentialSARSAConfig | None = None,
    *,
    steps: int = 32,
    feature_dim: int = 6,
    seed: int = 0,
) -> Step6SmokeResult:
    """Run a tiny deterministic Step 6 integration probe."""
    if steps < 1:
        raise ValueError("steps must be positive")
    if feature_dim < 1:
        raise ValueError("feature_dim must be positive")

    cfg = config or Step6DifferentialSARSAConfig()
    agent = make_step6_differential_sarsa_agent(cfg)
    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(data_key, (steps + 1, feature_dim), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])
    state = init_step6_state(
        agent,
        feature_dim=feature_dim,
        key=state_key,
        initial_features=observations[0],
    )
    result = run_differential_sarsa_from_arrays(
        agent,
        state,
        rewards,
        observations[1:],
    )
    result.td_errors.block_until_ready()
    finite = bool(
        jnp.all(jnp.isfinite(result.q_values))
        & jnp.all(jnp.isfinite(result.td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
        & jnp.all(result.actions >= 0)
        & jnp.all(result.actions < cfg.n_actions)
    )
    return Step6SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        q_values_shape=tuple(int(dim) for dim in result.q_values.shape),
        td_errors_shape=tuple(int(dim) for dim in result.td_errors.shape),
        average_rewards_shape=tuple(int(dim) for dim in result.average_rewards.shape),
        actions_shape=tuple(int(dim) for dim in result.actions.shape),
        finite=finite,
        agent_config=agent.to_config(),
    )
