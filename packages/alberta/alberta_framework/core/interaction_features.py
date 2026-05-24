"""Fixed-budget pairwise interaction feature discovery.

This module is a concrete Step 2 probe.  It restricts feature construction to
pairwise products of existing scalar observations, then studies whether an
online learner can manage a bounded set of those constructed features by
testing, scoring, promoting, and replacing them.
"""

import functools
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int, PRNGKeyArray

from alberta_framework.core.feature_discovery import (
    GENERATOR_IMPRINT,
    GENERATOR_MUTATE_PARENT,
    GENERATOR_RANDOM,
)
from alberta_framework.core.future_utility import one_step_output_loss_reduction


@chex.dataclass(frozen=True)
class InteractionFeatureState:
    """State for ``FixedBudgetInteractionLearner``."""

    key: PRNGKeyArray
    feature_left: Int[Array, " n_features"]
    feature_right: Int[Array, " n_features"]
    output_weights: Float[Array, "n_tasks n_features"]
    output_biases: Float[Array, " n_tasks"]
    utilities: Float[Array, " n_features"]
    task_activity_ema: Float[Array, " n_tasks"]
    ages: Int[Array, " n_features"]
    candidate_left: Int[Array, " n_candidates"]
    candidate_right: Int[Array, " n_candidates"]
    candidate_output_weights: Float[Array, "n_tasks n_candidates"]
    candidate_utilities: Float[Array, " n_candidates"]
    candidate_ages: Int[Array, " n_candidates"]
    feature_parent_a: Int[Array, " n_features"]
    feature_parent_b: Int[Array, " n_features"]
    feature_generator: Int[Array, " n_features"]
    candidate_parent_a: Int[Array, " n_candidates"]
    candidate_parent_b: Int[Array, " n_candidates"]
    candidate_generator: Int[Array, " n_candidates"]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class InteractionFeatureUpdateResult:
    """Result of one pairwise interaction feature update."""

    state: InteractionFeatureState
    predictions: Float[Array, " n_tasks"]
    errors: Float[Array, " n_tasks"]
    metrics: Float[Array, " 7"]
    replaced_slot: Int[Array, ""]
    promoted_candidate: Int[Array, ""]


@chex.dataclass(frozen=True)
class InteractionFeatureLearningResult:
    """Result from a scan-based interaction feature run."""

    state: InteractionFeatureState
    metrics: Float[Array, "num_steps 7"]


