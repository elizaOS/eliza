# mypy: disable-error-code="attr-defined,call-arg"
"""Production-facing Step 12 Intelligence Amplification facade.

Step 12 of the Alberta Plan — "Prototype-IA: Intelligence Amplification" —
demonstrates that an IA agent can increase the decision-making capacity of a
*partner* agent in non-trivial ways.  The IA agent is not a standalone
autonomous system; it amplifies another agent's intelligence.

Two augmentation streams are provided:

* **Exo-cerebellum** — An online multi-output linear predictor that learns to
  anticipate future observation features.  Its prediction vector becomes an
  augmented feature channel for the partner.
* **Exo-cortex** — An OaK-based (Step 11) agent that learns from the partner's
  experience and broadcasts greedy action recommendations.  The partner can
  accept or ignore these recommendations.

At each step the IA agent returns:

* ``predictions`` — shape ``(n_demons,)`` cerebellum predictions.
* ``recommendation`` — scalar int32 cortex action recommendation.
* ``augmented_obs`` — ``concat(partner_obs, predictions)``, a drop-in
  replacement for the partner's raw observation that adds predictive context.

References:
    Sutton, Bowling, & Pilarski (2022). "The Alberta Plan for AI Research."
    Mathewson et al. (2023). "Communicative Capital." *Neural Comp. & Apps.*
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import jax.numpy as jnp
import jax.random as jr
from jax import Array

from alberta_framework.core.intelligence_amplification import (
    ExoCerebellumConfig,
    IAAgent,
    IAArrayResult,
    IAConfig,
    IAState,
    IAUpdateResult,
    RecommendationProtocolConfig,
    RecommendationProtocolResult,
    RecommendationProtocolState,
    init_recommendation_protocol_state,
    update_recommendation_protocol,
)
from alberta_framework.core.oak import OaKConfig
from alberta_framework.core.options import STOMPConfig, SubtaskSpec


@dataclass(frozen=True)
class Step12IAConfig:
    """Configuration for the production Step 12 IA facade.

    Args:
        n_demons: Number of exo-cerebellum prediction heads.
        cerebellum_step_size: Learning rate for cerebellum weight updates.
        subtask_specs: Subtask specs for the exo-cortex OaK agent.
        observation_dim: Flat observation dimensionality.
        n_primitive_actions: Number of primitive discrete actions.
        base_step_size: Cortex base Q step-size.
        base_avg_reward_step_size: Cortex base average-reward step-size.
        option_step_size: Cortex intra-option Q step-size.
        option_gamma: Cortex option discount.
        epsilon_base: Cortex exploration rate.
        utility_ema_decay: Cortex option utility EMA decay.
    """

    n_demons: int = 4
    cerebellum_step_size: float = 0.05
    subtask_specs: tuple[SubtaskSpec, ...] = ()
    observation_dim: int = 4
    n_primitive_actions: int = 2
    base_step_size: float = 0.05
    base_avg_reward_step_size: float = 0.01
    option_step_size: float = 0.05
    option_gamma: float = 0.99
    epsilon_base: float = 0.1
    utility_ema_decay: float = 0.99

    def to_config(self) -> dict[str, Any]:
        """Return a JSON-serializable representation."""
        return {
            "type": "Step12IAConfig",
            "n_demons": self.n_demons,
            "cerebellum_step_size": self.cerebellum_step_size,
            "subtask_specs": [asdict(s) for s in self.subtask_specs],
            "observation_dim": self.observation_dim,
            "n_primitive_actions": self.n_primitive_actions,
            "base_step_size": self.base_step_size,
            "base_avg_reward_step_size": self.base_avg_reward_step_size,
            "option_step_size": self.option_step_size,
            "option_gamma": self.option_gamma,
            "epsilon_base": self.epsilon_base,
            "utility_ema_decay": self.utility_ema_decay,
        }

    @classmethod
    def from_config(cls, payload: dict[str, Any]) -> Step12IAConfig:
        """Reconstruct from :meth:`to_config` output."""
        data = dict(payload)
        data.pop("type", None)
        specs_raw = data.pop("subtask_specs", [])
        specs = tuple(SubtaskSpec(**s) for s in specs_raw)
        return cls(subtask_specs=specs, **data)

    def to_ia_config(self) -> IAConfig:
        """Convert to the core :class:`IAConfig`."""
        specs = self.subtask_specs
        if not specs:
            specs = (SubtaskSpec(feature_index=0),)
        stomp = STOMPConfig(
            subtask_specs=specs,
            observation_dim=self.observation_dim,
            n_primitive_actions=self.n_primitive_actions,
            base_step_size=self.base_step_size,
            base_avg_reward_step_size=self.base_avg_reward_step_size,
            option_step_size=self.option_step_size,
            option_gamma=self.option_gamma,
            epsilon_base=self.epsilon_base,
        )
        cortex = OaKConfig(stomp=stomp, utility_ema_decay=self.utility_ema_decay)
        cerebellum = ExoCerebellumConfig(
            n_demons=self.n_demons,
            obs_dim=self.observation_dim,
            step_size=self.cerebellum_step_size,
        )
        return IAConfig(cerebellum=cerebellum, cortex=cortex)


@dataclass(frozen=True)
class Step12SmokeResult:
    """Summary returned by :func:`run_step12_smoke`."""

    config: Step12IAConfig
    steps: int
    seed: int
    predictions_shape: tuple[int, ...]
    cerebellum_errors_shape: tuple[int, ...]
    recommendations_shape: tuple[int, ...]
    augmented_obs_shape: tuple[int, ...]
    cortex_td_errors_shape: tuple[int, ...]
    finite: bool
    agent_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return {
            "config": self.config.to_config(),
            "steps": self.steps,
            "seed": self.seed,
            "predictions_shape": list(self.predictions_shape),
            "cerebellum_errors_shape": list(self.cerebellum_errors_shape),
            "recommendations_shape": list(self.recommendations_shape),
            "augmented_obs_shape": list(self.augmented_obs_shape),
            "cortex_td_errors_shape": list(self.cortex_td_errors_shape),
            "finite": self.finite,
            "agent_config": self.agent_config,
        }


def make_step12_ia_agent(config: Step12IAConfig | None = None) -> IAAgent:
    """Create an :class:`IAAgent` from a :class:`Step12IAConfig`.

    Args:
        config: Step 12 configuration.  Defaults to 4 cerebellum demons and
            one cortex subtask on feature 0.

    Returns:
        Initialised :class:`IAAgent`.
    """
    if config is None:
        config = Step12IAConfig()
    return IAAgent(config.to_ia_config())


def init_step12_state(
    agent: IAAgent,
    *,
    key: Array,
    initial_observation: Array,
) -> IAState:
    """Initialise and prime the Step 12 IA state.

    Args:
        agent: The :class:`IAAgent` to initialise.
        key: JAX PRNG key.
        initial_observation: First real observation from the environment.

    Returns:
        Primed :class:`IAState`.
    """
    init_key, _ = jr.split(key)
    state = agent.init(init_key)
    obs = jnp.asarray(initial_observation, dtype=jnp.float32)
    return agent.start(state, obs)


def step12_update(
    agent: IAAgent,
    state: IAState,
    partner_obs: Array,
    partner_reward: Array,
    partner_next_obs: Array,
) -> IAUpdateResult:
    """Run one IA step from partner experience.

    Args:
        agent: The IA agent.
        state: Current IA state.
        partner_obs: Partner's current observation.
        partner_reward: Partner's received reward.
        partner_next_obs: Partner's next observation.

    Returns:
        :class:`IAUpdateResult` with predictions, recommendation, and
        augmented observation.
    """
    return agent.update(state, partner_obs, partner_reward, partner_next_obs)


def run_step12_scan(
    agent: IAAgent,
    state: IAState,
    partner_obs: Array,
    partner_rewards: Array,
    partner_next_obs: Array,
) -> IAArrayResult:
    """Run the IA agent over pre-collected partner transition arrays.

    Args:
        agent: The IA agent.
        state: Starting IA state.
        partner_obs: Shape ``(T, obs_dim)`` partner observations.
        partner_rewards: Shape ``(T,)`` partner rewards.
        partner_next_obs: Shape ``(T, obs_dim)`` partner next observations.

    Returns:
        :class:`IAArrayResult` with per-step diagnostics.
    """
    return agent.scan(state, partner_obs, partner_rewards, partner_next_obs)


def run_step12_smoke(
    config: Step12IAConfig | None = None,
    *,
    steps: int = 64,
    seed: int = 0,
) -> Step12SmokeResult:
    """Run a deterministic Step 12 IA integration probe.

    Args:
        config: Step 12 configuration.  Defaults to 4 cerebellum demons,
            one cortex subtask on feature 0.
        steps: Number of transition steps to run.
        seed: PRNG seed for reproducibility.

    Returns:
        :class:`Step12SmokeResult` with shape/fineness summary.
    """
    if steps < 1:
        raise ValueError("steps must be positive")

    cfg = config or Step12IAConfig()
    agent = make_step12_ia_agent(cfg)
    obs_dim = cfg.observation_dim

    data_key, state_key = jr.split(jr.key(seed))
    observations = jr.normal(data_key, (steps + 1, obs_dim), dtype=jnp.float32)
    rewards = jnp.tanh(observations[1:, 0])

    state = init_step12_state(agent, key=state_key, initial_observation=observations[0])
    result = run_step12_scan(
        agent,
        state,
        observations[:-1],
        rewards,
        observations[1:],
    )
    result.cortex_td_errors.block_until_ready()

    finite = bool(
        jnp.all(jnp.isfinite(result.predictions))
        & jnp.all(jnp.isfinite(result.cerebellum_errors))
        & jnp.all(jnp.isfinite(result.cortex_td_errors))
        & jnp.all(jnp.isfinite(result.augmented_obs))
        & jnp.all(result.recommendations >= 0)
        & jnp.all(result.recommendations < cfg.n_primitive_actions)
    )

    return Step12SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        predictions_shape=tuple(int(d) for d in result.predictions.shape),
        cerebellum_errors_shape=tuple(int(d) for d in result.cerebellum_errors.shape),
        recommendations_shape=tuple(int(d) for d in result.recommendations.shape),
        augmented_obs_shape=tuple(int(d) for d in result.augmented_obs.shape),
        cortex_td_errors_shape=tuple(int(d) for d in result.cortex_td_errors.shape),
        finite=finite,
        agent_config=agent.to_config(),
    )


__all__ = [
    "RecommendationProtocolConfig",
    "RecommendationProtocolResult",
    "RecommendationProtocolState",
    "Step12IAConfig",
    "Step12SmokeResult",
    "init_step12_state",
    "init_recommendation_protocol_state",
    "make_step12_ia_agent",
    "run_step12_scan",
    "run_step12_smoke",
    "step12_update",
    "update_recommendation_protocol",
]
