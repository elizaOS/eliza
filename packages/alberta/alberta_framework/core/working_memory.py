# mypy: disable-error-code="call-arg,name-defined"
"""Lightweight working-memory features for predictive state construction.

The module keeps causal, fixed-budget traces of observations, actions, and
rewards. It is intentionally smaller than a learned recurrent network: callers
can concatenate the feature vector into world models, behavior models, Horde
demons, or actor-critic inputs while preserving temporal-uniform per-step
updates.
"""

from __future__ import annotations

import functools
from dataclasses import asdict, dataclass
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


@dataclass(frozen=True)
class WorkingMemoryConfig:
    """Configuration for :class:`WorkingMemoryFeaturizer`.

    Args:
        observation_dim: Observation vector dimensionality.
        action_dim: Action-feature dimensionality, usually one-hot actions.
        reward_dim: Reward/cumulant vector dimensionality.
        observation_decay_rates: EMA rates for observation traces.
        action_decay_rates: EMA rates for action traces.
        reward_decay_rates: EMA rates for reward traces.
        include_current_observation: Include the current observation in output.
        include_current_action: Include the current action vector in output.
        include_current_reward: Include the current reward vector in output.
        include_traces: Include all trace banks in output.
        include_innovations: Include current-minus-fast-trace innovations.
        gated_update: If true, trace updates are scaled by a surprise gate.
        gate_threshold: Surprise level where gated updates start opening.
        gate_temperature: Positive softness for the surprise gate.
    """

    observation_dim: int
    action_dim: int = 0
    reward_dim: int = 1
    observation_decay_rates: tuple[float, ...] = (0.5, 0.9, 0.99)
    action_decay_rates: tuple[float, ...] = (0.5, 0.9)
    reward_decay_rates: tuple[float, ...] = (0.5, 0.9)
    include_current_observation: bool = True
    include_current_action: bool = True
    include_current_reward: bool = True
    include_traces: bool = True
    include_innovations: bool = False
    gated_update: bool = False
    gate_threshold: float = 0.0
    gate_temperature: float = 1.0

    def feature_dim(self) -> int:
        """Return the working-memory feature dimensionality."""
        dim = 0
        if self.include_current_observation:
            dim += self.observation_dim
        if self.include_current_action:
            dim += self.action_dim
        if self.include_current_reward:
            dim += self.reward_dim
        if self.include_traces:
            dim += self.observation_dim * len(self.observation_decay_rates)
            dim += self.action_dim * len(self.action_decay_rates)
            dim += self.reward_dim * len(self.reward_decay_rates)
        if self.include_innovations:
            dim += self.observation_dim * int(len(self.observation_decay_rates) > 0)
            dim += self.action_dim * int(len(self.action_decay_rates) > 0)
            dim += self.reward_dim * int(len(self.reward_decay_rates) > 0)
        return dim

    def to_config(self) -> dict[str, Any]:
        """Serialize to a plain dictionary."""
        payload = asdict(self)
        payload["observation_decay_rates"] = list(self.observation_decay_rates)
        payload["action_decay_rates"] = list(self.action_decay_rates)
        payload["reward_decay_rates"] = list(self.reward_decay_rates)
        payload["type"] = "WorkingMemoryConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> WorkingMemoryConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        for key in (
            "observation_decay_rates",
            "action_decay_rates",
            "reward_decay_rates",
        ):
            if key in payload:
                payload[key] = tuple(payload[key])
        return cls(**payload)


@chex.dataclass(frozen=True)
class WorkingMemoryState:
    """State for :class:`WorkingMemoryFeaturizer`."""

    observation_traces: Float[Array, "n_observation_decays observation_dim"]
    action_traces: Float[Array, "n_action_decays action_dim"]
    reward_traces: Float[Array, "n_reward_decays reward_dim"]
    step_count: Array
    last_gate: Float[Array, " 3"]


@chex.dataclass(frozen=True)
class WorkingMemoryDiagnostics:
    """Scalar diagnostics for the current memory state."""

    step_count: Array
    trace_energy: Array
    effective_dimension: Array
    observation_energy: Array
    action_energy: Array
    reward_energy: Array
    last_gate: Float[Array, " 3"]


def _validate_decay_rates(name: str, rates: tuple[float, ...]) -> None:
    if any(rate < 0.0 or rate >= 1.0 for rate in rates):
        raise ValueError(f"{name} must lie in [0, 1); got {rates}")


def _validate_config(config: WorkingMemoryConfig) -> None:
    if config.observation_dim < 1:
        raise ValueError("observation_dim must be positive")
    if config.action_dim < 0:
        raise ValueError("action_dim must be non-negative")
    if config.reward_dim < 0:
        raise ValueError("reward_dim must be non-negative")
    _validate_decay_rates("observation_decay_rates", config.observation_decay_rates)
    _validate_decay_rates("action_decay_rates", config.action_decay_rates)
    _validate_decay_rates("reward_decay_rates", config.reward_decay_rates)
    if config.gate_temperature <= 0.0:
        raise ValueError("gate_temperature must be positive")
    if config.gate_threshold < 0.0:
        raise ValueError("gate_threshold must be non-negative")
    if config.feature_dim() < 1:
        raise ValueError("configuration must produce at least one feature")


