# mypy: disable-error-code="attr-defined,call-arg"
"""Production-facing Step 4 SARSA control facade.

This module keeps the packaged Step 4 surface narrow: construct a SARSA agent,
prime it with an initial feature vector, run one online transition, or scan over
pre-collected feature/reward arrays.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.optimizers import (
    IDBD,
    LMS,
    Autostep,
    Bounder,
    ObGDBounding,
)
from alberta_framework.core.sarsa import (
    SARSAAgent,
    SARSAArrayResult,
    SARSAConfig,
    SARSAState,
    SARSAUpdateResult,
)
from alberta_framework.core.types import GVFSpec, TraceMode

Step4OptimizerName = Literal["lms", "idbd", "autostep"]
Step4BounderName = Literal["none", "obgd"]


@dataclass(frozen=True)
class Step4SARSAConfig:
    """Config for the production Step 4 SARSA facade."""

    n_actions: int = 2
    hidden_sizes: tuple[int, ...] = (16,)
    gamma: float = 0.99
    epsilon_start: float = 0.1
    epsilon_end: float = 0.01
    epsilon_decay_steps: int = 0
    lamda: float = 0.0
    optimizer: Step4OptimizerName = "lms"
    bounder: Step4BounderName = "obgd"
    step_size: float = 0.03
    meta_step_size: float = 0.01
    bounder_kappa: float = 0.5
    sparsity: float = 0.5
    use_layer_norm: bool = True
    trace_mode: Literal["accumulating", "replacing"] = "accumulating"

    def __post_init__(self) -> None:
        """Validate action count."""
        if self.n_actions < 1:
            msg = f"n_actions must be positive, got {self.n_actions}"
            raise ValueError(msg)

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step4SARSAConfig:
        """Reconstruct from :meth:`to_dict` output."""
        config = dict(payload)
        config["hidden_sizes"] = tuple(cast(list[int], config["hidden_sizes"]))
        return cls(**cast(Any, config))

    def to_sarsa_config(self) -> SARSAConfig:
        """Return the core SARSA configuration."""
        return SARSAConfig(
            n_actions=self.n_actions,
            gamma=self.gamma,
            epsilon_start=self.epsilon_start,
            epsilon_end=self.epsilon_end,
            epsilon_decay_steps=self.epsilon_decay_steps,
        )


@dataclass(frozen=True)
class Step4SmokeResult:
    """Summary returned by :func:`run_step4_smoke`."""

    config: Step4SARSAConfig
    steps: int
    seed: int
    q_values_shape: tuple[int, ...]
    td_errors_shape: tuple[int, ...]
    actions_shape: tuple[int, ...]
    finite: bool
    agent_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["q_values_shape"] = list(self.q_values_shape)
        payload["td_errors_shape"] = list(self.td_errors_shape)
        payload["actions_shape"] = list(self.actions_shape)
        return payload


@chex.dataclass(frozen=True)
class Step4OneStepResult:
    """Result from one production Step 4 transition."""

    state: SARSAState
    action: Array
    q_values: Array
    td_error: Array
    reward: Array


def make_step4_optimizer(config: Step4SARSAConfig) -> Any:
    """Construct the configured Step 4 optimizer."""
    if config.optimizer == "lms":
        return LMS(step_size=config.step_size)
    if config.optimizer == "idbd":
        return IDBD(
            initial_step_size=config.step_size,
            meta_step_size=config.meta_step_size,
        )
    if config.optimizer == "autostep":
        return Autostep(
            initial_step_size=config.step_size,
            meta_step_size=config.meta_step_size,
        )
    msg = f"unknown Step 4 optimizer {config.optimizer!r}"
    raise ValueError(msg)


def make_step4_bounder(config: Step4SARSAConfig) -> Bounder | None:
    """Construct the configured Step 4 update bounder."""
    if config.bounder == "none":
        return None
    if config.bounder == "obgd":
        return ObGDBounding(kappa=config.bounder_kappa)
    msg = f"unknown Step 4 bounder {config.bounder!r}"
    raise ValueError(msg)


def make_step4_sarsa_agent(
    config: Step4SARSAConfig | None = None,
    *,
    prediction_demons: tuple[GVFSpec, ...] | None = None,
) -> SARSAAgent:
    """Create the production Step 4 SARSA agent."""
    cfg = config or Step4SARSAConfig()
    return SARSAAgent(
        sarsa_config=cfg.to_sarsa_config(),
        hidden_sizes=cfg.hidden_sizes,
        optimizer=make_step4_optimizer(cfg),
        bounder=make_step4_bounder(cfg),
        sparsity=cfg.sparsity,
        use_layer_norm=cfg.use_layer_norm,
        lamda=cfg.lamda,
        trace_mode=TraceMode(cfg.trace_mode),
        prediction_demons=list(prediction_demons) if prediction_demons else None,
    )


def init_step4_state(
    agent: SARSAAgent,
    *,
    feature_dim: int,
    key: Array,
    initial_features: Array,
) -> SARSAState:
    """Initialize and prime a SARSA state with the first feature vector."""
    state = agent.init(feature_dim, key)
    action, next_key = agent.select_action(state, initial_features)
    return cast(
        SARSAState,
        state.replace(
            last_action=action,
            last_observation=initial_features,
            rng_key=next_key,
        ),
    )


def step4_update(
    agent: SARSAAgent,
    state: SARSAState,
    reward: Array,
    next_features: Array,
    terminated: Array,
    prediction_cumulants: Array | None = None,
) -> Step4OneStepResult:
    """Run one SARSA transition update and select the next action."""
    next_action, next_key = agent.select_action(state, next_features)
    ready_state = state.replace(rng_key=next_key)
    result: SARSAUpdateResult = agent.update(
        ready_state,
        reward,
        next_features,
        terminated,
        next_action,
        prediction_cumulants=prediction_cumulants,
    )
    return Step4OneStepResult(
        state=result.state,
        action=result.action,
        q_values=result.q_values,
        td_error=result.td_error,
        reward=result.reward,
    )


def run_step4_scan(
    agent: SARSAAgent,
    state: SARSAState,
    next_features: Array,
    rewards: Array,
    terminated: Array,
) -> SARSAArrayResult:
    """Run Step 4 SARSA over pre-collected transition arrays."""

    def step_fn(
        carry: SARSAState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[SARSAState, tuple[Array, Array, Array]]:
        s = carry
        features_t, reward_t, terminated_t = inputs
        result = step4_update(agent, s, reward_t, features_t, terminated_t)
        return result.state, (result.q_values, result.td_error, result.action)

    final_state, (q_values, td_errors, actions) = jax.lax.scan(
        step_fn,
        state,
        (next_features, rewards, terminated),
    )
    return SARSAArrayResult(
        state=final_state,
        q_values=q_values,
        td_errors=td_errors,
        actions=actions,
    )


def run_step4_smoke(
    config: Step4SARSAConfig | None = None,
    *,
    steps: int = 32,
    feature_dim: int = 6,
    seed: int = 0,
) -> Step4SmokeResult:
    """Run a tiny deterministic Step 4 integration probe."""
    if steps < 1:
        msg = f"steps must be positive, got {steps}"
        raise ValueError(msg)
    if feature_dim < 1:
        msg = f"feature_dim must be positive, got {feature_dim}"
        raise ValueError(msg)

    cfg = config or Step4SARSAConfig()
    agent = make_step4_sarsa_agent(cfg)
    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(data_key, (steps + 1, feature_dim), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])
    terminated = jnp.zeros(steps, dtype=jnp.float32)
    state = init_step4_state(
        agent,
        feature_dim=feature_dim,
        key=state_key,
        initial_features=observations[0],
    )
    result = run_step4_scan(
        agent,
        state,
        observations[1:],
        rewards,
        terminated,
    )
    result.q_values.block_until_ready()

    finite = bool(
        jnp.all(jnp.isfinite(result.q_values))
        & jnp.all(jnp.isfinite(result.td_errors))
        & jnp.all(result.actions >= 0)
        & jnp.all(result.actions < cfg.n_actions)
    )
    return Step4SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        q_values_shape=tuple(int(dim) for dim in result.q_values.shape),
        td_errors_shape=tuple(int(dim) for dim in result.td_errors.shape),
        actions_shape=tuple(int(dim) for dim in result.actions.shape),
        finite=finite,
        agent_config=agent.to_config(),
    )
