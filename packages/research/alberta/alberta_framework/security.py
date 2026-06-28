"""Security-gym integration contracts for downstream active-defense agents.

This module is intentionally small and dependency-free. It gives ``rlsecd`` and
``security-gym`` a stable framework-side contract for discrete actions, reward
components, feature schemas, rollout records, and throughput timing without
requiring either sibling repository at import time.
"""

from __future__ import annotations

import dataclasses
import time
from collections.abc import Mapping, Sequence
from enum import IntEnum
from typing import Any


class SecurityAction(IntEnum):
    """Stable six-action active-defense vocabulary.

    The integer values are the action-head indices expected by SARSA/Horde and
    actor-critic agents. Downstream environment wrappers should translate these
    semantic actions to their local actuation APIs without changing the values.
    """

    PASS = 0
    ALERT = 1
    THROTTLE = 2
    BLOCK = 3
    UNBLOCK = 4
    ISOLATE = 5


SECURITY_ACTION_NAMES: tuple[str, ...] = tuple(action.name.lower() for action in SecurityAction)
SECURITY_GYM_ACTION_NAMES: tuple[str, ...] = (
    "pass",
    "alert",
    "throttle",
    "block_source",
    "unblock",
    "isolate",
)
N_SECURITY_ACTIONS = len(SecurityAction)

_ACTION_ALIASES = {
    "block_source": SecurityAction.BLOCK,
    "block": SecurityAction.BLOCK,
}

_SECURITY_GYM_ATTACK_REWARDS = {
    SecurityAction.PASS: -0.5,
    SecurityAction.ALERT: 0.5,
    SecurityAction.THROTTLE: 0.75,
    SecurityAction.BLOCK: 1.0,
    SecurityAction.UNBLOCK: -0.5,
    SecurityAction.ISOLATE: 0.25,
}

_SECURITY_GYM_BENIGN_REWARDS = {
    SecurityAction.PASS: 0.0,
    SecurityAction.ALERT: -0.3,
    SecurityAction.THROTTLE: -0.5,
    SecurityAction.BLOCK: -1.0,
    SecurityAction.UNBLOCK: 0.0,
    SecurityAction.ISOLATE: -2.0,
}


@dataclasses.dataclass(frozen=True)
class SecurityRewardWeights:
    """Linear reward weights for active-defense rollouts.

    Positive components reward correct protection and service restoration.
    Negative components penalize operational disruption and missed threats. The
    defaults are conservative integration-test baselines; production
    experiments should record the exact weights in rollout metadata.
    """

    threat_blocked: float = 1.0
    false_positive: float = -0.5
    service_disruption: float = -0.2
    alert_cost: float = -0.05
    latency_cost: float = -0.1
    compromise_cost: float = -1.0
    recovery: float = 0.5

    def to_dict(self) -> dict[str, float]:
        """Return a JSON-serializable weight mapping."""
        return dataclasses.asdict(self)


def security_reward(
    components: Mapping[str, float],
    weights: SecurityRewardWeights | Mapping[str, float] | None = None,
) -> float:
    """Compute scalar reward from named security outcome components.

    Unknown component names are ignored so sibling environments can log richer
    diagnostics while keeping the learning reward contract stable.
    """
    weight_map = weights.to_dict() if isinstance(weights, SecurityRewardWeights) else weights
    if weight_map is None:
        weight_map = SecurityRewardWeights().to_dict()
    return float(
        sum(float(components.get(name, 0.0)) * weight for name, weight in weight_map.items())
    )