def _empty_or_vector(value: Array, dim: int) -> Array:
    return jnp.asarray(value, dtype=jnp.float32).reshape((dim,))


def _trace_bank(decay_count: int, dim: int) -> Array:
    return jnp.zeros((decay_count, dim), dtype=jnp.float32)


def _flatten_traces(state: WorkingMemoryState) -> Array:
    return jnp.concatenate(
        [
            state.observation_traces.reshape(-1),
            state.action_traces.reshape(-1),
            state.reward_traces.reshape(-1),
        ],
        axis=0,
    )


def _root_mean_square(values: Array) -> Array:
    if values.size == 0:
        return jnp.asarray(0.0, dtype=jnp.float32)
    return jnp.sqrt(jnp.mean(values * values))


def _effective_dimension(values: Array) -> Array:
    if values.size == 0:
        return jnp.asarray(0.0, dtype=jnp.float32)
    squared = values * values
    energy = jnp.sum(squared)
    fourth = jnp.sum(squared * squared)
    return jnp.where(fourth > 0.0, (energy * energy) / fourth, 0.0)


class WorkingMemoryFeaturizer:
    """Causal observation/action/reward trace features.

    ``features(state, observation, action, reward)`` exposes the current
    signals plus pre-update traces. ``update`` then advances memory with the
    same transition. This ordering lets callers predict the next environment
    event from information available before the current event is written into
    memory, while still allowing current observation/action/reward to be part
    of the model input when configured.
    """

    def __init__(self, config: WorkingMemoryConfig):
        _validate_config(config)
        self._config = config

    @property
    def config(self) -> WorkingMemoryConfig:
        """Featurizer configuration."""
        return self._config

    def feature_dim(self) -> int:
        """Return the working-memory feature dimensionality."""
        return self._config.feature_dim()

    def to_config(self) -> dict[str, Any]:
        """Serialize the featurizer configuration."""
        return {
            "type": "WorkingMemoryFeaturizer",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> WorkingMemoryFeaturizer:
        """Reconstruct a featurizer from :meth:`to_config` output."""
        return cls(WorkingMemoryConfig.from_config(dict(config["config"])))

    def init(self) -> WorkingMemoryState:
        """Return an all-zero memory state."""
        cfg = self._config
        return WorkingMemoryState(
            observation_traces=_trace_bank(
                len(cfg.observation_decay_rates),
                cfg.observation_dim,
            ),
            action_traces=_trace_bank(len(cfg.action_decay_rates), cfg.action_dim),
            reward_traces=_trace_bank(len(cfg.reward_decay_rates), cfg.reward_dim),
            step_count=jnp.array(0, dtype=jnp.int32),
            last_gate=jnp.ones((3,), dtype=jnp.float32),
        )

    def reset(self) -> WorkingMemoryState:
        """Reset memory to its initial all-zero state."""
        return self.init()

    def zero_action(self) -> Float[Array, " action_dim"]:
        """Return a zero action vector with the configured dimension."""
        return jnp.zeros((self._config.action_dim,), dtype=jnp.float32)

    def zero_reward(self) -> Float[Array, " reward_dim"]:
        """Return a zero reward vector with the configured dimension."""
        return jnp.zeros((self._config.reward_dim,), dtype=jnp.float32)

    def _surprise_gate(self, traces: Array, value: Array, threshold: Array) -> Array:
        if (not self._config.gated_update) or traces.shape[0] == 0 or value.size == 0:
            return jnp.asarray(1.0, dtype=jnp.float32)
        surprise = _root_mean_square(value - traces[0])
        temperature = jnp.asarray(self._config.gate_temperature, dtype=jnp.float32)
        return jax.nn.sigmoid((surprise - threshold) / temperature)

    @staticmethod
    def _update_trace_bank(
        traces: Array,
        value: Array,
        decay_rates: tuple[float, ...],
        gate: Array,
    ) -> Array:
        if len(decay_rates) == 0:
            return traces
        decay = jnp.asarray(decay_rates, dtype=jnp.float32)[:, None]
        update_rate = (1.0 - decay) * gate
        return traces + update_rate * (value[None, :] - traces)

    @functools.partial(jax.jit, static_argnums=(0,))
    def features(
        self,
        state: WorkingMemoryState,
        observation: Float[Array, " observation_dim"],
        action: Float[Array, " action_dim"],
        reward: Float[Array, " reward_dim"],
    ) -> Float[Array, " feature_dim"]:
        """Return current working-memory features without advancing state."""
        cfg = self._config
        obs = _empty_or_vector(observation, cfg.observation_dim)
        act = _empty_or_vector(action, cfg.action_dim)
        rew = _empty_or_vector(reward, cfg.reward_dim)

        blocks = []
        if cfg.include_current_observation:
            blocks.append(obs)
        if cfg.include_current_action:
            blocks.append(act)
        if cfg.include_current_reward:
            blocks.append(rew)
        if cfg.include_traces:
            blocks.extend(
                [
                    state.observation_traces.reshape(-1),
                    state.action_traces.reshape(-1),
                    state.reward_traces.reshape(-1),
                ]
            )
        if cfg.include_innovations:
            if len(cfg.observation_decay_rates) > 0:
                blocks.append(obs - state.observation_traces[0])
            if len(cfg.action_decay_rates) > 0:
                blocks.append(act - state.action_traces[0])
            if len(cfg.reward_decay_rates) > 0:
                blocks.append(rew - state.reward_traces[0])
        return jnp.concatenate(blocks, axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: WorkingMemoryState,
        observation: Float[Array, " observation_dim"],
        action: Float[Array, " action_dim"],
        reward: Float[Array, " reward_dim"],
        external_gate: Float[Array, ""] | float = 1.0,
    ) -> WorkingMemoryState:
        """Advance memory after one observation/action/reward transition."""
        cfg = self._config
        obs = _empty_or_vector(observation, cfg.observation_dim)
        act = _empty_or_vector(action, cfg.action_dim)
        rew = _empty_or_vector(reward, cfg.reward_dim)
        outer_gate = jnp.clip(jnp.asarray(external_gate, dtype=jnp.float32), 0.0, 1.0)
        threshold = jnp.asarray(cfg.gate_threshold, dtype=jnp.float32)

        observation_gate = outer_gate * self._surprise_gate(
            state.observation_traces,
            obs,
            threshold,
        )
        action_gate = outer_gate * self._surprise_gate(
            state.action_traces,
            act,
            threshold,
        )
        reward_gate = outer_gate * self._surprise_gate(
            state.reward_traces,
            rew,
            threshold,
        )

        return WorkingMemoryState(
            observation_traces=self._update_trace_bank(
                state.observation_traces,
                obs,
                cfg.observation_decay_rates,
                observation_gate,
            ),
            action_traces=self._update_trace_bank(
                state.action_traces,
                act,
                cfg.action_decay_rates,
                action_gate,
            ),
            reward_traces=self._update_trace_bank(
                state.reward_traces,
                rew,
                cfg.reward_decay_rates,
                reward_gate,
            ),
            step_count=state.step_count + 1,
            last_gate=jnp.stack([observation_gate, action_gate, reward_gate]),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def step(
        self,
        state: WorkingMemoryState,
        observation: Float[Array, " observation_dim"],
        action: Float[Array, " action_dim"],
        reward: Float[Array, " reward_dim"],
        external_gate: Float[Array, ""] | float = 1.0,
    ) -> tuple[WorkingMemoryState, Float[Array, " feature_dim"]]:
        """Return pre-update features, then advance memory."""
        features = self.features(state, observation, action, reward)
        next_state = self.update(state, observation, action, reward, external_gate)
        return next_state, features

    @functools.partial(jax.jit, static_argnums=(0,))
    def diagnostics(self, state: WorkingMemoryState) -> WorkingMemoryDiagnostics:
        """Return memory energy, participation-ratio dimension, and gates."""
        flat = _flatten_traces(state)
        return WorkingMemoryDiagnostics(
            step_count=state.step_count,
            trace_energy=_root_mean_square(flat),
            effective_dimension=_effective_dimension(flat),
            observation_energy=_root_mean_square(state.observation_traces.reshape(-1)),
            action_energy=_root_mean_square(state.action_traces.reshape(-1)),
            reward_energy=_root_mean_square(state.reward_traces.reshape(-1)),
            last_gate=state.last_gate,
        )


def transform_working_memory_arrays(
    featurizer: WorkingMemoryFeaturizer,
    observations: Float[Array, "steps observation_dim"],
    actions: Float[Array, "steps action_dim"],
    rewards: Float[Array, "steps reward_dim"],
    *,
    state: WorkingMemoryState | None = None,
    external_gates: Float[Array, " steps"] | None = None,
) -> tuple[WorkingMemoryState, Float[Array, "steps feature_dim"]]:
    """Transform transition arrays into causal working-memory features."""
    if state is None:
        state = featurizer.init()
    gates = (
        jnp.ones((observations.shape[0],), dtype=jnp.float32)
        if external_gates is None
        else jnp.asarray(external_gates, dtype=jnp.float32)
    )

    def step_fn(
        carry: WorkingMemoryState,
        inputs: tuple[Array, Array, Array, Array],
    ) -> tuple[WorkingMemoryState, Array]:
        obs, act, rew, gate = inputs
        return cast(
            tuple[WorkingMemoryState, Array],
            featurizer.step(carry, obs, act, rew, gate),
        )

    return cast(
        tuple[WorkingMemoryState, Float[Array, "steps feature_dim"]],
        jax.lax.scan(step_fn, state, (observations, actions, rewards, gates)),
    )
