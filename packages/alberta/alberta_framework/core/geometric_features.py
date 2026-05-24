"""Budgeted local geometric features for Step 2 probes.

The learner in this module is deliberately small: it keeps a causal dictionary
of input centers and trains a linear multi-head output layer over normalized
raw, RBF, and hinge features.  Centers are admitted online from the current
observation only when the pre-update residual is large relative to target
energy and the observation is novel relative to existing centers.
"""

from __future__ import annotations

import functools
import time
from typing import Any, NamedTuple

import jax
import jax.numpy as jnp
from jax import Array


class GeometricFeatureState(NamedTuple):
    """State for ``BudgetedGeometricFeatureLearner``."""

    centers: Array
    active: Array
    output_weights: Array
    output_biases: Array
    feature_energy_ema: Array
    input_energy_ema: Array
    target_energy_ema: Array
    utilities: Array
    ages: Array
    step_count: Array
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


class GeometricFeatureUpdateResult(NamedTuple):
    """Result of one geometric-feature update."""

    state: GeometricFeatureState
    predictions: Array
    errors: Array
    metrics: Array
    inserted_slot: Array


class GeometricFeatureLearningResult(NamedTuple):
    """Result from a scan-based geometric-feature run."""

    state: GeometricFeatureState
    metrics: Array


