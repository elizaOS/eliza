# mypy: disable-error-code="call-arg,name-defined"
"""Causal temporal/context features for non-stationary Step 2 streams."""

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
class TemporalContextConfig:
    """Configuration for :class:`TemporalContextFeaturizer`.

    The featurizer is causal: features at time ``t`` use the pre-update EMA and
    the current step counter, then the EMA is advanced after the observation is
    exposed.  This is meant for streams whose target changes with slowly moving
    latent context, such as rotating relevant subspaces.
    """

    input_dim: int
    include_raw: bool = True
    include_ema: bool = True
    include_delta: bool = True
    include_phase_products: bool = False
    ema_decay: float = 0.95
    periods: tuple[float, ...] = (50.0, 100.0, 200.0)

    def output_dim(self) -> int:
        """Return the transformed feature dimensionality."""
        copies = int(self.include_raw) + int(self.include_ema) + int(self.include_delta)
        phase_dim = 2 * len(self.periods)
        product_dim = phase_dim * self.input_dim * int(self.include_phase_products)
        return copies * self.input_dim + phase_dim + product_dim

    def to_config(self) -> dict[str, Any]:
        """Serialize to a plain dictionary."""
        payload = asdict(self)
        payload["periods"] = list(self.periods)
        payload["type"] = "TemporalContextConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> TemporalContextConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        if "periods" in payload:
            payload["periods"] = tuple(payload["periods"])
        return cls(**payload)


@chex.dataclass(frozen=True)
class TemporalContextState:
    """State for :class:`TemporalContextFeaturizer`."""

    observation_ema: Float[Array, " input_dim"]
    step_count: Array


def _validate_config(config: TemporalContextConfig) -> None:
    if config.input_dim < 1:
        raise ValueError("input_dim must be positive")
    if not (config.include_raw or config.include_ema or config.include_delta):
        raise ValueError("at least one observation feature block must be included")
    if not 0.0 <= config.ema_decay < 1.0:
        raise ValueError("ema_decay must be in [0, 1)")
    if any(period <= 0.0 for period in config.periods):
        raise ValueError("all temporal periods must be positive")


class TemporalContextFeaturizer:
    """Causal feature wrapper exposing EMA, innovation, and phase features."""

    def __init__(self, config: TemporalContextConfig):
        _validate_config(config)
        self._config = config

    @property
    def config(self) -> TemporalContextConfig:
        """Featurizer configuration."""
        return self._config

    def init(self) -> TemporalContextState:
        """Return an all-zero initial context state."""
        return TemporalContextState(
            observation_ema=jnp.zeros(self._config.input_dim, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def features(
        self,
        state: TemporalContextState,
        observation: Float[Array, " input_dim"],
    ) -> Float[Array, " output_dim"]:
        """Return current causal context features without advancing state."""
        cfg = self._config
        obs = jnp.asarray(observation, dtype=jnp.float32)
        blocks = []
        if cfg.include_raw:
            blocks.append(obs)
        if cfg.include_ema:
            blocks.append(state.observation_ema)
        if cfg.include_delta:
            blocks.append(obs - state.observation_ema)
        if cfg.periods:
            step = state.step_count.astype(jnp.float32)
            periods = jnp.asarray(cfg.periods, dtype=jnp.float32)
            angles = (2.0 * jnp.pi * step) / periods
            phase = jnp.ravel(jnp.stack([jnp.sin(angles), jnp.cos(angles)], axis=1))
            blocks.append(phase)
            if cfg.include_phase_products:
                blocks.append(jnp.ravel(phase[:, None] * obs[None, :]))
        return jnp.concatenate(blocks, axis=0)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: TemporalContextState,
        observation: Float[Array, " input_dim"],
    ) -> TemporalContextState:
        """Advance the context state after observing one input."""
        decay = jnp.asarray(self._config.ema_decay, dtype=jnp.float32)
        obs = jnp.asarray(observation, dtype=jnp.float32)
        return TemporalContextState(
            observation_ema=decay * state.observation_ema + (1.0 - decay) * obs,
            step_count=state.step_count + 1,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def step(
        self,
        state: TemporalContextState,
        observation: Float[Array, " input_dim"],
    ) -> tuple[TemporalContextState, Float[Array, " output_dim"]]:
        """Return features and then advance context state."""
        features = self.features(state, observation)
        next_state = self.update(state, observation)
        return next_state, features


def transform_temporal_context_arrays(
    featurizer: TemporalContextFeaturizer,
    observations: Float[Array, "steps input_dim"],
    *,
    state: TemporalContextState | None = None,
) -> tuple[TemporalContextState, Float[Array, "steps output_dim"]]:
    """Transform an observation array with a causal scan."""
    if state is None:
        state = featurizer.init()

    def step_fn(
        carry: TemporalContextState,
        observation: Array,
    ) -> tuple[TemporalContextState, Array]:
        return cast(tuple[TemporalContextState, Array], featurizer.step(carry, observation))

    return cast(
        tuple[TemporalContextState, Float[Array, "steps output_dim"]],
        jax.lax.scan(step_fn, state, observations),
    )
