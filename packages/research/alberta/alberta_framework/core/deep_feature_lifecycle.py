"""Native hidden-unit generate-and-test for deep MLP layers.

This module adds the smallest native feature lifecycle mechanism that is
still recognizably "inside" a deep MLP rather than an external feature bank.
It wraps :class:`MultiHeadMLPLearner` and keeps, for every hidden layer, a
small bank of shadow candidate units.  Candidates receive the same layer input
that an active unit would receive, train a residual readout to the supervised
heads, accumulate utility, and periodically compete with mature low-utility
active units for promotion.

Promotion replaces an active hidden unit's incoming weights with the selected
candidate's incoming weights.  For the final hidden layer, the active output
head connections are initialized from the candidate's residual readout.  For
earlier layers, outgoing connections are zeroed and downstream weights relearn
the promoted unit's use.  This keeps the algorithm functional, bounded-budget,
and JAX-scan compatible while making the early-layer test intentionally
conservative.
"""

from __future__ import annotations

import functools
import time
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.initializers import sparse_init
from alberta_framework.core.multi_head_learner import (
    AnyOptimizer,
    MultiHeadMLPLearner,
    MultiHeadMLPState,
    MultiHeadMLPUpdateResult,
)
from alberta_framework.core.normalizers import Normalizer
from alberta_framework.core.optimizers import Bounder
from alberta_framework.core.types import TraceMode