class BudgetedGeometricFeatureLearner:
    """Online learner with a budgeted RBF/hinge dictionary.

    The prediction features are ``[normalized_raw, normalized_rbf,
    normalized_hinge]``.  The dictionary update is causal: the model predicts
    before the current target is used, output weights are updated from that
    pre-update prediction, then the current observation may be inserted as a
    center using only residual energy and novelty available at that step.
    """

    def __init__(
        self,
        n_centers: int,
        n_tasks: int,
        step_size_output: float = 0.04,
        energy_decay: float = 0.99,
        utility_decay: float = 0.995,
        rbf_bandwidth: float = 1.5,
        hinge_radius: float = 2.0,
        novelty_threshold: float = 1.0,
        residual_threshold: float = 0.25,
        min_center_age: int = 25,
        imprint_scale: float = 0.2,
        feature_clip: float = 5.0,
        use_obgd: bool = True,
        obgd_kappa: float = 2.0,
    ) -> None:
        if n_centers < 1:
            raise ValueError("n_centers must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if not 0.0 <= energy_decay < 1.0:
            raise ValueError("energy_decay must be in [0, 1)")
        if not 0.0 <= utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")
        if rbf_bandwidth <= 0.0:
            raise ValueError("rbf_bandwidth must be positive")
        if hinge_radius <= 0.0:
            raise ValueError("hinge_radius must be positive")
        if novelty_threshold < 0.0:
            raise ValueError("novelty_threshold must be non-negative")
        if residual_threshold < 0.0:
            raise ValueError("residual_threshold must be non-negative")
        if min_center_age < 0:
            raise ValueError("min_center_age must be non-negative")
        if not 0.0 <= imprint_scale <= 1.0:
            raise ValueError("imprint_scale must be in [0, 1]")
        if feature_clip <= 0.0:
            raise ValueError("feature_clip must be positive")

        self._n_centers = int(n_centers)
        self._n_tasks = int(n_tasks)
        self._step_size_output = float(step_size_output)
        self._energy_decay = float(energy_decay)
        self._utility_decay = float(utility_decay)
        self._rbf_bandwidth = float(rbf_bandwidth)
        self._hinge_radius = float(hinge_radius)
        self._novelty_threshold = float(novelty_threshold)
        self._residual_threshold = float(residual_threshold)
        self._min_center_age = int(min_center_age)
        self._imprint_scale = float(imprint_scale)
        self._feature_clip = float(feature_clip)
        self._use_obgd = bool(use_obgd)
        self._obgd_kappa = float(obgd_kappa)

    @property
    def n_centers(self) -> int:
        """Return the center budget."""
        return self._n_centers

    @property
    def n_tasks(self) -> int:
        """Return the number of output heads."""
        return self._n_tasks

    def feature_dim(self, input_dim: int) -> int:
        """Return augmented feature dimension for an input width."""
        return int(input_dim) + 2 * self._n_centers

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration."""
        return {
            "type": "BudgetedGeometricFeatureLearner",
            "n_centers": self._n_centers,
            "n_tasks": self._n_tasks,
            "step_size_output": self._step_size_output,
            "energy_decay": self._energy_decay,
            "utility_decay": self._utility_decay,
            "rbf_bandwidth": self._rbf_bandwidth,
            "hinge_radius": self._hinge_radius,
            "novelty_threshold": self._novelty_threshold,
            "residual_threshold": self._residual_threshold,
            "min_center_age": self._min_center_age,
            "imprint_scale": self._imprint_scale,
            "feature_clip": self._feature_clip,
            "use_obgd": self._use_obgd,
            "obgd_kappa": self._obgd_kappa,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> BudgetedGeometricFeatureLearner:
        """Reconstruct a learner from ``to_config`` output."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)

    def init(self, feature_dim: int, key: Array | None = None) -> GeometricFeatureState:
        """Initialize the dictionary and output head.

        Args:
            feature_dim: Raw input dimension.
            key: Unused PRNG key, accepted for consistency with other learners.

        Returns:
            Zero-initialized geometric learner state.
        """
        del key
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        total_features = self.feature_dim(feature_dim)
        return GeometricFeatureState(
            centers=jnp.zeros((self._n_centers, feature_dim), dtype=jnp.float32),
            active=jnp.zeros(self._n_centers, dtype=jnp.float32),
            output_weights=jnp.zeros(
                (self._n_tasks, total_features), dtype=jnp.float32
            ),
            output_biases=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            feature_energy_ema=jnp.ones(total_features, dtype=jnp.float32),
            input_energy_ema=jnp.ones(feature_dim, dtype=jnp.float32),
            target_energy_ema=jnp.ones(self._n_tasks, dtype=jnp.float32),
            utilities=jnp.zeros(self._n_centers, dtype=jnp.float32),
            ages=jnp.zeros(self._n_centers, dtype=jnp.int32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _raw_scale(self, state: GeometricFeatureState) -> Array:
        return jnp.sqrt(jnp.maximum(state.input_energy_ema, 1.0e-6))

    def _local_values(self, state: GeometricFeatureState, observation: Array) -> Array:
        scaled_diff = (observation[None, :] - state.centers) / self._raw_scale(state)[
            None, :
        ]
        dist2 = jnp.sum(scaled_diff * scaled_diff, axis=1)
        dist = jnp.sqrt(jnp.maximum(dist2, 0.0))
        rbf = jnp.exp(-0.5 * dist2 / (self._rbf_bandwidth * self._rbf_bandwidth))
        hinge = jnp.maximum(1.0 - dist / self._hinge_radius, 0.0)
        return jnp.concatenate([rbf * state.active, hinge * state.active])

    def features(self, state: GeometricFeatureState, observation: Array) -> Array:
        """Return normalized raw plus local geometric features."""
        raw = observation / self._raw_scale(state)
        raw = jnp.clip(raw, -self._feature_clip, self._feature_clip)
        unnormalized = jnp.concatenate([raw, self._local_values(state, observation)])
        normalized = unnormalized / jnp.sqrt(
            jnp.maximum(state.feature_energy_ema, 1.0e-6)
        )
        return jnp.clip(normalized, -self._feature_clip, self._feature_clip)

    def predict(self, state: GeometricFeatureState, observation: Array) -> Array:
        """Predict all heads for one unbatched observation."""
        feats = self.features(state, observation)
        return state.output_weights @ feats + state.output_biases

    def _novelty(self, state: GeometricFeatureState, observation: Array) -> Array:
        scaled_diff = (observation[None, :] - state.centers) / self._raw_scale(state)[
            None, :
        ]
        dist = jnp.sqrt(jnp.maximum(jnp.sum(scaled_diff * scaled_diff, axis=1), 0.0))
        masked_dist = jnp.where(state.active > 0.5, dist, jnp.inf)
        nearest = jnp.min(masked_dist)
        any_active = jnp.any(state.active > 0.5)
        return jnp.where(any_active, nearest, jnp.inf)

    def _insert_center(
        self,
        state: GeometricFeatureState,
        observation: Array,
        errors: Array,
        active_mask: Array,
        residual_score: Array,
        novelty: Array,
    ) -> tuple[GeometricFeatureState, Array]:
        free_mask = state.active < 0.5
        free_exists = jnp.any(free_mask)
        free_slot = jnp.argmax(free_mask.astype(jnp.int32)).astype(jnp.int32)
        eligible = (state.active > 0.5) & (state.ages >= self._min_center_age)
        eligible_exists = jnp.any(eligible)
        replacement_scores = jnp.where(eligible, state.utilities, jnp.inf)
        replacement_slot = jnp.argmin(replacement_scores).astype(jnp.int32)
        slot = jnp.where(free_exists, free_slot, replacement_slot)
        should_insert = (
            (residual_score >= self._residual_threshold)
            & (novelty >= self._novelty_threshold)
            & (free_exists | eligible_exists)
        )

        local_start = state.output_weights.shape[1] - 2 * self._n_centers
        rbf_col = local_start + slot
        hinge_col = local_start + self._n_centers + slot
        imprint = self._imprint_scale * jnp.where(active_mask, errors, 0.0)
        weights = jnp.where(
            should_insert,
            state.output_weights.at[:, rbf_col].set(imprint).at[:, hinge_col].set(0.0),
            state.output_weights,
        )
        centers = jnp.where(
            should_insert,
            state.centers.at[slot].set(observation),
            state.centers,
        )
        active = jnp.where(should_insert, state.active.at[slot].set(1.0), state.active)
        utilities = jnp.where(
            should_insert, state.utilities.at[slot].set(residual_score), state.utilities
        )
        ages = jnp.where(should_insert, state.ages.at[slot].set(0), state.ages)
        inserted_slot = jnp.where(should_insert, slot, jnp.array(-1, dtype=jnp.int32))
        new_state = state._replace(
            centers=centers,
            active=active,
            output_weights=weights,
            utilities=utilities,
            ages=ages,
        )
        return new_state, inserted_slot

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: GeometricFeatureState,
        observation: Array,
        targets: Array,
    ) -> GeometricFeatureUpdateResult:
        """Perform one prediction-before-update step."""
        active_mask = ~jnp.isnan(targets)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)

        feats = self.features(state, observation)
        predictions = state.output_weights @ feats + state.output_biases
        errors = jnp.where(active_mask, safe_targets - predictions, 0.0)
        reported_errors = jnp.where(active_mask, errors, jnp.nan)
        loss = jnp.sum(errors * errors) / active_count

        step_scale = jnp.array(self._step_size_output, dtype=jnp.float32)
        weight_delta = step_scale * errors[:, None] * feats[None, :] / active_count
        bias_delta = step_scale * errors / active_count
        bounding_scale = jnp.array(1.0, dtype=jnp.float32)
        if self._use_obgd:
            total_step = jnp.sum(jnp.abs(weight_delta)) + jnp.sum(jnp.abs(bias_delta))
            err_norm = jnp.linalg.norm(errors)
            bound = self._obgd_kappa * jnp.maximum(err_norm, 1.0) * total_step
            bounding_scale = 1.0 / jnp.maximum(bound, 1.0)
            weight_delta = bounding_scale * weight_delta
            bias_delta = bounding_scale * bias_delta

        output_weights = state.output_weights + weight_delta
        output_biases = state.output_biases + bias_delta
        contribution = jnp.mean(
            jnp.abs(state.output_weights[:, -2 * self._n_centers :] * errors[:, None]),
            axis=0,
        )
        center_signal = 0.5 * (
            contribution[: self._n_centers] + contribution[self._n_centers :]
        )
        utilities = (
            self._utility_decay * state.utilities
            + (1.0 - self._utility_decay) * center_signal
        )

        residual_energy = jnp.sum(errors * errors) / active_count
        target_norm = jnp.sum(
            jnp.where(active_mask, state.target_energy_ema, 0.0)
        ) / active_count
        residual_score = residual_energy / jnp.maximum(target_norm, 1.0e-6)
        novelty = self._novelty(state, observation)

        pre_insert_state = state._replace(
            output_weights=output_weights,
            output_biases=output_biases,
            utilities=utilities,
            ages=state.ages + state.active.astype(jnp.int32),
            step_count=state.step_count + 1,
        )
        inserted_state, inserted_slot = self._insert_center(
            pre_insert_state,
            observation,
            errors,
            active_mask,
            residual_score,
            novelty,
        )

        local_unscaled = jnp.concatenate(
            [
                observation / self._raw_scale(state),
                self._local_values(inserted_state, observation),
            ]
        )
        feature_energy = (
            self._energy_decay * state.feature_energy_ema
            + (1.0 - self._energy_decay) * (local_unscaled * local_unscaled)
        )
        input_energy = (
            self._energy_decay * state.input_energy_ema
            + (1.0 - self._energy_decay) * (observation * observation)
        )
        target_energy = jnp.where(
            active_mask,
            self._energy_decay * state.target_energy_ema
            + (1.0 - self._energy_decay) * (safe_targets * safe_targets),
            state.target_energy_ema,
        )
        new_state = inserted_state._replace(
            feature_energy_ema=jnp.maximum(feature_energy, 1.0e-6),
            input_energy_ema=jnp.maximum(input_energy, 1.0e-6),
            target_energy_ema=jnp.maximum(target_energy, 1.0e-6),
        )
        metrics = jnp.array(
            [
                loss,
                residual_score,
                jnp.where(jnp.isinf(novelty), 1.0e6, novelty),
                jnp.sum(new_state.active),
                jnp.mean(new_state.utilities),
                bounding_scale,
                inserted_slot.astype(jnp.float32),
            ],
            dtype=jnp.float32,
        )
        return GeometricFeatureUpdateResult(
            state=new_state,
            predictions=predictions,
            errors=reported_errors,
            metrics=metrics,
            inserted_slot=inserted_slot,
        )


def run_geometric_feature_arrays(
    learner: BudgetedGeometricFeatureLearner,
    state: GeometricFeatureState,
    observations: Array,
    targets: Array,
) -> GeometricFeatureLearningResult:
    """Run a geometric learner over pre-collected arrays."""

    def step_fn(
        carry: GeometricFeatureState,
        inputs: tuple[Array, Array],
    ) -> tuple[GeometricFeatureState, Array]:
        observation, target = inputs
        result = learner.update(carry, observation, target)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state._replace(uptime_s=final_state.uptime_s + elapsed)
    return GeometricFeatureLearningResult(state=final_state, metrics=metrics)
