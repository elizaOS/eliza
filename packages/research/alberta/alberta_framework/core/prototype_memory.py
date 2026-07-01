# mypy: disable-error-code="call-arg,name-defined"
"""Fixed-budget JAX prototype memory for Step 2 retention.

This module distills the D20 OPMNIST research runner into a scan-compatible
core learner.  It keeps multiple novelty-allocated prototypes per class and
predicts with a softmax over nearest-prototype class logits.  The budget is
static, every step can update the memory, and the state is a JAX PyTree.
"""

from __future__ import annotations

import functools
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


@chex.dataclass(frozen=True)
class PrototypeMemoryConfig:
    """Configuration for :class:`PrototypeMemoryLearner`.

    Args:
        feature_dim: Observation dimensionality.
        n_classes: Number of one-hot classes.
        slots_per_class: Fixed prototype budget for each class.
        update_rate: EMA rate for updating a matched prototype.
        novelty_threshold: Mean-squared-distance threshold for allocating a
            new prototype instead of updating the nearest existing one.
        bandwidth: Distance-to-logit bandwidth for softmax prediction.
    """

    feature_dim: int
    n_classes: int
    slots_per_class: int = 20
    update_rate: float = 0.3
    novelty_threshold: float = 0.08
    bandwidth: float = 0.01

    def to_config(self) -> dict[str, Any]:
        """Serialize to a plain dictionary."""
        return {
            "type": "PrototypeMemoryConfig",
            "feature_dim": self.feature_dim,
            "n_classes": self.n_classes,
            "slots_per_class": self.slots_per_class,
            "update_rate": self.update_rate,
            "novelty_threshold": self.novelty_threshold,
            "bandwidth": self.bandwidth,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> PrototypeMemoryConfig:
        """Reconstruct from :meth:`to_config` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


@chex.dataclass(frozen=True)
class PrototypeMemoryState:
    """State for :class:`PrototypeMemoryLearner`."""

    means: Float[Array, "n_classes slots_per_class feature_dim"]
    counts: Float[Array, "n_classes slots_per_class"]
    last_update: Array
    step_count: Array


@chex.dataclass(frozen=True)
class PrototypeMemoryUpdateResult:
    """Result of one prototype-memory update."""

    state: PrototypeMemoryState
    predictions: Float[Array, " n_classes"]
    errors: Float[Array, " n_classes"]
    metrics: Float[Array, " 6"]


@chex.dataclass(frozen=True)
class PrototypeMemoryLearningResult:
    """Result from :func:`run_prototype_memory_arrays`."""

    state: PrototypeMemoryState
    predictions: Float[Array, "steps n_classes"]
    metrics: Float[Array, "steps 6"]


def _validate_config(config: PrototypeMemoryConfig) -> None:
    if config.feature_dim < 1:
        raise ValueError("feature_dim must be positive")
    if config.n_classes < 2:
        raise ValueError("n_classes must be at least 2")
    if config.slots_per_class < 1:
        raise ValueError("slots_per_class must be positive")
    if not 0.0 < config.update_rate <= 1.0:
        raise ValueError("update_rate must be in (0, 1]")
    if config.novelty_threshold < 0.0:
        raise ValueError("novelty_threshold must be non-negative")
    if config.bandwidth <= 0.0:
        raise ValueError("bandwidth must be positive")


def _softmax(logits: Array) -> Array:
    shifted = logits - jnp.max(logits)
    exp = jnp.exp(shifted)
    return exp / jnp.maximum(jnp.sum(exp), 1e-12)


class PrototypeMemoryLearner:
    """Fixed-budget multi-prototype classifier.

    The learner assumes one-hot classification targets.  Non-finite or
    non-simplex targets are ignored by the memory update but still produce a
    prediction and metrics.  This keeps the learner safe in mixed-head streams.
    """

    def __init__(self, config: PrototypeMemoryConfig):
        _validate_config(config)
        self._config = config

    @property
    def config(self) -> PrototypeMemoryConfig:
        """Learner configuration."""
        return self._config

    def to_config(self) -> dict[str, Any]:
        """Serialize the learner configuration."""
        return {
            "type": "PrototypeMemoryLearner",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> PrototypeMemoryLearner:
        """Reconstruct a learner from :meth:`to_config` output."""
        inner = dict(config["config"])
        return cls(PrototypeMemoryConfig.from_config(inner))

    def init(self) -> PrototypeMemoryState:
        """Create an empty fixed-budget memory."""
        c = self._config
        return PrototypeMemoryState(
            means=jnp.zeros(
                (c.n_classes, c.slots_per_class, c.feature_dim),
                dtype=jnp.float32,
            ),
            counts=jnp.zeros((c.n_classes, c.slots_per_class), dtype=jnp.float32),
            last_update=jnp.zeros((c.n_classes, c.slots_per_class), dtype=jnp.int32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def class_logits(
        self,
        state: PrototypeMemoryState,
        observation: Float[Array, " feature_dim"],
    ) -> Float[Array, " n_classes"]:
        """Return class logits from nearest active prototype distances."""
        x = jnp.asarray(observation, dtype=jnp.float32)
        diffs = state.means - x[None, None, :]
        distances = jnp.mean(diffs * diffs, axis=2)
        slot_logits = -distances / jnp.asarray(self._config.bandwidth, dtype=jnp.float32)
        slot_logits = jnp.where(state.counts > 0.0, slot_logits, -jnp.inf)
        logits = jnp.max(slot_logits, axis=1)
        any_active = jnp.any(state.counts > 0.0, axis=1)
        logits = jnp.where(any_active, logits, -1e9)
        logits = jnp.where(jnp.any(any_active), logits, jnp.zeros_like(logits))
        return logits

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: PrototypeMemoryState,
        observation: Float[Array, " feature_dim"],
    ) -> Float[Array, " n_classes"]:
        """Return class probabilities for one observation."""
        return _softmax(self.class_logits(state, observation))

    @staticmethod
    def valid_one_hot_target(target: Array) -> Array:
        """Return whether ``target`` is a finite one-hot/simplex target."""
        finite = jnp.all(jnp.isfinite(target))
        target_sum = jnp.sum(target)
        max_target = jnp.max(target)
        non_negative = jnp.all(target >= -1e-6)
        return finite & non_negative & (jnp.abs(target_sum - 1.0) <= 1e-5) & (
            max_target >= 0.999
        )

    def _replacement_slot(self, state: PrototypeMemoryState, head: Array) -> Array:
        """Choose least-used, then oldest, slot for a full class budget."""
        class_counts = state.counts[head]
        class_last_update = state.last_update[head]
        min_count = jnp.min(class_counts)
        tied = class_counts <= (min_count + 1e-6)
        oldest_among_tied = jnp.where(
            tied,
            class_last_update,
            jnp.array(2_147_483_647, dtype=class_last_update.dtype),
        )
        return jnp.argmin(oldest_among_tied)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_with_novelty_threshold(
        self,
        state: PrototypeMemoryState,
        observation: Float[Array, " feature_dim"],
        target: Float[Array, " n_classes"],
        novelty_threshold: Float[Array, ""],
    ) -> PrototypeMemoryUpdateResult:
        """Perform one causal update with a runtime novelty threshold."""
        prediction = self.predict(state, observation)
        valid_target = self.valid_one_hot_target(target)
        safe_target = jnp.where(jnp.isfinite(target), target, 0.0)
        errors = prediction - safe_target
        mse = jnp.mean(errors * errors)
        confidence = jnp.max(prediction)
        correct = jnp.where(
            valid_target,
            (jnp.argmax(prediction) == jnp.argmax(safe_target)).astype(jnp.float32),
            jnp.array(0.0, dtype=jnp.float32),
        )

        def do_update(current: PrototypeMemoryState) -> tuple[PrototypeMemoryState, Array]:
            head = jnp.argmax(safe_target)
            used = current.counts[head] > 0.0
            has_used = jnp.any(used)
            has_empty = jnp.any(~used)
            distances = jnp.mean(
                (current.means[head] - observation[None, :]) ** 2,
                axis=1,
            )
            used_distances = jnp.where(used, distances, jnp.inf)
            nearest_slot = jnp.argmin(used_distances)
            nearest_distance = used_distances[nearest_slot]
            empty_slot = jnp.argmax((~used).astype(jnp.int32))
            replacement_slot = self._replacement_slot(current, head)
            threshold = jnp.asarray(novelty_threshold, dtype=jnp.float32)
            novel = (~has_used) | (nearest_distance > threshold)
            slot = jnp.where(
                ~has_used,
                jnp.array(0, dtype=nearest_slot.dtype),
                jnp.where(
                    novel & has_empty,
                    empty_slot,
                    jnp.where(novel, replacement_slot, nearest_slot),
                ),
            )
            old_mean = current.means[head, slot]
            eta = jnp.asarray(self._config.update_rate, dtype=jnp.float32)
            new_mean = jnp.where(novel, observation, old_mean + eta * (observation - old_mean))
            new_count = jnp.where(novel, 1.0, current.counts[head, slot] + 1.0)
            next_state = PrototypeMemoryState(
                means=current.means.at[head, slot].set(new_mean),
                counts=current.counts.at[head, slot].set(new_count),
                last_update=current.last_update.at[head, slot].set(
                    current.step_count + 1
                ),
                step_count=current.step_count + 1,
            )
            return next_state, novel.astype(jnp.float32)

        def skip_update(current: PrototypeMemoryState) -> tuple[PrototypeMemoryState, Array]:
            return (
                PrototypeMemoryState(
                    means=current.means,
                    counts=current.counts,
                    last_update=current.last_update,
                    step_count=current.step_count + 1,
                ),
                jnp.array(0.0, dtype=jnp.float32),
            )

        new_state, allocated = jax.lax.cond(valid_target, do_update, skip_update, state)
        active = jnp.sum(new_state.counts > 0.0).astype(jnp.float32)
        metrics = jnp.asarray(
            [
                mse,
                correct,
                confidence,
                active,
                valid_target.astype(jnp.float32),
                allocated,
            ],
            dtype=jnp.float32,
        )
        return PrototypeMemoryUpdateResult(
            state=new_state,
            predictions=prediction,
            errors=errors,
            metrics=metrics,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: PrototypeMemoryState,
        observation: Float[Array, " feature_dim"],
        target: Float[Array, " n_classes"],
    ) -> PrototypeMemoryUpdateResult:
        """Perform one causal online memory update."""
        return cast(
            PrototypeMemoryUpdateResult,
            self.update_with_novelty_threshold(
                state,
                observation,
                target,
                jnp.asarray(self._config.novelty_threshold, dtype=jnp.float32),
            ),
        )


def run_prototype_memory_arrays(
    learner: PrototypeMemoryLearner,
    observations: Float[Array, "steps feature_dim"],
    targets: Float[Array, "steps n_classes"],
    *,
    state: PrototypeMemoryState | None = None,
) -> PrototypeMemoryLearningResult:
    """Run the prototype memory over arrays with ``jax.lax.scan``.

    Metric columns are ``mse, correct, confidence, active_prototypes,
    valid_update, allocated``.
    """
    if state is None:
        state = learner.init()

    def step_fn(
        carry: PrototypeMemoryState,
        batch: tuple[Array, Array],
    ) -> tuple[PrototypeMemoryState, tuple[Array, Array]]:
        observation, target = batch
        result = learner.update(carry, observation, target)
        return result.state, (result.predictions, result.metrics)

    final_state, (predictions, metrics) = jax.lax.scan(
        step_fn,
        state,
        (observations, targets),
    )
    return PrototypeMemoryLearningResult(
        state=final_state,
        predictions=predictions,
        metrics=metrics,
    )
