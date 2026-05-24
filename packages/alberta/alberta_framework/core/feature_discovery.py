"""Fixed-budget feature discovery for Alberta Plan Step 2.

The classes in this module make feature lifecycle explicit.  A learner keeps a
bounded bank of nonlinear features, assigns utility to each feature from online
prediction experience, and periodically replaces or promotes features according
to that utility.

This is intentionally narrower than a general MLP.  The point is to expose the
scientific variables called out in Step 2: construction, testing, ranking, and
discarding of features under a resource budget.
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

from alberta_framework.core.future_utility import (
    contribution_trace_output_loss_reduction,
    normalize_future_utility_signal,
    one_step_output_loss_reduction,
    trace_output_loss_reduction,
)

GENERATOR_RANDOM = 0
GENERATOR_MUTATE_PARENT = 1
GENERATOR_IMPRINT = 2


@chex.dataclass(frozen=True)
class FeatureDiscoveryState:
    """State for ``FixedBudgetFeatureLearner``.

    Active features contribute to prediction.  Candidate features are trained
    against residual error but do not affect prediction until promoted.
    """

    key: PRNGKeyArray
    feature_weights: Float[Array, "n_features feature_dim"]
    feature_biases: Float[Array, " n_features"]
    output_weights: Float[Array, "n_tasks n_features"]
    output_biases: Float[Array, " n_tasks"]
    utilities: Float[Array, " n_features"]
    utility_contribution_trace: Float[Array, "n_tasks n_features"]
    utility_error_trace: Float[Array, " n_tasks"]
    utility_feature_trace: Float[Array, " n_features"]
    utility_feature_energy_trace: Float[Array, " n_features"]
    utility_signal_second_moment: Float[Array, " n_features"]
    task_activity_ema: Float[Array, " n_tasks"]
    ages: Int[Array, " n_features"]
    candidate_weights: Float[Array, "n_candidates feature_dim"]
    candidate_biases: Float[Array, " n_candidates"]
    candidate_output_weights: Float[Array, "n_tasks n_candidates"]
    candidate_utilities: Float[Array, " n_candidates"]
    candidate_utility_contribution_trace: Float[Array, "n_tasks n_candidates"]
    candidate_utility_feature_trace: Float[Array, " n_candidates"]
    candidate_utility_feature_energy_trace: Float[Array, " n_candidates"]
    candidate_utility_signal_second_moment: Float[Array, " n_candidates"]
    candidate_ages: Int[Array, " n_candidates"]
    feature_parent_a: Int[Array, " n_features"]
    feature_parent_b: Int[Array, " n_features"]
    feature_generator: Int[Array, " n_features"]
    candidate_parent_a: Int[Array, " n_candidates"]
    candidate_parent_b: Int[Array, " n_candidates"]
    candidate_generator: Int[Array, " n_candidates"]
    generator_log_weights: Float[Array, " 3"]
    generator_utility_ema: Float[Array, " 3"]
    plasticity_log_weights: Float[Array, " 3"]
    plasticity_signal_ema: Float[Array, " 3"]
    replacement_accumulator: Float[Array, ""]
    step_count: Int[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class FeatureDiscoveryUpdateResult:
    """Result of one feature-discovery update."""

    state: FeatureDiscoveryState
    predictions: Float[Array, " n_tasks"]
    errors: Float[Array, " n_tasks"]
    metrics: Float[Array, " 7"]
    replaced_slot: Int[Array, ""]
    promoted_candidate: Int[Array, ""]


@chex.dataclass(frozen=True)
class FeatureDiscoveryLearningResult:
    """Result from a scan-based feature-discovery run."""

    state: FeatureDiscoveryState
    metrics: Float[Array, "num_steps 7"]


class FixedBudgetFeatureLearner:
    """One-hidden-layer feature bank with utility-based replacement.

    The model predicts vector targets with:

    ``h_t = tanh(A_t x_t + b_t)``
    ``y_t = W_t h_t + c_t``

    The number of active features is fixed.  Optional shadow candidates learn
    on the residual error and can be promoted into active slots if their utility
    exceeds the worst active feature.
    """

    def __init__(
        self,
        n_features: int,
        n_tasks: int,
        step_size_output: float = 0.03,
        step_size_feature: float = 0.003,
        utility_decay: float = 0.995,
        replacement_interval: int = 200,
        replace_fraction: float = 1.0,
        min_feature_age: int = 100,
        candidate_count: int = 0,
        candidate_min_age: int = 50,
        promotion_margin: float = 1.05,
        promotion_blend: float = 0.5,
        generator_mix: tuple[float, float, float] = (1.0, 0.0, 0.0),
        utility_aggregation: str = "mean",
        utility_top_k: int = 1,
        utility_task_balancing: str = "none",
        task_activity_decay: float = 0.995,
        future_utility_mix: float = 0.0,
        future_utility_trace_decay: float = 0.0,
        future_utility_trace_mode: str = "marginal",
        future_utility_normalization: str = "none",
        future_utility_normalization_decay: float = 0.99,
        future_utility_rare_task_power: float = 0.0,
        utility_retention_decay: float | None = None,
        init_scale: float = 1.0,
        mutation_scale: float = 0.1,
        use_obgd: bool = True,
        obgd_kappa: float = 2.0,
        learn_feature_resources: bool = False,
        resource_learning_rate: float = 1.0,
        resource_discount: float = 0.995,
        resource_exploration: float = 0.01,
        resource_advantage_clip: float = 10.0,
        plasticity_replacement_multipliers: tuple[float, float, float] = (
            0.5,
            1.0,
            2.0,
        ),
        plasticity_promotion_margin_multipliers: tuple[float, float, float] = (
            1.25,
            1.0,
            0.8,
        ),
    ):
        """Initialize the fixed-budget learner.

        Args:
            n_features: Number of active nonlinear features.
            n_tasks: Number of supervised output heads.
            step_size_output: LMS step-size for output weights.
            step_size_feature: LMS step-size for feature-constructor weights.
            utility_decay: EMA decay for feature utility estimates.
            replacement_interval: Steps between utility-based replacement
                attempts.  Set to ``0`` to disable replacement.
            replace_fraction: Reserved for sweeps; currently one slot is
                replaced per replacement event.
            min_feature_age: Minimum active age before a feature can be
                discarded.
            candidate_count: Number of shadow candidate features to train.
            candidate_min_age: Minimum candidate age before promotion.
            promotion_margin: Candidate utility must exceed
                ``promotion_margin * worst_active_utility``.
            promotion_blend: Fraction of candidate output weights copied on
                promotion.  ``0`` is safest for interim performance; ``1`` is
                fastest if candidate testing is reliable.
            generator_mix: Probabilities for random, parent-mutation, and
                imprint generators.
            utility_aggregation: How task utility signals are aggregated:
                ``"mean"``, ``"max"``, or ``"topk"``.
            utility_top_k: Number of task heads used by ``"topk"`` aggregation.
            utility_task_balancing: Optional active-head task balancing:
                ``"none"``, ``"active"``, or ``"active_inverse_frequency"``.
            task_activity_decay: EMA decay for task activity estimates used by
                inverse-frequency utility balancing.
            future_utility_mix: Mixture weight for the one-step counterfactual
                output-loss-reduction signal. ``0`` keeps the historical
                backward-looking utility; ``1`` uses only predicted future loss
                reduction.
            future_utility_trace_decay: Discount for temporally extended
                future-utility traces. ``0`` recovers the one-step
                counterfactual. Use ``trace_decay_from_half_life`` to sweep
                eligibility half-lives.
            future_utility_trace_mode: ``"contribution"`` traces
                ``error * feature`` directly; ``"marginal"`` keeps the older
                residual-trace times feature-trace proxy for ablation.
            future_utility_normalization: Optional normalization for the
                future term: ``"none"``, ``"age"``, ``"uncertainty"``, or
                ``"uncertainty_age"``.
            future_utility_normalization_decay: EMA decay for the future-signal
                second moment used by uncertainty normalization.
            future_utility_rare_task_power: Extra inverse-frequency weighting
                applied only to future-utility task credit. ``0`` disables it.
            utility_retention_decay: Optional slower decay floor for utilities,
                useful when recurrent contexts go inactive for many steps.
            init_scale: Scale of newly generated random weights.
            mutation_scale: Scale of parent-mutation and imprint noise.
            use_obgd: Whether to bound effective online updates.
            obgd_kappa: ObGD-style bounding sensitivity.
            learn_feature_resources: If true, learn generator allocation and
                plasticity aggressiveness inside this feature-construction
                learner instead of relying only on fixed constructor knobs.
            resource_learning_rate: Learning rate for generator/plasticity
                preference updates.
            resource_discount: Preference decay for the learned managers.
            resource_exploration: Uniform allocation floor for resource
                decisions.
            resource_advantage_clip: Absolute clip on utility advantages.
            plasticity_replacement_multipliers: Conservative, nominal, and
                aggressive multipliers applied to the base replacement rate.
            plasticity_promotion_margin_multipliers: Conservative, nominal,
                and aggressive multipliers applied to the promotion margin.
        """
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
        if not 0.0 <= future_utility_trace_decay < 1.0:
            raise ValueError("future_utility_trace_decay must be in [0, 1)")
        if future_utility_trace_mode not in {"contribution", "marginal"}:
            raise ValueError(
                "future_utility_trace_mode must be 'contribution' or 'marginal'"
            )
        if future_utility_normalization not in {
            "none",
            "age",
            "uncertainty",
            "uncertainty_age",
        }:
            raise ValueError(
                "future_utility_normalization must be one of "
                "'none', 'age', 'uncertainty', or 'uncertainty_age'"
            )
        if not 0.0 <= future_utility_normalization_decay < 1.0:
            raise ValueError("future_utility_normalization_decay must be in [0, 1)")
        if future_utility_rare_task_power < 0.0:
            raise ValueError("future_utility_rare_task_power must be non-negative")
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
        if resource_learning_rate < 0.0:
            raise ValueError("resource_learning_rate must be non-negative")
        if not 0.0 <= resource_discount <= 1.0:
            raise ValueError("resource_discount must be in [0, 1]")
        if not 0.0 <= resource_exploration < 1.0:
            raise ValueError("resource_exploration must be in [0, 1)")
        if resource_advantage_clip <= 0.0:
            raise ValueError("resource_advantage_clip must be positive")
        if len(plasticity_replacement_multipliers) != 3:
            raise ValueError("plasticity_replacement_multipliers must have length 3")
        if len(plasticity_promotion_margin_multipliers) != 3:
            raise ValueError(
                "plasticity_promotion_margin_multipliers must have length 3"
            )
        if any(v <= 0.0 for v in plasticity_replacement_multipliers):
            raise ValueError("plasticity_replacement_multipliers must be positive")
        if any(v <= 0.0 for v in plasticity_promotion_margin_multipliers):
            raise ValueError(
                "plasticity_promotion_margin_multipliers must be positive"
            )

        self._n_features = n_features
        self._n_tasks = n_tasks
        self._step_size_output = step_size_output
        self._step_size_feature = step_size_feature
        self._utility_decay = utility_decay
        self._replacement_interval = replacement_interval
        self._replace_fraction = replace_fraction
        self._min_feature_age = min_feature_age
        self._candidate_count = candidate_count
        self._candidate_min_age = candidate_min_age
        self._promotion_margin = promotion_margin
        self._promotion_blend = promotion_blend
        self._generator_mix = tuple(float(v) / mix_sum for v in generator_mix)
        self._utility_aggregation = utility_aggregation
        self._utility_top_k = utility_top_k
        self._utility_task_balancing = utility_task_balancing
        self._task_activity_decay = task_activity_decay
        self._future_utility_mix = future_utility_mix
        self._future_utility_trace_decay = future_utility_trace_decay
        self._future_utility_trace_mode = future_utility_trace_mode
        self._future_utility_normalization = future_utility_normalization
        self._future_utility_normalization_decay = future_utility_normalization_decay
        self._future_utility_rare_task_power = future_utility_rare_task_power
        self._utility_retention_decay = utility_retention_decay
        self._init_scale = init_scale
        self._mutation_scale = mutation_scale
        self._use_obgd = use_obgd
        self._obgd_kappa = obgd_kappa
        self._learn_feature_resources = learn_feature_resources
        self._resource_learning_rate = resource_learning_rate
        self._resource_discount = resource_discount
        self._resource_exploration = resource_exploration
        self._resource_advantage_clip = resource_advantage_clip
        self._plasticity_replacement_multipliers = plasticity_replacement_multipliers
        self._plasticity_promotion_margin_multipliers = (
            plasticity_promotion_margin_multipliers
        )

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
            "type": "FixedBudgetFeatureLearner",
            "n_features": self._n_features,
            "n_tasks": self._n_tasks,
            "step_size_output": self._step_size_output,
            "step_size_feature": self._step_size_feature,
            "utility_decay": self._utility_decay,
            "replacement_interval": self._replacement_interval,
            "replace_fraction": self._replace_fraction,
            "min_feature_age": self._min_feature_age,
            "candidate_count": self._candidate_count,
            "candidate_min_age": self._candidate_min_age,
            "promotion_margin": self._promotion_margin,
            "promotion_blend": self._promotion_blend,
            "generator_mix": list(self._generator_mix),
            "utility_aggregation": self._utility_aggregation,
            "utility_top_k": self._utility_top_k,
            "utility_task_balancing": self._utility_task_balancing,
            "task_activity_decay": self._task_activity_decay,
            "future_utility_mix": self._future_utility_mix,
            "future_utility_trace_decay": self._future_utility_trace_decay,
            "future_utility_trace_mode": self._future_utility_trace_mode,
            "future_utility_normalization": self._future_utility_normalization,
            "future_utility_normalization_decay": (
                self._future_utility_normalization_decay
            ),
            "future_utility_rare_task_power": self._future_utility_rare_task_power,
            "utility_retention_decay": self._utility_retention_decay,
            "init_scale": self._init_scale,
            "mutation_scale": self._mutation_scale,
            "use_obgd": self._use_obgd,
            "obgd_kappa": self._obgd_kappa,
            "learn_feature_resources": self._learn_feature_resources,
            "resource_learning_rate": self._resource_learning_rate,
            "resource_discount": self._resource_discount,
            "resource_exploration": self._resource_exploration,
            "resource_advantage_clip": self._resource_advantage_clip,
            "plasticity_replacement_multipliers": list(
                self._plasticity_replacement_multipliers
            ),
            "plasticity_promotion_margin_multipliers": list(
                self._plasticity_promotion_margin_multipliers
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "FixedBudgetFeatureLearner":
        """Reconstruct learner from ``to_config`` output."""
        config = dict(config)
        config.pop("type", None)
        generator_mix = config.pop("generator_mix", (1.0, 0.0, 0.0))
        replacement_multipliers = config.pop(
            "plasticity_replacement_multipliers",
            (0.5, 1.0, 2.0),
        )
        promotion_multipliers = config.pop(
            "plasticity_promotion_margin_multipliers",
            (1.25, 1.0, 0.8),
        )
        replacement_tuple = (
            float(replacement_multipliers[0]),
            float(replacement_multipliers[1]),
            float(replacement_multipliers[2]),
        )
        promotion_tuple = (
            float(promotion_multipliers[0]),
            float(promotion_multipliers[1]),
            float(promotion_multipliers[2]),
        )
        generator_tuple = (
            float(generator_mix[0]),
            float(generator_mix[1]),
            float(generator_mix[2]),
        )
        return cls(
            generator_mix=generator_tuple,
            plasticity_replacement_multipliers=replacement_tuple,
            plasticity_promotion_margin_multipliers=promotion_tuple,
            **config,
        )

    def init(self, feature_dim: int, key: Array) -> FeatureDiscoveryState:
        """Initialize active and candidate feature banks."""
        key, k_active, k_candidate = jr.split(key, 3)
        scale = self._init_scale / jnp.sqrt(float(feature_dim))
        feature_weights = scale * jr.normal(
            k_active, (self._n_features, feature_dim), dtype=jnp.float32
        )
        feature_biases = jnp.zeros(self._n_features, dtype=jnp.float32)

        candidate_weights = scale * jr.normal(
            k_candidate, (self._candidate_count, feature_dim), dtype=jnp.float32
        )
        candidate_biases = jnp.zeros(self._candidate_count, dtype=jnp.float32)

        return FeatureDiscoveryState(
            key=key,
            feature_weights=feature_weights,
            feature_biases=feature_biases,
            output_weights=jnp.zeros((self._n_tasks, self._n_features), dtype=jnp.float32),
            output_biases=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            utilities=jnp.zeros(self._n_features, dtype=jnp.float32),
            utility_contribution_trace=jnp.zeros(
                (self._n_tasks, self._n_features), dtype=jnp.float32
            ),
            utility_error_trace=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            utility_feature_trace=jnp.zeros(self._n_features, dtype=jnp.float32),
            utility_feature_energy_trace=jnp.zeros(
                self._n_features, dtype=jnp.float32
            ),
            utility_signal_second_moment=jnp.zeros(
                self._n_features, dtype=jnp.float32
            ),
            task_activity_ema=jnp.zeros(self._n_tasks, dtype=jnp.float32),
            ages=jnp.zeros(self._n_features, dtype=jnp.int32),
            candidate_weights=candidate_weights,
            candidate_biases=candidate_biases,
            candidate_output_weights=jnp.zeros(
                (self._n_tasks, self._candidate_count), dtype=jnp.float32
            ),
            candidate_utilities=jnp.zeros(self._candidate_count, dtype=jnp.float32),
            candidate_utility_contribution_trace=jnp.zeros(
                (self._n_tasks, self._candidate_count), dtype=jnp.float32
            ),
            candidate_utility_feature_trace=jnp.zeros(
                self._candidate_count, dtype=jnp.float32
            ),
            candidate_utility_feature_energy_trace=jnp.zeros(
                self._candidate_count, dtype=jnp.float32
            ),
            candidate_utility_signal_second_moment=jnp.zeros(
                self._candidate_count, dtype=jnp.float32
            ),
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
            generator_log_weights=(
                jnp.log(jnp.asarray(self._generator_mix, dtype=jnp.float32) + 1e-8)
                - jnp.mean(
                    jnp.log(jnp.asarray(self._generator_mix, dtype=jnp.float32) + 1e-8)
                )
            ),
            generator_utility_ema=jnp.zeros(3, dtype=jnp.float32),
            plasticity_log_weights=jnp.zeros(3, dtype=jnp.float32),
            plasticity_signal_ema=jnp.zeros(3, dtype=jnp.float32),
            replacement_accumulator=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @staticmethod
    def _features(weights: Array, biases: Array, observation: Array) -> tuple[Array, Array]:
        pre = weights @ observation + biases
        values = jnp.tanh(pre)
        return values, 1.0 - values**2

    def _task_activity_update(
        self,
        old_activity: Array,
        active_mask: Array,
    ) -> Array:
        """Track active target heads for opt-in task-balanced utility."""
        return (
            self._task_activity_decay * old_activity
            + (1.0 - self._task_activity_decay) * active_mask.astype(jnp.float32)
        )

    def _output_utility_signal(
        self,
        output_weights: Array,
        features: Array,
        active_mask: Array,
        task_activity_ema: Array,
    ) -> Array:
        """Aggregate outgoing-weight utility across tasks."""
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
        if self._utility_task_balancing in {"active", "active_inverse_frequency"}:
            active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
            return jnp.sum(weighted_activity, axis=0) / active_count
        return jnp.mean(weighted_activity, axis=0)

    def _aggregate_task_feature_signal(
        self,
        task_feature_signal: Array,
        active_mask: Array,
        task_activity_ema: Array,
    ) -> Array:
        """Aggregate a per-task/per-feature signal using utility knobs."""
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

    def _future_utility_signal(
        self,
        errors: Array,
        features: Array,
        active_mask: Array,
        task_activity_ema: Array,
        active_count: Array,
        contribution_trace: Array,
        error_trace: Array,
        feature_trace: Array,
        feature_energy_trace: Array,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Predict causal output-loss reduction for each feature."""
        if self._future_utility_trace_decay == 0.0:
            reductions = one_step_output_loss_reduction(
                errors,
                features,
                active_mask,
                self._step_size_output,
                active_count,
            )
            new_contribution_trace = contribution_trace
            new_error_trace = error_trace
            new_feature_trace = feature_trace
            new_feature_energy_trace = feature_energy_trace
        elif self._future_utility_trace_mode == "marginal":
            (
                reductions,
                new_error_trace,
                new_feature_trace,
                new_feature_energy_trace,
            ) = trace_output_loss_reduction(
                errors,
                features,
                active_mask,
                self._step_size_output,
                active_count,
                error_trace,
                feature_trace,
                feature_energy_trace,
                self._future_utility_trace_decay,
            )
            new_contribution_trace = contribution_trace
        else:
            reductions, new_contribution_trace, new_feature_energy_trace = (
                contribution_trace_output_loss_reduction(
                    errors,
                    features,
                    active_mask,
                    self._step_size_output,
                    active_count,
                    contribution_trace,
                    feature_energy_trace,
                    self._future_utility_trace_decay,
                )
            )
            new_error_trace = error_trace
            new_feature_trace = feature_trace

        if self._future_utility_rare_task_power > 0.0:
            frequency_floor = jnp.array(
                1.0 - self._task_activity_decay, dtype=jnp.float32
            )
            rare_weights = jnp.power(
                1.0 / jnp.maximum(task_activity_ema, frequency_floor),
                self._future_utility_rare_task_power,
            )
            reductions = reductions * rare_weights[:, None]
        return (
            self._aggregate_task_feature_signal(
                reductions,
                active_mask,
                task_activity_ema,
            ),
            new_contribution_trace,
            new_error_trace,
            new_feature_trace,
            new_feature_energy_trace,
        )

    def _mixed_utility_signal(
        self,
        current_signal: Array,
        errors: Array,
        features: Array,
        active_mask: Array,
        task_activity_ema: Array,
        active_count: Array,
        contribution_trace: Array,
        error_trace: Array,
        feature_trace: Array,
        feature_energy_trace: Array,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Blend historical utility with causal predicted future utility."""
        if self._future_utility_mix == 0.0:
            return (
                current_signal,
                contribution_trace,
                error_trace,
                feature_trace,
                feature_energy_trace,
            )
        (
            future_signal,
            new_contribution_trace,
            new_error_trace,
            new_feature_trace,
            new_feature_energy_trace,
        ) = self._future_utility_signal(
            errors,
            features,
            active_mask,
            task_activity_ema,
            active_count,
            contribution_trace,
            error_trace,
            feature_trace,
            feature_energy_trace,
        )
        return (
            (1.0 - self._future_utility_mix) * current_signal
            + self._future_utility_mix * future_signal,
            new_contribution_trace,
            new_error_trace,
            new_feature_trace,
            new_feature_energy_trace,
        )

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

    def _resource_weights(self, log_weights: Array) -> Array:
        """Return a soft resource allocation with optional exploration."""
        weights = jax.nn.softmax(log_weights)
        if self._resource_exploration > 0.0:
            uniform = jnp.full_like(weights, 1.0 / weights.shape[0])
            weights = (
                (1.0 - self._resource_exploration) * weights
                + self._resource_exploration * uniform
            )
        return weights

    def _resource_log_weight_update(
        self,
        log_weights: Array,
        allocation: Array,
        scores: Array,
        finite: Array,
    ) -> Array:
        """Exponentiated-gradient preference update for utility scores."""
        finite_mass = jnp.maximum(jnp.sum(jnp.where(finite, allocation, 0.0)), 1e-12)
        masked_allocation = jnp.where(finite, allocation / finite_mass, 0.0)
        baseline = jnp.sum(masked_allocation * jnp.where(finite, scores, 0.0))
        advantages = jnp.where(finite, scores - baseline, 0.0)
        advantages = jnp.clip(
            advantages,
            -self._resource_advantage_clip,
            self._resource_advantage_clip,
        )
        new_log_weights = (
            self._resource_discount * log_weights
            + self._resource_learning_rate * advantages
        )
        return new_log_weights - jnp.mean(new_log_weights)

    def _generator_scores(
        self,
        utilities: Array,
        feature_generator: Array,
        candidate_utilities: Array,
        candidate_generator: Array,
    ) -> tuple[Array, Array]:
        """Return mean utility and availability mask per generator action."""
        generator_ids = jnp.arange(3, dtype=jnp.int32)
        active_matches = feature_generator[None, :] == generator_ids[:, None]
        active_sums = jnp.sum(
            jnp.where(active_matches, utilities[None, :], 0.0),
            axis=1,
        )
        active_counts = jnp.sum(active_matches.astype(jnp.float32), axis=1)
        candidate_matches = candidate_generator[None, :] == generator_ids[:, None]
        candidate_sums = jnp.sum(
            jnp.where(candidate_matches, candidate_utilities[None, :], 0.0),
            axis=1,
        )
        candidate_counts = jnp.sum(candidate_matches.astype(jnp.float32), axis=1)
        counts = active_counts + candidate_counts
        scores = (active_sums + candidate_sums) / jnp.maximum(counts, 1.0)
        return scores, counts > 0.0

    def _generate_one(
        self,
        key: Array,
        observation: Array,
        active_weights: Array,
        active_biases: Array,
        utilities: Array,
        generator_mix: Array | None = None,
    ) -> tuple[Array, Array, Array, Array, Array]:
        """Generate one new feature constructor."""
        feature_dim = observation.shape[0]
        key_kind, key_noise, key_parent = jr.split(key, 3)
        mix = (
            jnp.array(self._generator_mix, dtype=jnp.float32)
            if generator_mix is None
            else jnp.asarray(generator_mix, dtype=jnp.float32)
        )
        generator = jr.categorical(key_kind, jnp.log(mix + 1e-8))
        noise = jr.normal(key_noise, (feature_dim,), dtype=jnp.float32)
        dim_scale = jnp.sqrt(jnp.array(feature_dim, dtype=jnp.float32))
        random_w = self._init_scale * noise / dim_scale
        random_b = jnp.array(0.0, dtype=jnp.float32)

        parent_logits = jnp.log(utilities + 1e-3)
        parent_idx = jr.categorical(key_parent, parent_logits).astype(jnp.int32)
        parent_w = active_weights[parent_idx]
        parent_b = active_biases[parent_idx]
        mutate_w = parent_w + self._mutation_scale * noise / dim_scale
        mutate_b = parent_b

        obs_norm = jnp.linalg.norm(observation) + 1e-6
        imprint_w = observation / obs_norm + self._mutation_scale * noise / dim_scale
        imprint_b = -0.5 * jnp.dot(imprint_w, observation)

        def random_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                random_w,
                random_b,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_RANDOM, dtype=jnp.int32),
            )

        def mutate_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                mutate_w,
                mutate_b,
                parent_idx,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_MUTATE_PARENT, dtype=jnp.int32),
            )

        def imprint_branch() -> tuple[Array, Array, Array, Array, Array]:
            return (
                imprint_w,
                imprint_b,
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(-1, dtype=jnp.int32),
                jnp.array(GENERATOR_IMPRINT, dtype=jnp.int32),
            )

        return jax.lax.switch(generator, (random_branch, mutate_branch, imprint_branch))

    @functools.partial(jax.jit, static_argnums=(0,))
    def constructed_features(
        self,
        state: FeatureDiscoveryState,
        observation: Array,
    ) -> Array:
        """Return active constructed nonlinear features for ``observation``.

        This is the representation handoff needed by later Alberta Plan steps:
        once Step 2 has found useful features, downstream predictors such as
        Horde/GVF learners can treat these values as given features.
        """
        features, _ = self._features(
            state.feature_weights, state.feature_biases, observation
        )
        return features

    @functools.partial(jax.jit, static_argnums=(0,))
    def augmented_observation(
        self,
        state: FeatureDiscoveryState,
        observation: Array,
    ) -> Array:
        """Concatenate raw observation with active constructed features."""
        return jnp.concatenate(
            [observation, self.constructed_features(state, observation)]
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: FeatureDiscoveryState, observation: Array) -> Array:
        """Predict all tasks from active features."""
        features = self.constructed_features(state, observation)
        return state.output_weights @ features + state.output_biases

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: FeatureDiscoveryState,
        observation: Array,
        targets: Array,
    ) -> FeatureDiscoveryUpdateResult:
        """Perform one temporally-uniform feature-discovery update."""
        active_mask = ~jnp.isnan(targets)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
        task_activity_ema = self._task_activity_update(
            state.task_activity_ema, active_mask
        )
        generator_mix = jnp.asarray(self._generator_mix, dtype=jnp.float32)
        plasticity_weights = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)
        if self._learn_feature_resources:
            generator_mix = self._resource_weights(state.generator_log_weights)
            plasticity_weights = self._resource_weights(state.plasticity_log_weights)
        promotion_margin = jnp.asarray(self._promotion_margin, dtype=jnp.float32)
        if self._learn_feature_resources:
            margin_multipliers = jnp.asarray(
                self._plasticity_promotion_margin_multipliers,
                dtype=jnp.float32,
            )
            promotion_margin = promotion_margin * jnp.sum(
                plasticity_weights * margin_multipliers
            )

        features, feature_derivs = self._features(
            state.feature_weights, state.feature_biases, observation
        )
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

        feature_credit = (errors @ state.output_weights) * feature_derivs / active_count
        feature_weight_delta = (
            self._step_size_feature * feature_credit[:, None] * observation[None, :]
        )
        feature_bias_delta = self._step_size_feature * feature_credit

        output_utility_signal = self._output_utility_signal(
            state.output_weights,
            features,
            active_mask,
            task_activity_ema,
        )
        current_utility_signal = 0.5 * output_utility_signal + 0.5 * jnp.abs(
            feature_credit
        )
        (
            utility_signal,
            utility_contribution_trace,
            utility_error_trace,
            utility_feature_trace,
            utility_feature_energy_trace,
        ) = self._mixed_utility_signal(
            current_utility_signal,
            errors,
            features,
            active_mask,
            task_activity_ema,
            active_count,
            state.utility_contribution_trace,
            state.utility_error_trace,
            state.utility_feature_trace,
            state.utility_feature_energy_trace,
        )
        utility_signal_second_moment = state.utility_signal_second_moment
        if (
            self._future_utility_mix > 0.0
            and self._future_utility_normalization != "none"
        ):
            utility_signal, utility_signal_second_moment = (
                normalize_future_utility_signal(
                    utility_signal,
                    state.ages,
                    state.utility_signal_second_moment,
                    self._future_utility_normalization_decay,
                    self._utility_decay,
                    self._future_utility_normalization,
                )
            )
        new_utilities = self._utility_update(
            state.utilities,
            utility_signal,
        )

        candidate_output_delta = jnp.zeros_like(state.candidate_output_weights)
        candidate_weight_delta = jnp.zeros_like(state.candidate_weights)
        candidate_bias_delta = jnp.zeros_like(state.candidate_biases)
        new_candidate_utilities = state.candidate_utilities
        candidate_utility_contribution_trace = (
            state.candidate_utility_contribution_trace
        )
        candidate_utility_feature_trace = state.candidate_utility_feature_trace
        candidate_utility_feature_energy_trace = (
            state.candidate_utility_feature_energy_trace
        )
        candidate_utility_signal_second_moment = (
            state.candidate_utility_signal_second_moment
        )
        if self._candidate_count > 0:
            candidate_features, candidate_derivs = self._features(
                state.candidate_weights, state.candidate_biases, observation
            )
            candidate_output_delta = (
                self._step_size_output
                * errors[:, None]
                * candidate_features[None, :]
                / active_count
            )
            candidate_credit = (
                errors @ state.candidate_output_weights
            ) * candidate_derivs / active_count
            candidate_weight_delta = (
                self._step_size_feature
                * candidate_credit[:, None]
                * observation[None, :]
            )
            candidate_bias_delta = self._step_size_feature * candidate_credit
            candidate_output_signal = self._output_utility_signal(
                state.candidate_output_weights,
                candidate_features,
                active_mask,
                task_activity_ema,
            )
            candidate_signal = 0.5 * candidate_output_signal + 0.5 * jnp.abs(
                candidate_credit
            )
            (
                candidate_signal,
                candidate_utility_contribution_trace,
                _candidate_error_trace,
                candidate_utility_feature_trace,
                candidate_utility_feature_energy_trace,
            ) = self._mixed_utility_signal(
                candidate_signal,
                errors,
                candidate_features,
                active_mask,
                task_activity_ema,
                active_count,
                state.candidate_utility_contribution_trace,
                state.utility_error_trace,
                state.candidate_utility_feature_trace,
                state.candidate_utility_feature_energy_trace,
            )
            del _candidate_error_trace
            if (
                self._future_utility_mix > 0.0
                and self._future_utility_normalization != "none"
            ):
                candidate_signal, candidate_utility_signal_second_moment = (
                    normalize_future_utility_signal(
                        candidate_signal,
                        state.candidate_ages,
                        state.candidate_utility_signal_second_moment,
                        self._future_utility_normalization_decay,
                        self._utility_decay,
                        self._future_utility_normalization,
                    )
                )
            new_candidate_utilities = self._utility_update(
                state.candidate_utilities,
                candidate_signal,
            )

        bounding_scale = jnp.array(1.0, dtype=jnp.float32)
        if self._use_obgd:
            total_step = (
                jnp.sum(jnp.abs(output_delta))
                + jnp.sum(jnp.abs(output_bias_delta))
                + jnp.sum(jnp.abs(feature_weight_delta))
                + jnp.sum(jnp.abs(feature_bias_delta))
                + jnp.sum(jnp.abs(candidate_output_delta))
                + jnp.sum(jnp.abs(candidate_weight_delta))
                + jnp.sum(jnp.abs(candidate_bias_delta))
            )
            err_norm = jnp.linalg.norm(errors)
            bound_magnitude = self._obgd_kappa * jnp.maximum(err_norm, 1.0) * total_step
            bounding_scale = 1.0 / jnp.maximum(bound_magnitude, 1.0)
            output_delta = bounding_scale * output_delta
            output_bias_delta = bounding_scale * output_bias_delta
            feature_weight_delta = bounding_scale * feature_weight_delta
            feature_bias_delta = bounding_scale * feature_bias_delta
            candidate_output_delta = bounding_scale * candidate_output_delta
            candidate_weight_delta = bounding_scale * candidate_weight_delta
            candidate_bias_delta = bounding_scale * candidate_bias_delta

        feature_weights = state.feature_weights + feature_weight_delta
        feature_biases = state.feature_biases + feature_bias_delta
        output_weights = state.output_weights + output_delta
        output_biases = state.output_biases + output_bias_delta
        candidate_weights = state.candidate_weights + candidate_weight_delta
        candidate_biases = state.candidate_biases + candidate_bias_delta
        candidate_output_weights = (
            state.candidate_output_weights + candidate_output_delta
        )
        ages = state.ages + 1
        candidate_ages = state.candidate_ages + 1
        step_count = state.step_count + 1
        key, replacement_key = jr.split(state.key)

        replaced_slot = jnp.array(-1, dtype=jnp.int32)
        promoted_candidate = jnp.array(-1, dtype=jnp.int32)

        replacement_accumulator = state.replacement_accumulator
        if self._learn_feature_resources and self._replacement_interval > 0:
            replacement_multipliers = jnp.asarray(
                self._plasticity_replacement_multipliers,
                dtype=jnp.float32,
            )
            replacement_rate = (
                jnp.sum(plasticity_weights * replacement_multipliers)
                / float(self._replacement_interval)
            )
            replacement_accumulator = replacement_accumulator + replacement_rate
            should_try_replace = replacement_accumulator >= 1.0
            replacement_accumulator = jnp.where(
                should_try_replace,
                replacement_accumulator - 1.0,
                replacement_accumulator,
            )
        else:
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
                    > promotion_margin * new_utilities[worst_active]
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
                Array,
            ]:
                (
                    fw,
                    fb,
                    ow,
                    util,
                    age,
                    cw,
                    cb,
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
                gen_key = replacement_key
                new_cw, new_cb, new_pa, new_pb, new_gen = self._generate_one(
                    gen_key, observation, fw, fb, util, generator_mix
                )
                fw = fw.at[worst_active].set(cw[best_candidate])
                fb = fb.at[worst_active].set(cb[best_candidate])
                ow = ow.at[:, worst_active].set(
                    self._promotion_blend * cow[:, best_candidate]
                )
                util = util.at[worst_active].set(cutil[best_candidate])
                age = age.at[worst_active].set(0)
                fpa = fpa.at[worst_active].set(cpa[best_candidate])
                fpb = fpb.at[worst_active].set(cpb[best_candidate])
                fg = fg.at[worst_active].set(cg[best_candidate])

                cw = cw.at[best_candidate].set(new_cw)
                cb = cb.at[best_candidate].set(new_cb)
                cow = cow.at[:, best_candidate].set(0.0)
                cutil = cutil.at[best_candidate].set(0.0)
                cage = cage.at[best_candidate].set(0)
                cpa = cpa.at[best_candidate].set(new_pa)
                cpb = cpb.at[best_candidate].set(new_pb)
                cg = cg.at[best_candidate].set(new_gen)
                return (
                    fw,
                    fb,
                    ow,
                    util,
                    age,
                    cw,
                    cb,
                    cow,
                    cutil,
                    cage,
                    fpa,
                    fpb,
                    fg,
                    cpa,
                    cpb,
                    cg,
                )

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
                Array,
            ]:
                (
                    fw,
                    fb,
                    ow,
                    util,
                    age,
                    cw,
                    cb,
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
                gen_key = replacement_key
                new_cw, new_cb, new_pa, new_pb, new_gen = self._generate_one(
                    gen_key, observation, fw, fb, util, generator_mix
                )
                do_refresh = should_try_replace
                cw = jax.lax.select(do_refresh, cw.at[worst_candidate].set(new_cw), cw)
                cb = jax.lax.select(do_refresh, cb.at[worst_candidate].set(new_cb), cb)
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
                return (
                    fw,
                    fb,
                    ow,
                    util,
                    age,
                    cw,
                    cb,
                    cow,
                    cutil,
                    cage,
                    fpa,
                    fpb,
                    fg,
                    cpa,
                    cpb,
                    cg,
                )

            carry = (
                feature_weights,
                feature_biases,
                output_weights,
                new_utilities,
                ages,
                candidate_weights,
                candidate_biases,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                state.feature_parent_a,
                state.feature_parent_b,
                state.feature_generator,
                state.candidate_parent_a,
                state.candidate_parent_b,
                state.candidate_generator,
            )
            (
                feature_weights,
                feature_biases,
                output_weights,
                new_utilities,
                ages,
                candidate_weights,
                candidate_biases,
                candidate_output_weights,
                new_candidate_utilities,
                candidate_ages,
                feature_parent_a,
                feature_parent_b,
                feature_generator,
                candidate_parent_a,
                candidate_parent_b,
                candidate_generator,
            ) = jax.lax.cond(
                should_promote, promote_branch, refresh_candidate_branch, carry
            )
            replaced_slot = jnp.where(should_promote, worst_active, replaced_slot)
            promoted_candidate = jnp.where(
                should_promote, best_candidate, promoted_candidate
            )
        else:

            def replace_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                fw, fb, ow, util, age, fpa, fpb, fg = args
                new_w, new_b, new_pa, new_pb, new_gen = self._generate_one(
                    replacement_key, observation, fw, fb, util, generator_mix
                )
                fw = fw.at[worst_active].set(new_w)
                fb = fb.at[worst_active].set(new_b)
                ow = ow.at[:, worst_active].set(0.0)
                util = util.at[worst_active].set(0.0)
                age = age.at[worst_active].set(0)
                fpa = fpa.at[worst_active].set(new_pa)
                fpb = fpb.at[worst_active].set(new_pb)
                fg = fg.at[worst_active].set(new_gen)
                return fw, fb, ow, util, age, fpa, fpb, fg

            def keep_active_branch(
                args: tuple[Array, Array, Array, Array, Array, Array, Array, Array],
            ) -> tuple[Array, Array, Array, Array, Array, Array, Array, Array]:
                return args

            do_replace = should_try_replace & has_active_slot
            (
                feature_weights,
                feature_biases,
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
                    feature_weights,
                    feature_biases,
                    output_weights,
                    new_utilities,
                    ages,
                    state.feature_parent_a,
                    state.feature_parent_b,
                    state.feature_generator,
                ),
            )
            replaced_slot = jnp.where(do_replace, worst_active, replaced_slot)
            candidate_parent_a = state.candidate_parent_a
            candidate_parent_b = state.candidate_parent_b
            candidate_generator = state.candidate_generator

        generator_log_weights = state.generator_log_weights
        generator_utility_ema = state.generator_utility_ema
        plasticity_log_weights = state.plasticity_log_weights
        plasticity_signal_ema = state.plasticity_signal_ema
        if self._learn_feature_resources:
            generator_scores, generator_finite = self._generator_scores(
                new_utilities,
                feature_generator,
                new_candidate_utilities,
                candidate_generator,
            )
            generator_utility_ema = jnp.where(
                generator_finite,
                self._resource_discount * generator_utility_ema
                + (1.0 - self._resource_discount) * generator_scores,
                generator_utility_ema,
            )
            generator_log_weights = self._resource_log_weight_update(
                generator_log_weights,
                generator_mix,
                generator_scores,
                generator_finite,
            )

            if self._candidate_count > 0:
                eligible_candidates_for_pressure = (
                    candidate_ages >= self._candidate_min_age
                )
                candidate_pressure_scores = jnp.where(
                    eligible_candidates_for_pressure,
                    new_candidate_utilities,
                    -jnp.inf,
                )
                best_candidate_for_pressure = jnp.argmax(
                    candidate_pressure_scores
                ).astype(jnp.int32)
                has_candidate_for_pressure = jnp.any(
                    eligible_candidates_for_pressure
                )
                worst_active_utility = new_utilities[worst_active]
                best_candidate_utility = new_candidate_utilities[
                    best_candidate_for_pressure
                ]
                pressure_raw = (
                    best_candidate_utility
                    - promotion_margin * worst_active_utility
                ) / (jnp.abs(worst_active_utility) + 1e-6)
                pressure = jnp.where(
                    has_active_slot & has_candidate_for_pressure,
                    jnp.tanh(pressure_raw),
                    jnp.array(0.0, dtype=jnp.float32),
                )
            else:
                pressure = jnp.array(0.0, dtype=jnp.float32)
            plasticity_scores = jnp.stack(
                [-pressure, jnp.array(0.0, dtype=jnp.float32), pressure]
            )
            plasticity_signal_ema = (
                self._resource_discount * plasticity_signal_ema
                + (1.0 - self._resource_discount) * plasticity_scores
            )
            plasticity_log_weights = self._resource_log_weight_update(
                plasticity_log_weights,
                plasticity_weights,
                plasticity_scores,
                jnp.ones(3, dtype=jnp.bool_),
            )

        reset_active_traces = ages == 0
        utility_contribution_trace = jnp.where(
            reset_active_traces[None, :], 0.0, utility_contribution_trace
        )
        utility_feature_trace = jnp.where(
            reset_active_traces, 0.0, utility_feature_trace
        )
        utility_feature_energy_trace = jnp.where(
            reset_active_traces, 0.0, utility_feature_energy_trace
        )
        utility_signal_second_moment = jnp.where(
            reset_active_traces, 0.0, utility_signal_second_moment
        )
        reset_candidate_traces = candidate_ages == 0
        candidate_utility_contribution_trace = jnp.where(
            reset_candidate_traces[None, :],
            0.0,
            candidate_utility_contribution_trace,
        )
        candidate_utility_feature_trace = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_feature_trace
        )
        candidate_utility_feature_energy_trace = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_feature_energy_trace
        )
        candidate_utility_signal_second_moment = jnp.where(
            reset_candidate_traces, 0.0, candidate_utility_signal_second_moment
        )

        new_state = FeatureDiscoveryState(
            key=key,
            feature_weights=feature_weights,
            feature_biases=feature_biases,
            output_weights=output_weights,
            output_biases=output_biases,
            utilities=new_utilities,
            utility_contribution_trace=utility_contribution_trace,
            utility_error_trace=utility_error_trace,
            utility_feature_trace=utility_feature_trace,
            utility_feature_energy_trace=utility_feature_energy_trace,
            utility_signal_second_moment=utility_signal_second_moment,
            task_activity_ema=task_activity_ema,
            ages=ages,
            candidate_weights=candidate_weights,
            candidate_biases=candidate_biases,
            candidate_output_weights=candidate_output_weights,
            candidate_utilities=new_candidate_utilities,
            candidate_utility_contribution_trace=candidate_utility_contribution_trace,
            candidate_utility_feature_trace=candidate_utility_feature_trace,
            candidate_utility_feature_energy_trace=(
                candidate_utility_feature_energy_trace
            ),
            candidate_utility_signal_second_moment=(
                candidate_utility_signal_second_moment
            ),
            candidate_ages=candidate_ages,
            feature_parent_a=feature_parent_a,
            feature_parent_b=feature_parent_b,
            feature_generator=feature_generator,
            candidate_parent_a=candidate_parent_a,
            candidate_parent_b=candidate_parent_b,
            candidate_generator=candidate_generator,
            generator_log_weights=generator_log_weights,
            generator_utility_ema=generator_utility_ema,
            plasticity_log_weights=plasticity_log_weights,
            plasticity_signal_ema=plasticity_signal_ema,
            replacement_accumulator=replacement_accumulator,
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

        return FeatureDiscoveryUpdateResult(
            state=new_state,
            predictions=predictions,
            errors=reported_errors,
            metrics=metrics,
            replaced_slot=replaced_slot,
            promoted_candidate=promoted_candidate,
        )


def run_feature_discovery_arrays(
    learner: FixedBudgetFeatureLearner,
    state: FeatureDiscoveryState,
    observations: Array,
    targets: Array,
) -> FeatureDiscoveryLearningResult:
    """Run a feature-discovery learner over pre-collected stream arrays."""

    def step_fn(
        carry: FeatureDiscoveryState,
        inputs: tuple[Array, Array],
    ) -> tuple[FeatureDiscoveryState, Array]:
        observation, target = inputs
        result = learner.update(carry, observation, target)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]
    return FeatureDiscoveryLearningResult(state=final_state, metrics=metrics)


def run_feature_discovery_loop(
    learner: FixedBudgetFeatureLearner,
    stream: Any,
    num_steps: int,
    key: Array,
    learner_state: FeatureDiscoveryState | None = None,
) -> FeatureDiscoveryLearningResult:
    """Run feature discovery directly from a scan-compatible stream."""
    stream_key, learner_key = jr.split(key)
    stream_state = stream.init(stream_key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, learner_key)

    def step_fn(
        carry: tuple[FeatureDiscoveryState, Any],
        idx: Array,
    ) -> tuple[tuple[FeatureDiscoveryState, Any], Array]:
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
    return FeatureDiscoveryLearningResult(state=final_state, metrics=metrics)
