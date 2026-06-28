# mypy: disable-error-code="call-arg"
"""Production-facing Step 5 average-reward prediction facade."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, cast

import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.average_reward import (
    DifferentialTDArrayResult,
    DifferentialTDConfig,
    DifferentialTDLearner,
    run_differential_td_from_arrays,
)


@dataclass(frozen=True)
class Step5AverageRewardTDConfig:
    """Config for the production Step 5 differential TD facade."""

    step_size: float = 0.05
    average_reward_step_size: float = 0.01
    trace_decay: float = 0.0

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> Step5AverageRewardTDConfig:
        """Reconstruct from :meth:`to_dict` output."""
        return cls(**cast(Any, payload))

    def to_core_config(self) -> DifferentialTDConfig:
        """Return the core differential TD config."""
        return DifferentialTDConfig(
            step_size=self.step_size,
            average_reward_step_size=self.average_reward_step_size,
            trace_decay=self.trace_decay,
        )


@dataclass(frozen=True)
class Step5SmokeResult:
    """Summary returned by :func:`run_step5_smoke`."""

    config: Step5AverageRewardTDConfig
    steps: int
    seed: int
    predictions_shape: tuple[int, ...]
    td_errors_shape: tuple[int, ...]
    average_rewards_shape: tuple[int, ...]
    finite: bool
    learner_config: dict[str, Any]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["config"] = self.config.to_dict()
        payload["predictions_shape"] = list(self.predictions_shape)
        payload["td_errors_shape"] = list(self.td_errors_shape)
        payload["average_rewards_shape"] = list(self.average_rewards_shape)
        return payload


def make_step5_td_learner(
    config: Step5AverageRewardTDConfig | None = None,
) -> DifferentialTDLearner:
    """Create the production Step 5 differential TD learner."""
    cfg = config or Step5AverageRewardTDConfig()
    return DifferentialTDLearner(cfg.to_core_config())


def run_step5_scan(
    learner: DifferentialTDLearner,
    state: object,
    observations: object,
    rewards: object,
    next_observations: object,
) -> DifferentialTDArrayResult:
    """Run Step 5 differential TD over pre-collected transition arrays."""
    return run_differential_td_from_arrays(
        learner,
        state,  # type: ignore[arg-type]
        observations,  # type: ignore[arg-type]
        rewards,  # type: ignore[arg-type]
        next_observations,  # type: ignore[arg-type]
    )


def run_step5_smoke(
    config: Step5AverageRewardTDConfig | None = None,
    *,
    steps: int = 32,
    feature_dim: int = 6,
    seed: int = 0,
) -> Step5SmokeResult:
    """Run a tiny deterministic Step 5 integration probe."""
    if steps < 1:
        raise ValueError("steps must be positive")
    if feature_dim < 1:
        raise ValueError("feature_dim must be positive")

    cfg = config or Step5AverageRewardTDConfig()
    learner = make_step5_td_learner(cfg)
    key = jr.key(seed)
    obs_key, reward_key = jr.split(key)
    observations = jr.normal(obs_key, (steps + 1, feature_dim), dtype=jnp.float32)
    rewards = 0.25 + 0.1 * jnp.tanh(
        observations[:-1, 0] + jr.normal(reward_key, (steps,), dtype=jnp.float32)
    )
    state = learner.init(feature_dim)
    result = run_differential_td_from_arrays(
        learner,
        state,
        observations[:-1],
        rewards,
        observations[1:],
    )
    result.td_errors.block_until_ready()
    finite = bool(
        jnp.all(jnp.isfinite(result.predictions))
        & jnp.all(jnp.isfinite(result.td_errors))
        & jnp.all(jnp.isfinite(result.average_rewards))
    )
    return Step5SmokeResult(
        config=cfg,
        steps=steps,
        seed=seed,
        predictions_shape=tuple(int(dim) for dim in result.predictions.shape),
        td_errors_shape=tuple(int(dim) for dim in result.td_errors.shape),
        average_rewards_shape=tuple(int(dim) for dim in result.average_rewards.shape),
        finite=finite,
        learner_config=learner.to_config(),
    )