@dataclasses.dataclass(frozen=True)
class SecurityFeatureSchema:
    """Versioned flat feature schema for rlsecd/security-gym observations."""

    names: tuple[str, ...]
    version: str = "security-gym-v1"
    dtype: str = "float32"

    def __post_init__(self) -> None:
        if not self.names:
            raise ValueError("feature schema must contain at least one feature")
        if len(set(self.names)) != len(self.names):
            raise ValueError("feature names must be unique")

    @property
    def feature_dim(self) -> int:
        """Number of features in this schema."""
        return len(self.names)

    def validate_observation(self, observation: Sequence[float]) -> None:
        """Raise ``ValueError`` if an observation does not match this schema."""
        if len(observation) != self.feature_dim:
            raise ValueError(
                f"observation length {len(observation)} does not match "
                f"schema feature_dim {self.feature_dim}"
            )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable schema mapping."""
        return {
            "version": self.version,
            "dtype": self.dtype,
            "names": list(self.names),
            "feature_dim": self.feature_dim,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> SecurityFeatureSchema:
        """Reconstruct a schema from ``to_dict`` output."""
        return cls(
            names=tuple(str(name) for name in data["names"]),
            version=str(data.get("version", "security-gym-v1")),
            dtype=str(data.get("dtype", "float32")),
        )


@dataclasses.dataclass(frozen=True)
class SecurityRolloutStep:
    """Serializable transition record for reproducible active-defense rollouts."""

    state: tuple[float, ...]
    action: SecurityAction
    reward: float
    next_state: tuple[float, ...]
    terminated: bool
    truncated: bool = False
    policy_metadata: Mapping[str, Any] = dataclasses.field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable transition mapping."""
        return {
            "state": list(self.state),
            "action": int(self.action),
            "action_name": self.action.name.lower(),
            "reward": self.reward,
            "next_state": list(self.next_state),
            "terminated": self.terminated,
            "truncated": self.truncated,
            "policy_metadata": dict(self.policy_metadata),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> SecurityRolloutStep:
        """Reconstruct a rollout step from ``to_dict`` output."""
        return cls(
            state=tuple(float(value) for value in data["state"]),
            action=coerce_security_action(data["action"]),
            reward=float(data["reward"]),
            next_state=tuple(float(value) for value in data["next_state"]),
            terminated=bool(data["terminated"]),
            truncated=bool(data.get("truncated", False)),
            policy_metadata=dict(data.get("policy_metadata", {})),
        )


@dataclasses.dataclass(frozen=True)
class SecurityOracleExperience:
    """Serializable oracle-review record derived from a security rollout step."""

    state: tuple[float, ...]
    action: SecurityAction
    reward: float
    outcome: Mapping[str, Any]
    policy_metadata: Mapping[str, Any] = dataclasses.field(default_factory=dict)
    schema: str = "alberta.security_gym.oracle_experience.v1"

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable oracle experience mapping."""
        return {
            "schema": self.schema,
            "state": list(self.state),
            "action": int(self.action),
            "action_name": security_gym_action_name(self.action),
            "reward": self.reward,
            "outcome": dict(self.outcome),
            "policy_metadata": dict(self.policy_metadata),
        }


def security_rollout_step_to_oracle_experience(
    step: SecurityRolloutStep,
) -> SecurityOracleExperience:
    """Convert a rollout transition to a compact oracle-review record."""
    is_malicious = bool(step.policy_metadata.get("is_malicious", False))
    defensive_action = step.action in (
        SecurityAction.THROTTLE,
        SecurityAction.BLOCK,
        SecurityAction.ISOLATE,
    )
    if is_malicious and defensive_action:
        label = "true_positive"
    elif is_malicious:
        label = "false_negative"
    elif defensive_action:
        label = "false_positive"
    else:
        label = "true_negative"
    return SecurityOracleExperience(
        state=step.state,
        action=step.action,
        reward=step.reward,
        outcome={
            "label": label,
            "terminated": step.terminated,
            "truncated": step.truncated,
        },
        policy_metadata=step.policy_metadata,
    )


def validate_security_oracle_experience(
    records: Sequence[SecurityOracleExperience],
    schema: SecurityFeatureSchema,
) -> None:
    """Validate oracle-review records against a feature schema."""
    for idx, record in enumerate(records):
        try:
            schema.validate_observation(record.state)
        except ValueError as exc:
            raise ValueError(f"invalid oracle experience {idx}: {exc}") from exc
        if not isinstance(record.outcome.get("label"), str) or not record.outcome["label"]:
            raise ValueError(f"invalid oracle experience {idx}: missing outcome label")


def coerce_security_action(action: SecurityAction | int | str) -> SecurityAction:
    """Coerce an integer or name to ``SecurityAction``."""
    if isinstance(action, SecurityAction):
        return action
    if isinstance(action, int):
        return SecurityAction(action)
    normalized = action.strip().lower()
    if normalized in _ACTION_ALIASES:
        return _ACTION_ALIASES[normalized]
    for candidate in SecurityAction:
        if candidate.name.lower() == normalized:
            return candidate
    raise ValueError(f"unknown security action: {action!r}")


def security_gym_action_name(action: SecurityAction | int | str) -> str:
    """Return the action name expected by ``security-gym``."""
    return SECURITY_GYM_ACTION_NAMES[int(coerce_security_action(action))]


def to_security_gym_action(
    action: SecurityAction | int | str,
    risk_score: float = 0.0,
) -> dict[str, int | tuple[float]]:
    """Convert a framework action into a ``security-gym`` action dict.

    ``security-gym`` uses a Gymnasium ``Dict`` action space with a discrete
    ``action`` id and a one-element ``risk_score`` array. A one-element tuple is
    accepted by the environment and keeps this module dependency-free.
    """
    clipped_risk = min(10.0, max(0.0, float(risk_score)))
    return {
        "action": int(coerce_security_action(action)),
        "risk_score": (clipped_risk,),
    }


def security_gym_action_reward(
    action: SecurityAction | int | str,
    *,
    is_malicious: bool,
) -> float:
    """Return the immediate action reward from ``security-gym`` v0.4.x."""
    table = _SECURITY_GYM_ATTACK_REWARDS if is_malicious else _SECURITY_GYM_BENIGN_REWARDS
    return table[coerce_security_action(action)]


def validate_security_rollout(
    steps: Sequence[SecurityRolloutStep],
    schema: SecurityFeatureSchema,
) -> None:
    """Validate that rollout transitions satisfy the active-defense contract."""
    for idx, step in enumerate(steps):
        try:
            schema.validate_observation(step.state)
            schema.validate_observation(step.next_state)
        except ValueError as exc:
            raise ValueError(f"invalid rollout step {idx}: {exc}") from exc


@dataclasses.dataclass(frozen=True)
class ThroughputMeasurement:
    """Measured events-per-second summary."""

    n_events: int
    elapsed_s: float

    @property
    def events_per_second(self) -> float:
        """Throughput in events per second."""
        if self.elapsed_s <= 0.0:
            return float("inf")
        return self.n_events / self.elapsed_s

    def to_dict(self) -> dict[str, float | int]:
        """Return a JSON-serializable measurement mapping."""
        return {
            "n_events": self.n_events,
            "elapsed_s": self.elapsed_s,
            "events_per_second": self.events_per_second,
        }


class ThroughputMeter:
    """Wall-clock throughput hook for daemon integration smoke tests."""

    def __init__(self) -> None:
        self._start = time.perf_counter()
        self._n_events = 0

    def tick(self, n_events: int = 1) -> None:
        """Record completed events."""
        if n_events < 0:
            raise ValueError("n_events must be non-negative")
        self._n_events += n_events

    def measure(self) -> ThroughputMeasurement:
        """Return current throughput measurement."""
        return ThroughputMeasurement(
            n_events=self._n_events,
            elapsed_s=time.perf_counter() - self._start,
        )


__all__ = [
    "N_SECURITY_ACTIONS",
    "SECURITY_GYM_ACTION_NAMES",
    "SECURITY_ACTION_NAMES",
    "SecurityAction",
    "SecurityFeatureSchema",
    "SecurityOracleExperience",
    "SecurityRewardWeights",
    "SecurityRolloutStep",
    "ThroughputMeasurement",
    "ThroughputMeter",
    "coerce_security_action",
    "security_gym_action_name",
    "security_gym_action_reward",
    "security_rollout_step_to_oracle_experience",
    "security_reward",
    "to_security_gym_action",
    "validate_security_oracle_experience",
    "validate_security_rollout",
]