class FixedBudgetInteractionLearner:
    """Fixed-budget learner over constructed pairwise product features.

    Active features are products ``x[left] * x[right]``.  Optional candidates
    are trained against residual error without contributing to predictions.
    Periodic replacement either promotes the best candidate into the worst
    active slot or refreshes the worst candidate.
    """

    def __init__(
        self,
        n_features: int,
        n_tasks: int,
        step_size_output: float = 0.03,
        utility_decay: float = 0.995,
        replacement_interval: int = 100,
        min_feature_age: int = 50,
        candidate_count: int = 0,
        candidate_min_age: int = 25,
        promotion_margin: float = 1.05,
        promotion_blend: float = 1.0,
        generator_mix: tuple[float, float, float] = (1.0, 0.0, 0.0),
        candidate_strategy: str = "random",
        utility_aggregation: str = "mean",
        utility_top_k: int = 1,
        utility_task_balancing: str = "none",
        task_activity_decay: float = 0.995,
        future_utility_mix: float = 0.0,
        utility_retention_decay: float | None = None,
        refresh_candidates: bool = True,
        refresh_promoted_candidate: bool = True,
        include_squares: bool = False,
        use_obgd: bool = True,
        obgd_kappa: float = 2.0,
    ):
        if n_features < 1:
            raise ValueError("n_features must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if candidate_count < 0:
            raise ValueError("candidate_count must be non-negative")
        if not 0.0 <= utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")
        if replacement_interval < 0:
            raise ValueError("replacement_interval must be non-negative")
        if not 0.0 <= promotion_blend <= 1.0:
            raise ValueError("promotion_blend must be in [0, 1]")
        if candidate_strategy not in {"random", "all_pairs"}:
            raise ValueError("candidate_strategy must be 'random' or 'all_pairs'")
        if utility_aggregation not in {"mean", "max", "topk"}:
            raise ValueError("utility_aggregation must be 'mean', 'max', or 'topk'")
        if utility_top_k < 1:
            raise ValueError("utility_top_k must be positive")
        if utility_task_balancing not in {"none", "active", "active_inverse_frequency"}:
            raise ValueError(
                "utility_task_balancing must be 'none', 'active', "
                "or 'active_inverse_frequency'"
            )
        if not 0.0 <= task_activity_decay < 1.0:
            raise ValueError("task_activity_decay must be in [0, 1)")
        if not 0.0 <= future_utility_mix <= 1.0:
            raise ValueError("future_utility_mix must be in [0, 1]")
        if utility_retention_decay is not None and not (
            utility_decay <= utility_retention_decay < 1.0
        ):
            raise ValueError(
                "utility_retention_decay must be in [utility_decay, 1) when set"
            )

        mix = jnp.array(generator_mix, dtype=jnp.float32)
        if mix.shape != (3,):
            raise ValueError("generator_mix must have three entries")
        mix_sum = float(jnp.sum(mix))
        if mix_sum <= 0.0:
            raise ValueError("generator_mix must contain positive mass")

        self._n_features = n_features
        self._n_tasks = n_tasks
        self._step_size_output = step_size_output
        self._utility_decay = utility_decay
        self._replacement_interval = replacement_interval
        self._min_feature_age = min_feature_age
        self._candidate_count = candidate_count
        self._candidate_min_age = candidate_min_age
        self._promotion_margin = promotion_margin
        self._promotion_blend = promotion_blend
        self._generator_mix = tuple(float(v) / mix_sum for v in generator_mix)
        self._candidate_strategy = candidate_strategy
        self._utility_aggregation = utility_aggregation
        self._utility_top_k = utility_top_k
        self._utility_task_balancing = utility_task_balancing
        self._task_activity_decay = task_activity_decay
        self._future_utility_mix = future_utility_mix
        self._utility_retention_decay = utility_retention_decay
        self._refresh_candidates = refresh_candidates
        self._refresh_promoted_candidate = refresh_promoted_candidate
        self._include_squares = include_squares
        self._use_obgd = use_obgd
        self._obgd_kappa = obgd_kappa

    @property
    def n_features(self) -> int:
        """Number of active features."""
        return self._n_features

    @property
    def n_tasks(self) -> int:
        """Number of output tasks."""
        return self._n_tasks

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration."""
        return {
            "type": "FixedBudgetInteractionLearner",
            "n_features": self._n_features,
            "n_tasks": self._n_tasks,
            "step_size_output": self._step_size_output,
            "utility_decay": self._utility_decay,
            "replacement_interval": self._replacement_interval,
            "min_feature_age": self._min_feature_age,
            "candidate_count": self._candidate_count,
            "candidate_min_age": self._candidate_min_age,
            "promotion_margin": self._promotion_margin,
            "promotion_blend": self._promotion_blend,
            "generator_mix": list(self._generator_mix),
            "candidate_strategy": self._candidate_strategy,
            "utility_aggregation": self._utility_aggregation,
            "utility_top_k": self._utility_top_k,
            "utility_task_balancing": self._utility_task_balancing,
            "task_activity_decay": self._task_activity_decay,
            "future_utility_mix": self._future_utility_mix,
            "utility_retention_decay": self._utility_retention_decay,
            "refresh_candidates": self._refresh_candidates,
            "refresh_promoted_candidate": self._refresh_promoted_candidate,
            "include_squares": self._include_squares,
            "use_obgd": self._use_obgd,
            "obgd_kappa": self._obgd_kappa,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "FixedBudgetInteractionLearner":
        """Reconstruct learner from ``to_config`` output."""
        config = dict(config)
        config.pop("type", None)
        generator_mix = config.pop("generator_mix", (1.0, 0.0, 0.0))
        return cls(generator_mix=tuple(generator_mix), **config)

    def init(self, feature_dim: int, key: Array) -> InteractionFeatureState:
        """Initialize active and candidate pair banks."""
        if feature_dim < 2 and not self._include_squares:
            raise ValueError("feature_dim must be at least 2 when squares are disabled")

        key, k_active, k_candidate = jr.split(key, 3)
        feature_left, feature_right = self._random_pairs(
            k_active, self._n_features, feature_dim
        )
        if self._candidate_strategy == "all_pairs":
            candidate_left, candidate_right = self._candidate_pairs(
                k_candidate, self._candidate_count, feature_dim
            )
        else:
            candidate_left, candidate_right = self._random_pairs(
                k_candidate, self._candidate_count, feature_dim
            )

        return InteractionFeatureState(
            key=key,
            feature_left=feature_left,
            feature_right=feature_right,
            output_weights=jnp.zeros((self._n_tasks, self._n_features), dtype=jnp.float32),
            output_biases=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            utilities=jnp.zeros(self._n_features, dtype=jnp.float32),
            task_activity_ema=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            ages=jnp.zeros(self._n_features, dtype=jnp.int32),
            candidate_left=candidate_left,
            candidate_right=candidate_right,
            candidate_output_weights=jnp.zeros(
                (self._n_tasks, self._candidate_count), dtype=jnp.float32
            ),
            candidate_utilities=jnp.zeros(self._candidate_count, dtype=jnp.float32),
            candidate_ages=jnp.zeros(self._candidate_count, dtype=jnp.int32),
            feature_parent_a=jnp.full(self._n_features, -1, dtype=jnp.int32),
            feature_parent_b=jnp.full(self._n_features, -1, dtype=jnp.int32),
            feature_generator=jnp.full(
                self._n_features, GENERATOR_RANDOM, dtype=jnp.int32
            ),
            candidate_parent_a=jnp.full(self._candidate_count, -1, dtype=jnp.int32),
            candidate_parent_b=jnp.full(self._candidate_count, -1, dtype=jnp.int32),
            candidate_generator=jnp.full(
                self._candidate_count, GENERATOR_RANDOM, dtype=jnp.int32
            ),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def _all_pairs(self, feature_dim: int) -> tuple[Array, Array]:
        pairs = []
        for i in range(feature_dim):
            start = i if self._include_squares else i + 1
            for j in range(start, feature_dim):
                pairs.append((i, j))
        arr = jnp.array(pairs, dtype=jnp.int32)
        return arr[:, 0], arr[:, 1]

    def _candidate_pairs(
        self,
        key: Array,
        count: int,
        feature_dim: int,
    ) -> tuple[Array, Array]:
        """Generate candidate pairs, optionally covering the whole pair space."""
        if count == 0:
            empty = jnp.zeros((0,), dtype=jnp.int32)
            return empty, empty

        pair_left, pair_right = self._all_pairs(feature_dim)
        n_pairs = pair_left.shape[0]
        if count >= n_pairs:
            repeats = (count + n_pairs - 1) // n_pairs
            left = jnp.tile(pair_left, repeats)[:count]
            right = jnp.tile(pair_right, repeats)[:count]
            return left, right

        perm = jr.permutation(key, n_pairs)[:count]
        return pair_left[perm], pair_right[perm]

    def _random_pairs(
        self,
        key: Array,
        count: int,
        feature_dim: int,
    ) -> tuple[Array, Array]:
        """Generate canonical random pairs."""
        if count == 0:
            empty = jnp.zeros((0,), dtype=jnp.int32)
            return empty, empty

        k_left, k_offset = jr.split(key)
        left = jr.randint(k_left, (count,), 0, feature_dim, dtype=jnp.int32)
        if self._include_squares:
            right = jr.randint(k_offset, (count,), 0, feature_dim, dtype=jnp.int32)
        else:
            offset = jr.randint(k_offset, (count,), 1, feature_dim, dtype=jnp.int32)
            right = (left + offset) % feature_dim
        return self._canonicalize(left, right)

    def _canonicalize(self, left: Array, right: Array) -> tuple[Array, Array]:
        if self._include_squares:
            return left, right
        return jnp.minimum(left, right), jnp.maximum(left, right)

    @staticmethod
    def _values(left: Array, right: Array, observation: Array) -> Array:
        return observation[left] * observation[right]

    def _task_activity_update(
        self,
        old_activity: Array,
        active_mask: Array,
    ) -> Array:
        """Track how often each task is observed for opt-in utility balancing."""
        return (
            self._task_activity_decay * old_activity
            + (1.0 - self._task_activity_decay) * active_mask.astype(jnp.float32)
        )

    def _utility_signal(
        self,
        output_weights: Array,
        features: Array,
        active_mask: Array,
        task_activity_ema: Array,
    ) -> Array:
        """Score feature usefulness from current outgoing weights and activity."""
        weighted_activity = jnp.abs(output_weights) * jnp.abs(features)[None, :]
        if self._utility_task_balancing != "none":
            active = active_mask.astype(jnp.float32)
            if self._utility_task_balancing == "active_inverse_frequency":
                frequency_floor = jnp.array(
                    1.0 - self._task_activity_decay, dtype=jnp.float32
                )
                task_weights = active / jnp.maximum(task_activity_ema, frequency_floor)
            else:
                task_weights = active
            weighted_activity = weighted_activity * task_weights[:, None]

        if self._utility_aggregation == "max":
            return jnp.max(weighted_activity, axis=0)
        if self._utility_aggregation == "topk":
            k = min(self._utility_top_k, self._n_tasks)
            return jnp.mean(jnp.sort(weighted_activity, axis=0)[-k:, :], axis=0)

        if self._utility_task_balancing == "active":
            active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
            return jnp.sum(weighted_activity, axis=0) / active_count
        if self._utility_task_balancing == "active_inverse_frequency":
            active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
            return jnp.sum(weighted_activity, axis=0) / active_count
        return jnp.mean(weighted_activity, axis=0)

    def _mixed_utility_signal(
        self,
        old_output_weights: Array,
        new_output_weights: Array,
        features: Array,
        errors: Array,
        active_mask: Array,
        task_activity_ema: Array,
        active_count: Array,
        effective_step_size: Array,
    ) -> Array:
        current_signal = self._utility_signal(
            old_output_weights, features, active_mask, task_activity_ema
        )
        if self._future_utility_mix == 0.0:
            return current_signal
        del new_output_weights
        future_signal = self._future_utility_signal(
            errors,
            features,
            active_mask,
            task_activity_ema,
            active_count,
            effective_step_size,
        )
        return (
            (1.0 - self._future_utility_mix) * current_signal
            + self._future_utility_mix * future_signal
        )

    def _future_utility_signal(
        self,
        errors: Array,
        features: Array,
        active_mask: Array,
        task_activity_ema: Array,
        active_count: Array,
        effective_step_size: Array,
    ) -> Array:
        reductions = one_step_output_loss_reduction(
            errors,
            features,
            active_mask,
            effective_step_size,
            active_count,
        )
        return self._aggregate_task_feature_signal(
            reductions,
            active_mask,
            task_activity_ema,
        )

    def _aggregate_task_feature_signal(
        self,
        task_feature_signal: Array,
        active_mask: Array,
        task_activity_ema: Array,
    ) -> Array:
        weighted_signal = task_feature_signal
        if self._utility_task_balancing != "none":
            active = active_mask.astype(jnp.float32)
            if self._utility_task_balancing == "active_inverse_frequency":
                frequency_floor = jnp.array(
                    1.0 - self._task_activity_decay, dtype=jnp.float32
                )
                task_weights = active / jnp.maximum(task_activity_ema, frequency_floor)
            else:
                task_weights = active
            weighted_signal = weighted_signal * task_weights[:, None]

        if self._utility_aggregation == "max":
            return jnp.max(weighted_signal, axis=0)
        if self._utility_aggregation == "topk":
            k = min(self._utility_top_k, self._n_tasks)
            return jnp.mean(jnp.sort(weighted_signal, axis=0)[-k:, :], axis=0)
        if self._utility_task_balancing in {"active", "active_inverse_frequency"}:
            active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
            return jnp.sum(weighted_signal, axis=0) / active_count
        return jnp.mean(weighted_signal, axis=0)

    def _utility_update(self, old_utilities: Array, utility_signal: Array) -> Array:
        """Update utility, optionally retaining recurrent-context peaks longer."""
        ema = (
            self._utility_decay * old_utilities
            + (1.0 - self._utility_decay) * utility_signal
        )
        if self._utility_retention_decay is None:
            return ema
        retained = self._utility_retention_decay * old_utilities
        return jnp.maximum(ema, retained)

    def _generate_one(
        self,
        key: Array,
        observation: Array,
        active_left: Array,
        active_right: Array,
        utilities: Array,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Generate one candidate pair using random, mutation, or imprint."""
        feature_dim = observation.shape[0]
        key_kind, key_random, key_parent, key_mutate = jr.split(key, 4)
        mix = jnp.array(self._generator_mix, dtype=jnp.float32)
        generator = jr.categorical(key_kind, jnp.log(mix + 1e-8))

        random_left, random_right = self._random_pairs(key_random, 1, feature_dim)
        random_left = random_left[0]
        random_right = random_right[0]

        parent_logits = jnp.log(utilities + 1e-3)
        parent_idx = jr.categorical(key_parent, parent_logits).astype(jnp.int32)
        parent_left = active_left[parent_idx]
        parent_right = active_right[parent_idx]
        key_dim, key_side = jr.split(key_mutate)
        mutate_dim = jr.randint(key_dim, (), 0, feature_dim, dtype=jnp.int32)
        mutate_left_side = jr.bernoulli(key_side)
        mutate_left = jnp.where(mutate_left_side, mutate_dim, parent_left)
        mutate_right = jnp.where(mutate_left_side, parent_right, mutate_dim)
        if not self._include_squares:
            mutate_right = jnp.where(
                mutate_left == mutate_right,
                (mutate_right + 1) % feature_dim,
                mutate_right,
            )
        mutate_left, mutate_right = self._canonicalize(mutate_left, mutate_right)

        top_two = jnp.argsort(jnp.abs(observation))[-2:]
        imprint_left, imprint_right = self._canonicalize(top_two[0], top_two[1])

        def random_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                random_left,
                random_right,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_RANDOM, dtype=jnp.int32),
            )

        def mutate_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                mutate_left,
                mutate_right,
                parent_idx,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_MUTATE_PARENT, dtype=jnp.int32),
            )

        def imprint_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                imprint_left,
                imprint_right,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_IMPRINT, dtype=jnp.int32),
            )

        return jax.lax.switch(generator, (random_branch, mutate_branch, imprint_branch))

    @functools.partial(jax.jit, static_argnums=(0,))
    def constructed_features(
        self,
        state: InteractionFeatureState,
        observation: Array,
    ) -> Array:
        """Return active constructed pair-product features for ``observation``.

        These are literal Step 2 features made by combining existing features.
        Downstream GVF/Horde learners can consume them as a fixed representation
        or concatenate them with raw observations.
        """
        return self._values(state.feature_left, state.feature_right, observation)

    @functools.partial(jax.jit, static_argnums=(0,))
    def augmented_observation(
        self,
        state: InteractionFeatureState,
        observation: Array,
    ) -> Array:
        """Concatenate raw observation with active pair-product features."""
        return jnp.concatenate(
            [observation, self.constructed_features(state, observation)]
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: InteractionFeatureState, observation: Array) -> Array:
        """Predict all tasks from active interaction features."""
        features = self.constructed_features(state, observation)
        return state.output_weights @ features + state.output_biases

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: InteractionFeatureState,
        observation: Array,
        targets: Array,
    ) -> InteractionFeatureUpdateResult:
        """Perform one temporally-uniform interaction-feature update."""
        active_mask = ~jnp.isnan(targets)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
        task_activity_ema = self._task_activity_update(
            state.task_activity_ema, active_mask
        )

        features = self._values(state.feature_left, state.feature_right, observation)
        predictions = state.output_weights @ features + state.output_biases
        errors = jnp.where(active_mask, safe_targets - predictions, 0.0)
        reported_errors = jnp.where(active_mask, errors, jnp.nan)

        output_delta = (
            self._step_size_output
            * errors[:, None]
            * features[None, :]
            / active_count
        )
        output_bias_delta = self._step_size_output * errors / active_count

        candidate_output_delta = jnp.zeros_like(state.candidate_output_weights)
        candidate_features = jnp.zeros(self._candidate_count, dtype=jnp.float32)
        if self._candidate_count > 0:
            candidate_features = self._values(
                state.candidate_left, state.candidate_right, observation
            )
            candidate_output_delta = (
                self._step_size_output
                * errors[:, None]
                * candidate_features[None, :]
                / active_count
            )
        bounding_scale = jnp.array(1.0, dtype=jnp.float32)
        if self._use_obgd:
            total_step = (
                jnp.sum(jnp.abs(output_delta))
                + jnp.sum(jnp.abs(output_bias_delta))
                + jnp.sum(jnp.abs(candidate_output_delta))
            )
            err_norm = jnp.linalg.norm(errors)
            bound_magnitude = self._obgd_kappa * jnp.maximum(err_norm, 1.0) * total_step
            bounding_scale = 1.0 / jnp.maximum(bound_magnitude, 1.0)
            output_delta = bounding_scale * output_delta
            output_bias_delta = bounding_scale * output_bias_delta
            candidate_output_delta = bounding_scale * candidate_output_delta

        output_weights = state.output_weights + output_delta
        output_biases = state.output_biases + output_bias_delta
        candidate_output_weights = (
            state.candidate_output_weights + candidate_output_delta
        )
        utility_signal = self._mixed_utility_signal(
            state.output_weights,
            output_weights,
            features,
            errors,
            active_mask,
            task_activity_ema,
            active_count,
            self._step_size_output * bounding_scale,
        )
        new_utilities = self._utility_update(state.utilities, utility_signal)
        if self._candidate_count > 0:
            candidate_signal = self._mixed_utility_signal(
                state.candidate_output_weights,
                candidate_output_weights,
                candidate_features,
                errors,
                active_mask,
                task_activity_ema,
                active_count,
                self._step_size_output * bounding_scale,
            )
            new_candidate_utilities = self._utility_update(
                state.candidate_utilities, candidate_signal
            )
        else:
            new_candidate_utilities = state.candidate_utilities
        ages = state.ages + 1
        candidate_ages = state.candidate_ages + 1
        step_count = state.step_count + 1
        key, replacement_key = jr.split(state.key)

        feature_left = state.feature_left
        feature_right = state.feature_right
        candidate_left = state.candidate_left
        candidate_right = state.candidate_right
        feature_parent_a = state.feature_parent_a
        feature_parent_b = state.feature_parent_b
        feature_generator = state.feature_generator
        candidate_parent_a = state.candidate_parent_a
        candidate_parent_b = state.candidate_parent_b
        candidate_generator = state.candidate_generator

        replaced_slot = jnp.array(-1, dtype=jnp.int32)
        promoted_candidate = jnp.array(-1, dtype=jnp.int32)

        should_try_replace = (
            (self._replacement_interval > 0)
            & (step_count % jnp.array(max(self._replacement_interval, 1)) == 0)
        )
        eligible_active = ages >= self._min_feature_age
        active_scores = jnp.where(eligible_active, new_utilities, jnp.inf)
        worst_active = jnp.argmin(active_scores).astype(jnp.int32)
        has_active_slot = jnp.any(eligible_active)

        if self._candidate_count > 0:
            eligible_candidates = candidate_ages >= self._candidate_min_age
            candidate_scores = jnp.where(
                eligible_candidates, new_candidate_utilities, -jnp.inf
            )
            best_candidate = jnp.argmax(candidate_scores).astype(jnp.int32)
            worst_candidate = jnp.argmin(new_candidate_utilities).astype(jnp.int32)
            has_candidate = jnp.any(eligible_candidates)
            should_promote = (
                should_try_replace
                & has_active_slot
                & has_candidate
                & (
                    new_candidate_utilities[best_candidate]
                    > self._promotion_margin * new_utilities[worst_active]
                )
            )

            def promote_branch(
                args: tuple[
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                ],
            ) -> tuple[
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
            ]:
                (
                    fl,
                    fr,
                    ow,
                    util,
                    age,
                    cl,
                    cr,
                    cow,
                    cutil,
                    cage,
                    fpa,
                    fpb,
                    fg,
                    cpa,
                    cpb,
                    cg,
                ) = args
                fl = fl.at[worst_active].set(cl[best_candidate])
                fr = fr.at[worst_active].set(cr[best_candidate])
                ow = ow.at[:, worst_active].set(
                    self._promotion_blend * cow[:, best_candidate]
                )
                util = util.at[worst_active].set(cutil[best_candidate])
                age = age.at[worst_active].set(0)
                fpa = fpa.at[worst_active].set(cpa[best_candidate])
                fpb = fpb.at[worst_active].set(cpb[best_candidate])
                fg = fg.at[worst_active].set(cg[best_candidate])

                if self._refresh_promoted_candidate:
                    new_l, new_r, new_pa, new_pb, new_gen = self._generate_one(
                        replacement_key, observation, fl, fr, util
                    )
                    cl = cl.at[best_candidate].set(new_l)
                    cr = cr.at[best_candidate].set(new_r)
                    cpa = cpa.at[best_candidate].set(new_pa)
                    cpb = cpb.at[best_candidate].set(new_pb)
                    cg = cg.at[best_candidate].set(new_gen)
                cow = cow.at[:, best_candidate].set(0.0)
                cutil = cutil.at[best_candidate].set(0.0)
                cage = cage.at[best_candidate].set(0)
                return fl, fr, ow, util, age, cl, cr, cow, cutil, cage, fpa, fpb, fg, cpa, cpb, cg

            def refresh_candidate_branch(
                args: tuple[
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                    Array,
                ],
            ) -> tuple[
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
                Array,
            ]:
                (
                    fl,
                    fr,
                    ow,
                    util,
                    age,
                    cl,
                    cr,
                    cow,
                    cutil,
                    cage,
                    fpa,
                    fpb,
                    fg,
                    cpa,
                    cpb,
                    cg,
                ) = args
                new_l, new_r, new_pa, new_pb, new_gen = self._generate_one(
                    replacement_key, observation, fl, fr, util
                )
                do_refresh = should_try_replace & self._refresh_candidates
                cl = jax.lax.select(do_refresh, cl.at[worst_candidate].set(new_l), cl)
                cr = jax.lax.select(do_refresh, cr.at[worst_candidate].set(new_r), cr)
                cow = jax.lax.select(
                    do_refresh, cow.at[:, worst_candidate].set(0.0), cow
                )
                cutil = jax.lax.select(
                    do_refresh, cutil.at[worst_candidate].set(0.0), cutil
                )
                cage = jax.lax.select(
                    do_refresh, cage.at[worst_candidate].set(0), cage
                )
                cpa = jax.lax.select(
                    do_refresh, cpa.at[worst_candidate].set(new_pa), cpa
                )
                cpb = jax.lax.select(
                    do_refresh, cpb.at[worst_candidate].set(new_pb), cpb
                )
                cg = jax.lax.select(
                    do_refresh, cg.at[worst_candidate].set(new_gen), cg
                )
                return fl, fr, ow, util, age, cl, cr, cow, cutil, cage, fpa, fpb, fg, cpa, cpb, cg

            carry = (
                feature_left,
                feature_right,
                output_weights,
                new_utilities,
                ages,
                candidate_left,
                candidate_right,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                feature_parent_a,
                feature_parent_b,
                feature_generator,
                candidate_parent_a,
                candidate_parent_b,
                candidate_generator,
            )
            (
                feature_left,
                feature_right,
                output_weights,
                new_utilities,
                ages,
                candidate_left,
                candidate_right,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                feature_parent_a,
                feature_parent_b,
                feature_generator,
                candidate_parent_a,
                candidate_parent_b,
                candidate_generator,
            ) = jax.lax.cond(should_promote, promote_branch, refresh_candidate_branch, carry)
            replaced_slot = jnp.where(should_promote, worst_active, replaced_slot)
            promoted_candidate = jnp.where(
                should_promote, best_candidate, promoted_candidate
            )
        else:

            def replace_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                fl, fr, ow, util, age, fpa, fpb, fg = args
                new_l, new_r, new_pa, new_pb, new_gen = self._generate_one(
                    replacement_key, observation, fl, fr, util
                )
                fl = fl.at[worst_active].set(new_l)
                fr = fr.at[worst_active].set(new_r)
                ow = ow.at[:, worst_active].set(0.0)
                util = util.at[worst_active].set(0.0)
                age = age.at[worst_active].set(0)
                fpa = fpa.at[worst_active].set(new_pa)
                fpb = fpb.at[worst_active].set(new_pb)
                fg = fg.at[worst_active].set(new_gen)
                return fl, fr, ow, util, age, fpa, fpb, fg

            def keep_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                return args

            do_replace = should_try_replace & has_active_slot
            (
                feature_left,
                feature_right,
                output_weights,
                new_utilities,
                ages,
                feature_parent_a,
                feature_parent_b,
                feature_generator,
            ) = jax.lax.cond(
                do_replace,
                replace_active_branch,
                keep_active_branch,
                (
                    feature_left,
                    feature_right,
                    output_weights,
                    new_utilities,
                    ages,
                    feature_parent_a,
                    feature_parent_b,
                    feature_generator,
                ),
            )
            replaced_slot = jnp.where(do_replace, worst_active, replaced_slot)

        new_state = InteractionFeatureState(
            key=key,
            feature_left=feature_left,
            feature_right=feature_right,
            output_weights=output_weights,
            output_biases=output_biases,
            utilities=new_utilities,
            task_activity_ema=task_activity_ema,
            ages=ages,
            candidate_left=candidate_left,
            candidate_right=candidate_right,
            candidate_output_weights=candidate_output_weights,
            candidate_utilities=new_candidate_utilities,
            candidate_ages=candidate_ages,
            feature_parent_a=feature_parent_a,
            feature_parent_b=feature_parent_b,
            feature_generator=feature_generator,
            candidate_parent_a=candidate_parent_a,
            candidate_parent_b=candidate_parent_b,
            candidate_generator=candidate_generator,
            step_count=step_count,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        loss = jnp.sum(errors**2) / active_count
        mean_abs_error = jnp.sum(jnp.abs(errors)) / active_count
        max_candidate_utility = (
            jnp.max(new_candidate_utilities)
            if self._candidate_count > 0
            else jnp.array(0.0, dtype=jnp.float32)
        )
        replacement_flag = (replaced_slot >= 0).astype(jnp.float32)
        metrics = jnp.array(
            [
                loss,
                mean_abs_error,
                jnp.mean(new_utilities),
                jnp.min(new_utilities),
                max_candidate_utility,
                replacement_flag,
                bounding_scale,
            ],
            dtype=jnp.float32,
        )

        return InteractionFeatureUpdateResult(
            state=new_state,
            predictions=predictions,
            errors=reported_errors,
            metrics=metrics,
            replaced_slot=replaced_slot,
            promoted_candidate=promoted_candidate,
        )


def run_interaction_feature_arrays(
    learner: FixedBudgetInteractionLearner,
    state: InteractionFeatureState,
    observations: Array,
    targets: Array,
) -> InteractionFeatureLearningResult:
    """Run an interaction-feature learner over pre-collected arrays."""

    def step_fn(
        carry: InteractionFeatureState,
        inputs: tuple[Array, Array],
    ) -> tuple[InteractionFeatureState, Array]:
        observation, target = inputs
        result = learner.update(carry, observation, target)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]
    return InteractionFeatureLearningResult(state=final_state, metrics=metrics)


def run_interaction_feature_loop(
    learner: FixedBudgetInteractionLearner,
    stream: Any,
    num_steps: int,
    key: Array,
    learner_state: InteractionFeatureState | None = None,
) -> InteractionFeatureLearningResult:
    """Run interaction feature discovery directly from a scan-compatible stream."""
    stream_key, learner_key = jr.split(key)
    stream_state = stream.init(stream_key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, learner_key)

    def step_fn(
        carry: tuple[InteractionFeatureState, Any],
        idx: Array,
    ) -> tuple[tuple[InteractionFeatureState, Any], Array]:
        l_state, s_state = carry
        timestep, new_s_state = stream.step(s_state, idx)
        result = learner.update(l_state, timestep.observation, timestep.target)
        return (result.state, new_s_state), result.metrics

    t0 = time.time()
    (final_state, _), metrics = jax.lax.scan(
        step_fn, (learner_state, stream_state), jnp.arange(num_steps)
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]
    return InteractionFeatureLearningResult(state=final_state, metrics=metrics)