@chex.dataclass(frozen=True)
class DeepFeatureLifecycleConfig:
    """Hyperparameters for native deep feature generate-and-test.

    Attributes:
        candidate_count: Number of shadow candidate units per hidden layer.
        candidate_step_size: LMS step-size for each candidate's residual
            readout into the supervised heads.
        candidate_utility_decay: EMA decay for candidate utility.
        candidate_weight_step_size: LMS step-size for residual-gradient updates
            to candidate incoming weights and biases.  ``0`` keeps candidates
            static after initialization except for refresh.
        candidate_perturbation_std: Standard deviation of additive Gaussian
            perturbations to candidate incoming weights on each online update.
            This gives a small plasticity-search hybrid when nonzero.
        candidate_normalized_updates: Use normalized LMS-style candidate
            readout and incoming-weight updates.  Readout steps are divided by
            candidate activation energy, and incoming-row steps by layer-input
            energy.  This is a compact unit-level scaling rule for candidate
            learning, independent of the active learner optimizer.
        candidate_update_epsilon: Numerical floor for normalized candidate
            updates.
        active_utility_decay: EMA decay for mature active-unit utility.  This
            mirrors ``MultiHeadMLPLearner``'s utility signal but is tracked here
            so promotions can reset ages and utilities independently.
        promotion_interval: Try one promotion per hidden layer every N updates.
        min_unit_age: Minimum active-unit age before it can be replaced.
        candidate_min_age: Minimum candidate age before it can be promoted.
        promotion_margin: Candidate utility must exceed active utility by this
            absolute margin.
        promotion_ratio: Candidate utility must exceed
            ``promotion_ratio * active_utility``.
        promotion_layer_mode: Hidden layers eligible for promotion:
            ``"all"``, ``"first"``, or ``"final"``.
        promotion_utility_mode: Utility comparison mode. ``"raw"`` compares
            candidate and active utility directly. ``"mean_normalized"``
            divides each by its layer mean before applying ratio/margin.
        replacement_warmup_steps: Number of learner updates before scheduled
            promotions can occur. Candidate training still runs during warmup.
        replacement_utility_quantile: Only active units at or below this
            utility quantile are eligible for replacement.  ``1.0`` means all
            mature units are eligible; lower values protect high-utility units.
        layer_promotion_budget: Maximum number of hidden layers promoted at one
            scheduled test.  ``0`` means no cross-layer cap.
        early_promotion_outgoing_mode: How to handle outgoing weights when
            promoting into a non-final hidden layer. ``"zero"`` matches the
            conservative original behavior. ``"preserve"`` keeps the replaced
            unit's outgoing column so the promoted unit can be tested through
            the existing downstream pathway instead of starting disconnected.
        candidate_init: Candidate incoming-weight initialization mode:
            ``"sparse"``, ``"orthogonalized"``, or ``"active_perturbation"``.
            Orthogonalized candidates subtract their projection on current
            active rows when possible.  Active-perturbation candidates copy a
            low-utility active unit's incoming row plus small Gaussian noise.
        active_candidate_perturbation_std: Standard deviation for
            ``candidate_init="active_perturbation"``.
        function_preserving_promotion: Preserve existing outgoing coefficients
            and compensate the next-layer/head bias by the current activation
            delta when promoting a candidate.  This is an opt-in Net2Net-style
            hardening path that minimizes the current prediction jump.
        promotion_output_change_threshold: Maximum current-sample prediction
            change allowed before promotion. ``inf`` disables this guard.
        candidate_perturbation_utility_scaled: Scale candidate input-weight
            perturbations by low normalized candidate utility, matching UPGD's
            "perturb least useful structure most" bias.
        active_perturbation_std: Optional UPGD-style perturbation scale applied
            to active trunk weight rows with low layer-local hidden-unit
            utility.  ``0`` disables active perturbation.
        active_perturbation_beta: Exponent on ``(1 - normalized_utility)`` for
            active low-utility perturbations.
        active_perturbation_warmup_steps: Number of learner updates before
            active perturbations begin.
        active_perturbation_ramp_steps: Number of updates after warmup used to
            ramp active perturbations up to ``active_perturbation_std``.
        active_perturbation_interval: Apply active perturbation every N updates.
        soft_gated_candidates: Route candidate units through a small trainable
            gate into existing hidden-layer outputs.  This is opt-in; defaults
            preserve the original off-path hard candidate test.
        candidate_gate_init: Initial scalar gate value for each candidate.
        candidate_gate_step_size: LMS step-size for candidate gates.
        candidate_gate_l1: Per-step L1 shrinkage applied to gates.
        candidate_gate_max_abs: Absolute gate clipping bound.
        soft_gate_layer_mode: Layers that receive live candidate gates:
            ``"final"`` or ``"all"``.
        refresh_on_failed_promotion: Refresh the worst mature candidate when no
            promotion occurs at a scheduled test.  This keeps generation active
            instead of letting stale candidates occupy the bank forever.
        enabled: Master switch.  When ``False``, the wrapper degenerates to the
            underlying MLP update with zero promotions.
    """

    candidate_count: int = 4
    candidate_step_size: float = 0.03
    candidate_utility_decay: float = 0.99
    candidate_weight_step_size: float = 0.0
    candidate_perturbation_std: float = 0.0
    candidate_normalized_updates: bool = False
    candidate_update_epsilon: float = 1e-3
    active_utility_decay: float = 0.99
    promotion_interval: int = 100
    min_unit_age: int = 100
    candidate_min_age: int = 50
    promotion_margin: float = 0.0
    promotion_ratio: float = 1.05
    promotion_layer_mode: str = "all"
    promotion_utility_mode: str = "raw"
    replacement_warmup_steps: int = 0
    replacement_utility_quantile: float = 1.0
    layer_promotion_budget: int = 0
    early_promotion_outgoing_mode: str = "zero"
    candidate_init: str = "sparse"
    active_candidate_perturbation_std: float = 0.01
    function_preserving_promotion: bool = False
    promotion_output_change_threshold: float = float("inf")
    candidate_perturbation_utility_scaled: bool = False
    active_perturbation_std: float = 0.0
    active_perturbation_beta: float = 2.0
    active_perturbation_warmup_steps: int = 0
    active_perturbation_ramp_steps: int = 0
    active_perturbation_interval: int = 1
    soft_gated_candidates: bool = False
    candidate_gate_init: float = 0.0
    candidate_gate_step_size: float = 0.01
    candidate_gate_l1: float = 0.0
    candidate_gate_max_abs: float = 0.25
    soft_gate_layer_mode: str = "final"
    refresh_on_failed_promotion: bool = True
    enabled: bool = True

    def __post_init__(self) -> None:
        if self.candidate_count < 1:
            raise ValueError("candidate_count must be >= 1")
        if self.candidate_step_size < 0.0:
            raise ValueError("candidate_step_size must be >= 0")
        if not 0.0 <= self.candidate_utility_decay < 1.0:
            raise ValueError("candidate_utility_decay must be in [0, 1)")
        if self.candidate_weight_step_size < 0.0:
            raise ValueError("candidate_weight_step_size must be >= 0")
        if self.candidate_perturbation_std < 0.0:
            raise ValueError("candidate_perturbation_std must be >= 0")
        if self.candidate_update_epsilon <= 0.0:
            raise ValueError("candidate_update_epsilon must be > 0")
        if not 0.0 <= self.active_utility_decay < 1.0:
            raise ValueError("active_utility_decay must be in [0, 1)")
        if self.promotion_interval < 1:
            raise ValueError("promotion_interval must be >= 1")
        if self.min_unit_age < 0:
            raise ValueError("min_unit_age must be >= 0")
        if self.candidate_min_age < 0:
            raise ValueError("candidate_min_age must be >= 0")
        if self.promotion_ratio < 0.0:
            raise ValueError("promotion_ratio must be >= 0")
        if self.promotion_layer_mode not in {"all", "first", "final"}:
            raise ValueError("promotion_layer_mode must be 'all', 'first', or 'final'")
        if self.promotion_utility_mode not in {"raw", "mean_normalized"}:
            raise ValueError("promotion_utility_mode must be 'raw' or 'mean_normalized'")
        if self.replacement_warmup_steps < 0:
            raise ValueError("replacement_warmup_steps must be >= 0")
        if not 0.0 <= self.replacement_utility_quantile <= 1.0:
            raise ValueError("replacement_utility_quantile must be in [0, 1]")
        if self.layer_promotion_budget < 0:
            raise ValueError("layer_promotion_budget must be >= 0")
        if self.early_promotion_outgoing_mode not in {"zero", "preserve"}:
            raise ValueError(
                "early_promotion_outgoing_mode must be 'zero' or 'preserve'"
            )
        if self.candidate_init not in {
            "sparse",
            "orthogonalized",
            "active_perturbation",
        }:
            raise ValueError(
                "candidate_init must be 'sparse', 'orthogonalized', "
                "or 'active_perturbation'"
            )
        if self.active_candidate_perturbation_std < 0.0:
            raise ValueError("active_candidate_perturbation_std must be >= 0")
        if self.promotion_output_change_threshold < 0.0:
            raise ValueError("promotion_output_change_threshold must be >= 0")
        if self.active_perturbation_std < 0.0:
            raise ValueError("active_perturbation_std must be >= 0")
        if self.active_perturbation_beta < 0.0:
            raise ValueError("active_perturbation_beta must be >= 0")
        if self.active_perturbation_warmup_steps < 0:
            raise ValueError("active_perturbation_warmup_steps must be >= 0")
        if self.active_perturbation_ramp_steps < 0:
            raise ValueError("active_perturbation_ramp_steps must be >= 0")
        if self.active_perturbation_interval < 1:
            raise ValueError("active_perturbation_interval must be >= 1")
        if self.candidate_gate_step_size < 0.0:
            raise ValueError("candidate_gate_step_size must be >= 0")
        if self.candidate_gate_l1 < 0.0:
            raise ValueError("candidate_gate_l1 must be >= 0")
        if self.candidate_gate_max_abs < 0.0:
            raise ValueError("candidate_gate_max_abs must be >= 0")
        if self.soft_gate_layer_mode not in {"final", "all"}:
            raise ValueError("soft_gate_layer_mode must be 'final' or 'all'")

    def to_config(self) -> dict[str, Any]:
        """Serialize to a JSON-compatible dict."""
        return {
            "candidate_count": self.candidate_count,
            "candidate_step_size": self.candidate_step_size,
            "candidate_utility_decay": self.candidate_utility_decay,
            "candidate_weight_step_size": self.candidate_weight_step_size,
            "candidate_perturbation_std": self.candidate_perturbation_std,
            "candidate_normalized_updates": self.candidate_normalized_updates,
            "candidate_update_epsilon": self.candidate_update_epsilon,
            "active_utility_decay": self.active_utility_decay,
            "promotion_interval": self.promotion_interval,
            "min_unit_age": self.min_unit_age,
            "candidate_min_age": self.candidate_min_age,
            "promotion_margin": self.promotion_margin,
            "promotion_ratio": self.promotion_ratio,
            "promotion_layer_mode": self.promotion_layer_mode,
            "promotion_utility_mode": self.promotion_utility_mode,
            "replacement_warmup_steps": self.replacement_warmup_steps,
            "replacement_utility_quantile": self.replacement_utility_quantile,
            "layer_promotion_budget": self.layer_promotion_budget,
            "early_promotion_outgoing_mode": self.early_promotion_outgoing_mode,
            "candidate_init": self.candidate_init,
            "active_candidate_perturbation_std": (
                self.active_candidate_perturbation_std
            ),
            "function_preserving_promotion": self.function_preserving_promotion,
            "promotion_output_change_threshold": (
                self.promotion_output_change_threshold
            ),
            "candidate_perturbation_utility_scaled": (
                self.candidate_perturbation_utility_scaled
            ),
            "active_perturbation_std": self.active_perturbation_std,
            "active_perturbation_beta": self.active_perturbation_beta,
            "active_perturbation_warmup_steps": (
                self.active_perturbation_warmup_steps
            ),
            "active_perturbation_ramp_steps": self.active_perturbation_ramp_steps,
            "active_perturbation_interval": self.active_perturbation_interval,
            "soft_gated_candidates": self.soft_gated_candidates,
            "candidate_gate_init": self.candidate_gate_init,
            "candidate_gate_step_size": self.candidate_gate_step_size,
            "candidate_gate_l1": self.candidate_gate_l1,
            "candidate_gate_max_abs": self.candidate_gate_max_abs,
            "soft_gate_layer_mode": self.soft_gate_layer_mode,
            "refresh_on_failed_promotion": self.refresh_on_failed_promotion,
            "enabled": self.enabled,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> DeepFeatureLifecycleConfig:
        """Reconstruct from :meth:`to_config` output."""
        return cls(**config)


@chex.dataclass(frozen=True)
class DeepFeatureLifecycleState:
    """Joint state for deep feature lifecycle learning."""

    mlp_state: MultiHeadMLPState
    unit_ages: tuple[Int[Array, " hidden_dim"], ...]
    active_utilities: tuple[Float[Array, " hidden_dim"], ...]
    candidate_weights: tuple[Float[Array, "candidates fan_in"], ...]
    candidate_biases: tuple[Float[Array, " candidates"], ...]
    candidate_output_weights: tuple[Float[Array, "n_heads candidates"], ...]
    candidate_gates: tuple[Float[Array, " candidates"], ...]
    candidate_target_units: tuple[Int[Array, " candidates"], ...]
    candidate_utilities: tuple[Float[Array, " candidates"], ...]
    candidate_ages: tuple[Int[Array, " candidates"], ...]
    rng_key: Array


@chex.dataclass(frozen=True)
class DeepFeatureLifecycleUpdateResult:
    """Result of one deep feature lifecycle update."""

    state: DeepFeatureLifecycleState
    predictions: Float[Array, " n_heads"]
    errors: Float[Array, " n_heads"]
    per_head_metrics: Float[Array, "n_heads 3"]
    lifecycle_metrics: Float[Array, " 4"]
    promotions_made: Int[Array, " n_layers"]


@chex.dataclass(frozen=True)
class DeepFeatureLifecycleLearningResult:
    """Result from a scan-based deep feature lifecycle run."""

    state: DeepFeatureLifecycleState
    per_head_metrics: Float[Array, "num_steps n_heads 3"]
    lifecycle_metrics: Float[Array, "num_steps 4"]
    promotions_made: Int[Array, "num_steps n_layers"]


def _layer_inputs_and_activations(
    weights: tuple[Array, ...],
    biases: tuple[Array, ...],
    observation: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> tuple[tuple[Array, ...], tuple[Array, ...]]:
    """Return each hidden layer's input and post-activation."""
    inputs: list[Array] = []
    activations: list[Array] = []
    x = observation
    for i in range(len(weights)):
        inputs.append(x)
        x = weights[i] @ x + biases[i]
        if use_layer_norm:
            mean = jnp.mean(x)
            var = jnp.var(x)
            x = (x - mean) / jnp.sqrt(var + 1e-5)
        x = jnp.where(x >= 0, x, leaky_relu_slope * x)
        activations.append(x)
    return tuple(inputs), tuple(activations)


def _candidate_activations(
    weights: Array,
    biases: Array,
    layer_input: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> Array:
    """Evaluate a layer's candidate bank on the current layer input."""
    pre = weights @ layer_input + biases
    if use_layer_norm and pre.shape[0] > 1:
        pre = (pre - jnp.mean(pre)) / jnp.sqrt(jnp.var(pre) + 1e-5)
    return jnp.where(pre >= 0, pre, leaky_relu_slope * pre)


def _candidate_activation_derivatives(
    weights: Array,
    biases: Array,
    layer_input: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> Array:
    """Approximate local derivative for candidate imprinting."""
    pre = weights @ layer_input + biases
    if use_layer_norm and pre.shape[0] > 1:
        pre = (pre - jnp.mean(pre)) / jnp.sqrt(jnp.var(pre) + 1e-5)
    return jnp.where(pre >= 0, jnp.float32(1.0), jnp.asarray(leaky_relu_slope, jnp.float32))


def _activate_layer_pre(
    pre: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> Array:
    """Apply the hidden-layer normalization and nonlinearity."""
    if use_layer_norm:
        pre = (pre - jnp.mean(pre)) / jnp.sqrt(jnp.var(pre) + 1e-5)
    return jnp.where(pre >= 0, pre, leaky_relu_slope * pre)


def _hidden_after_unit_replacement(
    weights: Array,
    biases: Array,
    layer_input: Array,
    unit_idx: Array,
    new_row: Array,
    new_bias: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> Array:
    """Hidden activation vector after replacing one incoming row."""
    pre = weights @ layer_input + biases
    promoted_pre = new_row @ layer_input + new_bias
    pre = pre.at[unit_idx].set(promoted_pre)
    return _activate_layer_pre(pre, leaky_relu_slope, use_layer_norm)


def _predict_from_params(
    trunk_weights: tuple[Array, ...],
    trunk_biases: tuple[Array, ...],
    head_weights: tuple[Array, ...],
    head_biases: tuple[Array, ...],
    observation: Array,
    leaky_relu_slope: float,
    use_layer_norm: bool,
) -> Array:
    """Predict directly from parameter tuples on an already-normalized input."""
    x = observation
    for weights, biases in zip(trunk_weights, trunk_biases, strict=True):
        x = _activate_layer_pre(
            weights @ x + biases,
            leaky_relu_slope,
            use_layer_norm,
        )
    return jnp.asarray(
        [jnp.squeeze(w @ x + b) for w, b in zip(head_weights, head_biases, strict=True)]
    )


def _orthogonalize_against_rows(weights: Array, active_rows: Array) -> Array:
    """Subtract projection of candidate rows on current active rows."""
    gram = active_rows @ active_rows.T
    ridge = 1e-6 * jnp.eye(gram.shape[0], dtype=gram.dtype)

    def orthogonalize(row: Array) -> Array:
        coeffs = jnp.linalg.solve(gram + ridge, active_rows @ row)
        projected = coeffs @ active_rows
        candidate = row - projected
        candidate_norm = jnp.linalg.norm(candidate)
        row_norm = jnp.linalg.norm(row)
        scaled = candidate * (row_norm / (candidate_norm + 1e-8))
        return jnp.where(candidate_norm > 1e-6, scaled, row)

    return jax.vmap(orthogonalize)(weights)


def _initialize_candidate_weights(
    key: Array,
    shape: tuple[int, int],
    active_rows: Array,
    sparsity: float,
    candidate_init: str,
    active_candidate_perturbation_std: float = 0.01,
    target_units: Array | None = None,
) -> Array:
    if candidate_init == "active_perturbation":
        if target_units is None:
            target_units = jnp.arange(shape[0], dtype=jnp.int32) % active_rows.shape[0]
        noise = jr.normal(key, shape, dtype=active_rows.dtype)
        return (
            active_rows[target_units]
            + jnp.asarray(active_candidate_perturbation_std, active_rows.dtype) * noise
        )
    weights = sparse_init(key, shape, sparsity=sparsity)
    if candidate_init == "orthogonalized":
        return _orthogonalize_against_rows(weights, active_rows)
    return weights


def _select_low_utility_mature(
    utilities: Array,
    ages: Array,
    min_age: int,
    max_utility_quantile: float = 1.0,
) -> tuple[Array, Array]:
    threshold = jnp.quantile(utilities, jnp.asarray(max_utility_quantile, jnp.float32))
    mature = jnp.logical_and(
        ages >= jnp.asarray(min_age, dtype=ages.dtype),
        utilities <= threshold,
    )
    masked = jnp.where(mature, utilities, jnp.inf)
    has_candidate = jnp.any(mature)
    idx = jnp.argmin(masked)
    return idx.astype(jnp.int32), has_candidate


def _select_high_utility_mature(
    utilities: Array,
    ages: Array,
    min_age: int,
) -> tuple[Array, Array]:
    mature = ages >= jnp.asarray(min_age, dtype=ages.dtype)
    masked = jnp.where(mature, utilities, -jnp.inf)
    has_candidate = jnp.any(mature)
    idx = jnp.argmax(masked)
    return idx.astype(jnp.int32), has_candidate


def _replace_tuple_item(values: tuple[Array, ...], idx: int, value: Array) -> tuple[Array, ...]:
    out = list(values)
    out[idx] = value
    return tuple(out)


def _mean_normalized(value: Array, values: Array) -> Array:
    scale = jnp.maximum(
        jnp.mean(jnp.abs(values)),
        jnp.asarray(1e-8, dtype=values.dtype),
    )
    return value / scale


def _add_candidates_to_layer(
    active: Array,
    candidate_activations: Array,
    gates: Array,
    target_units: Array,
) -> Array:
    """Inject gated candidate activations into fixed active-unit slots."""
    live_delta = gates * candidate_activations
    return active.at[target_units].add(live_delta)


class DeepFeatureGeneratingMultiHeadMLPLearner:
    """Multi-head MLP with native hidden-unit candidate testing.

    The underlying learner supplies ordinary streaming backprop updates and
    hidden-unit utility signals.  This wrapper adds a bounded shadow candidate
    bank to each hidden layer and periodically promotes a tested candidate into
    the actual MLP.  Existing ``MultiHeadMLPLearner`` APIs and states are not
    modified.
    """

    def __init__(
        self,
        n_heads: int,
        hidden_sizes: tuple[int, ...] = (128, 128),
        lifecycle_config: DeepFeatureLifecycleConfig | None = None,
        optimizer: AnyOptimizer | None = None,
        step_size: float = 1.0,
        bounder: Bounder | None = None,
        gamma: float = 0.0,
        lamda: float = 0.0,
        normalizer: Normalizer[Any] | None = None,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        head_optimizer: AnyOptimizer | None = None,
        per_head_gamma_lamda: tuple[float, ...] | None = None,
        trace_mode: TraceMode = TraceMode.ACCUMULATING,
        utility_decay: float = 0.99,
    ):
        self._n_heads = n_heads
        self._hidden_sizes = hidden_sizes
        self._config = lifecycle_config or DeepFeatureLifecycleConfig()
        self._sparsity = float(sparsity)
        self._leaky_relu_slope = float(leaky_relu_slope)
        self._use_layer_norm = bool(use_layer_norm)
        self._learner = MultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=hidden_sizes,
            optimizer=optimizer,
            step_size=step_size,
            bounder=bounder,
            gamma=gamma,
            lamda=lamda,
            normalizer=normalizer,
            sparsity=sparsity,
            leaky_relu_slope=leaky_relu_slope,
            use_layer_norm=use_layer_norm,
            head_optimizer=head_optimizer,
            per_head_gamma_lamda=per_head_gamma_lamda,
            trace_mode=trace_mode,
            utility_decay=utility_decay,
        )

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying plain multi-head MLP learner."""
        return self._learner

    @property
    def config(self) -> DeepFeatureLifecycleConfig:
        """Lifecycle hyperparameters."""
        return self._config

    @property
    def n_heads(self) -> int:
        """Number of supervised heads."""
        return self._n_heads

    @property
    def hidden_sizes(self) -> tuple[int, ...]:
        """Hidden layer sizes."""
        return self._hidden_sizes

    def to_config(self) -> dict[str, Any]:
        """Serialize learner and lifecycle configuration."""
        learner_cfg = self._learner.to_config()
        learner_cfg.pop("type", None)
        return {
            "type": "DeepFeatureGeneratingMultiHeadMLPLearner",
            "lifecycle_config": self._config.to_config(),
            **learner_cfg,
        }

    @classmethod
    def from_config(
        cls,
        config: dict[str, Any],
    ) -> DeepFeatureGeneratingMultiHeadMLPLearner:
        """Reconstruct from :meth:`to_config` output."""
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        config = dict(config)
        config.pop("type", None)
        lifecycle_config = DeepFeatureLifecycleConfig.from_config(
            config.pop("lifecycle_config")
        )

        optimizer = optimizer_from_config(config.pop("optimizer"))
        bounder_cfg = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_cfg) if bounder_cfg is not None else None
        normalizer_cfg = config.pop("normalizer", None)
        normalizer = (
            normalizer_from_config(normalizer_cfg) if normalizer_cfg is not None else None
        )
        head_opt_cfg = config.pop("head_optimizer", None)
        head_optimizer = (
            optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
        )
        per_head_gl = config.pop("per_head_gamma_lamda", None)
        if per_head_gl is not None:
            per_head_gl = tuple(per_head_gl)
        trace_mode_str = config.pop("trace_mode", None)
        trace_mode = (
            TraceMode(trace_mode_str)
            if trace_mode_str is not None
            else TraceMode.ACCUMULATING
        )

        return cls(
            n_heads=config.pop("n_heads"),
            hidden_sizes=tuple(config.pop("hidden_sizes")),
            lifecycle_config=lifecycle_config,
            optimizer=optimizer,
            bounder=bounder,
            normalizer=normalizer,
            head_optimizer=head_optimizer,
            per_head_gamma_lamda=per_head_gl,
            trace_mode=trace_mode,
            **config,
        )

    def init(self, feature_dim: int, key: Array) -> DeepFeatureLifecycleState:
        """Initialize underlying MLP and per-layer candidate banks."""
        mlp_key, candidate_key = jr.split(key)
        mlp_state = self._learner.init(feature_dim, mlp_key)
        candidate_weights: list[Array] = []
        candidate_biases: list[Array] = []
        candidate_output_weights: list[Array] = []
        candidate_gates: list[Array] = []
        candidate_target_units: list[Array] = []
        candidate_utilities: list[Array] = []
        candidate_ages: list[Array] = []
        unit_ages: list[Array] = []
        active_utilities: list[Array] = []

        layer_sizes = [feature_dim, *self._hidden_sizes]
        for i, hidden_size in enumerate(self._hidden_sizes):
            fan_in = layer_sizes[i]
            candidate_key, subkey = jr.split(candidate_key)
            target_units = (
                jnp.arange(self._config.candidate_count, dtype=jnp.int32) % hidden_size
            )
            w = _initialize_candidate_weights(
                subkey,
                (self._config.candidate_count, fan_in),
                mlp_state.trunk_params.weights[i],
                sparsity=self._sparsity,
                candidate_init=self._config.candidate_init,
                active_candidate_perturbation_std=(
                    self._config.active_candidate_perturbation_std
                ),
                target_units=target_units,
            )
            candidate_weights.append(w)
            candidate_biases.append(
                jnp.zeros(self._config.candidate_count, dtype=jnp.float32)
            )
            candidate_output_weights.append(
                jnp.zeros(
                    (self._n_heads, self._config.candidate_count),
                    dtype=jnp.float32,
                )
            )
            candidate_gates.append(
                jnp.full(
                    self._config.candidate_count,
                    self._config.candidate_gate_init,
                    dtype=jnp.float32,
                )
            )
            candidate_target_units.append(target_units)
            candidate_utilities.append(
                jnp.zeros(self._config.candidate_count, dtype=jnp.float32)
            )
            candidate_ages.append(
                jnp.zeros(self._config.candidate_count, dtype=jnp.int32)
            )
            unit_ages.append(jnp.zeros(hidden_size, dtype=jnp.int32))
            active_utilities.append(jnp.zeros(hidden_size, dtype=jnp.float32))

        return DeepFeatureLifecycleState(  # type: ignore[call-arg]
            mlp_state=mlp_state,
            unit_ages=tuple(unit_ages),
            active_utilities=tuple(active_utilities),
            candidate_weights=tuple(candidate_weights),
            candidate_biases=tuple(candidate_biases),
            candidate_output_weights=tuple(candidate_output_weights),
            candidate_gates=tuple(candidate_gates),
            candidate_target_units=tuple(candidate_target_units),
            candidate_utilities=tuple(candidate_utilities),
            candidate_ages=tuple(candidate_ages),
            rng_key=candidate_key,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: DeepFeatureLifecycleState, observation: Array) -> Array:
        """Predict using the promoted active MLP only."""
        if self._config.soft_gated_candidates and self._config.enabled:
            return self._predict_with_soft_candidates(state, observation)
        return self._learner.predict(state.mlp_state, observation)  # type: ignore[no-any-return]

    def _soft_gate_layer_enabled(self, layer_idx: int, n_layers: int) -> bool:
        if not self._config.soft_gated_candidates:
            return False
        if self._config.soft_gate_layer_mode == "all":
            return True
        return layer_idx == n_layers - 1

    def _predict_with_soft_candidates(
        self,
        state: DeepFeatureLifecycleState,
        observation: Array,
    ) -> Array:
        """Predict with opt-in live gated candidates and fixed tensor shapes."""
        obs = observation
        if self._learner.normalizer is not None and state.mlp_state.normalizer_state is not None:
            obs = self._learner.normalizer.normalize_only(
                state.mlp_state.normalizer_state, observation
            )

        x = obs
        n_layers = len(state.mlp_state.trunk_params.weights)
        for layer_idx in range(n_layers):
            pre = (
                state.mlp_state.trunk_params.weights[layer_idx] @ x
                + state.mlp_state.trunk_params.biases[layer_idx]
            )
            if self._use_layer_norm:
                pre = (pre - jnp.mean(pre)) / jnp.sqrt(jnp.var(pre) + 1e-5)
            active = jnp.where(pre >= 0, pre, self._leaky_relu_slope * pre)
            if self._soft_gate_layer_enabled(layer_idx, n_layers):
                cand_act = _candidate_activations(
                    state.candidate_weights[layer_idx],
                    state.candidate_biases[layer_idx],
                    x,
                    self._leaky_relu_slope,
                    self._use_layer_norm,
                )
                active = _add_candidates_to_layer(
                    active,
                    cand_act,
                    state.candidate_gates[layer_idx],
                    state.candidate_target_units[layer_idx],
                )
            x = active

        predictions = []
        for h in range(self._n_heads):
            pred = jnp.squeeze(
                state.mlp_state.head_params.weights[h] @ x
                + state.mlp_state.head_params.biases[h]
            )
            predictions.append(pred)
        return jnp.asarray(predictions)

    def _refresh_candidate(
        self,
        layer_idx: int,
        candidate_idx: Array,
        do_refresh: Array,
        state: DeepFeatureLifecycleState,
        key: Array,
    ) -> DeepFeatureLifecycleState:
        fan_in = state.candidate_weights[layer_idx].shape[1]
        low_unit_idx, has_low_unit = _select_low_utility_mature(
            state.active_utilities[layer_idx],
            state.unit_ages[layer_idx],
            0,
            self._config.replacement_utility_quantile,
        )
        target_units = jnp.expand_dims(low_unit_idx, axis=0)
        sampled = _initialize_candidate_weights(
            key,
            (1, fan_in),
            state.mlp_state.trunk_params.weights[layer_idx],
            sparsity=self._sparsity,
            candidate_init=self._config.candidate_init,
            active_candidate_perturbation_std=(
                self._config.active_candidate_perturbation_std
            ),
            target_units=target_units,
        )[0]

        old_w_layer = state.candidate_weights[layer_idx]
        old_b_layer = state.candidate_biases[layer_idx]
        old_out_layer = state.candidate_output_weights[layer_idx]
        old_gate_layer = state.candidate_gates[layer_idx]
        old_target_layer = state.candidate_target_units[layer_idx]
        old_util_layer = state.candidate_utilities[layer_idx]
        old_age_layer = state.candidate_ages[layer_idx]

        new_row = jnp.where(do_refresh, sampled, old_w_layer[candidate_idx])
        new_w_layer = old_w_layer.at[candidate_idx].set(new_row)
        new_b_layer = old_b_layer.at[candidate_idx].set(
            jnp.where(do_refresh, jnp.float32(0.0), old_b_layer[candidate_idx])
        )
        new_out_col = jnp.where(
            do_refresh,
            jnp.zeros(self._n_heads, dtype=jnp.float32),
            old_out_layer[:, candidate_idx],
        )
        new_out_layer = old_out_layer.at[:, candidate_idx].set(new_out_col)
        new_gate_layer = old_gate_layer.at[candidate_idx].set(
            jnp.where(
                do_refresh,
                jnp.asarray(self._config.candidate_gate_init, dtype=jnp.float32),
                old_gate_layer[candidate_idx],
            )
        )
        new_target_layer = old_target_layer.at[candidate_idx].set(
            jnp.where(
                jnp.logical_and(do_refresh, has_low_unit),
                low_unit_idx,
                old_target_layer[candidate_idx],
            )
        )
        new_util_layer = old_util_layer.at[candidate_idx].set(
            jnp.where(do_refresh, jnp.float32(0.0), old_util_layer[candidate_idx])
        )
        new_age_layer = old_age_layer.at[candidate_idx].set(
            jnp.where(do_refresh, jnp.int32(0), old_age_layer[candidate_idx])
        )

        new_state = state.replace(  # type: ignore[attr-defined]
            candidate_weights=_replace_tuple_item(
                state.candidate_weights, layer_idx, new_w_layer
            ),
            candidate_biases=_replace_tuple_item(
                state.candidate_biases, layer_idx, new_b_layer
            ),
            candidate_output_weights=_replace_tuple_item(
                state.candidate_output_weights, layer_idx, new_out_layer
            ),
            candidate_gates=_replace_tuple_item(
                state.candidate_gates, layer_idx, new_gate_layer
            ),
            candidate_target_units=_replace_tuple_item(
                state.candidate_target_units, layer_idx, new_target_layer
            ),
            candidate_utilities=_replace_tuple_item(
                state.candidate_utilities, layer_idx, new_util_layer
            ),
            candidate_ages=_replace_tuple_item(
                state.candidate_ages, layer_idx, new_age_layer
            ),
        )
        return cast(DeepFeatureLifecycleState, new_state)

    def _apply_active_perturbations(
        self,
        mlp_state: MultiHeadMLPState,
        key: Array,
    ) -> tuple[MultiHeadMLPState, Array]:
        """Perturb low-utility active trunk rows using layer-local utility."""
        std = jnp.asarray(self._config.active_perturbation_std, dtype=jnp.float32)
        beta = jnp.asarray(self._config.active_perturbation_beta, dtype=jnp.float32)
        warmup_steps = jnp.asarray(
            self._config.active_perturbation_warmup_steps,
            dtype=mlp_state.step_count.dtype,
        )
        ramp_steps = jnp.asarray(
            self._config.active_perturbation_ramp_steps,
            dtype=jnp.float32,
        )
        interval = jnp.asarray(
            self._config.active_perturbation_interval,
            dtype=mlp_state.step_count.dtype,
        )
        do_perturb = jnp.logical_and(
            std > 0.0,
            jnp.logical_and(
                mlp_state.step_count >= warmup_steps,
                (mlp_state.step_count % interval) == 0,
            ),
        )
        ramp_progress = jnp.where(
            ramp_steps > 0.0,
            (
                mlp_state.step_count.astype(jnp.float32)
                - warmup_steps.astype(jnp.float32)
                + 1.0
            )
            / jnp.maximum(ramp_steps, 1.0),
            1.0,
        )
        schedule_scale = jnp.clip(ramp_progress, 0.0, 1.0)

        new_weights: list[Array] = []
        for layer_idx, weights in enumerate(mlp_state.trunk_params.weights):
            key, subkey = jr.split(key)
            utilities = (
                mlp_state.hidden_unit_utilities[layer_idx]
                if len(mlp_state.hidden_unit_utilities) > layer_idx
                else jnp.zeros(weights.shape[0], dtype=weights.dtype)
            )
            utility_max = jnp.max(utilities) + jnp.asarray(1e-8, dtype=weights.dtype)
            utility_norm = jnp.clip(utilities / utility_max, 0.0, 1.0)
            row_scale = (
                std
                * schedule_scale
                * jnp.power(jnp.maximum(1.0 - utility_norm, 0.0), beta)
            )
            noise = jr.normal(subkey, weights.shape, dtype=weights.dtype)
            perturbation = jnp.where(do_perturb, row_scale[:, None] * noise, 0.0)
            new_weights.append(weights + perturbation)

        new_trunk_params = mlp_state.trunk_params.replace(  # type: ignore[attr-defined]
            weights=tuple(new_weights)
        )
        new_mlp_state = mlp_state.replace(trunk_params=new_trunk_params)  # type: ignore[attr-defined]
        return cast(MultiHeadMLPState, new_mlp_state), key

    def _activation_delta_for_promotion(
        self,
        layer_idx: int,
        unit_idx: Array,
        candidate_idx: Array,
        state: DeepFeatureLifecycleState,
        layer_inputs: tuple[Array, ...],
        activations: tuple[Array, ...],
    ) -> Array:
        """Current-sample hidden-vector delta from inserting a candidate."""
        promoted_hidden = _hidden_after_unit_replacement(
            state.mlp_state.trunk_params.weights[layer_idx],
            state.mlp_state.trunk_params.biases[layer_idx],
            layer_inputs[layer_idx],
            unit_idx,
            state.candidate_weights[layer_idx][candidate_idx],
            state.candidate_biases[layer_idx][candidate_idx],
            self._leaky_relu_slope,
            self._use_layer_norm,
        )
        return promoted_hidden - activations[layer_idx]

    def _promotion_output_change_estimate(
        self,
        layer_idx: int,
        unit_idx: Array,
        candidate_idx: Array,
        state: DeepFeatureLifecycleState,
        normalized_observation: Array,
    ) -> Array:
        """Estimate immediate prediction jump for an uncompensated hardening."""
        mlp_state = state.mlp_state
        n_layers = len(mlp_state.trunk_params.weights)
        trunk_weights = list(mlp_state.trunk_params.weights)
        trunk_biases = list(mlp_state.trunk_params.biases)
        head_weights = list(mlp_state.head_params.weights)

        w_layer = trunk_weights[layer_idx]
        b_layer = trunk_biases[layer_idx]
        trunk_weights[layer_idx] = w_layer.at[unit_idx].set(
            state.candidate_weights[layer_idx][candidate_idx]
        )
        trunk_biases[layer_idx] = b_layer.at[unit_idx].set(
            state.candidate_biases[layer_idx][candidate_idx]
        )
        if (
            layer_idx < n_layers - 1
            and self._config.early_promotion_outgoing_mode == "zero"
            and not self._config.function_preserving_promotion
        ):
            next_w = trunk_weights[layer_idx + 1]
            trunk_weights[layer_idx + 1] = next_w.at[:, unit_idx].set(
                jnp.zeros(next_w.shape[0], dtype=next_w.dtype)
            )
        elif layer_idx == n_layers - 1 and not self._config.function_preserving_promotion:
            out_col = state.candidate_output_weights[layer_idx][:, candidate_idx]
            for h in range(self._n_heads):
                head_weights[h] = head_weights[h].at[0, unit_idx].set(out_col[h])

        old_pred = _predict_from_params(
            mlp_state.trunk_params.weights,
            mlp_state.trunk_params.biases,
            mlp_state.head_params.weights,
            mlp_state.head_params.biases,
            normalized_observation,
            self._leaky_relu_slope,
            self._use_layer_norm,
        )
        new_pred = _predict_from_params(
            tuple(trunk_weights),
            tuple(trunk_biases),
            tuple(head_weights),
            mlp_state.head_params.biases,
            normalized_observation,
            self._leaky_relu_slope,
            self._use_layer_norm,
        )
        return jnp.max(jnp.abs(new_pred - old_pred))

    def _promote_candidate(
        self,
        layer_idx: int,
        unit_idx: Array,
        candidate_idx: Array,
        do_promote: Array,
        state: DeepFeatureLifecycleState,
        layer_inputs: tuple[Array, ...],
        activations: tuple[Array, ...],
    ) -> DeepFeatureLifecycleState:
        mlp_state = state.mlp_state
        n_layers = len(mlp_state.trunk_params.weights)

        trunk_weights = list(mlp_state.trunk_params.weights)
        trunk_biases = list(mlp_state.trunk_params.biases)
        head_weights = list(mlp_state.head_params.weights)
        head_biases = list(mlp_state.head_params.biases)
        trunk_traces = list(mlp_state.trunk_traces)
        head_traces = list(mlp_state.head_traces)
        activation_delta = self._activation_delta_for_promotion(
            layer_idx,
            unit_idx,
            candidate_idx,
            state,
            layer_inputs,
            activations,
        )

        w_layer = trunk_weights[layer_idx]
        b_layer = trunk_biases[layer_idx]
        new_in_row = jnp.where(
            do_promote,
            state.candidate_weights[layer_idx][candidate_idx],
            w_layer[unit_idx],
        )
        trunk_weights[layer_idx] = w_layer.at[unit_idx].set(new_in_row)
        trunk_biases[layer_idx] = b_layer.at[unit_idx].set(
            jnp.where(
                do_promote,
                state.candidate_biases[layer_idx][candidate_idx],
                b_layer[unit_idx],
            )
        )
        trunk_traces[2 * layer_idx] = trunk_traces[2 * layer_idx].at[unit_idx].set(
            jnp.where(
                do_promote,
                jnp.zeros_like(trunk_traces[2 * layer_idx][unit_idx]),
                trunk_traces[2 * layer_idx][unit_idx],
            )
        )
        trunk_traces[2 * layer_idx + 1] = trunk_traces[2 * layer_idx + 1].at[
            unit_idx
        ].set(
            jnp.where(
                do_promote,
                jnp.float32(0.0),
                trunk_traces[2 * layer_idx + 1][unit_idx],
            )
        )

        if layer_idx < n_layers - 1:
            next_w = trunk_weights[layer_idx + 1]
            if self._config.function_preserving_promotion:
                next_bias = trunk_biases[layer_idx + 1]
                bias_correction = next_w @ activation_delta
                trunk_biases[layer_idx + 1] = next_bias - jnp.where(
                    do_promote,
                    bias_correction,
                    jnp.zeros_like(bias_correction),
                )
            elif self._config.early_promotion_outgoing_mode == "zero":
                zero_col = jnp.zeros(next_w.shape[0], dtype=next_w.dtype)
                trunk_weights[layer_idx + 1] = next_w.at[:, unit_idx].set(
                    jnp.where(do_promote, zero_col, next_w[:, unit_idx])
                )
            next_trace = trunk_traces[2 * (layer_idx + 1)]
            trunk_traces[2 * (layer_idx + 1)] = next_trace.at[:, unit_idx].set(
                jnp.where(
                    do_promote,
                    jnp.zeros(next_trace.shape[0], dtype=next_trace.dtype),
                    next_trace[:, unit_idx],
                )
            )
        else:
            out_col = state.candidate_output_weights[layer_idx][:, candidate_idx]
            for h in range(self._n_heads):
                head_w = head_weights[h]
                if self._config.function_preserving_promotion:
                    promoted_val = head_w[0, unit_idx]
                    bias_correction = jnp.squeeze(head_w @ activation_delta)
                    head_biases[h] = head_biases[h] - jnp.where(
                        do_promote,
                        jnp.reshape(bias_correction, head_biases[h].shape),
                        jnp.zeros_like(head_biases[h]),
                    )
                else:
                    promoted_val = (
                        head_w[0, unit_idx]
                        if self._config.soft_gated_candidates
                        else out_col[h]
                    )
                new_val = jnp.where(do_promote, promoted_val, head_w[0, unit_idx])
                head_weights[h] = head_w.at[0, unit_idx].set(new_val)
                w_trace, b_trace = head_traces[h]
                del b_trace
                new_trace_val = jnp.where(do_promote, jnp.float32(0.0), w_trace[0, unit_idx])
                head_traces[h] = (
                    w_trace.at[0, unit_idx].set(new_trace_val),
                    head_traces[h][1],
                )

        new_trunk_params = mlp_state.trunk_params.replace(  # type: ignore[attr-defined]
            weights=tuple(trunk_weights),
            biases=tuple(trunk_biases),
        )
        new_head_params = mlp_state.head_params.replace(  # type: ignore[attr-defined]
            weights=tuple(head_weights),
            biases=tuple(head_biases),
        )
        new_hidden_utils = list(mlp_state.hidden_unit_utilities)
        if new_hidden_utils:
            util_layer = new_hidden_utils[layer_idx]
            new_hidden_utils[layer_idx] = util_layer.at[unit_idx].set(
                jnp.where(do_promote, jnp.float32(0.0), util_layer[unit_idx])
            )

        new_mlp_state = mlp_state.replace(  # type: ignore[attr-defined]
            trunk_params=new_trunk_params,
            head_params=new_head_params,
            trunk_traces=tuple(trunk_traces),
            head_traces=tuple(head_traces),
            hidden_unit_utilities=tuple(new_hidden_utils),
        )

        unit_age_layer = state.unit_ages[layer_idx]
        active_util_layer = state.active_utilities[layer_idx]
        new_unit_age_layer = unit_age_layer.at[unit_idx].set(
            jnp.where(do_promote, jnp.int32(0), unit_age_layer[unit_idx])
        )
        new_active_util_layer = active_util_layer.at[unit_idx].set(
            jnp.where(do_promote, jnp.float32(0.0), active_util_layer[unit_idx])
        )

        new_state = state.replace(  # type: ignore[attr-defined]
            mlp_state=new_mlp_state,
            unit_ages=_replace_tuple_item(state.unit_ages, layer_idx, new_unit_age_layer),
            active_utilities=_replace_tuple_item(
                state.active_utilities, layer_idx, new_active_util_layer
            ),
        )
        return cast(DeepFeatureLifecycleState, new_state)

    def _promotion_step_for_layer(
        self,
        layer_idx: int,
        state: DeepFeatureLifecycleState,
        scheduled: Array,
        key: Array,
        normalized_observation: Array,
        layer_inputs: tuple[Array, ...],
        activations: tuple[Array, ...],
    ) -> tuple[DeepFeatureLifecycleState, Array]:
        cand_idx, has_candidate = _select_high_utility_mature(
            state.candidate_utilities[layer_idx],
            state.candidate_ages[layer_idx],
            self._config.candidate_min_age,
        )
        if self._soft_gate_layer_enabled(layer_idx, len(self._hidden_sizes)):
            unit_idx = state.candidate_target_units[layer_idx][cand_idx]
            threshold = jnp.quantile(
                state.active_utilities[layer_idx],
                jnp.asarray(self._config.replacement_utility_quantile, jnp.float32),
            )
            has_unit = jnp.logical_and(
                state.unit_ages[layer_idx][unit_idx]
                >= jnp.asarray(
                    self._config.min_unit_age,
                    dtype=state.unit_ages[layer_idx].dtype,
                ),
                state.active_utilities[layer_idx][unit_idx] <= threshold,
            )
        else:
            unit_idx, has_unit = _select_low_utility_mature(
                state.active_utilities[layer_idx],
                state.unit_ages[layer_idx],
                self._config.min_unit_age,
                self._config.replacement_utility_quantile,
            )
        active_u = state.active_utilities[layer_idx][unit_idx]
        cand_u = state.candidate_utilities[layer_idx][cand_idx]
        if self._config.promotion_utility_mode == "mean_normalized":
            active_score = _mean_normalized(
                active_u, state.active_utilities[layer_idx]
            )
            cand_score = _mean_normalized(
                cand_u, state.candidate_utilities[layer_idx]
            )
        else:
            active_score = active_u
            cand_score = cand_u
        beats_active = cand_score > (
            self._config.promotion_ratio * active_score
            + self._config.promotion_margin
        )
        output_change = self._promotion_output_change_estimate(
            layer_idx,
            unit_idx,
            cand_idx,
            state,
            normalized_observation,
        )
        output_change_ok = output_change <= jnp.asarray(
            self._config.promotion_output_change_threshold,
            dtype=jnp.float32,
        )
        do_promote = jnp.logical_and(
            scheduled,
            jnp.logical_and(
                output_change_ok,
                jnp.logical_and(has_unit, jnp.logical_and(has_candidate, beats_active)),
            ),
        )

        promoted_state = self._promote_candidate(
            layer_idx,
            unit_idx,
            cand_idx,
            do_promote,
            state,
            layer_inputs,
            activations,
        )

        refresh_idx, has_refresh = _select_low_utility_mature(
            promoted_state.candidate_utilities[layer_idx],
            promoted_state.candidate_ages[layer_idx],
            self._config.candidate_min_age,
        )
        chosen_refresh_idx = jnp.where(do_promote, cand_idx, refresh_idx)
        do_refresh = jnp.logical_or(
            do_promote,
            jnp.logical_and(
                scheduled,
                jnp.logical_and(
                    jnp.asarray(self._config.refresh_on_failed_promotion),
                    jnp.logical_and(~do_promote, has_refresh),
                ),
            ),
        )
        refreshed_state = self._refresh_candidate(
            layer_idx,
            chosen_refresh_idx,
            do_refresh,
            promoted_state,
            key,
        )
        return refreshed_state, do_promote.astype(jnp.int32)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: DeepFeatureLifecycleState,
        observation: Array,
        targets: Array,
    ) -> DeepFeatureLifecycleUpdateResult:
        """Update MLP, test candidates, and possibly promote candidates."""
        active_mask = ~jnp.isnan(targets)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        live_predictions = self._learner.predict(state.mlp_state, observation)
        update_targets = targets
        if self._config.soft_gated_candidates and self._config.enabled:
            live_predictions = self._predict_with_soft_candidates(state, observation)
            plain_predictions = self._learner.predict(state.mlp_state, observation)
            soft_delta = live_predictions - plain_predictions
            update_targets = jnp.where(active_mask, targets - soft_delta, targets)

        mlp_result: MultiHeadMLPUpdateResult = self._learner.update(
            state.mlp_state, observation, update_targets
        )
        post_state = mlp_result.state
        n_layers = len(self._hidden_sizes)
        rng_key = state.rng_key
        post_state, rng_key = self._apply_active_perturbations(post_state, rng_key)

        if not self._config.enabled or n_layers == 0:
            passthrough_state = state.replace(  # type: ignore[attr-defined]
                mlp_state=post_state,
                rng_key=rng_key,
            )
            return DeepFeatureLifecycleUpdateResult(  # type: ignore[call-arg]
                state=passthrough_state,
                predictions=live_predictions,
                errors=mlp_result.errors,
                per_head_metrics=mlp_result.per_head_metrics,
                lifecycle_metrics=jnp.zeros(4, dtype=jnp.float32),
                promotions_made=jnp.zeros((max(n_layers, 1),), dtype=jnp.int32),
            )

        obs = observation
        if self._learner.normalizer is not None and post_state.normalizer_state is not None:
            obs = self._learner.normalizer.normalize_only(
                post_state.normalizer_state, observation
            )

        layer_inputs, activations = _layer_inputs_and_activations(
            post_state.trunk_params.weights,
            post_state.trunk_params.biases,
            obs,
            self._leaky_relu_slope,
            self._use_layer_norm,
        )

        residual = jnp.where(active_mask, safe_targets - live_predictions, 0.0)
        active_count = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
        candidate_decay = jnp.asarray(self._config.candidate_utility_decay, dtype=jnp.float32)
        active_decay = jnp.asarray(self._config.active_utility_decay, dtype=jnp.float32)
        candidate_step_size = jnp.asarray(self._config.candidate_step_size, dtype=jnp.float32)
        candidate_weight_step_size = jnp.asarray(
            self._config.candidate_weight_step_size, dtype=jnp.float32
        )
        candidate_update_epsilon = jnp.asarray(
            self._config.candidate_update_epsilon, dtype=jnp.float32
        )
        candidate_gate_step_size = jnp.asarray(
            self._config.candidate_gate_step_size, dtype=jnp.float32
        )
        candidate_gate_l1 = jnp.asarray(
            self._config.candidate_gate_l1, dtype=jnp.float32
        )
        candidate_gate_max_abs = jnp.asarray(
            self._config.candidate_gate_max_abs, dtype=jnp.float32
        )
        perturbation_std = jnp.asarray(
            self._config.candidate_perturbation_std, dtype=jnp.float32
        )
        perturbation_utility_scaled = jnp.asarray(
            self._config.candidate_perturbation_utility_scaled
        )

        new_state = state.replace(mlp_state=post_state)  # type: ignore[attr-defined]
        mean_candidate_utilities: list[Array] = []
        max_candidate_utilities: list[Array] = []
        mean_active_utilities: list[Array] = []

        for layer_idx in range(n_layers):
            rng_key, perturb_key = jr.split(rng_key)
            cand_act = _candidate_activations(
                new_state.candidate_weights[layer_idx],
                new_state.candidate_biases[layer_idx],
                layer_inputs[layer_idx],
                self._leaky_relu_slope,
                self._use_layer_norm,
            )
            cand_deriv = _candidate_activation_derivatives(
                new_state.candidate_weights[layer_idx],
                new_state.candidate_biases[layer_idx],
                layer_inputs[layer_idx],
                self._leaky_relu_slope,
                self._use_layer_norm,
            )
            old_out = new_state.candidate_output_weights[layer_idx]
            old_gates = new_state.candidate_gates[layer_idx]
            if self._soft_gate_layer_enabled(layer_idx, n_layers):
                target_units = new_state.candidate_target_units[layer_idx]
                head_coefficients = jnp.stack(
                    [
                        post_state.head_params.weights[h][0, target_units]
                        for h in range(self._n_heads)
                    ],
                    axis=0,
                )
                live_contribution = (
                    old_gates[None, :] * cand_act[None, :] * head_coefficients
                )
                gate_grad = (
                    jnp.sum(
                        jnp.where(
                            active_mask[:, None],
                            residual[:, None] * head_coefficients * cand_act[None, :],
                            0.0,
                        ),
                        axis=0,
                    )
                    / active_count
                )
                shrunk_gates = old_gates - candidate_gate_l1 * jnp.sign(old_gates)
                new_gates = jnp.clip(
                    shrunk_gates + candidate_gate_step_size * gate_grad,
                    -candidate_gate_max_abs,
                    candidate_gate_max_abs,
                )
                proposed_contribution = (
                    new_gates[None, :] * cand_act[None, :] * head_coefficients
                )
                proposed_residual = residual[:, None] + (
                    live_contribution - proposed_contribution
                )
                per_head_improvement = (
                    residual[:, None] ** 2 - proposed_residual**2
                )
                masked_improvement = jnp.where(
                    active_mask[:, None], per_head_improvement, 0.0
                )
                utility_signal = jnp.maximum(
                    jnp.sum(masked_improvement, axis=0) / active_count,
                    jnp.abs(gate_grad),
                )
                new_out = old_out
                residual_drive = (
                    jnp.sum(
                        jnp.where(
                            active_mask[:, None],
                            residual[:, None] * head_coefficients * old_gates[None, :],
                            0.0,
                        ),
                        axis=0,
                    )
                    / active_count
                )
            else:
                shadow_pred = old_out * cand_act[None, :]
                per_head_improvement = (
                    residual[:, None] ** 2
                    - (residual[:, None] - shadow_pred) ** 2
                )
                masked_improvement = jnp.where(
                    active_mask[:, None], per_head_improvement, 0.0
                )
                utility_signal = jnp.maximum(
                    jnp.sum(masked_improvement, axis=0) / active_count,
                    0.0,
                )
                out_delta = candidate_step_size * residual[:, None] * cand_act[None, :]
                if self._config.candidate_normalized_updates:
                    out_delta = out_delta / (
                        cand_act[None, :] ** 2 + candidate_update_epsilon
                    )
                out_delta = jnp.where(active_mask[:, None], out_delta, 0.0)
                new_out = old_out + out_delta
                residual_drive = (
                    jnp.sum(
                        jnp.where(
                            active_mask[:, None],
                            residual[:, None] * old_out,
                            0.0,
                        ),
                        axis=0,
                    )
                    / active_count
                )
                new_gates = old_gates
            new_cand_util = (
                candidate_decay * new_state.candidate_utilities[layer_idx]
                + (1.0 - candidate_decay) * utility_signal
            )
            candidate_weight_delta = (
                candidate_weight_step_size
                * residual_drive[:, None]
                * cand_deriv[:, None]
                * layer_inputs[layer_idx][None, :]
            )
            candidate_bias_delta = (
                candidate_weight_step_size * residual_drive * cand_deriv
            )
            if self._config.candidate_normalized_updates:
                input_energy = (
                    jnp.sum(layer_inputs[layer_idx] ** 2) + candidate_update_epsilon
                )
                candidate_weight_delta = candidate_weight_delta / input_energy
                candidate_bias_delta = candidate_bias_delta / input_energy
            perturbation_scale = perturbation_std
            if self._config.candidate_perturbation_utility_scaled:
                utility_max = jnp.max(new_cand_util) + jnp.asarray(1e-8, jnp.float32)
                utility_norm = jnp.clip(new_cand_util / utility_max, 0.0, 1.0)
                perturbation_scale = (
                    perturbation_std * (1.0 - utility_norm)[:, None] ** 2
                )
            weight_perturbation = jnp.where(
                perturbation_utility_scaled,
                perturbation_scale,
                perturbation_std,
            ) * jr.normal(
                perturb_key,
                new_state.candidate_weights[layer_idx].shape,
                dtype=jnp.float32,
            )
            new_candidate_weights = (
                new_state.candidate_weights[layer_idx]
                + candidate_weight_delta
                + weight_perturbation
            )
            new_candidate_biases = (
                new_state.candidate_biases[layer_idx] + candidate_bias_delta
            )

            source_utility = (
                post_state.hidden_unit_utilities[layer_idx]
                if len(post_state.hidden_unit_utilities) > layer_idx
                else jnp.zeros_like(new_state.active_utilities[layer_idx])
            )
            new_active_util = (
                active_decay * new_state.active_utilities[layer_idx]
                + (1.0 - active_decay) * source_utility
            )

            new_state = new_state.replace(
                candidate_weights=_replace_tuple_item(
                    new_state.candidate_weights, layer_idx, new_candidate_weights
                ),
                candidate_biases=_replace_tuple_item(
                    new_state.candidate_biases, layer_idx, new_candidate_biases
                ),
                candidate_output_weights=_replace_tuple_item(
                    new_state.candidate_output_weights, layer_idx, new_out
                ),
                candidate_gates=_replace_tuple_item(
                    new_state.candidate_gates, layer_idx, new_gates
                ),
                candidate_utilities=_replace_tuple_item(
                    new_state.candidate_utilities, layer_idx, new_cand_util
                ),
                candidate_ages=_replace_tuple_item(
                    new_state.candidate_ages,
                    layer_idx,
                    new_state.candidate_ages[layer_idx] + 1,
                ),
                active_utilities=_replace_tuple_item(
                    new_state.active_utilities, layer_idx, new_active_util
                ),
                unit_ages=_replace_tuple_item(
                    new_state.unit_ages,
                    layer_idx,
                    new_state.unit_ages[layer_idx] + 1,
                ),
            )
            mean_candidate_utilities.append(jnp.mean(new_cand_util))
            max_candidate_utilities.append(jnp.max(new_cand_util))
            mean_active_utilities.append(jnp.mean(new_active_util))

        scheduled = jnp.logical_and(
            (post_state.step_count % self._config.promotion_interval) == 0,
            post_state.step_count
            >= jnp.asarray(
                self._config.replacement_warmup_steps,
                dtype=post_state.step_count.dtype,
            ),
        )
        promotions: list[Array] = []
        promotion_count = jnp.array(0, dtype=jnp.int32)
        for layer_idx in range(n_layers):
            rng_key, subkey = jr.split(rng_key)
            layer_budget = self._config.layer_promotion_budget
            layer_scheduled = scheduled
            if self._config.promotion_layer_mode == "first":
                layer_scheduled = jnp.logical_and(layer_scheduled, layer_idx == 0)
            elif self._config.promotion_layer_mode == "final":
                layer_scheduled = jnp.logical_and(
                    layer_scheduled, layer_idx == n_layers - 1
                )
            if layer_budget > 0:
                layer_scheduled = jnp.logical_and(
                    layer_scheduled,
                    promotion_count < jnp.asarray(layer_budget, dtype=jnp.int32),
                )
            new_state, promoted = self._promotion_step_for_layer(
                layer_idx,
                new_state,
                layer_scheduled,
                subkey,
                obs,
                layer_inputs,
                activations,
            )
            promotions.append(promoted)
            promotion_count = promotion_count + promoted

        new_state = new_state.replace(rng_key=rng_key)
        promotions_arr = jnp.stack(promotions)
        lifecycle_metrics = jnp.array(
            [
                jnp.sum(promotions_arr.astype(jnp.float32)),
                jnp.mean(jnp.stack(mean_candidate_utilities)),
                jnp.max(jnp.stack(max_candidate_utilities)),
                jnp.mean(jnp.stack(mean_active_utilities)),
            ],
            dtype=jnp.float32,
        )

        return DeepFeatureLifecycleUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            predictions=live_predictions,
            errors=mlp_result.errors,
            per_head_metrics=mlp_result.per_head_metrics,
            lifecycle_metrics=lifecycle_metrics,
            promotions_made=promotions_arr,
        )


def run_deep_feature_lifecycle_arrays(
    learner: DeepFeatureGeneratingMultiHeadMLPLearner,
    state: DeepFeatureLifecycleState,
    observations: Float[Array, "num_steps feature_dim"],
    targets: Float[Array, "num_steps n_heads"],
) -> DeepFeatureLifecycleLearningResult:
    """Run a deep feature lifecycle learner over materialized arrays."""

    def step_fn(
        carry: DeepFeatureLifecycleState,
        inputs: tuple[Array, Array],
    ) -> tuple[DeepFeatureLifecycleState, tuple[Array, Array, Array]]:
        obs, tgt = inputs
        result = learner.update(carry, obs, tgt)
        return result.state, (
            result.per_head_metrics,
            result.lifecycle_metrics,
            result.promotions_made,
        )

    t0 = time.time()
    final_state, (per_head_metrics, lifecycle_metrics, promotions_made) = jax.lax.scan(
        step_fn,
        state,
        (observations, targets),
    )
    elapsed = time.time() - t0
    final_mlp = final_state.mlp_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.mlp_state.uptime_s + elapsed
    )
    final_state = final_state.replace(mlp_state=final_mlp)  # type: ignore[attr-defined]
    return DeepFeatureLifecycleLearningResult(  # type: ignore[call-arg]
        state=final_state,
        per_head_metrics=per_head_metrics,
        lifecycle_metrics=lifecycle_metrics,
        promotions_made=promotions_made,
    )
