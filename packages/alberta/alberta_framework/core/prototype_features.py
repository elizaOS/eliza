"""Causal prototype features for supervised Step 2 classification streams.

This module implements the small mechanism that repaired the class-blocked
digits tracking/retention conflict in the Step 2 probes: maintain a bounded set
of normalized class prototypes and expose cosine-similarity probabilities as
constructed features.

The constructor is intentionally narrow.  It updates only on non-negative
unit-mass simplex targets, so dense regression and non-simplex vector targets
are skipped by default.
"""

import functools

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


@chex.dataclass(frozen=True)
class PrototypeFeatureState:
    """State for a fixed-budget prototype feature constructor."""

    prototypes: Float[Array, "n_classes feature_dim"]
    counts: Float[Array, " n_classes"]
    step_count: Array


class PrototypeFeatureConstructor:
    """One-prototype-per-class causal feature constructor.

    Args:
        n_classes: Number of simplex target classes/tasks.
        alpha: EMA rate for the observed class prototype.
        temperature: Softmax temperature for cosine-similarity features.
    """

    def __init__(
        self,
        n_classes: int,
        alpha: float = 0.05,
        temperature: float = 0.05,
    ):
        if n_classes < 2:
            msg = f"n_classes must be >= 2, got {n_classes}"
            raise ValueError(msg)
        if not 0.0 < alpha <= 1.0:
            msg = f"alpha must be in (0, 1], got {alpha}"
            raise ValueError(msg)
        if temperature <= 0.0:
            msg = f"temperature must be positive, got {temperature}"
            raise ValueError(msg)
        self._n_classes = int(n_classes)
        self._alpha = float(alpha)
        self._temperature = float(temperature)

    @property
    def n_classes(self) -> int:
        """Number of prototype classes."""
        return self._n_classes

    def init(self, feature_dim: int) -> PrototypeFeatureState:
        """Return an empty prototype feature state."""
        if feature_dim < 1:
            msg = f"feature_dim must be >= 1, got {feature_dim}"
            raise ValueError(msg)
        return PrototypeFeatureState(  # type: ignore[call-arg]
            prototypes=jnp.zeros((self._n_classes, feature_dim), dtype=jnp.float32),
            counts=jnp.zeros((self._n_classes,), dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def features(self, state: PrototypeFeatureState, observation: Array) -> Array:
        """Construct prototype probability features for one observation."""
        obs = observation / (jnp.linalg.norm(observation) + 1e-8)
        prototype_norms = jnp.linalg.norm(state.prototypes, axis=1)
        normalized_prototypes = state.prototypes / (prototype_norms[:, None] + 1e-8)
        cosine = normalized_prototypes @ obs
        seen = state.counts > 0.0
        scores = jnp.where(
            seen,
            cosine / jnp.asarray(self._temperature, dtype=jnp.float32),
            -20.0,
        )
        return jax.nn.softmax(scores)

    @functools.partial(jax.jit, static_argnums=(0,))
    def augment(self, state: PrototypeFeatureState, observation: Array) -> Array:
        """Concatenate raw observation and prototype features."""
        return jnp.concatenate([observation, self.features(state, observation)])

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: PrototypeFeatureState,
        observation: Array,
        target: Array,
    ) -> PrototypeFeatureState:
        """Update the observed class prototype when the target is simplex-like."""
        active = ~jnp.isnan(target)
        safe_target = jnp.where(active, target, 0.0)
        target_mass = jnp.sum(jnp.where(active, safe_target, 0.0))
        has_negative = jnp.any(jnp.logical_and(active, safe_target < -1e-6))
        simplex_like = (
            (~has_negative)
            & (target_mass > 1e-8)
            & (jnp.abs(target_mass - 1.0) <= 1e-5)
        )
        label = jnp.argmax(jnp.where(active, safe_target, -jnp.inf)).astype(jnp.int32)
        obs = observation / (jnp.linalg.norm(observation) + 1e-8)
        old = state.prototypes[label]
        alpha = jnp.asarray(self._alpha, dtype=jnp.float32)
        new = (1.0 - alpha) * old + alpha * obs
        new = new / (jnp.linalg.norm(new) + 1e-8)
        prototypes = state.prototypes.at[label].set(
            jnp.where(simplex_like, new, old)
        )
        counts = state.counts.at[label].set(
            state.counts[label] + simplex_like.astype(jnp.float32)
        )
        return PrototypeFeatureState(  # type: ignore[call-arg]
            prototypes=prototypes,
            counts=counts,
            step_count=state.step_count + 1,
        )
