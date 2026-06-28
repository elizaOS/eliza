# mypy: disable-error-code="call-arg,name-defined"
"""Prototype basis blocks for recursive Step 2 feature construction.

Unlike :mod:`alberta_framework.core.prototype_memory`, this module is not a
classifier.  It exposes a global novelty-allocated RBF-like basis with a
trainable value/readout map.  The same block can be used as:

* an online supervised learner with prototype activations as features,
* a recursive feature map by feeding activations into another basis, or
* a transformer FFN/residual sublayer by mapping hidden states through the basis.
"""

from __future__ import annotations

import functools
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float


@chex.dataclass(frozen=True)
class PrototypeBasisConfig:
    """Configuration for :class:`PrototypeBasisBlock`.

    Args:
        input_dim: Input feature dimensionality.
        output_dim: Output dimensionality for the trainable value map.
        n_prototypes: Global fixed prototype budget.
        step_size: Online LMS step-size for values and bias.
        update_rate: EMA update rate for matched centers.
        novelty_threshold: Mean-squared-distance threshold for allocation.
        bandwidth: Initial activation bandwidth.
        adaptive_bandwidth: Whether matched centers adapt their bandwidths from
            observed assignment distances.
        bandwidth_update_rate: EMA rate for adaptive bandwidth updates.
        min_bandwidth: Lower clipping bound for per-prototype bandwidths.
        max_bandwidth: Upper clipping bound for per-prototype bandwidths.
        normalize_activations: Normalize active RBF activations to sum to one.
        value_init_scale: Random value initialization scale. Zero gives a
            neutral residual/readout map.
    """

    input_dim: int
    output_dim: int
    n_prototypes: int = 64
    step_size: float = 0.05
    update_rate: float = 0.3
    novelty_threshold: float = 0.08
    bandwidth: float = 0.01
    adaptive_bandwidth: bool = False
    bandwidth_update_rate: float = 0.1
    min_bandwidth: float = 1e-4
    max_bandwidth: float = 10.0
    normalize_activations: bool = True
    value_init_scale: float = 0.0

    def to_config(self) -> dict[str, Any]:
        """Serialize to a plain dictionary."""
        return {
            "type": "PrototypeBasisConfig",
            "input_dim": self.input_dim,
            "output_dim": self.output_dim,
            "n_prototypes": self.n_prototypes,
            "step_size": self.step_size,
            "update_rate": self.update_rate,
            "novelty_threshold": self.novelty_threshold,
            "bandwidth": self.bandwidth,
            "adaptive_bandwidth": self.adaptive_bandwidth,
            "bandwidth_update_rate": self.bandwidth_update_rate,
            "min_bandwidth": self.min_bandwidth,
            "max_bandwidth": self.max_bandwidth,
            "normalize_activations": self.normalize_activations,
            "value_init_scale": self.value_init_scale,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> PrototypeBasisConfig:
        """Reconstruct from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class PrototypeBasisParams:
    """Trainable value map for a prototype basis."""

    values: Float[Array, "n_prototypes output_dim"]
    bias: Float[Array, " output_dim"]


@chex.dataclass(frozen=True)
class PrototypeBasisState:
    """Non-gradient prototype center state."""

    centers: Float[Array, "n_prototypes input_dim"]
    bandwidths: Float[Array, " n_prototypes"]
    counts: Float[Array, " n_prototypes"]
    last_update: Array
    step_count: Array


@chex.dataclass(frozen=True)
class PrototypeBasisUpdateResult:
    """Result of one prototype-basis online update."""

    params: PrototypeBasisParams
    state: PrototypeBasisState
    prediction: Float[Array, " output_dim"]
    activations: Float[Array, " n_prototypes"]
    error: Float[Array, " output_dim"]
    metrics: Float[Array, " 6"]


@chex.dataclass(frozen=True)
class PrototypeBasisLearningResult:
    """Result from :func:`run_prototype_basis_arrays`."""

    params: PrototypeBasisParams
    state: PrototypeBasisState
    predictions: Float[Array, "steps output_dim"]
    activations: Float[Array, "steps n_prototypes"]
    metrics: Float[Array, "steps 6"]


def _validate_config(config: PrototypeBasisConfig) -> None:
    if config.input_dim < 1:
        raise ValueError("input_dim must be positive")
    if config.output_dim < 1:
        raise ValueError("output_dim must be positive")
    if config.n_prototypes < 1:
        raise ValueError("n_prototypes must be positive")
    if config.step_size < 0.0:
        raise ValueError("step_size must be non-negative")
    if not 0.0 < config.update_rate <= 1.0:
        raise ValueError("update_rate must be in (0, 1]")
    if config.novelty_threshold < 0.0:
        raise ValueError("novelty_threshold must be non-negative")
    if config.bandwidth <= 0.0:
        raise ValueError("bandwidth must be positive")
    if not 0.0 <= config.bandwidth_update_rate <= 1.0:
        raise ValueError("bandwidth_update_rate must be in [0, 1]")
    if config.min_bandwidth <= 0.0:
        raise ValueError("min_bandwidth must be positive")
    if config.max_bandwidth < config.min_bandwidth:
        raise ValueError("max_bandwidth must be >= min_bandwidth")
    if config.value_init_scale < 0.0:
        raise ValueError("value_init_scale must be non-negative")


class PrototypeBasisBlock:
    """Global online prototype basis with a trainable value map."""

    def __init__(self, config: PrototypeBasisConfig):
        _validate_config(config)
        self._config = config

    @property
    def config(self) -> PrototypeBasisConfig:
        """Block configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize the block configuration."""
        return {"type": "PrototypeBasisBlock", "config": self._config.to_config()}

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> PrototypeBasisBlock:
        """Reconstruct a block from :meth:`to_config` output."""
        return cls(PrototypeBasisConfig.from_config(dict(config["config"])))

    def init(self, key: Array | None = None) -> tuple[PrototypeBasisParams, PrototypeBasisState]:
        """Create initial params and empty prototype state."""
        c = self._config
        if key is None:
            key = jr.key(0)
        if c.value_init_scale > 0.0:
            values = c.value_init_scale * jr.normal(
                key,
                (c.n_prototypes, c.output_dim),
                dtype=jnp.float32,
            )
        else:
            values = jnp.zeros((c.n_prototypes, c.output_dim), dtype=jnp.float32)
        params = PrototypeBasisParams(
            values=values,
            bias=jnp.zeros(c.output_dim, dtype=jnp.float32),
        )
        state = PrototypeBasisState(
            centers=jnp.zeros((c.n_prototypes, c.input_dim), dtype=jnp.float32),
            bandwidths=jnp.full((c.n_prototypes,), c.bandwidth, dtype=jnp.float32),
            counts=jnp.zeros((c.n_prototypes,), dtype=jnp.float32),
            last_update=jnp.zeros((c.n_prototypes,), dtype=jnp.int32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )
        return params, state

    @functools.partial(jax.jit, static_argnums=(0,))
    def activations(
        self,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
    ) -> Float[Array, " n_prototypes"]:
        """Return RBF-like activations for one observation."""
        diffs = state.centers - observation[None, :]
        distances = jnp.mean(diffs * diffs, axis=1)
        active = state.counts > 0.0
        bandwidths = jnp.clip(
            state.bandwidths,
            self._config.min_bandwidth,
            self._config.max_bandwidth,
        )
        acts = jnp.exp(-distances / jnp.maximum(bandwidths, 1e-12))
        acts = jnp.where(active, acts, 0.0)
        if self._config.normalize_activations:
            acts = acts / jnp.maximum(jnp.sum(acts), 1e-12)
        return acts

    @staticmethod
    def transform(
        params: PrototypeBasisParams,
        activations: Float[Array, " n_prototypes"],
    ) -> Float[Array, " output_dim"]:
        """Map prototype activations through trainable values."""
        return activations @ params.values + params.bias

    def _replacement_slot(self, state: PrototypeBasisState) -> Array:
        """Choose least-used, then oldest, slot."""
        min_count = jnp.min(state.counts)
        tied = state.counts <= (min_count + 1e-6)
        oldest = jnp.where(
            tied,
            state.last_update,
            jnp.array(2_147_483_647, dtype=state.last_update.dtype),
        )
        return jnp.argmin(oldest)

    def _update_centers_with_slot_impl(
        self,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
    ) -> tuple[PrototypeBasisState, Float[Array, " 3"], Array, Array]:
        used = state.counts > 0.0
        has_used = jnp.any(used)
        has_empty = jnp.any(~used)
        distances = jnp.mean((state.centers - observation[None, :]) ** 2, axis=1)
        used_distances = jnp.where(used, distances, jnp.inf)
        nearest_slot = jnp.argmin(used_distances)
        nearest_distance = used_distances[nearest_slot]
        empty_slot = jnp.argmax((~used).astype(jnp.int32))
        replacement_slot = self._replacement_slot(state)
        novel = (~has_used) | (
            nearest_distance
            > jnp.asarray(self._config.novelty_threshold, dtype=jnp.float32)
        )
        slot = jnp.where(
            ~has_used,
            jnp.array(0, dtype=nearest_slot.dtype),
            jnp.where(
                novel & has_empty,
                empty_slot,
                jnp.where(novel, replacement_slot, nearest_slot),
            ),
        )
        eta = jnp.asarray(self._config.update_rate, dtype=jnp.float32)
        old_center = state.centers[slot]
        new_center = jnp.where(
            novel,
            observation,
            old_center + eta * (observation - old_center),
        )
        old_bandwidth = state.bandwidths[slot]
        distance_for_bandwidth = jnp.maximum(nearest_distance, self._config.min_bandwidth)
        bandwidth_eta = jnp.asarray(self._config.bandwidth_update_rate, dtype=jnp.float32)
        adapted_bandwidth = old_bandwidth + bandwidth_eta * (
            distance_for_bandwidth - old_bandwidth
        )
        new_bandwidth = jnp.where(
            self._config.adaptive_bandwidth & (~novel),
            jnp.clip(
                adapted_bandwidth,
                self._config.min_bandwidth,
                self._config.max_bandwidth,
            ),
            jnp.asarray(self._config.bandwidth, dtype=jnp.float32),
        )
        new_count = jnp.where(novel, 1.0, state.counts[slot] + 1.0)
        new_state = PrototypeBasisState(
            centers=state.centers.at[slot].set(new_center),
            bandwidths=state.bandwidths.at[slot].set(new_bandwidth),
            counts=state.counts.at[slot].set(new_count),
            last_update=state.last_update.at[slot].set(state.step_count + 1),
            step_count=state.step_count + 1,
        )
        active_count = jnp.sum(new_state.counts > 0.0).astype(jnp.float32)
        metrics = jnp.asarray(
            [
                active_count,
                novel.astype(jnp.float32),
                jnp.where(has_used, nearest_distance, jnp.array(0.0, dtype=jnp.float32)),
            ],
            dtype=jnp.float32,
        )
        return new_state, metrics, slot, novel

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_centers_with_slot(
        self,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
    ) -> tuple[PrototypeBasisState, Float[Array, " 3"], Array, Array]:
        """Allocate or update a center and return the selected slot.

        This is equivalent to calling the external slot selector followed by
        :meth:`update_centers`, but computes nearest-center distances once.
        The return tuple is ``(state, metrics, slot, novel)``.
        """
        return self._update_centers_with_slot_impl(state, observation)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_centers(
        self,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
    ) -> tuple[PrototypeBasisState, Float[Array, " 3"]]:
        """Allocate or update the nearest prototype center."""
        new_state, metrics, _, _ = self._update_centers_with_slot_impl(state, observation)
        return new_state, metrics

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        params: PrototypeBasisParams,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
    ) -> Float[Array, " output_dim"]:
        """Return the current value-map output."""
        return self.transform(params, self.activations(state, observation))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        params: PrototypeBasisParams,
        state: PrototypeBasisState,
        observation: Float[Array, " input_dim"],
        target: Float[Array, " output_dim"],
    ) -> PrototypeBasisUpdateResult:
        """Perform one online LMS value update and one center update."""
        features = self.activations(state, observation)
        prediction = self.transform(params, features)
        error = prediction - target
        new_values = params.values - self._config.step_size * features[:, None] * error[None, :]
        new_bias = params.bias - self._config.step_size * error
        new_params = PrototypeBasisParams(values=new_values, bias=new_bias)
        new_state, center_metrics = self.update_centers(state, observation)
        mse = jnp.mean(error * error)
        metrics = jnp.asarray(
            [
                mse,
                jnp.max(jnp.abs(error)),
                jnp.sum(features > 1e-6).astype(jnp.float32),
                center_metrics[0],
                center_metrics[1],
                center_metrics[2],
            ],
            dtype=jnp.float32,
        )
        return PrototypeBasisUpdateResult(
            params=new_params,
            state=new_state,
            prediction=prediction,
            activations=features,
            error=error,
            metrics=metrics,
        )


def run_prototype_basis_arrays(
    block: PrototypeBasisBlock,
    observations: Float[Array, "steps input_dim"],
    targets: Float[Array, "steps output_dim"],
    *,
    params: PrototypeBasisParams | None = None,
    state: PrototypeBasisState | None = None,
    key: Array | None = None,
) -> PrototypeBasisLearningResult:
    """Run the prototype basis over arrays with ``jax.lax.scan``.

    Metric columns are ``mse, max_abs_error, active_features,
    active_prototypes, allocated, nearest_distance``.
    """
    if params is None or state is None:
        params, state = block.init(key)

    def step_fn(
        carry: tuple[PrototypeBasisParams, PrototypeBasisState],
        batch: tuple[Array, Array],
    ) -> tuple[tuple[PrototypeBasisParams, PrototypeBasisState], tuple[Array, Array, Array]]:
        params_inner, state_inner = carry
        observation, target = batch
        result = block.update(params_inner, state_inner, observation, target)
        return (
            result.params,
            result.state,
        ), (result.prediction, result.activations, result.metrics)

    (final_params, final_state), (predictions, activations, metrics) = jax.lax.scan(
        step_fn,
        (params, state),
        (observations, targets),
    )
    return PrototypeBasisLearningResult(
        params=final_params,
        state=final_state,
        predictions=predictions,
        activations=activations,
        metrics=metrics,
    )
