"""UPGD (Utility-based Perturbed Gradient Descent) learner.

Implements UPGD (Dohare et al. 2023, "Maintaining Plasticity in Deep
Continual Learning"), which augments standard SGD with utility-scaled
perturbations of low-utility weights instead of the hard slot replacement
used by generate-and-test methods.

The intuition: weights with low utility (small product of weight magnitude
and gradient magnitude) are not contributing to the prediction and are
"dead". UPGD adds Gaussian noise to such weights, scaled by ``(1 - u_norm)^beta``,
which lets them drift back into a useful regime without destroying any
structure that the network has already learned.

Architecture mirrors :class:`MultiHeadMLPLearner`: a shared MLP trunk
(``Input -> [Dense -> LayerNorm -> LeakyReLU] x N``) with ``n_heads``
linear output heads. Utility tracking and perturbation are applied only
to the trunk hidden weight matrices -- biases and output (head) weights
and biases are updated with plain SGD with no perturbation.

Reference: Dohare et al. 2023, "Maintaining Plasticity in Deep Continual
Learning"
"""

import functools
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float

from alberta_framework.core.initializers import sparse_init
from alberta_framework.core.optimizers import Bounder, ObGDBounding
from alberta_framework.core.types import MLPParams

# =============================================================================
# Types
# =============================================================================


@chex.dataclass(frozen=True)
class UPGDState:
    """State for a UPGD learner.

    Attributes:
        trunk_params: Shared hidden layer parameters (weights, biases)
        head_params: Per-head output layer parameters
        readout_fast_head_params: Per-head fast simplex output layer
            parameters used by ``two_timescale_simplex`` readout. The regular
            ``head_params`` remain the slow linear-MSE head.
        readout_label_adapter: Row-stochastic label-map matrix used by
            ``factorized_simplex`` readout. Convention: rows index the stable
            base class simplex and columns index the current target simplex, so
            ``pred = softmax(logits) @ readout_label_adapter``.
        utilities: Per-hidden-layer running utility arrays.
            ``utilities[i]`` matches ``trunk_params.weights[i].shape``.
            Empty tuple when ``hidden_sizes=()``.
        unit_utilities: Per-hidden-layer hidden-unit utility arrays.
            ``unit_utilities[i]`` has one scalar per hidden unit. These are
            used only by optional unit recycling.
        unit_long_utilities: Slower per-hidden-unit utility arrays used by
            two-signal recycling criteria.
        unit_gradient_emas: Per-hidden-unit EMA of current gradient demand.
        unit_ages: Per-hidden-layer hidden-unit ages since initialization or
            last recycling.
        unit_replacement_counts: Per-hidden-layer count of hidden-unit
            replacements performed by optional recycling.
        unit_replacement_accumulators: Per-layer fractional replacement
            budget accumulator for optional hidden-unit recycling.
        loss_fast_ema: Fast EMA of the online per-step MSE, used only by
            optional loss-spike-gated recycling.
        loss_slow_ema: Slow EMA of the online per-step MSE, used only by
            optional loss-spike-gated recycling.
        previous_targets: Last active target vector, used only by optional
            target-repetition head plasticity.
        target_repeat_ema: EMA of whether recent targets are locally repeated.
        target_simplex_ema: EMA of whether recent targets were non-negative
            unit-mass simplex targets. Adaptive simplex readouts use this in
            target-free ``predict`` calls to avoid applying probability heads
            after dense/vector-target streams.
        meta_trunk_log_scale: Learned log multiplier for trunk update plasticity.
        meta_head_weight_log_scale: Learned log multiplier for output-head
            weight plasticity.
        meta_head_bias_log_scale: Learned log multiplier for output-head bias
            plasticity.
        meta_repetition_log_scale: Learned log multiplier for repeated-target
            head plasticity.
        adaptive_kappa_log_scale: Learned log multiplier for effective ObGD
            kappa. Positive values make bounding more conservative; negative
            values permit larger bounded steps.
        previous_trunk_weight_grads: Previous trunk-weight gradients for online
            gradient-alignment meta-plasticity.
        previous_trunk_bias_grads: Previous trunk-bias gradients for online
            gradient-alignment meta-plasticity.
        previous_head_weight_grads: Previous output-head weight gradients for
            online gradient-alignment meta-plasticity.
        previous_head_bias_grads: Previous output-head bias gradients for
            online gradient-alignment meta-plasticity.
        key: JAX random key for sampling perturbations
        step_count: Scalar step counter
        birth_timestamp: Wall-clock time at init
        uptime_s: Cumulative time spent in learning loops
    """

    trunk_params: MLPParams
    head_params: MLPParams
    readout_fast_head_params: MLPParams
    readout_label_adapter: Array
    utilities: tuple[Array, ...]
    unit_utilities: tuple[Array, ...]
    unit_long_utilities: tuple[Array, ...]
    unit_gradient_emas: tuple[Array, ...]
    unit_ages: tuple[Array, ...]
    unit_replacement_accumulators: Array
    loss_fast_ema: Array
    loss_slow_ema: Array
    previous_targets: Array
    target_repeat_ema: Array
    target_simplex_ema: Array
    meta_trunk_log_scale: Array
    meta_head_weight_log_scale: Array
    meta_head_bias_log_scale: Array
    meta_repetition_log_scale: Array
    adaptive_kappa_log_scale: Array
    previous_trunk_weight_grads: tuple[Array, ...]
    previous_trunk_bias_grads: tuple[Array, ...]
    previous_head_weight_grads: tuple[Array, ...]
    previous_head_bias_grads: tuple[Array, ...]
    key: Array
    step_count: Array = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0
    unit_replacement_counts: Array | None = None


@chex.dataclass(frozen=True)
class UPGDUpdateResult:
    """Result of a UPGD update step.

    Attributes:
        state: Updated UPGD state
        predictions: Per-head predictions, shape ``(n_heads,)``
        errors: Per-head prediction errors. NaN for inactive heads.
        metrics: 1D array ``[mean_loss, mean_utility, min_utility,
            max_perturbation_magnitude]``. ``mean_utility`` and
            ``min_utility`` are 0 when there are no hidden layers.
    """

    state: UPGDState
    predictions: Float[Array, " n_heads"]
    errors: Float[Array, " n_heads"]
    metrics: Float[Array, " 4"]


@chex.dataclass(frozen=True)
class UPGDLearningResult:
    """Result from a UPGD learning loop.

    Attributes:
        state: Final UPGD state
        metrics: Per-step metrics, shape ``(num_steps, 4)``.
            Columns match :class:`UPGDUpdateResult.metrics`.
    """

    state: UPGDState
    metrics: Float[Array, "num_steps 4"]


# =============================================================================
# UPGDLearner
# =============================================================================


class UPGDLearner:
    """Utility-based Perturbed Gradient Descent learner (Dohare et al. 2023).

    Architecture mirrors :class:`MultiHeadMLPLearner`:

    ``Input -> [Dense(H) -> LayerNorm -> LeakyReLU] x N -> {Head_i: Dense(1)} x n_heads``

    When ``use_layer_norm=False``, layer norms are dropped.

    Each step performs:

    1. Forward pass + ``jax.grad`` of ``0.5 * sum_active((pred - target)^2)``
       w.r.t. all trunk and head parameters.
    2. Standard SGD step ``param -= step_size * grad``.
    3. For each hidden weight matrix, update the running utility:
       ``u = decay * u + (1 - decay) * |w * grad|``.
    4. Compute per-layer normalized utility ``u_norm = u / (u_max + eps)``
       and add perturbation ``sigma * (1 - u_norm)^beta * noise``
       to the post-SGD weights.

    Perturbation is applied every ``perturbation_interval`` steps. Hidden
    biases and output (head) parameters receive plain SGD with no
    perturbation -- the heads must track per-task signal so should not
    be perturbed away.

    NaN targets mask inactive heads: their contribution to the loss is
    zero, so their gradients (and thus utility updates and SGD steps)
    are zero for that step.

    Attributes:
        n_heads: Number of prediction heads
        hidden_sizes: Tuple of hidden layer sizes
        step_size: SGD learning rate
        bounder: Optional gradient bounder (e.g. ObGDBounding)
        utility_decay: EMA decay for the running utility
        perturbation_sigma: Base Gaussian noise scale
        perturbation_beta: Exponent applied to ``(1 - u_norm)``
        perturbation_interval: Apply perturbation every N steps
        perturbation_warmup_steps: Number of initial updates with zero
            perturbation.
        perturbation_noise: Noise distribution used for weight perturbations.
            ``"normal"`` reproduces Gaussian UPGD; ``"rademacher"`` uses
            bounded ±1 noise, a cheaper and less heavy-tailed mutation.
        perturbation_ramp_steps: Number of updates over which perturbation
            linearly ramps from zero to ``perturbation_sigma`` after warmup.
        sparsity: Fraction of weights zeroed at init
        leaky_relu_slope: Negative slope for LeakyReLU
        use_layer_norm: Whether to apply parameterless layer normalization
        loss_normalization: How to scale the active-head squared-error loss.
            ``"sum"`` leaves per-head gradients undiluted and is the Step 2
            multi-task default. ``"mean"`` divides by the number of active
            heads, matching earlier UPGD behavior. ``"target_density"``
            divides by the number of nonzero active target components, so
            dense vector targets behave like ``"mean"`` while sparse one-hot
            targets behave like ``"sum"``. ``"target_structure"`` uses
            ``"sum"`` only for non-negative simplex targets and otherwise uses
            ``"mean"``; this preserves one-hot classification pressure without
            misclassifying dense zero-valued regression heads or multilabel
            targets as sparse one-hot tasks.
        positive_target_loss_scale: MSE loss multiplier for active targets
            greater than zero.
        negative_target_loss_scale: MSE loss multiplier for active targets
            less than or equal to zero. Values below ``1`` reduce the flood of
            negative updates in sparse multi-task classification targets while
            preserving the default behavior when left at ``1``.
        head_gradient_scale: Optional extra scaling for output-head gradients.
            ``"none"`` leaves head gradients as produced by the loss.
            ``"active_count"`` multiplies head gradients by the number of
            active heads, so each task head adapts as if trained independently
            while trunk gradients can remain mean-normalized.
        head_step_size_multiplier: Additional fixed multiplier applied to
            output-head steps only. This lets task heads track non-stationary
            targets faster without increasing trunk plasticity.
        head_bias_step_size_multiplier: Additional fixed multiplier applied
            only to output-head bias steps after ``head_step_size_multiplier``.
            Values below ``1`` slow global head bias drift while leaving
            class-discriminative head weights plastic.
        head_loss_pressure_gate_ratio: When positive, boosts output-head
            plasticity only when the fast loss EMA exceeds this multiple of
            the slow loss EMA.
        head_loss_pressure_multiplier: Maximum additional multiplicative
            output-head step-size boost under loss pressure. ``0`` disables
            adaptive head pressure.
        head_loss_pressure_warmup_steps: Number of initial steps before the
            adaptive head-pressure boost can turn on.
        head_repetition_multiplier: Maximum additional output-head step-size
            boost from locally repeated targets. This is useful when a stream
            presents long target blocks: output heads can track the current
            block faster without increasing trunk plasticity everywhere.
        head_repetition_decay: EMA decay for repeated-target detection.
        head_repetition_delta_threshold: Mean absolute target-vector change at
            or below which consecutive targets count as repeated.
        head_repetition_pressure_threshold: EMA level below which repeated-target
            pressure is zero. This filters out accidental isolated repeats while
            preserving persistent blocks.
        head_repetition_warmup_steps: Number of initial steps before the
            repeated-target boost can turn on.
        unit_replacement_rate: Optional hidden-unit recycling rate per step,
            expressed as a fraction of units per layer. ``0`` disables
            recycling while still tracking per-unit utility.
        unit_maturity_threshold: Minimum age before a hidden unit can be
            recycled.
        unit_utility_decay: Optional EMA decay for hidden-unit utilities. When
            ``None``, reuses ``utility_decay``.
        unit_long_utility_decay: EMA decay for the slower retained-value
            hidden-unit utility.
        unit_gradient_decay: EMA decay for per-unit current gradient demand.
        unit_replacement_criterion: Which mature unit to recycle:
            ``"low_utility"`` preserves prior behavior; ``"stale_gradient_ratio"``
            recycles units with low current gradient demand relative to retained
            utility; ``"low_long_and_gradient"`` recycles units low on both
            retained value and current demand.
        unit_replacement_fanin: How to initialize recycled incoming weights.
            ``"random"`` uses sparse random init; ``"gradient_columns"`` samples
            nonzero fan-in columns from high current-gradient columns.
        unit_replacement_loss_gate_ratio: When positive, recycle only when a
            fast loss EMA exceeds ``ratio * slow loss EMA``.
        unit_replacement_budget_mode: How replacement budget accumulates.
            ``"always"`` preserves the original behavior: budget accumulates
            every step, even while gates are closed. ``"gated"`` accumulates
            only when the current candidate passes the configured loss and
            score gates. ``"loss_pressure"`` accumulates proportionally to the
            fast/slow loss-ratio surplus above the loss gate, so replacement
            pressure rises with an online non-stationarity signal without
            storing closed-gate replacement debt.
        track_unit_utilities: Whether to maintain row-level hidden-unit
            utility traces when hidden-unit recycling is disabled. Disable for
            lean UPGD benchmarks that use per-weight utility perturbation but
            no unit recycling.
        track_gradient_history: Whether to copy current gradients into state
            when no gradient-alignment meta-rule is active. Disable for lean
            non-meta UPGD benchmarks to reduce carry traffic.
        adaptive_kappa_mode: Optional online control law for ObGD ``kappa``.
            ``"none"`` uses the configured bounder unchanged. ``"loss_ratio"``
            computes an effective kappa from the learner's fast/slow loss EMAs,
            lowering kappa when fast loss exceeds slow loss and raising it when
            the stream appears stable. ``"gradient_alignment"`` learns a
            bounded kappa multiplier from consecutive gradient alignment.
        adaptive_kappa_meta_step_size: Meta step-size for learned kappa log
            multiplier. Positive gradient alignment lowers kappa, permitting
            larger bounded updates; gradient reversals raise kappa.
        adaptive_kappa_meta_min_multiplier: Minimum learned kappa multiplier.
        adaptive_kappa_meta_max_multiplier: Maximum learned kappa multiplier.
        adaptive_kappa_meta_warmup_steps: Number of initial steps before the
            learned kappa multiplier can adapt.
        meta_plasticity_mode: Optional online control law for group plasticity.
            ``"gradient_alignment"`` learns bounded log step multipliers for
            trunk updates, head-weight updates, head-bias updates, and repeated
            target head plasticity from consecutive gradient alignment.
        meta_plasticity_step_size: Meta step-size for group log multipliers.
        meta_plasticity_min_multiplier: Minimum learned multiplier.
        meta_plasticity_max_multiplier: Maximum learned multiplier.
        meta_plasticity_warmup_steps: Number of initial steps before group
            plasticity multipliers can adapt.
        meta_plasticity_trunk_enabled: Whether group meta-plasticity can alter
            shared trunk updates.
        meta_plasticity_head_weight_enabled: Whether group meta-plasticity can
            alter output-head weight updates.
        meta_plasticity_head_bias_enabled: Whether group meta-plasticity can
            alter output-head bias updates.
        meta_plasticity_repetition_enabled: Whether group meta-plasticity can
            alter repeated-target head-plasticity gain.
        readout_loss_mode: Optional explicit output loss geometry. When left
            ``None``, it is derived from ``readout_mode`` for backward
            compatibility.
        readout_prediction_mode: Optional explicit output transform used for
            predictions and online metrics. When left ``None``, it is derived
            from ``readout_mode``.
        readout_robust_q: Generalized-cross-entropy ``q`` value for robust
            simplex readout losses.
        readout_label_adapter_step_size: Step-size for the fast label-map
            adapter used by ``factorized_simplex`` readout. The adapter is
            updated causally from the current prediction error on active
            non-negative simplex targets.
        readout_label_adapter_identity_regularization: Per-step pull toward
            the identity label map for ``factorized_simplex``.
        readout_label_adapter_entropy_regularization: Optional entropy-style
            row regularizer for the label map. ``0`` disables it.
        readout_label_adapter_floor: Non-negative floor applied before
            row-normalizing the label map after each adapter update.
        readout_fast_head_step_size_multiplier: Step-size multiplier for the
            fast simplex head used by ``two_timescale_simplex``.
        readout_fast_head_bias_step_size_multiplier: Bias step-size multiplier
            for the fast simplex head used by ``two_timescale_simplex``.
        readout_fast_trunk_gradient_multiplier: Multiplier for sending the
            fast simplex head's CE gradient into the shared trunk. This is
            gated by the same adaptive simplex gate used for prediction.
        readout_fast_head_bounder_mode: How to bound fast simplex-head updates
            in ``two_timescale_simplex``. ``"shared"`` puts fast-head steps in
            the same ObGD budget as trunk and slow-head steps. ``"separate"``
            applies the same bounder/kappa to fast-head steps as a distinct
            readout group.
        readout_slow_simplex_gradient_multiplier: Slow-head MSE gradient
            multiplier when the adaptive simplex gate is fully open in
            ``two_timescale_simplex``. ``1`` keeps the slow branch always
            learning; ``0`` allocates the bounded gradient budget to the fast
            simplex branch on persistent simplex targets while preserving slow
            gradients when the gate is closed.
        readout_simplex_bias_decay: Per-update decay applied only to active
            output biases on non-negative unit-mass targets. ``0`` disables it.
        readout_simplex_bias_centering_rate: Per-update mean-bias removal rate
            for active output biases on non-negative unit-mass targets. ``1``
            exactly centers active biases after decay; ``0`` disables it.
    """

    def __init__(
        self,
        n_heads: int,
        hidden_sizes: tuple[int, ...] = (128, 128),
        step_size: float = 0.01,
        bounder: Bounder | None = None,
        utility_decay: float = 0.995,
        perturbation_sigma: float = 1e-3,
        perturbation_beta: float = 2.0,
        perturbation_interval: int = 1,
        perturbation_noise: str = "normal",
        perturbation_warmup_steps: int = 0,
        perturbation_ramp_steps: int = 0,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        loss_normalization: str = "sum",
        positive_target_loss_scale: float = 1.0,
        negative_target_loss_scale: float = 1.0,
        head_gradient_scale: str = "none",
        head_step_size_multiplier: float = 1.0,
        head_bias_step_size_multiplier: float = 1.0,
        head_loss_pressure_gate_ratio: float = 0.0,
        head_loss_pressure_multiplier: float = 0.0,
        head_loss_pressure_warmup_steps: int = 0,
        head_repetition_multiplier: float = 0.0,
        head_repetition_decay: float = 0.9,
        head_repetition_delta_threshold: float = 0.05,
        head_repetition_pressure_threshold: float = 0.0,
        head_repetition_warmup_steps: int = 0,
        unit_replacement_rate: float = 0.0,
        unit_maturity_threshold: int = 100,
        unit_utility_decay: float | None = None,
        unit_long_utility_decay: float = 0.999,
        unit_gradient_decay: float = 0.95,
        unit_replacement_criterion: str = "low_utility",
        unit_replacement_fanin: str = "random",
        unit_replacement_loss_gate_ratio: float = 0.0,
        unit_replacement_budget_mode: str = "always",
        unit_replacement_outgoing_scale: float = 0.0,
        unit_replacement_partial_fanin: int = 0,
        unit_replacement_score_threshold: float = 0.0,
        unit_outgoing_utility_weight: float = 0.0,
        track_unit_utilities: bool = True,
        track_gradient_history: bool = True,
        loss_fast_decay: float = 0.90,
        loss_slow_decay: float = 0.995,
        adaptive_kappa_mode: str = "none",
        adaptive_kappa_base: float = 0.5,
        adaptive_kappa_min: float = 0.25,
        adaptive_kappa_max: float = 1.0,
        adaptive_kappa_exponent: float = 0.5,
        adaptive_kappa_warmup_steps: int = 0,
        adaptive_kappa_meta_step_size: float = 0.0,
        adaptive_kappa_meta_min_multiplier: float = 0.5,
        adaptive_kappa_meta_max_multiplier: float = 2.0,
        adaptive_kappa_meta_warmup_steps: int = 0,
        meta_plasticity_mode: str = "none",
        meta_plasticity_step_size: float = 0.0,
        meta_plasticity_min_multiplier: float = 0.25,
        meta_plasticity_max_multiplier: float = 4.0,
        meta_plasticity_warmup_steps: int = 0,
        meta_plasticity_trunk_enabled: bool = True,
        meta_plasticity_head_weight_enabled: bool = True,
        meta_plasticity_head_bias_enabled: bool = True,
        meta_plasticity_repetition_enabled: bool = True,
        readout_mode: str = "linear_mse",
        readout_loss_mode: str | None = None,
        readout_prediction_mode: str | None = None,
        readout_robust_q: float = 0.7,
        readout_adaptive_gate_start: float = 0.2,
        readout_adaptive_gate_width: float = 0.3,
        readout_input_mode: str = "hidden",
        readout_head_normalization: str = "none",
        readout_margin: float = 0.0,
        readout_margin_step_size: float = 0.0,
        readout_label_adapter_step_size: float = 0.2,
        readout_label_adapter_identity_regularization: float = 1e-3,
        readout_label_adapter_entropy_regularization: float = 0.0,
        readout_label_adapter_floor: float = 1e-6,
        readout_fast_head_step_size_multiplier: float = 1.0,
        readout_fast_head_bias_step_size_multiplier: float = 1.0,
        readout_fast_trunk_gradient_multiplier: float = 0.0,
        readout_fast_head_bounder_mode: str = "shared",
        readout_slow_simplex_gradient_multiplier: float = 1.0,
        readout_simplex_bias_decay: float = 0.0,
        readout_simplex_bias_centering_rate: float = 0.0,
    ):
        """Initialize the UPGD learner.

        Args:
            n_heads: Number of prediction heads
            hidden_sizes: Hidden layer sizes (default two layers of 128)
            step_size: SGD learning rate (default 0.01)
            bounder: Optional :class:`Bounder` applied to the per-parameter
                gradient steps before they are added to the parameters.
                When None (default), no bounding is applied.
            utility_decay: EMA decay for the per-weight utility estimate
                (default 0.995)
            perturbation_sigma: Base Gaussian noise scale used in the
                perturbation step (default 1e-3)
            perturbation_beta: Exponent applied to ``(1 - u_norm)`` in the
                perturbation magnitude (default 2.0)
        perturbation_interval: Apply perturbation every N steps
                (default 1, i.e. every step)
            perturbation_noise: Noise distribution for utility-weighted
                perturbation: ``"normal"`` or ``"rademacher"``.
            perturbation_warmup_steps: Number of initial updates during which
                perturbation is disabled (default 0).
            perturbation_ramp_steps: Number of updates after warmup over which
                perturbation linearly ramps to full strength (default 0).
            sparsity: Fraction of input connections zeroed at init per
                output unit (default 0.9)
            leaky_relu_slope: Negative slope for LeakyReLU (default 0.01)
            use_layer_norm: Whether to apply parameterless layer normalization
                between hidden layers (default True)

        Raises:
            ValueError: If ``perturbation_interval < 1`` or ``utility_decay``
                is outside ``[0, 1)``.
        """
        if n_heads < 1:
            msg = f"n_heads must be >= 1, got {n_heads}"
            raise ValueError(msg)
        if any(size < 1 for size in hidden_sizes):
            msg = f"hidden_sizes must contain only positive sizes, got {hidden_sizes!r}"
            raise ValueError(msg)
        if step_size < 0.0:
            msg = f"step_size must be non-negative, got {step_size}"
            raise ValueError(msg)
        if perturbation_sigma < 0.0:
            msg = f"perturbation_sigma must be non-negative, got {perturbation_sigma}"
            raise ValueError(msg)
        if perturbation_beta < 0.0:
            msg = f"perturbation_beta must be non-negative, got {perturbation_beta}"
            raise ValueError(msg)
        if perturbation_interval < 1:
            msg = f"perturbation_interval must be >= 1, got {perturbation_interval}"
            raise ValueError(msg)
        if perturbation_noise not in {"normal", "rademacher"}:
            msg = (
                "perturbation_noise must be 'normal' or 'rademacher', "
                f"got {perturbation_noise!r}"
            )
            raise ValueError(msg)
        if perturbation_warmup_steps < 0:
            msg = (
                "perturbation_warmup_steps must be >= 0, "
                f"got {perturbation_warmup_steps}"
            )
            raise ValueError(msg)
        if perturbation_ramp_steps < 0:
            msg = (
                "perturbation_ramp_steps must be >= 0, "
                f"got {perturbation_ramp_steps}"
            )
            raise ValueError(msg)
        if not 0.0 <= utility_decay < 1.0:
            msg = f"utility_decay must be in [0, 1), got {utility_decay}"
            raise ValueError(msg)
        if not 0.0 <= sparsity <= 1.0:
            msg = f"sparsity must be in [0, 1], got {sparsity}"
            raise ValueError(msg)
        if leaky_relu_slope < 0.0:
            msg = f"leaky_relu_slope must be non-negative, got {leaky_relu_slope}"
            raise ValueError(msg)
        if loss_normalization not in (
            "mean",
            "sum",
            "target_density",
            "target_structure",
        ):
            msg = (
                "loss_normalization must be 'mean', 'sum', 'target_density', "
                "or 'target_structure', "
                f"got {loss_normalization!r}"
            )
            raise ValueError(msg)
        if positive_target_loss_scale < 0.0:
            msg = (
                "positive_target_loss_scale must be non-negative, "
                f"got {positive_target_loss_scale}"
            )
            raise ValueError(msg)
        if negative_target_loss_scale < 0.0:
            msg = (
                "negative_target_loss_scale must be non-negative, "
                f"got {negative_target_loss_scale}"
            )
            raise ValueError(msg)
        if head_gradient_scale not in ("none", "active_count"):
            msg = (
                "head_gradient_scale must be 'none' or 'active_count', "
                f"got {head_gradient_scale!r}"
            )
            raise ValueError(msg)
        if head_step_size_multiplier <= 0.0:
            msg = (
                "head_step_size_multiplier must be positive, "
                f"got {head_step_size_multiplier}"
            )
            raise ValueError(msg)
        if head_bias_step_size_multiplier < 0.0:
            msg = (
                "head_bias_step_size_multiplier must be non-negative, "
                f"got {head_bias_step_size_multiplier}"
            )
            raise ValueError(msg)
        if head_loss_pressure_gate_ratio < 0.0:
            msg = (
                "head_loss_pressure_gate_ratio must be non-negative, "
                f"got {head_loss_pressure_gate_ratio}"
            )
            raise ValueError(msg)
        if head_loss_pressure_multiplier < 0.0:
            msg = (
                "head_loss_pressure_multiplier must be non-negative, "
                f"got {head_loss_pressure_multiplier}"
            )
            raise ValueError(msg)
        if head_loss_pressure_warmup_steps < 0:
            msg = (
                "head_loss_pressure_warmup_steps must be non-negative, "
                f"got {head_loss_pressure_warmup_steps}"
            )
            raise ValueError(msg)
        if head_repetition_multiplier < 0.0:
            msg = (
                "head_repetition_multiplier must be non-negative, "
                f"got {head_repetition_multiplier}"
            )
            raise ValueError(msg)
        if not 0.0 <= head_repetition_decay < 1.0:
            msg = (
                "head_repetition_decay must be in [0, 1), "
                f"got {head_repetition_decay}"
            )
            raise ValueError(msg)
        if head_repetition_delta_threshold < 0.0:
            msg = (
                "head_repetition_delta_threshold must be non-negative, "
                f"got {head_repetition_delta_threshold}"
            )
            raise ValueError(msg)
        if not 0.0 <= head_repetition_pressure_threshold < 1.0:
            msg = (
                "head_repetition_pressure_threshold must be in [0, 1), "
                f"got {head_repetition_pressure_threshold}"
            )
            raise ValueError(msg)
        if head_repetition_warmup_steps < 0:
            msg = (
                "head_repetition_warmup_steps must be non-negative, "
                f"got {head_repetition_warmup_steps}"
            )
            raise ValueError(msg)
        if not 0.0 <= unit_replacement_rate <= 1.0:
            msg = (
                "unit_replacement_rate must be in [0, 1], "
                f"got {unit_replacement_rate}"
            )
            raise ValueError(msg)
        if unit_maturity_threshold < 0:
            msg = (
                "unit_maturity_threshold must be non-negative, "
                f"got {unit_maturity_threshold}"
            )
            raise ValueError(msg)
        if unit_utility_decay is not None and not 0.0 <= unit_utility_decay < 1.0:
            msg = (
                "unit_utility_decay must be in [0, 1) when set, "
                f"got {unit_utility_decay}"
            )
            raise ValueError(msg)
        if not 0.0 <= unit_long_utility_decay < 1.0:
            msg = (
                "unit_long_utility_decay must be in [0, 1), "
                f"got {unit_long_utility_decay}"
            )
            raise ValueError(msg)
        if not 0.0 <= unit_gradient_decay < 1.0:
            msg = (
                "unit_gradient_decay must be in [0, 1), "
                f"got {unit_gradient_decay}"
            )
            raise ValueError(msg)
        if unit_replacement_criterion not in {
            "low_utility",
            "stale_gradient_ratio",
            "low_long_and_gradient",
        }:
            msg = (
                "unit_replacement_criterion must be one of "
                "'low_utility', 'stale_gradient_ratio', "
                f"or 'low_long_and_gradient', got {unit_replacement_criterion!r}"
            )
            raise ValueError(msg)
        if unit_replacement_fanin not in {"random", "gradient_columns"}:
            msg = (
                "unit_replacement_fanin must be 'random' or 'gradient_columns', "
                f"got {unit_replacement_fanin!r}"
            )
            raise ValueError(msg)
        if unit_replacement_loss_gate_ratio < 0.0:
            msg = (
                "unit_replacement_loss_gate_ratio must be non-negative, "
                f"got {unit_replacement_loss_gate_ratio}"
            )
            raise ValueError(msg)
        if unit_replacement_budget_mode not in {"always", "gated", "loss_pressure"}:
            msg = (
                "unit_replacement_budget_mode must be one of "
                "'always', 'gated', or 'loss_pressure', "
                f"got {unit_replacement_budget_mode!r}"
            )
            raise ValueError(msg)
        if unit_replacement_outgoing_scale < 0.0:
            msg = (
                "unit_replacement_outgoing_scale must be non-negative, "
                f"got {unit_replacement_outgoing_scale}"
            )
            raise ValueError(msg)
        if unit_replacement_partial_fanin < 0:
            msg = (
                "unit_replacement_partial_fanin must be non-negative, "
                f"got {unit_replacement_partial_fanin}"
            )
            raise ValueError(msg)
        if unit_replacement_score_threshold < 0.0:
            msg = (
                "unit_replacement_score_threshold must be non-negative, "
                f"got {unit_replacement_score_threshold}"
            )
            raise ValueError(msg)
        if unit_outgoing_utility_weight < 0.0:
            msg = (
                "unit_outgoing_utility_weight must be non-negative, "
                f"got {unit_outgoing_utility_weight}"
            )
            raise ValueError(msg)
        if not 0.0 <= loss_fast_decay < 1.0:
            msg = f"loss_fast_decay must be in [0, 1), got {loss_fast_decay}"
            raise ValueError(msg)
        if not 0.0 <= loss_slow_decay < 1.0:
            msg = f"loss_slow_decay must be in [0, 1), got {loss_slow_decay}"
            raise ValueError(msg)
        if adaptive_kappa_mode not in {"none", "loss_ratio", "gradient_alignment"}:
            msg = (
                "adaptive_kappa_mode must be 'none', 'loss_ratio', "
                "or 'gradient_alignment', "
                f"got {adaptive_kappa_mode!r}"
            )
            raise ValueError(msg)
        if adaptive_kappa_base <= 0.0:
            msg = f"adaptive_kappa_base must be positive, got {adaptive_kappa_base}"
            raise ValueError(msg)
        if adaptive_kappa_min <= 0.0:
            msg = f"adaptive_kappa_min must be positive, got {adaptive_kappa_min}"
            raise ValueError(msg)
        if adaptive_kappa_max < adaptive_kappa_min:
            msg = (
                "adaptive_kappa_max must be >= adaptive_kappa_min, "
                f"got {adaptive_kappa_max} < {adaptive_kappa_min}"
            )
            raise ValueError(msg)
        if adaptive_kappa_exponent < 0.0:
            msg = (
                "adaptive_kappa_exponent must be non-negative, "
                f"got {adaptive_kappa_exponent}"
            )
            raise ValueError(msg)
        if adaptive_kappa_warmup_steps < 0:
            msg = (
                "adaptive_kappa_warmup_steps must be non-negative, "
                f"got {adaptive_kappa_warmup_steps}"
            )
            raise ValueError(msg)
        if adaptive_kappa_meta_step_size < 0.0:
            msg = (
                "adaptive_kappa_meta_step_size must be non-negative, "
                f"got {adaptive_kappa_meta_step_size}"
            )
            raise ValueError(msg)
        if adaptive_kappa_meta_min_multiplier <= 0.0:
            msg = (
                "adaptive_kappa_meta_min_multiplier must be positive, "
                f"got {adaptive_kappa_meta_min_multiplier}"
            )
            raise ValueError(msg)
        if adaptive_kappa_meta_max_multiplier < adaptive_kappa_meta_min_multiplier:
            msg = (
                "adaptive_kappa_meta_max_multiplier must be >= "
                "adaptive_kappa_meta_min_multiplier, "
                f"got {adaptive_kappa_meta_max_multiplier} < "
                f"{adaptive_kappa_meta_min_multiplier}"
            )
            raise ValueError(msg)
        if adaptive_kappa_meta_warmup_steps < 0:
            msg = (
                "adaptive_kappa_meta_warmup_steps must be non-negative, "
                f"got {adaptive_kappa_meta_warmup_steps}"
            )
            raise ValueError(msg)
        if meta_plasticity_mode not in {"none", "gradient_alignment"}:
            msg = (
                "meta_plasticity_mode must be 'none' or 'gradient_alignment', "
                f"got {meta_plasticity_mode!r}"
            )
            raise ValueError(msg)
        if meta_plasticity_step_size < 0.0:
            msg = (
                "meta_plasticity_step_size must be non-negative, "
                f"got {meta_plasticity_step_size}"
            )
            raise ValueError(msg)
        if meta_plasticity_min_multiplier <= 0.0:
            msg = (
                "meta_plasticity_min_multiplier must be positive, "
                f"got {meta_plasticity_min_multiplier}"
            )
            raise ValueError(msg)
        if meta_plasticity_max_multiplier < meta_plasticity_min_multiplier:
            msg = (
                "meta_plasticity_max_multiplier must be >= "
                "meta_plasticity_min_multiplier, "
                f"got {meta_plasticity_max_multiplier} < "
                f"{meta_plasticity_min_multiplier}"
            )
            raise ValueError(msg)
        if meta_plasticity_warmup_steps < 0:
            msg = (
                "meta_plasticity_warmup_steps must be non-negative, "
                f"got {meta_plasticity_warmup_steps}"
            )
            raise ValueError(msg)
        readout_aliases = {
            "linear_mse": ("linear_mse", "identity"),
            "softmax_ce": ("softmax_ce", "softmax"),
            "softmax_mse": ("softmax_mse", "softmax"),
            "adaptive_simplex": ("adaptive_simplex", "adaptive_simplex"),
            "factorized_simplex": ("softmax_ce", "factorized_simplex"),
            "adaptive_factorized_simplex": (
                "adaptive_factorized_simplex",
                "adaptive_factorized_simplex",
            ),
            "two_timescale_simplex": (
                "two_timescale_simplex",
                "two_timescale_simplex",
            ),
        }
        if readout_mode not in readout_aliases:
            msg = (
                "readout_mode must be 'linear_mse', 'softmax_ce', "
                "'softmax_mse', "
                "'adaptive_simplex', 'factorized_simplex', or "
                "'adaptive_factorized_simplex', or 'two_timescale_simplex', "
                f"got {readout_mode!r}"
            )
            raise ValueError(msg)
        default_loss_mode, default_prediction_mode = readout_aliases[readout_mode]
        resolved_readout_loss_mode = (
            default_loss_mode if readout_loss_mode is None else readout_loss_mode
        )
        resolved_readout_prediction_mode = (
            default_prediction_mode
            if readout_prediction_mode is None
            else readout_prediction_mode
        )
        if resolved_readout_loss_mode not in {
            "linear_mse",
            "softmax_ce",
            "softmax_mse",
            "adaptive_simplex",
            "adaptive_factorized_simplex",
            "two_timescale_simplex",
            "gce",
            "adaptive_gce",
        }:
            msg = (
                "readout_loss_mode must be 'linear_mse', 'softmax_ce', "
                "'softmax_mse', "
                "'adaptive_simplex', 'adaptive_factorized_simplex', "
                "'two_timescale_simplex', 'gce', or 'adaptive_gce', "
                f"got {resolved_readout_loss_mode!r}"
            )
            raise ValueError(msg)
        if resolved_readout_prediction_mode not in {
            "identity",
            "softmax",
            "adaptive_simplex",
            "factorized_simplex",
            "adaptive_factorized_simplex",
            "two_timescale_simplex",
            "unit_clip",
        }:
            msg = (
                "readout_prediction_mode must be 'identity', 'softmax', "
                "'adaptive_simplex', 'factorized_simplex', "
                "'adaptive_factorized_simplex', 'two_timescale_simplex', "
                "or 'unit_clip', "
                f"got {resolved_readout_prediction_mode!r}"
            )
            raise ValueError(msg)
        if not 0.0 < readout_robust_q <= 1.0:
            msg = f"readout_robust_q must be in (0, 1], got {readout_robust_q}"
            raise ValueError(msg)
        if not 0.0 <= readout_adaptive_gate_start <= 1.0:
            msg = (
                "readout_adaptive_gate_start must be in [0, 1], "
                f"got {readout_adaptive_gate_start}"
            )
            raise ValueError(msg)
        if readout_adaptive_gate_width <= 0.0:
            msg = (
                "readout_adaptive_gate_width must be positive, "
                f"got {readout_adaptive_gate_width}"
            )
            raise ValueError(msg)
        if readout_input_mode not in {"hidden", "hidden_plus_input"}:
            msg = (
                "readout_input_mode must be 'hidden' or 'hidden_plus_input', "
                f"got {readout_input_mode!r}"
            )
            raise ValueError(msg)
        if readout_head_normalization not in {"none", "hidden_norm"}:
            msg = (
                "readout_head_normalization must be 'none' or 'hidden_norm', "
                f"got {readout_head_normalization!r}"
            )
            raise ValueError(msg)
        if readout_margin < 0.0:
            msg = f"readout_margin must be non-negative, got {readout_margin}"
            raise ValueError(msg)
        if readout_margin_step_size < 0.0:
            msg = (
                "readout_margin_step_size must be non-negative, "
                f"got {readout_margin_step_size}"
            )
            raise ValueError(msg)
        if readout_label_adapter_step_size < 0.0:
            msg = (
                "readout_label_adapter_step_size must be non-negative, "
                f"got {readout_label_adapter_step_size}"
            )
            raise ValueError(msg)
        if readout_label_adapter_identity_regularization < 0.0:
            msg = (
                "readout_label_adapter_identity_regularization must be "
                "non-negative, "
                f"got {readout_label_adapter_identity_regularization}"
            )
            raise ValueError(msg)
        if readout_label_adapter_entropy_regularization < 0.0:
            msg = (
                "readout_label_adapter_entropy_regularization must be "
                "non-negative, "
                f"got {readout_label_adapter_entropy_regularization}"
            )
            raise ValueError(msg)
        if not 0.0 <= readout_label_adapter_floor < 1.0:
            msg = (
                "readout_label_adapter_floor must be in [0, 1), "
                f"got {readout_label_adapter_floor}"
            )
            raise ValueError(msg)
        if readout_fast_head_step_size_multiplier < 0.0:
            msg = (
                "readout_fast_head_step_size_multiplier must be non-negative, "
                f"got {readout_fast_head_step_size_multiplier}"
            )
            raise ValueError(msg)
        if readout_fast_head_bias_step_size_multiplier < 0.0:
            msg = (
                "readout_fast_head_bias_step_size_multiplier must be "
                "non-negative, "
                f"got {readout_fast_head_bias_step_size_multiplier}"
            )
            raise ValueError(msg)
        if readout_fast_trunk_gradient_multiplier < 0.0:
            msg = (
                "readout_fast_trunk_gradient_multiplier must be non-negative, "
                f"got {readout_fast_trunk_gradient_multiplier}"
            )
            raise ValueError(msg)
        if readout_fast_head_bounder_mode not in {"shared", "separate"}:
            msg = (
                "readout_fast_head_bounder_mode must be 'shared' or 'separate', "
                f"got {readout_fast_head_bounder_mode!r}"
            )
            raise ValueError(msg)
        if readout_slow_simplex_gradient_multiplier < 0.0:
            msg = (
                "readout_slow_simplex_gradient_multiplier must be non-negative, "
                f"got {readout_slow_simplex_gradient_multiplier}"
            )
            raise ValueError(msg)
        if not 0.0 <= readout_simplex_bias_decay <= 1.0:
            msg = (
                "readout_simplex_bias_decay must be in [0, 1], "
                f"got {readout_simplex_bias_decay}"
            )
            raise ValueError(msg)
        if not 0.0 <= readout_simplex_bias_centering_rate <= 1.0:
            msg = (
                "readout_simplex_bias_centering_rate must be in [0, 1], "
                f"got {readout_simplex_bias_centering_rate}"
            )
            raise ValueError(msg)

        self._n_heads = n_heads
        self._hidden_sizes = hidden_sizes
        self._step_size = float(step_size)
        self._bounder = bounder
        self._utility_decay = float(utility_decay)
        self._perturbation_sigma = float(perturbation_sigma)
        self._perturbation_beta = float(perturbation_beta)
        self._perturbation_interval = int(perturbation_interval)
        self._perturbation_noise = perturbation_noise
        self._perturbation_warmup_steps = int(perturbation_warmup_steps)
        self._perturbation_ramp_steps = int(perturbation_ramp_steps)
        self._sparsity = float(sparsity)
        self._leaky_relu_slope = float(leaky_relu_slope)
        self._use_layer_norm = bool(use_layer_norm)
        self._loss_normalization = loss_normalization
        self._positive_target_loss_scale = float(positive_target_loss_scale)
        self._negative_target_loss_scale = float(negative_target_loss_scale)
        self._head_gradient_scale = head_gradient_scale
        self._head_step_size_multiplier = float(head_step_size_multiplier)
        self._head_bias_step_size_multiplier = float(head_bias_step_size_multiplier)
        self._head_loss_pressure_gate_ratio = float(head_loss_pressure_gate_ratio)
        self._head_loss_pressure_multiplier = float(head_loss_pressure_multiplier)
        self._head_loss_pressure_warmup_steps = int(head_loss_pressure_warmup_steps)
        self._head_repetition_multiplier = float(head_repetition_multiplier)
        self._head_repetition_decay = float(head_repetition_decay)
        self._head_repetition_delta_threshold = float(
            head_repetition_delta_threshold
        )
        self._head_repetition_pressure_threshold = float(
            head_repetition_pressure_threshold
        )
        self._head_repetition_warmup_steps = int(head_repetition_warmup_steps)
        self._unit_replacement_rate = float(unit_replacement_rate)
        self._unit_maturity_threshold = int(unit_maturity_threshold)
        self._unit_utility_decay = (
            float(utility_decay)
            if unit_utility_decay is None
            else float(unit_utility_decay)
        )
        self._unit_long_utility_decay = float(unit_long_utility_decay)
        self._unit_gradient_decay = float(unit_gradient_decay)
        self._unit_replacement_criterion = unit_replacement_criterion
        self._unit_replacement_fanin = unit_replacement_fanin
        self._unit_replacement_loss_gate_ratio = float(unit_replacement_loss_gate_ratio)
        self._unit_replacement_budget_mode = unit_replacement_budget_mode
        self._unit_replacement_outgoing_scale = float(unit_replacement_outgoing_scale)
        self._unit_replacement_partial_fanin = int(unit_replacement_partial_fanin)
        self._unit_replacement_score_threshold = float(
            unit_replacement_score_threshold
        )
        self._unit_outgoing_utility_weight = float(unit_outgoing_utility_weight)
        self._track_unit_utilities = bool(track_unit_utilities)
        self._track_gradient_history = bool(track_gradient_history)
        self._loss_fast_decay = float(loss_fast_decay)
        self._loss_slow_decay = float(loss_slow_decay)
        self._adaptive_kappa_mode = adaptive_kappa_mode
        self._adaptive_kappa_base = float(adaptive_kappa_base)
        self._adaptive_kappa_min = float(adaptive_kappa_min)
        self._adaptive_kappa_max = float(adaptive_kappa_max)
        self._adaptive_kappa_exponent = float(adaptive_kappa_exponent)
        self._adaptive_kappa_warmup_steps = int(adaptive_kappa_warmup_steps)
        self._adaptive_kappa_meta_step_size = float(adaptive_kappa_meta_step_size)
        self._adaptive_kappa_meta_min_multiplier = float(
            adaptive_kappa_meta_min_multiplier
        )
        self._adaptive_kappa_meta_max_multiplier = float(
            adaptive_kappa_meta_max_multiplier
        )
        self._adaptive_kappa_meta_warmup_steps = int(
            adaptive_kappa_meta_warmup_steps
        )
        self._meta_plasticity_mode = meta_plasticity_mode
        self._meta_plasticity_step_size = float(meta_plasticity_step_size)
        self._meta_plasticity_min_multiplier = float(
            meta_plasticity_min_multiplier
        )
        self._meta_plasticity_max_multiplier = float(
            meta_plasticity_max_multiplier
        )
        self._meta_plasticity_warmup_steps = int(meta_plasticity_warmup_steps)
        self._meta_plasticity_trunk_enabled = bool(meta_plasticity_trunk_enabled)
        self._meta_plasticity_head_weight_enabled = bool(
            meta_plasticity_head_weight_enabled
        )
        self._meta_plasticity_head_bias_enabled = bool(
            meta_plasticity_head_bias_enabled
        )
        self._meta_plasticity_repetition_enabled = bool(
            meta_plasticity_repetition_enabled
        )
        self._readout_mode = readout_mode
        self._readout_loss_mode = resolved_readout_loss_mode
        self._readout_prediction_mode = resolved_readout_prediction_mode
        self._readout_robust_q = float(readout_robust_q)
        self._readout_adaptive_gate_start = float(readout_adaptive_gate_start)
        self._readout_adaptive_gate_width = float(readout_adaptive_gate_width)
        self._readout_input_mode = readout_input_mode
        self._readout_head_normalization = readout_head_normalization
        self._readout_margin = float(readout_margin)
        self._readout_margin_step_size = float(readout_margin_step_size)
        self._readout_label_adapter_step_size = float(
            readout_label_adapter_step_size
        )
        self._readout_label_adapter_identity_regularization = float(
            readout_label_adapter_identity_regularization
        )
        self._readout_label_adapter_entropy_regularization = float(
            readout_label_adapter_entropy_regularization
        )
        self._readout_label_adapter_floor = float(readout_label_adapter_floor)
        self._readout_fast_head_step_size_multiplier = float(
            readout_fast_head_step_size_multiplier
        )
        self._readout_fast_head_bias_step_size_multiplier = float(
            readout_fast_head_bias_step_size_multiplier
        )
        self._readout_fast_trunk_gradient_multiplier = float(
            readout_fast_trunk_gradient_multiplier
        )
        self._readout_fast_head_bounder_mode = readout_fast_head_bounder_mode
        self._readout_slow_simplex_gradient_multiplier = float(
            readout_slow_simplex_gradient_multiplier
        )
        self._readout_simplex_bias_decay = float(readout_simplex_bias_decay)
        self._readout_simplex_bias_centering_rate = float(
            readout_simplex_bias_centering_rate
        )

    @property
    def n_heads(self) -> int:
        """Number of prediction heads."""
        return self._n_heads

    def _stores_unit_state(self) -> bool:
        """Whether this configuration needs row-level unit bookkeeping."""
        return (
            self._track_unit_utilities
            or self._unit_replacement_rate > 0.0
            or self._unit_outgoing_utility_weight > 0.0
        )

    def _stores_gradient_history(self) -> bool:
        """Whether this configuration needs previous-gradient buffers."""
        return (
            self._track_gradient_history
            or self._meta_plasticity_mode == "gradient_alignment"
            or (
                self._adaptive_kappa_mode in {"loss_ratio", "gradient_alignment"}
                and self._adaptive_kappa_meta_step_size > 0.0
            )
        )

    @classmethod
    def step2_default(
        cls,
        n_heads: int,
        hidden_sizes: tuple[int, ...] = (32,),
        *,
        loss_normalization: str = "target_structure",
        readout_mode: str = "linear_mse",
        readout_loss_mode: str | None = None,
        readout_prediction_mode: str | None = None,
        readout_robust_q: float = 0.7,
        readout_label_adapter_step_size: float = 0.2,
        readout_label_adapter_identity_regularization: float = 1e-3,
        readout_label_adapter_entropy_regularization: float = 0.0,
        readout_label_adapter_floor: float = 1e-6,
        readout_fast_head_step_size_multiplier: float = 1.0,
        readout_fast_head_bias_step_size_multiplier: float = 1.0,
        readout_fast_trunk_gradient_multiplier: float = 0.0,
        readout_fast_head_bounder_mode: str = "shared",
        readout_slow_simplex_gradient_multiplier: float = 1.0,
        step_size: float = 0.03,
    ) -> "UPGDLearner":
        """Create the current resource-efficient Step 2 UPGD candidate.

        This factory is intentionally explicit rather than changing the
        constructor default.  It captures the no-portfolio Step 2 candidate
        used for the compute-efficiency promotion experiments: target-structure
        vector loss, conservative ObGD bounding, low-noise utility perturbation,
        sparse Rademacher mutation every 16 steps, and lean bookkeeping when
        unit recycling and gradient-alignment meta-control are disabled.

        Args:
            n_heads: Number of vector-output prediction heads.
            hidden_sizes: Shared hidden-layer sizes.
            loss_normalization: Target normalizer to test.  The preferred
                default is ``"target_structure"``; pass ``"target_density"``
                only to reproduce historical one-hot density-equivalent
                ablations.
            readout_mode: Output loss/readout mode.  ``"linear_mse"`` is the
                supervised Step 2 default; ``"softmax_ce"`` keeps the same
                resource-efficient UPGD branch for one-hot classification or
                language-model next-token demos. ``"softmax_mse"`` uses the
                same softmax predictions but trains them with Brier/MSE loss.
                ``"adaptive_simplex"`` uses the target-repeat EMA to
                interpolate from linear-MSE readout toward softmax/CE on
                persistent simplex targets.
                ``"factorized_simplex"`` keeps the base softmax head and adds
                a fast causal row-stochastic label-map adapter.
            step_size: Base UPGD step-size.

        Returns:
            Configured :class:`UPGDLearner`.
        """
        if loss_normalization not in {"target_structure", "target_density"}:
            msg = (
                "step2_default loss_normalization must be 'target_structure' "
                f"or 'target_density', got {loss_normalization!r}"
            )
            raise ValueError(msg)
        if readout_mode not in {
            "linear_mse",
            "softmax_ce",
            "softmax_mse",
            "adaptive_simplex",
            "factorized_simplex",
            "adaptive_factorized_simplex",
            "two_timescale_simplex",
        }:
            msg = (
                "step2_default readout_mode must be 'linear_mse', "
                "'softmax_ce', 'softmax_mse', 'adaptive_simplex', "
                "'factorized_simplex', 'adaptive_factorized_simplex', or "
                "'two_timescale_simplex', "
                f"got {readout_mode!r}"
            )
            raise ValueError(msg)
        return cls(
            n_heads=n_heads,
            hidden_sizes=hidden_sizes,
            step_size=step_size,
            bounder=ObGDBounding(kappa=0.5),
            sparsity=0.5,
            use_layer_norm=True,
            perturbation_sigma=1e-4,
            perturbation_noise="rademacher",
            utility_decay=0.995,
            perturbation_beta=2.0,
            perturbation_interval=16,
            loss_normalization=loss_normalization,
            readout_mode=readout_mode,
            readout_loss_mode=readout_loss_mode,
            readout_prediction_mode=readout_prediction_mode,
            readout_robust_q=readout_robust_q,
            readout_label_adapter_step_size=readout_label_adapter_step_size,
            readout_label_adapter_identity_regularization=(
                readout_label_adapter_identity_regularization
            ),
            readout_label_adapter_entropy_regularization=(
                readout_label_adapter_entropy_regularization
            ),
            readout_label_adapter_floor=readout_label_adapter_floor,
            readout_fast_head_step_size_multiplier=(
                readout_fast_head_step_size_multiplier
            ),
            readout_fast_head_bias_step_size_multiplier=(
                readout_fast_head_bias_step_size_multiplier
            ),
            readout_fast_trunk_gradient_multiplier=(
                readout_fast_trunk_gradient_multiplier
            ),
            readout_fast_head_bounder_mode=readout_fast_head_bounder_mode,
            readout_slow_simplex_gradient_multiplier=(
                readout_slow_simplex_gradient_multiplier
            ),
            track_unit_utilities=False,
            track_gradient_history=False,
        )

    @classmethod
    def step2_strict_digit_readout_default(
        cls,
        n_heads: int,
        hidden_sizes: tuple[int, ...] = (64, 64),
        *,
        step_size: float = 0.018,
    ) -> "UPGDLearner":
        """Create the strict Step 2 digit/readout consistency candidate.

        This factory captures the 2026-05-07 branch that closes the
        one-branch digit readout conflict against same-run fair MLP baselines.
        It is intentionally separate from :meth:`step2_default`: this branch
        is a heavier simplex/readout default for sklearn-digits-style online
        classification streams, while ``step2_default`` remains the
        resource-efficient broad target-structure default.

        Args:
            n_heads: Number of simplex output heads.
            hidden_sizes: Shared hidden-layer sizes.
            step_size: Base UPGD step-size.  The promoted row uses ``0.018``.

        Returns:
            Configured :class:`UPGDLearner`.
        """
        return cls(
            n_heads=n_heads,
            hidden_sizes=hidden_sizes,
            step_size=step_size,
            bounder=ObGDBounding(kappa=0.5),
            sparsity=0.5,
            use_layer_norm=True,
            perturbation_sigma=1e-4,
            utility_decay=0.995,
            perturbation_beta=2.0,
            perturbation_interval=1,
            loss_normalization="target_structure",
            head_repetition_multiplier=0.75,
            adaptive_kappa_mode="loss_ratio",
            adaptive_kappa_base=0.5,
            adaptive_kappa_min=0.35,
            adaptive_kappa_max=0.65,
            adaptive_kappa_exponent=0.5,
            adaptive_kappa_warmup_steps=120,
            meta_plasticity_mode="gradient_alignment",
            meta_plasticity_step_size=0.001,
            meta_plasticity_min_multiplier=0.5,
            meta_plasticity_max_multiplier=2.0,
            meta_plasticity_warmup_steps=30,
            meta_plasticity_trunk_enabled=False,
            meta_plasticity_head_weight_enabled=True,
            meta_plasticity_head_bias_enabled=True,
            meta_plasticity_repetition_enabled=True,
            readout_mode="two_timescale_simplex",
            readout_fast_head_step_size_multiplier=2.0,
            readout_fast_trunk_gradient_multiplier=2.0,
            readout_fast_head_bounder_mode="separate",
            readout_slow_simplex_gradient_multiplier=0.0,
        )

    # -------------------------------------------------------------------------
    # Config serialization
    # -------------------------------------------------------------------------

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to dict."""
        return {
            "type": "UPGDLearner",
            "n_heads": self._n_heads,
            "hidden_sizes": list(self._hidden_sizes),
            "step_size": self._step_size,
            "bounder": self._bounder.to_config() if self._bounder is not None else None,
            "utility_decay": self._utility_decay,
            "perturbation_sigma": self._perturbation_sigma,
            "perturbation_beta": self._perturbation_beta,
            "perturbation_interval": self._perturbation_interval,
            "perturbation_noise": self._perturbation_noise,
            "perturbation_warmup_steps": self._perturbation_warmup_steps,
            "perturbation_ramp_steps": self._perturbation_ramp_steps,
            "sparsity": self._sparsity,
            "leaky_relu_slope": self._leaky_relu_slope,
            "use_layer_norm": self._use_layer_norm,
            "loss_normalization": self._loss_normalization,
            "positive_target_loss_scale": self._positive_target_loss_scale,
            "negative_target_loss_scale": self._negative_target_loss_scale,
            "head_gradient_scale": self._head_gradient_scale,
            "head_step_size_multiplier": self._head_step_size_multiplier,
            "head_bias_step_size_multiplier": (
                self._head_bias_step_size_multiplier
            ),
            "head_loss_pressure_gate_ratio": self._head_loss_pressure_gate_ratio,
            "head_loss_pressure_multiplier": self._head_loss_pressure_multiplier,
            "head_loss_pressure_warmup_steps": (
                self._head_loss_pressure_warmup_steps
            ),
            "head_repetition_multiplier": self._head_repetition_multiplier,
            "head_repetition_decay": self._head_repetition_decay,
            "head_repetition_delta_threshold": (
                self._head_repetition_delta_threshold
            ),
            "head_repetition_pressure_threshold": (
                self._head_repetition_pressure_threshold
            ),
            "head_repetition_warmup_steps": self._head_repetition_warmup_steps,
            "unit_replacement_rate": self._unit_replacement_rate,
            "unit_maturity_threshold": self._unit_maturity_threshold,
            "unit_utility_decay": self._unit_utility_decay,
            "unit_long_utility_decay": self._unit_long_utility_decay,
            "unit_gradient_decay": self._unit_gradient_decay,
            "unit_replacement_criterion": self._unit_replacement_criterion,
            "unit_replacement_fanin": self._unit_replacement_fanin,
            "unit_replacement_loss_gate_ratio": (
                self._unit_replacement_loss_gate_ratio
            ),
            "unit_replacement_budget_mode": self._unit_replacement_budget_mode,
            "unit_replacement_outgoing_scale": (
                self._unit_replacement_outgoing_scale
            ),
            "unit_replacement_partial_fanin": (
                self._unit_replacement_partial_fanin
            ),
            "unit_replacement_score_threshold": (
                self._unit_replacement_score_threshold
            ),
            "unit_outgoing_utility_weight": self._unit_outgoing_utility_weight,
            "track_unit_utilities": self._track_unit_utilities,
            "track_gradient_history": self._track_gradient_history,
            "loss_fast_decay": self._loss_fast_decay,
            "loss_slow_decay": self._loss_slow_decay,
            "adaptive_kappa_mode": self._adaptive_kappa_mode,
            "adaptive_kappa_base": self._adaptive_kappa_base,
            "adaptive_kappa_min": self._adaptive_kappa_min,
            "adaptive_kappa_max": self._adaptive_kappa_max,
            "adaptive_kappa_exponent": self._adaptive_kappa_exponent,
            "adaptive_kappa_warmup_steps": self._adaptive_kappa_warmup_steps,
            "adaptive_kappa_meta_step_size": (
                self._adaptive_kappa_meta_step_size
            ),
            "adaptive_kappa_meta_min_multiplier": (
                self._adaptive_kappa_meta_min_multiplier
            ),
            "adaptive_kappa_meta_max_multiplier": (
                self._adaptive_kappa_meta_max_multiplier
            ),
            "adaptive_kappa_meta_warmup_steps": (
                self._adaptive_kappa_meta_warmup_steps
            ),
            "meta_plasticity_mode": self._meta_plasticity_mode,
            "meta_plasticity_step_size": self._meta_plasticity_step_size,
            "meta_plasticity_min_multiplier": (
                self._meta_plasticity_min_multiplier
            ),
            "meta_plasticity_max_multiplier": (
                self._meta_plasticity_max_multiplier
            ),
            "meta_plasticity_warmup_steps": (
                self._meta_plasticity_warmup_steps
            ),
            "meta_plasticity_trunk_enabled": (
                self._meta_plasticity_trunk_enabled
            ),
            "meta_plasticity_head_weight_enabled": (
                self._meta_plasticity_head_weight_enabled
            ),
            "meta_plasticity_head_bias_enabled": (
                self._meta_plasticity_head_bias_enabled
            ),
            "meta_plasticity_repetition_enabled": (
                self._meta_plasticity_repetition_enabled
            ),
            "readout_mode": self._readout_mode,
            "readout_loss_mode": self._readout_loss_mode,
            "readout_prediction_mode": self._readout_prediction_mode,
            "readout_robust_q": self._readout_robust_q,
            "readout_adaptive_gate_start": self._readout_adaptive_gate_start,
            "readout_adaptive_gate_width": self._readout_adaptive_gate_width,
            "readout_input_mode": self._readout_input_mode,
            "readout_head_normalization": self._readout_head_normalization,
            "readout_margin": self._readout_margin,
            "readout_margin_step_size": self._readout_margin_step_size,
            "readout_label_adapter_step_size": (
                self._readout_label_adapter_step_size
            ),
            "readout_label_adapter_identity_regularization": (
                self._readout_label_adapter_identity_regularization
            ),
            "readout_label_adapter_entropy_regularization": (
                self._readout_label_adapter_entropy_regularization
            ),
            "readout_label_adapter_floor": self._readout_label_adapter_floor,
            "readout_fast_head_step_size_multiplier": (
                self._readout_fast_head_step_size_multiplier
            ),
            "readout_fast_head_bias_step_size_multiplier": (
                self._readout_fast_head_bias_step_size_multiplier
            ),
            "readout_fast_trunk_gradient_multiplier": (
                self._readout_fast_trunk_gradient_multiplier
            ),
            "readout_fast_head_bounder_mode": self._readout_fast_head_bounder_mode,
            "readout_slow_simplex_gradient_multiplier": (
                self._readout_slow_simplex_gradient_multiplier
            ),
            "readout_simplex_bias_decay": self._readout_simplex_bias_decay,
            "readout_simplex_bias_centering_rate": (
                self._readout_simplex_bias_centering_rate
            ),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "UPGDLearner":
        """Reconstruct a :class:`UPGDLearner` from a config dict."""
        from alberta_framework.core.optimizers import bounder_from_config

        config = dict(config)
        config.pop("type", None)
        bounder_cfg = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_cfg) if bounder_cfg is not None else None
        return cls(
            n_heads=config.pop("n_heads"),
            hidden_sizes=tuple(config.pop("hidden_sizes")),
            bounder=bounder,
            **config,
        )

    # -------------------------------------------------------------------------
    # Init
    # -------------------------------------------------------------------------

    def init(self, feature_dim: int, key: Array) -> UPGDState:
        """Initialize UPGD state.

        Trunk and head weights use sparse LeCun initialization. Biases are
        zero. Per-hidden-layer utility arrays are zero. The PRNG key carried
        in the state is split off and reused for perturbation sampling.

        Args:
            feature_dim: Dimension of the input feature vector
            key: JAX random key for weight initialization and perturbation

        Returns:
            Initial :class:`UPGDState`
        """
        if feature_dim < 1:
            msg = f"feature_dim must be >= 1, got {feature_dim}"
            raise ValueError(msg)
        # Trunk: feature_dim -> H1 -> H2 -> ... -> H_last
        trunk_layer_sizes = [feature_dim, *self._hidden_sizes]
        store_unit_state = self._stores_unit_state()
        store_gradient_history = self._stores_gradient_history()

        trunk_weights: list[Array] = []
        trunk_biases: list[Array] = []
        utilities: list[Array] = []
        unit_utilities: list[Array] = []
        unit_long_utilities: list[Array] = []
        unit_gradient_emas: list[Array] = []
        unit_ages: list[Array] = []

        for i in range(len(trunk_layer_sizes) - 1):
            fan_in = trunk_layer_sizes[i]
            fan_out = trunk_layer_sizes[i + 1]
            key, subkey = jr.split(key)
            w = sparse_init(subkey, (fan_out, fan_in), sparsity=self._sparsity)
            b = jnp.zeros(fan_out, dtype=jnp.float32)
            trunk_weights.append(w)
            trunk_biases.append(b)
            utilities.append(jnp.zeros_like(w))
            if store_unit_state:
                unit_utilities.append(jnp.zeros(fan_out, dtype=jnp.float32))
                unit_long_utilities.append(jnp.zeros(fan_out, dtype=jnp.float32))
                unit_gradient_emas.append(jnp.zeros(fan_out, dtype=jnp.float32))
                unit_ages.append(jnp.zeros(fan_out, dtype=jnp.int32))

        trunk_params = MLPParams(  # type: ignore[call-arg]
            weights=tuple(trunk_weights),
            biases=tuple(trunk_biases),
        )

        # Heads: n_heads x (1, H_last). When hidden_sizes=(), heads project
        # directly from the input features.
        h_last = self._hidden_sizes[-1] if self._hidden_sizes else feature_dim
        head_input_dim = h_last
        if self._readout_input_mode == "hidden_plus_input" and self._hidden_sizes:
            head_input_dim += feature_dim
        head_weights: list[Array] = []
        head_biases: list[Array] = []
        for _ in range(self._n_heads):
            key, subkey = jr.split(key)
            w = sparse_init(subkey, (1, head_input_dim), sparsity=self._sparsity)
            b = jnp.zeros(1, dtype=jnp.float32)
            head_weights.append(w)
            head_biases.append(b)

        head_params = MLPParams(  # type: ignore[call-arg]
            weights=tuple(head_weights),
            biases=tuple(head_biases),
        )
        readout_label_adapter = self._normalize_label_adapter(
            jnp.eye(self._n_heads, dtype=jnp.float32),
            jnp.asarray(self._readout_label_adapter_floor, dtype=jnp.float32),
        )

        # The remaining key is carried in state for perturbation sampling.
        return UPGDState(  # type: ignore[call-arg]
            trunk_params=trunk_params,
            head_params=head_params,
            readout_fast_head_params=head_params,
            readout_label_adapter=readout_label_adapter,
            utilities=tuple(utilities),
            unit_utilities=tuple(unit_utilities),
            unit_long_utilities=tuple(unit_long_utilities),
            unit_gradient_emas=tuple(unit_gradient_emas),
            unit_ages=tuple(unit_ages),
            unit_replacement_counts=jnp.zeros(
                len(unit_utilities),
                dtype=jnp.float32,
            ),
            unit_replacement_accumulators=jnp.zeros(
                len(unit_utilities),
                dtype=jnp.float32,
            ),
            loss_fast_ema=jnp.array(0.0, dtype=jnp.float32),
            loss_slow_ema=jnp.array(0.0, dtype=jnp.float32),
            previous_targets=jnp.zeros(self._n_heads, dtype=jnp.float32),
            target_repeat_ema=jnp.array(0.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(0.0, dtype=jnp.float32),
            meta_trunk_log_scale=jnp.array(0.0, dtype=jnp.float32),
            meta_head_weight_log_scale=jnp.array(0.0, dtype=jnp.float32),
            meta_head_bias_log_scale=jnp.array(0.0, dtype=jnp.float32),
            meta_repetition_log_scale=jnp.array(0.0, dtype=jnp.float32),
            adaptive_kappa_log_scale=jnp.array(0.0, dtype=jnp.float32),
            previous_trunk_weight_grads=(
                tuple(jnp.zeros_like(w) for w in trunk_weights)
                if store_gradient_history
                else ()
            ),
            previous_trunk_bias_grads=(
                tuple(jnp.zeros_like(b) for b in trunk_biases)
                if store_gradient_history
                else ()
            ),
            previous_head_weight_grads=(
                tuple(jnp.zeros_like(w) for w in head_weights)
                if store_gradient_history
                else ()
            ),
            previous_head_bias_grads=(
                tuple(jnp.zeros_like(b) for b in head_biases)
                if store_gradient_history
                else ()
            ),
            key=key,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    # -------------------------------------------------------------------------
    # Forward pass
    # -------------------------------------------------------------------------

    @staticmethod
    def _trunk_forward(
        weights: tuple[Array, ...],
        biases: tuple[Array, ...],
        observation: Array,
        leaky_relu_slope: float,
        use_layer_norm: bool,
    ) -> Array:
        """Forward through the shared trunk.

        Returns the last hidden representation. When ``weights`` is empty
        (linear baseline), returns the observation unchanged.
        """
        if len(weights) == 0:
            return observation
        x = observation
        for i in range(len(weights)):
            x = weights[i] @ x + biases[i]
            if use_layer_norm:
                mean = jnp.mean(x)
                var = jnp.var(x)
                x = (x - mean) / jnp.sqrt(var + 1e-5)
            x = jnp.where(x >= 0, x, leaky_relu_slope * x)
        return x

    @staticmethod
    def _full_forward(
        trunk_weights: tuple[Array, ...],
        trunk_biases: tuple[Array, ...],
        head_weights: tuple[Array, ...],
        head_biases: tuple[Array, ...],
        observation: Array,
        leaky_relu_slope: float,
        use_layer_norm: bool,
        readout_input_mode: str = "hidden",
    ) -> Array:
        """Forward through trunk + all heads. Returns shape ``(n_heads,)``."""
        logits, _ = UPGDLearner._forward_with_readout_input(
            trunk_weights,
            trunk_biases,
            head_weights,
            head_biases,
            observation,
            leaky_relu_slope,
            use_layer_norm,
            readout_input_mode,
        )
        return logits

    @staticmethod
    def _forward_with_readout_input(
        trunk_weights: tuple[Array, ...],
        trunk_biases: tuple[Array, ...],
        head_weights: tuple[Array, ...],
        head_biases: tuple[Array, ...],
        observation: Array,
        leaky_relu_slope: float,
        use_layer_norm: bool,
        readout_input_mode: str = "hidden",
    ) -> tuple[Array, Array]:
        """Forward through trunk + all heads and return readout features.

        Returning the head input lets ``update`` reuse the same forward pass
        for loss, metrics, head normalization, and margin updates instead of
        recomputing the trunk outside the differentiated loss.
        """
        hidden = UPGDLearner._trunk_forward(
            trunk_weights, trunk_biases, observation, leaky_relu_slope, use_layer_norm
        )
        if readout_input_mode == "hidden_plus_input" and len(trunk_weights) > 0:
            hidden = jnp.concatenate([hidden, observation])
        head_matrix = jnp.concatenate(head_weights, axis=0)
        head_bias_vector = jnp.concatenate(head_biases, axis=0)
        return head_matrix @ hidden + head_bias_vector, hidden

    @staticmethod
    def _softmax_predictions(logits: Array) -> Array:
        """Convert logits to class probabilities."""
        shifted = logits - jnp.max(logits)
        exp = jnp.exp(shifted)
        return exp / jnp.sum(exp)

    @staticmethod
    def _normalize_label_adapter(adapter: Array, floor: Array) -> Array:
        """Project the label-map adapter to non-negative row-stochastic form."""
        clipped = jnp.maximum(adapter, floor)
        return clipped / jnp.sum(clipped, axis=1, keepdims=True)

    @staticmethod
    def _factorized_simplex_predictions(logits: Array, adapter: Array) -> Array:
        """Map base class probabilities through a source-row label adapter."""
        base_probs = UPGDLearner._softmax_predictions(logits)
        return base_probs @ adapter

    def _adaptive_readout_gate(self, target_repeat_ema: Array) -> Array:
        """Map target persistence to a bounded simplex readout gate."""
        start = jnp.asarray(self._readout_adaptive_gate_start, dtype=jnp.float32)
        width = jnp.asarray(self._readout_adaptive_gate_width, dtype=jnp.float32)
        return jnp.clip((target_repeat_ema - start) / width, 0.0, 1.0)

    def _prediction_from_logits(
        self,
        logits: Array,
        adaptive_gate: Array,
        label_adapter: Array,
        fast_logits: Array | None = None,
    ) -> Array:
        """Apply the configured readout prediction transform."""
        if self._readout_prediction_mode == "softmax":
            return self._softmax_predictions(logits)
        if self._readout_prediction_mode == "adaptive_simplex":
            probs = self._softmax_predictions(logits)
            return adaptive_gate * probs + (1.0 - adaptive_gate) * logits
        if self._readout_prediction_mode == "factorized_simplex":
            return self._factorized_simplex_predictions(logits, label_adapter)
        if self._readout_prediction_mode == "adaptive_factorized_simplex":
            adapted = self._factorized_simplex_predictions(logits, label_adapter)
            return adaptive_gate * adapted + (1.0 - adaptive_gate) * logits
        if self._readout_prediction_mode == "two_timescale_simplex":
            fast = logits if fast_logits is None else fast_logits
            return (
                adaptive_gate * self._softmax_predictions(fast)
                + (1.0 - adaptive_gate) * logits
            )
        if self._readout_prediction_mode == "unit_clip":
            return jnp.clip(logits, 0.0, 1.0)
        return logits

    @staticmethod
    def _obgd_bound_with_kappa(
        steps: tuple[Array, ...],
        error: Array,
        kappa: Array,
    ) -> tuple[tuple[Array, ...], Array]:
        """Apply ObGD global step bounding with a dynamic kappa."""
        error_scalar = jnp.squeeze(error)
        total_step = jnp.array(0.0, dtype=jnp.float32)
        for step in steps:
            total_step = total_step + jnp.sum(jnp.abs(step))
        delta_bar = jnp.maximum(jnp.abs(error_scalar), 1.0)
        bound_magnitude = kappa * delta_bar * total_step
        scale = 1.0 / jnp.maximum(bound_magnitude, 1.0)
        return tuple(scale * step for step in steps), scale

    @staticmethod
    def _tuple_dot(xs: tuple[Array, ...], ys: tuple[Array, ...]) -> Array:
        """Dot product over a static tuple of arrays."""
        total = jnp.array(0.0, dtype=jnp.float32)
        for x, y in zip(xs, ys):
            total = total + jnp.sum(x * y)
        return total

    @staticmethod
    def _tuple_norm(xs: tuple[Array, ...]) -> Array:
        """L2 norm over a static tuple of arrays."""
        total = jnp.array(0.0, dtype=jnp.float32)
        for x in xs:
            total = total + jnp.sum(jnp.square(x))
        return jnp.sqrt(total + 1e-12)

    @staticmethod
    def _gradient_alignment(
        previous: tuple[Array, ...],
        current: tuple[Array, ...],
    ) -> Array:
        """Cosine alignment of two gradient tuples, zero for empty gradients."""
        previous_norm = UPGDLearner._tuple_norm(previous)
        current_norm = UPGDLearner._tuple_norm(current)
        return jnp.where(
            (previous_norm > 1e-6) & (current_norm > 1e-6),
            UPGDLearner._tuple_dot(previous, current)
            / (previous_norm * current_norm + 1e-12),
            jnp.array(0.0, dtype=jnp.float32),
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: UPGDState, observation: Array) -> Array:
        """Compute per-head predictions for an observation.

        Args:
            state: Current UPGD state
            observation: Input feature vector of shape ``(feature_dim,)``

        Returns:
            Array of shape ``(n_heads,)`` with one prediction per head.
        """
        logits = self._full_forward(
            state.trunk_params.weights,
            state.trunk_params.biases,
            state.head_params.weights,
            state.head_params.biases,
            observation,
            self._leaky_relu_slope,
            self._use_layer_norm,
            self._readout_input_mode,
        )
        fast_logits = logits
        if self._readout_prediction_mode == "two_timescale_simplex":
            fast_logits = self._full_forward(
                state.trunk_params.weights,
                state.trunk_params.biases,
                state.readout_fast_head_params.weights,
                state.readout_fast_head_params.biases,
                observation,
                self._leaky_relu_slope,
                self._use_layer_norm,
                self._readout_input_mode,
            )
        simplex_gate = jnp.where(
            self._n_heads > 1,
            self._adaptive_readout_gate(state.target_repeat_ema)
            * jnp.clip(state.target_simplex_ema, 0.0, 1.0),
            0.0,
        )
        return self._prediction_from_logits(
            logits,
            simplex_gate,
            state.readout_label_adapter,
            fast_logits,
        )

    # -------------------------------------------------------------------------
    # Update
    # -------------------------------------------------------------------------

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: UPGDState,
        observation: Array,
        targets: Array,
    ) -> UPGDUpdateResult:
        """Run one UPGD update step.

        The loss is ``0.5 * sum_active((pred_i - target_i)^2)`` by default;
        inactive (NaN target) heads contribute zero. Gradients are computed
        for all trunk and head parameters at once via :func:`jax.grad`.

        Args:
            state: Current UPGD state
            observation: Input feature vector ``(feature_dim,)``
            targets: Per-head targets ``(n_heads,)``. NaN entries mark
                inactive heads.

        Returns:
            :class:`UPGDUpdateResult` with the updated state, predictions,
            errors, and 1D metrics array.
        """
        slope = self._leaky_relu_slope
        ln = self._use_layer_norm
        sigma = jnp.array(self._perturbation_sigma, dtype=jnp.float32)
        beta = jnp.array(self._perturbation_beta, dtype=jnp.float32)
        decay = jnp.array(self._utility_decay, dtype=jnp.float32)
        unit_decay = jnp.array(self._unit_utility_decay, dtype=jnp.float32)
        unit_long_decay = jnp.array(self._unit_long_utility_decay, dtype=jnp.float32)
        unit_gradient_decay = jnp.array(self._unit_gradient_decay, dtype=jnp.float32)
        step_size = jnp.array(self._step_size, dtype=jnp.float32)
        warmup_steps = jnp.array(self._perturbation_warmup_steps, dtype=jnp.float32)
        ramp_steps = jnp.array(self._perturbation_ramp_steps, dtype=jnp.float32)
        use_mean_loss = self._loss_normalization == "mean"
        use_target_density_loss = self._loss_normalization == "target_density"
        use_target_structure_loss = self._loss_normalization == "target_structure"
        use_direct_mse_loss = self._readout_loss_mode in {
            "linear_mse",
            "two_timescale_simplex",
        }
        n_trunk = len(state.trunk_params.weights)
        track_unit_utilities = self._stores_unit_state()
        track_gradient_history = self._stores_gradient_history()

        active_mask = ~jnp.isnan(targets)  # (n_heads,)
        safe_targets = jnp.where(active_mask, targets, 0.0)
        n_active = jnp.maximum(jnp.sum(active_mask.astype(jnp.float32)), 1.0)
        n_nonzero_targets = jnp.maximum(
            jnp.sum(
                jnp.logical_and(active_mask, jnp.abs(safe_targets) > 1e-8).astype(
                    jnp.float32
                )
            ),
            1.0,
        )
        active_targets = jnp.where(active_mask, safe_targets, 0.0)
        target_mass = jnp.sum(jnp.where(active_mask, active_targets, 0.0))
        has_negative_target = jnp.any(
            jnp.logical_and(active_mask, active_targets < -1e-6)
        )
        simplex_like_target = (
            (~has_negative_target)
            & (target_mass > 1e-8)
            & (jnp.abs(target_mass - 1.0) <= 1e-5)
        )
        adaptive_simplex_gate = jnp.where(
            simplex_like_target & (self._n_heads > 1),
            self._adaptive_readout_gate(state.target_repeat_ema),
            0.0,
        )
        slow_simplex_gradient_scale = jnp.array(1.0, dtype=jnp.float32)
        if self._readout_loss_mode == "two_timescale_simplex":
            slow_simplex_gradient_scale = jnp.where(
                simplex_like_target,
                (1.0 - adaptive_simplex_gate)
                + jnp.asarray(
                    self._readout_slow_simplex_gradient_multiplier,
                    dtype=jnp.float32,
                )
                * adaptive_simplex_gate,
                1.0,
            )
        robust_q = jnp.asarray(self._readout_robust_q, dtype=jnp.float32)

        # ---- Loss + gradient -------------------------------------------------
        def loss_and_aux_fn(
            trunk_weights: tuple[Array, ...],
            trunk_biases: tuple[Array, ...],
            head_weights: tuple[Array, ...],
            head_biases: tuple[Array, ...],
        ) -> tuple[Array, tuple[Array, Array]]:
            logits_for_loss, hidden_for_loss = self._forward_with_readout_input(
                trunk_weights,
                trunk_biases,
                head_weights,
                head_biases,
                observation,
                slope,
                ln,
                self._readout_input_mode,
            )
            if not use_direct_mse_loss:
                active_logits = jnp.where(active_mask, logits_for_loss, -1e30)
                base_probs = self._softmax_predictions(active_logits)
                if self._readout_prediction_mode in {
                    "factorized_simplex",
                    "adaptive_factorized_simplex",
                }:
                    adapted_probs = base_probs @ state.readout_label_adapter
                    active_adapted_probs = jnp.where(active_mask, adapted_probs, 0.0)
                    probs = active_adapted_probs / jnp.maximum(
                        jnp.sum(active_adapted_probs),
                        1e-12,
                    )
                else:
                    probs = base_probs
                active_target_mass = jnp.sum(
                    jnp.where(active_mask, jnp.maximum(safe_targets, 0.0), 0.0)
                )
                target_probs = jnp.where(
                    active_mask,
                    jnp.maximum(safe_targets, 0.0)
                    / jnp.maximum(active_target_mass, 1e-12),
                    0.0,
                )
                ce = -jnp.sum(target_probs * jnp.log(probs + 1e-8))
                ce_loss = jnp.where(
                    active_target_mass > 0.0,
                    ce,
                    jnp.array(0.0, dtype=ce.dtype),
                )
                brier = 0.5 * jnp.sum(
                    jnp.where(active_mask, (probs - target_probs) ** 2, 0.0)
                )
                brier_loss = jnp.where(
                    active_target_mass > 0.0,
                    brier,
                    jnp.array(0.0, dtype=brier.dtype),
                )
                target_confidence = jnp.sum(
                    target_probs * (probs ** robust_q)
                )
                gce = (1.0 - target_confidence) / robust_q
                gce_loss = jnp.where(
                    active_target_mass > 0.0,
                    gce,
                    jnp.array(0.0, dtype=gce.dtype),
                )
                preds = logits_for_loss
                sq = (preds - safe_targets) ** 2
                target_loss_weights = jnp.where(
                    safe_targets > 0.0,
                    jnp.asarray(self._positive_target_loss_scale, dtype=jnp.float32),
                    jnp.asarray(self._negative_target_loss_scale, dtype=jnp.float32),
                )
                sq_masked = jnp.where(active_mask, target_loss_weights * sq, 0.0)
                denom = jnp.where(
                    use_mean_loss,
                    n_active,
                    jnp.where(
                        use_target_density_loss,
                        n_nonzero_targets,
                        jnp.where(
                            use_target_structure_loss,
                            jnp.where(simplex_like_target, 1.0, n_active),
                            1.0,
                        ),
                    ),
                )
                mse_loss = 0.5 * jnp.sum(sq_masked) / denom
                if self._readout_loss_mode == "softmax_ce":
                    loss = ce_loss
                elif self._readout_loss_mode == "softmax_mse":
                    loss = jnp.where(simplex_like_target, brier_loss, mse_loss)
                elif self._readout_loss_mode == "gce":
                    loss = jnp.where(simplex_like_target, gce_loss, mse_loss)
                elif self._readout_loss_mode == "adaptive_gce":
                    loss = jnp.where(
                        simplex_like_target,
                        adaptive_simplex_gate * ce_loss
                        + (1.0 - adaptive_simplex_gate) * gce_loss,
                        mse_loss,
                    )
                elif self._readout_loss_mode == "adaptive_factorized_simplex":
                    loss = jnp.where(
                        simplex_like_target,
                        adaptive_simplex_gate * ce_loss
                        + (1.0 - adaptive_simplex_gate) * mse_loss,
                        mse_loss,
                    )
                elif self._readout_loss_mode == "two_timescale_simplex":
                    loss = slow_simplex_gradient_scale * mse_loss
                else:
                    loss = (
                        adaptive_simplex_gate * ce_loss
                        + (1.0 - adaptive_simplex_gate) * mse_loss
                    )
                return loss, (logits_for_loss, hidden_for_loss)
            preds = logits_for_loss
            sq = (preds - safe_targets) ** 2
            target_loss_weights = jnp.where(
                safe_targets > 0.0,
                jnp.asarray(self._positive_target_loss_scale, dtype=jnp.float32),
                jnp.asarray(self._negative_target_loss_scale, dtype=jnp.float32),
            )
            sq_masked = jnp.where(active_mask, target_loss_weights * sq, 0.0)
            denom = jnp.where(
                use_mean_loss,
                n_active,
                jnp.where(
                    use_target_density_loss,
                    n_nonzero_targets,
                    jnp.where(
                        use_target_structure_loss,
                        jnp.where(simplex_like_target, 1.0, n_active),
                        1.0,
                    ),
                ),
            )
            loss = 0.5 * jnp.sum(sq_masked) / denom
            return loss, (logits_for_loss, hidden_for_loss)

        if not use_direct_mse_loss:
            (loss_value, (logits, hidden_for_readout)), grads = jax.value_and_grad(
                loss_and_aux_fn,
                argnums=(0, 1, 2, 3),
                has_aux=True,
            )(
                state.trunk_params.weights,
                state.trunk_params.biases,
                state.head_params.weights,
                state.head_params.biases,
            )
            trunk_w_grads, trunk_b_grads, head_w_grads, head_b_grads = grads
        else:
            def trunk_fn(
                weights: tuple[Array, ...],
                biases: tuple[Array, ...],
            ) -> Array:
                return self._trunk_forward(weights, biases, observation, slope, ln)

            raw_hidden, trunk_vjp_fn = jax.vjp(
                trunk_fn,
                state.trunk_params.weights,
                state.trunk_params.biases,
            )
            hidden_for_readout = raw_hidden
            if self._readout_input_mode == "hidden_plus_input" and n_trunk > 0:
                hidden_for_readout = jnp.concatenate([raw_hidden, observation])
            head_matrix = jnp.concatenate(state.head_params.weights, axis=0)
            head_bias_vector = jnp.concatenate(state.head_params.biases, axis=0)
            logits = head_matrix @ hidden_for_readout + head_bias_vector
            sq = (logits - safe_targets) ** 2
            target_loss_weights = jnp.where(
                safe_targets > 0.0,
                jnp.asarray(self._positive_target_loss_scale, dtype=jnp.float32),
                jnp.asarray(self._negative_target_loss_scale, dtype=jnp.float32),
            )
            sq_masked = jnp.where(active_mask, target_loss_weights * sq, 0.0)
            denom = jnp.where(
                use_mean_loss,
                n_active,
                jnp.where(
                    use_target_density_loss,
                    n_nonzero_targets,
                    jnp.where(
                        use_target_structure_loss,
                        jnp.where(simplex_like_target, 1.0, n_active),
                        1.0,
                    ),
                ),
            )
            loss_value = slow_simplex_gradient_scale * 0.5 * jnp.sum(sq_masked) / denom
            logit_grads = jnp.where(
                active_mask,
                slow_simplex_gradient_scale
                * target_loss_weights
                * (logits - safe_targets)
                / denom,
                0.0,
            )
            head_w_grad_matrix = logit_grads[:, None] * hidden_for_readout[None, :]
            head_w_grads = tuple(
                head_w_grad_matrix[i : i + 1] for i in range(self._n_heads)
            )
            head_b_grads = tuple(
                logit_grads[i : i + 1] for i in range(self._n_heads)
            )
            if self._readout_input_mode == "hidden_plus_input" and n_trunk > 0:
                hidden_dim = raw_hidden.shape[0]
                head_cotangent = head_matrix[:, :hidden_dim].T @ logit_grads
            else:
                head_cotangent = head_matrix.T @ logit_grads
            trunk_w_grads, trunk_b_grads = trunk_vjp_fn(head_cotangent)
        fast_logits = logits
        fast_head_w_grads = tuple(
            jnp.zeros_like(w) for w in state.readout_fast_head_params.weights
        )
        fast_head_b_grads = tuple(
            jnp.zeros_like(b) for b in state.readout_fast_head_params.biases
        )
        if self._readout_prediction_mode == "two_timescale_simplex":
            fast_head_matrix = jnp.concatenate(
                state.readout_fast_head_params.weights,
                axis=0,
            )
            fast_head_bias_vector = jnp.concatenate(
                state.readout_fast_head_params.biases,
                axis=0,
            )
            fast_logits = fast_head_matrix @ hidden_for_readout + fast_head_bias_vector
            active_fast_logits = jnp.where(active_mask, fast_logits, -1e30)
            fast_probs = self._softmax_predictions(active_fast_logits)
            active_target_mass = jnp.sum(
                jnp.where(active_mask, jnp.maximum(safe_targets, 0.0), 0.0)
            )
            fast_target_probs = jnp.where(
                active_mask,
                jnp.maximum(safe_targets, 0.0)
                / jnp.maximum(active_target_mass, 1e-12),
                0.0,
            )
            fast_logit_grads = jnp.where(
                simplex_like_target & active_mask,
                fast_probs - fast_target_probs,
                0.0,
            )
            fast_head_w_grad_matrix = (
                fast_logit_grads[:, None] * hidden_for_readout[None, :]
            )
            fast_head_w_grads = tuple(
                fast_head_w_grad_matrix[i : i + 1] for i in range(self._n_heads)
            )
            fast_head_b_grads = tuple(
                fast_logit_grads[i : i + 1] for i in range(self._n_heads)
            )
            if self._readout_fast_trunk_gradient_multiplier > 0.0:
                fast_head_cotangent = (
                    fast_head_matrix[:, : raw_hidden.shape[0]].T @ fast_logit_grads
                    if self._readout_input_mode == "hidden_plus_input" and n_trunk > 0
                    else fast_head_matrix.T @ fast_logit_grads
                )
                fast_trunk_w_grads, fast_trunk_b_grads = trunk_vjp_fn(
                    fast_head_cotangent
                )
                fast_trunk_scale = (
                    jnp.asarray(
                        self._readout_fast_trunk_gradient_multiplier,
                        dtype=jnp.float32,
                    )
                    * adaptive_simplex_gate
                )
                trunk_w_grads = tuple(
                    g + fast_trunk_scale * fg
                    for g, fg in zip(trunk_w_grads, fast_trunk_w_grads)
                )
                trunk_b_grads = tuple(
                    g + fast_trunk_scale * fg
                    for g, fg in zip(trunk_b_grads, fast_trunk_b_grads)
                )
        predictions = self._prediction_from_logits(
            logits,
            adaptive_simplex_gate,
            state.readout_label_adapter,
            fast_logits,
        )

        sq_for_metric = (predictions - safe_targets) ** 2
        step_mse = jnp.sum(jnp.where(active_mask, sq_for_metric, 0.0)) / n_active
        new_loss_fast_ema = (
            jnp.asarray(self._loss_fast_decay, dtype=jnp.float32) * state.loss_fast_ema
            + (1.0 - jnp.asarray(self._loss_fast_decay, dtype=jnp.float32)) * step_mse
        )
        new_loss_slow_ema = (
            jnp.asarray(self._loss_slow_decay, dtype=jnp.float32) * state.loss_slow_ema
            + (1.0 - jnp.asarray(self._loss_slow_decay, dtype=jnp.float32)) * step_mse
        )
        loss_pressure = jnp.array(1.0, dtype=jnp.float32)
        if self._unit_replacement_loss_gate_ratio > 0.0:
            unit_threshold = jnp.asarray(
                self._unit_replacement_loss_gate_ratio,
                dtype=jnp.float32,
            )
            loss_ratio = new_loss_fast_ema / (new_loss_slow_ema + 1e-12)
            pressure_width = jnp.maximum(unit_threshold - 1.0, 1e-3)
            loss_pressure = jnp.clip(
                (loss_ratio - unit_threshold) / pressure_width,
                0.0,
                1.0,
            )
        head_loss_pressure = jnp.array(0.0, dtype=jnp.float32)
        if (
            self._head_loss_pressure_gate_ratio > 0.0
            and self._head_loss_pressure_multiplier > 0.0
        ):
            head_threshold = jnp.asarray(
                self._head_loss_pressure_gate_ratio,
                dtype=jnp.float32,
            )
            head_ratio = new_loss_fast_ema / (new_loss_slow_ema + 1e-12)
            head_pressure_width = jnp.maximum(head_threshold - 1.0, 1e-3)
            warm = state.step_count >= jnp.asarray(
                self._head_loss_pressure_warmup_steps,
                dtype=jnp.int32,
            )
            head_loss_pressure = jnp.where(
                warm,
                jnp.clip(
                    (head_ratio - head_threshold) / head_pressure_width,
                    0.0,
                    1.0,
                ),
                0.0,
            )
        target_delta = jnp.sum(jnp.abs(safe_targets - state.previous_targets)) / n_active
        repeat_now = target_delta <= jnp.asarray(
            self._head_repetition_delta_threshold,
            dtype=jnp.float32,
        )
        new_target_repeat_ema = (
            jnp.asarray(self._head_repetition_decay, dtype=jnp.float32)
            * state.target_repeat_ema
            + (
                1.0
                - jnp.asarray(self._head_repetition_decay, dtype=jnp.float32)
            )
            * repeat_now.astype(jnp.float32)
        )
        new_target_simplex_ema = (
            jnp.asarray(self._head_repetition_decay, dtype=jnp.float32)
            * state.target_simplex_ema
            + (
                1.0
                - jnp.asarray(self._head_repetition_decay, dtype=jnp.float32)
            )
            * simplex_like_target.astype(jnp.float32)
        )
        repetition_warm = state.step_count >= jnp.asarray(
            self._head_repetition_warmup_steps,
            dtype=jnp.int32,
        )
        repetition_threshold = jnp.asarray(
            self._head_repetition_pressure_threshold,
            dtype=jnp.float32,
        )
        filtered_repetition_pressure = jnp.clip(
            (new_target_repeat_ema - repetition_threshold)
            / jnp.maximum(1.0 - repetition_threshold, 1e-6),
            0.0,
            1.0,
        )
        head_repetition_pressure = jnp.where(
            repetition_warm,
            filtered_repetition_pressure,
            jnp.array(0.0, dtype=jnp.float32),
        )

        # ---- Optional bounding ----------------------------------------------
        # Build per-parameter step magnitudes (step = -lr * grad). Bounder
        # operates on the full step list; we re-split it back afterwards.
        meta_enabled = (
            self._meta_plasticity_mode == "gradient_alignment"
            and self._meta_plasticity_step_size > 0.0
        )
        if meta_enabled:
            trunk_meta_scale = (
                jnp.exp(state.meta_trunk_log_scale)
                if self._meta_plasticity_trunk_enabled
                else jnp.array(1.0, dtype=jnp.float32)
            )
            head_weight_meta_scale = (
                jnp.exp(state.meta_head_weight_log_scale)
                if self._meta_plasticity_head_weight_enabled
                else jnp.array(1.0, dtype=jnp.float32)
            )
            head_bias_meta_scale = (
                jnp.exp(state.meta_head_bias_log_scale)
                if self._meta_plasticity_head_bias_enabled
                else jnp.array(1.0, dtype=jnp.float32)
            )
            repetition_meta_scale = (
                jnp.exp(state.meta_repetition_log_scale)
                if self._meta_plasticity_repetition_enabled
                else jnp.array(1.0, dtype=jnp.float32)
            )
        else:
            trunk_meta_scale = jnp.array(1.0, dtype=jnp.float32)
            head_weight_meta_scale = jnp.array(1.0, dtype=jnp.float32)
            head_bias_meta_scale = jnp.array(1.0, dtype=jnp.float32)
            repetition_meta_scale = jnp.array(1.0, dtype=jnp.float32)

        trunk_w_steps = tuple(-step_size * trunk_meta_scale * g for g in trunk_w_grads)
        trunk_b_steps = tuple(-step_size * trunk_meta_scale * g for g in trunk_b_grads)
        head_scale = jnp.where(self._head_gradient_scale == "active_count", n_active, 1.0)
        head_scale = head_scale * jnp.asarray(
            self._head_step_size_multiplier,
            dtype=jnp.float32,
        )
        head_scale = head_scale * (
            1.0
            + jnp.asarray(
                self._head_loss_pressure_multiplier,
                dtype=jnp.float32,
            )
            * head_loss_pressure
        )
        effective_repetition_multiplier = (
            jnp.asarray(
                self._head_repetition_multiplier,
                dtype=jnp.float32,
            )
            * repetition_meta_scale
        )
        head_scale = head_scale * (
            1.0
            + effective_repetition_multiplier * head_repetition_pressure
        )
        head_w_scale = head_scale * head_weight_meta_scale
        head_b_scale = head_scale * head_bias_meta_scale * jnp.asarray(
            self._head_bias_step_size_multiplier,
            dtype=jnp.float32,
        )
        if self._readout_head_normalization == "hidden_norm":
            norm_scale = 1.0 / (
                1.0 + jnp.sum(jnp.square(hidden_for_readout))
            )
            head_w_scale = head_w_scale * norm_scale
            head_b_scale = head_b_scale * norm_scale
        head_w_steps = tuple(-step_size * head_w_scale * g for g in head_w_grads)
        head_b_steps = tuple(-step_size * head_b_scale * g for g in head_b_grads)
        fast_head_w_scale = head_scale * jnp.asarray(
            self._readout_fast_head_step_size_multiplier,
            dtype=jnp.float32,
        )
        fast_head_b_scale = head_scale * jnp.asarray(
            self._readout_fast_head_bias_step_size_multiplier,
            dtype=jnp.float32,
        )
        if self._readout_head_normalization == "hidden_norm":
            fast_head_w_scale = fast_head_w_scale * norm_scale
            fast_head_b_scale = fast_head_b_scale * norm_scale
        fast_head_w_steps = tuple(
            -step_size * fast_head_w_scale * g for g in fast_head_w_grads
        )
        fast_head_b_steps = tuple(
            -step_size * fast_head_b_scale * g for g in fast_head_b_grads
        )
        bound_fast_readout = self._readout_prediction_mode == "two_timescale_simplex"
        bound_fast_readout_shared = (
            bound_fast_readout and self._readout_fast_head_bounder_mode == "shared"
        )
        bound_fast_readout_separate = (
            bound_fast_readout and self._readout_fast_head_bounder_mode == "separate"
        )

        if self._bounder is not None:
            # Flatten interleaved (w0, b0, w1, b1, ..., head_w0, head_b0, ...)
            all_steps: list[Array] = []
            all_params: list[Array] = []
            for i in range(n_trunk):
                all_steps.append(trunk_w_steps[i])
                all_steps.append(trunk_b_steps[i])
                all_params.append(state.trunk_params.weights[i])
                all_params.append(state.trunk_params.biases[i])
            for i in range(self._n_heads):
                all_steps.append(head_w_steps[i])
                all_steps.append(head_b_steps[i])
                all_params.append(state.head_params.weights[i])
                all_params.append(state.head_params.biases[i])
            if bound_fast_readout_shared:
                for i in range(self._n_heads):
                    all_steps.append(fast_head_w_steps[i])
                    all_steps.append(fast_head_b_steps[i])
                    all_params.append(state.readout_fast_head_params.weights[i])
                    all_params.append(state.readout_fast_head_params.biases[i])

            # Use a representative error scalar: mean absolute error across
            # active heads (matches conventions used elsewhere when bounding
            # outside the per-head error multiplication).
            errors_for_bound = jnp.where(active_mask, predictions - safe_targets, 0.0)
            mean_abs_err = jnp.sum(jnp.abs(errors_for_bound)) / n_active

            if self._adaptive_kappa_mode in {"loss_ratio", "gradient_alignment"}:
                raw_kappa = jnp.asarray(
                    self._adaptive_kappa_base,
                    dtype=jnp.float32,
                )
                if self._adaptive_kappa_mode == "loss_ratio":
                    loss_ratio_for_kappa = new_loss_fast_ema / (
                        new_loss_slow_ema + 1e-12
                    )
                    raw_kappa = raw_kappa / (
                        jnp.maximum(loss_ratio_for_kappa, 1e-6)
                        ** jnp.asarray(
                            self._adaptive_kappa_exponent,
                            dtype=jnp.float32,
                        )
                    )
                if self._adaptive_kappa_meta_step_size > 0.0:
                    raw_kappa = raw_kappa * jnp.exp(state.adaptive_kappa_log_scale)
                effective_kappa = jnp.clip(
                    raw_kappa,
                    jnp.asarray(self._adaptive_kappa_min, dtype=jnp.float32),
                    jnp.asarray(self._adaptive_kappa_max, dtype=jnp.float32),
                )
                effective_kappa = jnp.where(
                    state.step_count
                    >= jnp.asarray(
                        self._adaptive_kappa_warmup_steps,
                        dtype=jnp.int32,
                    ),
                    effective_kappa,
                    jnp.asarray(self._adaptive_kappa_base, dtype=jnp.float32),
                )
                bounded_steps, _scale = self._obgd_bound_with_kappa(
                    tuple(all_steps),
                    mean_abs_err,
                    effective_kappa,
                )
            else:
                bounded_steps, _scale = self._bounder.bound(
                    tuple(all_steps), mean_abs_err, tuple(all_params)
                )
            # Unpack
            idx = 0
            trunk_w_steps = tuple(bounded_steps[idx + 2 * i] for i in range(n_trunk))
            trunk_b_steps = tuple(bounded_steps[idx + 2 * i + 1] for i in range(n_trunk))
            idx = 2 * n_trunk
            head_w_steps = tuple(
                bounded_steps[idx + 2 * i] for i in range(self._n_heads)
            )
            head_b_steps = tuple(
                bounded_steps[idx + 2 * i + 1] for i in range(self._n_heads)
            )
            if bound_fast_readout_shared:
                idx = idx + 2 * self._n_heads
                fast_head_w_steps = tuple(
                    bounded_steps[idx + 2 * i] for i in range(self._n_heads)
                )
                fast_head_b_steps = tuple(
                    bounded_steps[idx + 2 * i + 1] for i in range(self._n_heads)
                )
            if bound_fast_readout_separate:
                fast_steps: list[Array] = []
                fast_params: list[Array] = []
                for i in range(self._n_heads):
                    fast_steps.append(fast_head_w_steps[i])
                    fast_steps.append(fast_head_b_steps[i])
                    fast_params.append(state.readout_fast_head_params.weights[i])
                    fast_params.append(state.readout_fast_head_params.biases[i])
                if self._adaptive_kappa_mode in {"loss_ratio", "gradient_alignment"}:
                    raw_kappa = jnp.asarray(
                        self._adaptive_kappa_base,
                        dtype=jnp.float32,
                    )
                    if self._adaptive_kappa_mode == "loss_ratio":
                        loss_ratio_for_kappa = new_loss_fast_ema / (
                            new_loss_slow_ema + 1e-12
                        )
                        raw_kappa = raw_kappa / (
                            jnp.maximum(loss_ratio_for_kappa, 1e-6)
                            ** jnp.asarray(
                                self._adaptive_kappa_exponent,
                                dtype=jnp.float32,
                            )
                        )
                    if self._adaptive_kappa_meta_step_size > 0.0:
                        raw_kappa = raw_kappa * jnp.exp(state.adaptive_kappa_log_scale)
                    effective_kappa = jnp.clip(
                        raw_kappa,
                        jnp.asarray(self._adaptive_kappa_min, dtype=jnp.float32),
                        jnp.asarray(self._adaptive_kappa_max, dtype=jnp.float32),
                    )
                    effective_kappa = jnp.where(
                        state.step_count
                        >= jnp.asarray(
                            self._adaptive_kappa_warmup_steps,
                            dtype=jnp.int32,
                        ),
                        effective_kappa,
                        jnp.asarray(self._adaptive_kappa_base, dtype=jnp.float32),
                    )
                    bounded_fast_steps, _fast_scale = self._obgd_bound_with_kappa(
                        tuple(fast_steps),
                        mean_abs_err,
                        effective_kappa,
                    )
                else:
                    bounded_fast_steps, _fast_scale = self._bounder.bound(
                        tuple(fast_steps),
                        mean_abs_err,
                        tuple(fast_params),
                    )
                fast_head_w_steps = tuple(
                    bounded_fast_steps[2 * i] for i in range(self._n_heads)
                )
                fast_head_b_steps = tuple(
                    bounded_fast_steps[2 * i + 1] for i in range(self._n_heads)
                )

        # ---- SGD step --------------------------------------------------------
        post_sgd_trunk_weights = tuple(
            state.trunk_params.weights[i] + trunk_w_steps[i] for i in range(n_trunk)
        )
        new_trunk_biases = tuple(
            state.trunk_params.biases[i] + trunk_b_steps[i] for i in range(n_trunk)
        )
        new_head_weights = tuple(
            state.head_params.weights[i] + head_w_steps[i]
            for i in range(self._n_heads)
        )
        new_head_biases = tuple(
            state.head_params.biases[i] + head_b_steps[i]
            for i in range(self._n_heads)
        )
        new_fast_head_weights = tuple(
            state.readout_fast_head_params.weights[i] + fast_head_w_steps[i]
            for i in range(self._n_heads)
        )
        new_fast_head_biases = tuple(
            state.readout_fast_head_params.biases[i] + fast_head_b_steps[i]
            for i in range(self._n_heads)
        )
        new_head_weights_list = list(new_head_weights)
        new_head_biases_list = list(new_head_biases)

        if self._readout_margin_step_size > 0.0 and self._n_heads > 1:
            target_mass = jnp.sum(
                jnp.where(active_mask, jnp.maximum(safe_targets, 0.0), 0.0)
            )
            true_idx = jnp.argmax(
                jnp.where(active_mask, safe_targets, -jnp.inf)
            ).astype(jnp.int32)
            head_indices = jnp.arange(self._n_heads, dtype=jnp.int32)
            wrong_logits = jnp.where(
                jnp.logical_and(active_mask, head_indices != true_idx),
                logits,
                -jnp.inf,
            )
            wrong_idx = jnp.argmax(wrong_logits).astype(jnp.int32)
            margin = logits[true_idx] - logits[wrong_idx]
            do_margin = jnp.logical_and(
                target_mass > 0.0,
                margin < jnp.asarray(self._readout_margin, dtype=jnp.float32),
            )
            margin_scale = (
                jnp.asarray(self._readout_margin_step_size, dtype=jnp.float32)
                / (1.0 + jnp.sum(jnp.square(hidden_for_readout)))
            )
            margin_delta = margin_scale * hidden_for_readout
            bias_delta = jnp.asarray(self._readout_margin_step_size, dtype=jnp.float32)
            for h in range(self._n_heads):
                sign = jnp.where(
                    h == true_idx,
                    jnp.float32(1.0),
                    jnp.where(h == wrong_idx, jnp.float32(-1.0), jnp.float32(0.0)),
                )
                signed = jnp.where(do_margin, sign, jnp.float32(0.0))
                new_head_weights_list[h] = (
                    new_head_weights_list[h] + signed * margin_delta[None, :]
                )
                new_head_biases_list[h] = (
                    new_head_biases_list[h] + signed * bias_delta
                )

        if (
            self._readout_simplex_bias_decay > 0.0
            or self._readout_simplex_bias_centering_rate > 0.0
        ) and self._n_heads > 1:
            bias_vector = jnp.concatenate(new_head_biases_list, axis=0)
            active_bias_mask = active_mask.astype(jnp.float32)
            bias_decay = jnp.asarray(
                self._readout_simplex_bias_decay,
                dtype=jnp.float32,
            )
            decayed_bias_vector = jnp.where(
                active_mask,
                (1.0 - bias_decay) * bias_vector,
                bias_vector,
            )
            active_mean_bias = (
                jnp.sum(active_bias_mask * decayed_bias_vector) / n_active
            )
            centering_rate = jnp.asarray(
                self._readout_simplex_bias_centering_rate,
                dtype=jnp.float32,
            )
            centered_bias_vector = jnp.where(
                active_mask,
                decayed_bias_vector - centering_rate * active_mean_bias,
                decayed_bias_vector,
            )
            do_bias_antidrift = jnp.logical_and(simplex_like_target, n_active > 1.0)
            anti_drift_bias_vector = jnp.where(
                do_bias_antidrift,
                centered_bias_vector,
                bias_vector,
            )
            new_head_biases_list = [
                anti_drift_bias_vector[h : h + 1] for h in range(self._n_heads)
            ]

        new_readout_label_adapter = state.readout_label_adapter
        if (
            self._readout_prediction_mode
            in {"factorized_simplex", "adaptive_factorized_simplex"}
            and self._n_heads > 1
        ):
            adapter_eta = jnp.asarray(
                self._readout_label_adapter_step_size,
                dtype=jnp.float32,
            )
            if self._readout_prediction_mode == "adaptive_factorized_simplex":
                adapter_eta = adapter_eta * adaptive_simplex_gate
            identity_reg = jnp.asarray(
                self._readout_label_adapter_identity_regularization,
                dtype=jnp.float32,
            )
            entropy_reg = jnp.asarray(
                self._readout_label_adapter_entropy_regularization,
                dtype=jnp.float32,
            )
            adapter_floor = jnp.asarray(
                self._readout_label_adapter_floor,
                dtype=jnp.float32,
            )
            base_probs = self._softmax_predictions(logits)
            adapter_error = jnp.where(active_mask, predictions - safe_targets, 0.0)
            adapter_grad = base_probs[:, None] * adapter_error[None, :]
            identity_adapter = jnp.eye(self._n_heads, dtype=jnp.float32)
            adapter_grad = adapter_grad + identity_reg * (
                state.readout_label_adapter - identity_adapter
            )
            if self._readout_label_adapter_entropy_regularization > 0.0:
                adapter_grad = adapter_grad + entropy_reg * (
                    jnp.log(jnp.maximum(state.readout_label_adapter, 1e-12)) + 1.0
                )
            proposed_adapter = state.readout_label_adapter - adapter_eta * adapter_grad
            normalized_adapter = self._normalize_label_adapter(
                proposed_adapter,
                adapter_floor,
            )
            do_adapter_update = (
                simplex_like_target
                & (n_active > 1.0)
                & (adapter_eta > jnp.array(0.0, dtype=jnp.float32))
            )
            new_readout_label_adapter = jnp.where(
                do_adapter_update,
                normalized_adapter,
                state.readout_label_adapter,
            )

        # ---- Utility update --------------------------------------------------
        # u <- decay * u + (1 - decay) * |w * grad|
        # Use the *pre-SGD* weights here (matches Dohare et al.: utility
        # reflects how much the current weights contribute to the loss
        # gradient, not the post-SGD weights).
        new_utilities: list[Array] = []
        new_unit_utilities: list[Array] = []
        new_unit_long_utilities: list[Array] = []
        new_unit_gradient_emas: list[Array] = []
        new_unit_ages: list[Array] = []
        for i in range(n_trunk):
            instantaneous = jnp.abs(state.trunk_params.weights[i] * trunk_w_grads[i])
            u_new = decay * state.utilities[i] + (1.0 - decay) * instantaneous
            new_utilities.append(u_new)

            if track_unit_utilities:
                # Hidden-unit utility is the row-level contribution of the unit's
                # incoming weights. This is cheaper than a second activation-gradient
                # pass and keeps recycling coupled to the same utility signal as
                # UPGD's per-weight plasticity mechanism.
                unit_signal = jnp.mean(instantaneous, axis=1)
                if self._unit_outgoing_utility_weight > 0.0:
                    if i < n_trunk - 1:
                        outgoing = jnp.abs(
                            state.trunk_params.weights[i + 1]
                            * trunk_w_grads[i + 1]
                        )
                        outgoing_signal = jnp.mean(outgoing, axis=0)
                    else:
                        layer_size = state.trunk_params.weights[i].shape[0]
                        outgoing_signal = jnp.mean(
                            jnp.stack(
                                [
                                    jnp.abs(
                                        state.head_params.weights[h][:, :layer_size]
                                        * head_w_grads[h][:, :layer_size]
                                    )[0]
                                    for h in range(self._n_heads)
                                ]
                            ),
                            axis=0,
                        )
                    unit_signal = unit_signal + (
                        jnp.asarray(
                            self._unit_outgoing_utility_weight,
                            dtype=jnp.float32,
                        )
                        * outgoing_signal
                    )
                new_unit_utilities.append(
                    unit_decay * state.unit_utilities[i]
                    + (1.0 - unit_decay) * unit_signal
                )
                new_unit_long_utilities.append(
                    unit_long_decay * state.unit_long_utilities[i]
                    + (1.0 - unit_long_decay) * unit_signal
                )
                unit_gradient_signal = jnp.mean(jnp.abs(trunk_w_grads[i]), axis=1)
                new_unit_gradient_emas.append(
                    unit_gradient_decay * state.unit_gradient_emas[i]
                    + (1.0 - unit_gradient_decay) * unit_gradient_signal
                )
                new_unit_ages.append(state.unit_ages[i] + 1)
            elif len(state.unit_utilities) > 0:
                new_unit_utilities.append(state.unit_utilities[i])
                new_unit_long_utilities.append(state.unit_long_utilities[i])
                new_unit_gradient_emas.append(state.unit_gradient_emas[i])
                new_unit_ages.append(state.unit_ages[i])

        # ---- Perturbation ----------------------------------------------------
        # Apply every `perturbation_interval` steps. Skip on step 0 because
        # utilities are still all zero (would maximally perturb every weight).
        do_perturb = jnp.logical_and(
            state.step_count > 0,
            (state.step_count % self._perturbation_interval) == 0,
        )
        after_warmup = state.step_count >= self._perturbation_warmup_steps
        ramp_progress = jnp.where(
            ramp_steps > 0.0,
            (state.step_count.astype(jnp.float32) - warmup_steps + 1.0)
            / jnp.maximum(ramp_steps, 1.0),
            1.0,
        )
        schedule_scale = jnp.where(
            after_warmup,
            jnp.clip(ramp_progress, 0.0, 1.0),
            0.0,
        )
        effective_sigma = sigma * schedule_scale

        new_key = state.key
        eps = jnp.array(1e-12, dtype=jnp.float32)
        max_perturbation_magnitude = jnp.array(0.0, dtype=jnp.float32)
        new_trunk_weights: list[Array]
        if self._perturbation_sigma == 0.0 or n_trunk == 0:
            new_trunk_weights = list(post_sgd_trunk_weights)
        else:
            new_trunk_weights = []

            for i in range(n_trunk):
                u_i = new_utilities[i]
                u_max = jnp.max(u_i) + eps
                u_norm = u_i / u_max
                scale = effective_sigma * jnp.power(
                    jnp.maximum(1.0 - u_norm, 0.0),
                    beta,
                )

                def perturb_branch(key: Array) -> tuple[Array, tuple[Array, Array]]:
                    next_key, subkey = jr.split(key)
                    if self._perturbation_noise == "rademacher":
                        noise = jr.rademacher(subkey, u_i.shape, dtype=jnp.float32)
                    else:
                        noise = jr.normal(subkey, u_i.shape, dtype=jnp.float32)
                    perturbation = scale * noise
                    return next_key, (
                        post_sgd_trunk_weights[i] + perturbation,
                        jnp.max(jnp.abs(perturbation)),
                    )

                def skip_branch(key: Array) -> tuple[Array, tuple[Array, Array]]:
                    return key, (
                        post_sgd_trunk_weights[i],
                        jnp.array(0.0, dtype=jnp.float32),
                    )

                new_key, (new_w, layer_perturbation_magnitude) = jax.lax.cond(
                    do_perturb,
                    perturb_branch,
                    skip_branch,
                    new_key,
                )
                new_trunk_weights.append(new_w)
                max_perturbation_magnitude = jnp.maximum(
                    max_perturbation_magnitude,
                    layer_perturbation_magnitude,
                )

        new_trunk_biases_list = list(new_trunk_biases)
        new_accumulators: list[Array] = list(state.unit_replacement_accumulators)
        unit_replacement_counts = state.unit_replacement_counts
        if unit_replacement_counts is None:
            unit_replacement_counts = jnp.zeros(
                len(state.unit_utilities),
                dtype=jnp.float32,
            )
        new_replacement_counts: list[Array] = list(unit_replacement_counts)

        def _replacement_row(
            key: Array,
            fan_in: int,
            fanin_signal: Array,
        ) -> Array:
            if self._unit_replacement_fanin == "gradient_columns":
                keep_count = max(
                    1,
                    min(fan_in, int(round((1.0 - self._sparsity) * fan_in))),
                )
                value_key, gumbel_key = jr.split(key)
                scale = 1.0 / jnp.sqrt(jnp.asarray(fan_in, dtype=jnp.float32))
                values = jr.uniform(
                    value_key,
                    (fan_in,),
                    dtype=jnp.float32,
                    minval=-scale,
                    maxval=scale,
                )
                noisy_scores = jnp.log(fanin_signal + 1e-8) + jr.gumbel(
                    gumbel_key,
                    (fan_in,),
                    dtype=jnp.float32,
                )
                top_idx = jax.lax.top_k(noisy_scores, keep_count)[1]
                mask = jnp.zeros((fan_in,), dtype=jnp.float32).at[top_idx].set(1.0)
                return values * mask
            return sparse_init(key, (1, fan_in), sparsity=self._sparsity)[0]

        # ---- Optional hidden-unit recycling ---------------------------------
        # Recycle only mature low-utility units. Optional preservation and
        # partial fan-in rewiring let a stale feature adapt without destroying
        # all output-side class-discriminative structure.
        if self._unit_replacement_rate > 0.0 and n_trunk > 0:
            rate = jnp.array(self._unit_replacement_rate, dtype=jnp.float32)
            maturity = jnp.array(self._unit_maturity_threshold, dtype=jnp.int32)
            new_accumulators = []
            new_replacement_counts = []
            for i in range(n_trunk):
                layer_size = new_unit_utilities[i].shape[0]
                layer_size_f = jnp.array(layer_size, dtype=jnp.float32)

                mature = new_unit_ages[i] >= maturity
                if self._unit_replacement_criterion == "stale_gradient_ratio":
                    util_norm = new_unit_long_utilities[i] / (
                        jnp.mean(new_unit_long_utilities[i]) + 1e-12
                    )
                    grad_norm = new_unit_gradient_emas[i] / (
                        jnp.mean(new_unit_gradient_emas[i]) + 1e-12
                    )
                    selection_score = grad_norm / (util_norm + 0.05)
                elif self._unit_replacement_criterion == "low_long_and_gradient":
                    util_norm = new_unit_long_utilities[i] / (
                        jnp.mean(new_unit_long_utilities[i]) + 1e-12
                    )
                    grad_norm = new_unit_gradient_emas[i] / (
                        jnp.mean(new_unit_gradient_emas[i]) + 1e-12
                    )
                    selection_score = jnp.maximum(util_norm, grad_norm)
                else:
                    selection_score = new_unit_utilities[i]

                masked_utility = jnp.where(mature, selection_score, jnp.inf)
                has_candidate = jnp.any(mature)
                unit_idx = jnp.argmin(masked_utility).astype(jnp.int32)
                selected_score = selection_score[unit_idx]
                if self._unit_replacement_score_threshold > 0.0:
                    score_gate = selected_score <= jnp.asarray(
                        self._unit_replacement_score_threshold,
                        dtype=jnp.float32,
                    )
                else:
                    score_gate = jnp.array(True)
                if self._unit_replacement_loss_gate_ratio > 0.0:
                    loss_gate = new_loss_fast_ema > (
                        new_loss_slow_ema
                        * jnp.asarray(
                            self._unit_replacement_loss_gate_ratio,
                            dtype=jnp.float32,
                        )
                    )
                else:
                    loss_gate = jnp.array(True)
                gated = jnp.logical_and(
                    jnp.logical_and(
                        loss_gate,
                        has_candidate,
                    ),
                    score_gate,
                )
                if self._unit_replacement_budget_mode == "gated":
                    rate_scale = gated.astype(jnp.float32)
                elif self._unit_replacement_budget_mode == "loss_pressure":
                    rate_scale = jnp.where(
                        jnp.logical_and(has_candidate, score_gate),
                        loss_pressure,
                        0.0,
                    )
                else:
                    rate_scale = jnp.array(1.0, dtype=jnp.float32)
                accum = (
                    state.unit_replacement_accumulators[i]
                    + rate * layer_size_f * rate_scale
                )
                do_replace = accum >= 1.0
                gated = jnp.logical_and(
                    jnp.logical_and(
                        jnp.logical_and(do_replace, has_candidate),
                        loss_gate,
                    ),
                    score_gate,
                )

                new_key, subkey = jr.split(new_key)
                layer_w = new_trunk_weights[i]
                fanin_signal = jnp.mean(jnp.abs(trunk_w_grads[i]), axis=0)
                sampled = _replacement_row(
                    subkey,
                    layer_w.shape[1],
                    fanin_signal,
                )
                if self._unit_replacement_partial_fanin > 0:
                    replace_count = min(
                        layer_w.shape[1],
                        self._unit_replacement_partial_fanin,
                    )
                    utility_scores = new_utilities[i][unit_idx]
                    bottom_idx = jax.lax.top_k(-utility_scores, replace_count)[1]
                    partial_mask = jnp.zeros(
                        (layer_w.shape[1],),
                        dtype=jnp.float32,
                    ).at[bottom_idx].set(1.0)
                    sampled = jnp.where(
                        partial_mask > 0.0,
                        sampled,
                        layer_w[unit_idx],
                    )
                else:
                    partial_mask = jnp.ones((layer_w.shape[1],), dtype=jnp.float32)
                new_row = jnp.where(gated, sampled, layer_w[unit_idx])
                new_trunk_weights[i] = layer_w.at[unit_idx].set(new_row)

                layer_b = new_trunk_biases_list[i]
                replacement_b = jnp.where(
                    self._unit_replacement_partial_fanin > 0,
                    layer_b[unit_idx],
                    jnp.float32(0.0),
                )
                new_b = jnp.where(gated, replacement_b, layer_b[unit_idx])
                new_trunk_biases_list[i] = layer_b.at[unit_idx].set(new_b)

                utility_row = new_utilities[i]
                replacement_utility_row = jnp.where(
                    partial_mask > 0.0,
                    jnp.zeros_like(utility_row[unit_idx]),
                    utility_row[unit_idx],
                )
                new_utilities[i] = utility_row.at[unit_idx].set(
                    jnp.where(gated, replacement_utility_row, utility_row[unit_idx])
                )

                outgoing_scale = jnp.asarray(
                    self._unit_replacement_outgoing_scale,
                    dtype=jnp.float32,
                )
                if i < n_trunk - 1:
                    next_w = new_trunk_weights[i + 1]
                    replacement_col = outgoing_scale * next_w[:, unit_idx]
                    new_col = jnp.where(gated, replacement_col, next_w[:, unit_idx])
                    new_trunk_weights[i + 1] = next_w.at[:, unit_idx].set(new_col)

                    next_u = new_utilities[i + 1]
                    replacement_util_col = outgoing_scale * next_u[:, unit_idx]
                    new_util_col = jnp.where(
                        gated,
                        replacement_util_col,
                        next_u[:, unit_idx],
                    )
                    new_utilities[i + 1] = next_u.at[:, unit_idx].set(new_util_col)
                else:
                    for h in range(self._n_heads):
                        head_w = new_head_weights_list[h]
                        replacement_col = outgoing_scale * head_w[:, unit_idx]
                        new_col = jnp.where(gated, replacement_col, head_w[:, unit_idx])
                        new_head_weights_list[h] = head_w.at[:, unit_idx].set(new_col)

                unit_util = new_unit_utilities[i]
                unit_long_util = new_unit_long_utilities[i]
                unit_gradient_ema = new_unit_gradient_emas[i]
                unit_age = new_unit_ages[i]
                new_unit_utilities[i] = unit_util.at[unit_idx].set(
                    jnp.where(gated, jnp.float32(0.0), unit_util[unit_idx])
                )
                new_unit_long_utilities[i] = unit_long_util.at[unit_idx].set(
                    jnp.where(gated, jnp.float32(0.0), unit_long_util[unit_idx])
                )
                new_unit_gradient_emas[i] = unit_gradient_ema.at[unit_idx].set(
                    jnp.where(gated, jnp.float32(0.0), unit_gradient_ema[unit_idx])
                )
                new_unit_ages[i] = unit_age.at[unit_idx].set(
                    jnp.where(gated, jnp.int32(0), unit_age[unit_idx])
                )
                new_accumulators.append(jnp.where(gated, accum - 1.0, accum))
                new_replacement_counts.append(
                    unit_replacement_counts[i] + gated.astype(jnp.float32)
                )
        # When there are no hidden layers, utilities is empty.
        if n_trunk == 0:
            mean_utility = jnp.array(0.0, dtype=jnp.float32)
            min_utility = jnp.array(0.0, dtype=jnp.float32)
        else:
            mean_utility = jnp.mean(jnp.stack([jnp.mean(u) for u in new_utilities]))
            min_utility = jnp.min(jnp.stack([jnp.min(u) for u in new_utilities]))

        new_trunk_params = MLPParams(  # type: ignore[call-arg]
            weights=tuple(new_trunk_weights),
            biases=tuple(new_trunk_biases_list),
        )
        new_head_params = MLPParams(  # type: ignore[call-arg]
            weights=tuple(new_head_weights_list),
            biases=tuple(new_head_biases_list),
        )
        new_fast_head_params = MLPParams(  # type: ignore[call-arg]
            weights=new_fast_head_weights,
            biases=new_fast_head_biases,
        )

        # Errors: NaN for inactive heads (matches MultiHeadMLP convention).
        raw_errors = safe_targets - predictions
        errors = jnp.where(active_mask, raw_errors, jnp.nan)

        new_meta_trunk_log_scale = state.meta_trunk_log_scale
        new_meta_head_weight_log_scale = state.meta_head_weight_log_scale
        new_meta_head_bias_log_scale = state.meta_head_bias_log_scale
        new_meta_repetition_log_scale = state.meta_repetition_log_scale
        new_adaptive_kappa_log_scale = state.adaptive_kappa_log_scale
        if (
            self._adaptive_kappa_mode in {"loss_ratio", "gradient_alignment"}
            and self._adaptive_kappa_meta_step_size > 0.0
        ):
            kappa_meta_eta = jnp.asarray(
                self._adaptive_kappa_meta_step_size,
                dtype=jnp.float32,
            )
            kappa_min_log = jnp.log(
                jnp.asarray(
                    self._adaptive_kappa_meta_min_multiplier,
                    dtype=jnp.float32,
                )
            )
            kappa_max_log = jnp.log(
                jnp.asarray(
                    self._adaptive_kappa_meta_max_multiplier,
                    dtype=jnp.float32,
                )
            )
            kappa_meta_warm = state.step_count >= jnp.asarray(
                self._adaptive_kappa_meta_warmup_steps,
                dtype=jnp.int32,
            )
            global_alignment = self._gradient_alignment(
                state.previous_trunk_weight_grads
                + state.previous_trunk_bias_grads
                + state.previous_head_weight_grads
                + state.previous_head_bias_grads,
                trunk_w_grads + trunk_b_grads + head_w_grads + head_b_grads,
            )
            updated_kappa_log_scale = jnp.clip(
                state.adaptive_kappa_log_scale
                - kappa_meta_eta * global_alignment,
                kappa_min_log,
                kappa_max_log,
            )
            new_adaptive_kappa_log_scale = jnp.where(
                kappa_meta_warm,
                updated_kappa_log_scale,
                state.adaptive_kappa_log_scale,
            )
        if meta_enabled:
            meta_eta = jnp.asarray(self._meta_plasticity_step_size, dtype=jnp.float32)
            min_log = jnp.log(
                jnp.asarray(
                    self._meta_plasticity_min_multiplier,
                    dtype=jnp.float32,
                )
            )
            max_log = jnp.log(
                jnp.asarray(
                    self._meta_plasticity_max_multiplier,
                    dtype=jnp.float32,
                )
            )
            meta_warm = state.step_count >= jnp.asarray(
                self._meta_plasticity_warmup_steps,
                dtype=jnp.int32,
            )

            def update_log_scale(log_scale: Array, signal: Array) -> Array:
                updated = jnp.clip(log_scale + meta_eta * signal, min_log, max_log)
                return jnp.where(meta_warm, updated, log_scale)

            trunk_alignment = self._gradient_alignment(
                state.previous_trunk_weight_grads + state.previous_trunk_bias_grads,
                trunk_w_grads + trunk_b_grads,
            )
            head_weight_alignment = self._gradient_alignment(
                state.previous_head_weight_grads,
                head_w_grads,
            )
            head_bias_alignment = self._gradient_alignment(
                state.previous_head_bias_grads,
                head_b_grads,
            )
            repetition_alignment = head_weight_alignment * head_repetition_pressure

            if self._meta_plasticity_trunk_enabled:
                new_meta_trunk_log_scale = update_log_scale(
                    state.meta_trunk_log_scale,
                    trunk_alignment,
                )
            if self._meta_plasticity_head_weight_enabled:
                new_meta_head_weight_log_scale = update_log_scale(
                    state.meta_head_weight_log_scale,
                    head_weight_alignment,
                )
            if self._meta_plasticity_head_bias_enabled:
                new_meta_head_bias_log_scale = update_log_scale(
                    state.meta_head_bias_log_scale,
                    head_bias_alignment,
                )
            if self._meta_plasticity_repetition_enabled:
                new_meta_repetition_log_scale = update_log_scale(
                    state.meta_repetition_log_scale,
                    repetition_alignment,
                )

        if track_gradient_history:
            next_previous_trunk_weight_grads = trunk_w_grads
            next_previous_trunk_bias_grads = trunk_b_grads
            next_previous_head_weight_grads = head_w_grads
            next_previous_head_bias_grads = head_b_grads
        else:
            next_previous_trunk_weight_grads = state.previous_trunk_weight_grads
            next_previous_trunk_bias_grads = state.previous_trunk_bias_grads
            next_previous_head_weight_grads = state.previous_head_weight_grads
            next_previous_head_bias_grads = state.previous_head_bias_grads

        new_state = UPGDState(  # type: ignore[call-arg]
            trunk_params=new_trunk_params,
            head_params=new_head_params,
            readout_fast_head_params=new_fast_head_params,
            readout_label_adapter=new_readout_label_adapter,
            utilities=tuple(new_utilities),
            unit_utilities=tuple(new_unit_utilities),
            unit_long_utilities=tuple(new_unit_long_utilities),
            unit_gradient_emas=tuple(new_unit_gradient_emas),
            unit_ages=tuple(new_unit_ages),
            unit_replacement_counts=jnp.asarray(
                new_replacement_counts,
                dtype=jnp.float32,
            ),
            unit_replacement_accumulators=jnp.asarray(
                new_accumulators,
                dtype=jnp.float32,
            ),
            loss_fast_ema=new_loss_fast_ema,
            loss_slow_ema=new_loss_slow_ema,
            previous_targets=safe_targets,
            target_repeat_ema=new_target_repeat_ema,
            target_simplex_ema=new_target_simplex_ema,
            meta_trunk_log_scale=new_meta_trunk_log_scale,
            meta_head_weight_log_scale=new_meta_head_weight_log_scale,
            meta_head_bias_log_scale=new_meta_head_bias_log_scale,
            meta_repetition_log_scale=new_meta_repetition_log_scale,
            adaptive_kappa_log_scale=new_adaptive_kappa_log_scale,
            previous_trunk_weight_grads=next_previous_trunk_weight_grads,
            previous_trunk_bias_grads=next_previous_trunk_bias_grads,
            previous_head_weight_grads=next_previous_head_weight_grads,
            previous_head_bias_grads=next_previous_head_bias_grads,
            key=new_key,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        metrics = jnp.stack(
            [loss_value, mean_utility, min_utility, max_perturbation_magnitude]
        )

        return UPGDUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            predictions=predictions,
            errors=errors,
            metrics=metrics,
        )


# =============================================================================
# Loops
# =============================================================================


def run_upgd_arrays(
    learner: UPGDLearner,
    state: UPGDState,
    observations: Float[Array, "num_steps feature_dim"],
    targets: Float[Array, "num_steps n_heads"],
) -> UPGDLearningResult:
    """Run a UPGD learning loop over pre-collected arrays via ``jax.lax.scan``.

    Args:
        learner: UPGD learner
        state: Initial UPGD state
        observations: Input observations, shape ``(num_steps, feature_dim)``
        targets: Per-head targets, shape ``(num_steps, n_heads)``.
            NaN entries mark inactive heads for that step.

    Returns:
        :class:`UPGDLearningResult` with the final state and the per-step
        4-column metrics array.
    """

    def step_fn(
        carry: UPGDState, inputs: tuple[Array, Array]
    ) -> tuple[UPGDState, Array]:
        obs, tgt = inputs
        result = learner.update(carry, obs, tgt)
        return result.state, result.metrics

    t0 = time.time()
    final_state, metrics = jax.lax.scan(step_fn, state, (observations, targets))
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]
    return UPGDLearningResult(state=final_state, metrics=metrics)  # type: ignore[call-arg]


def run_upgd_loop[StreamStateT](
    learner: UPGDLearner,
    stream: Any,  # ScanStream[StreamStateT]; loose typing avoids a Protocol import cost
    num_steps: int,
    key: Array,
    learner_state: UPGDState | None = None,
) -> UPGDLearningResult:
    """Run a UPGD learning loop driven by a :class:`ScanStream` via ``jax.lax.scan``.

    The stream emits :class:`TimeStep` with a 1D ``target``; it is broadcast
    across all heads (every head sees the same target). For multi-task
    streams that already produce ``(n_heads,)`` targets, prefer
    :func:`run_upgd_arrays`.

    Args:
        learner: UPGD learner
        stream: Experience stream (must implement the ScanStream protocol)
        num_steps: Number of learning steps
        key: JAX random key for stream and (if needed) learner init
        learner_state: Optional pre-initialized state. When None, the stream's
            ``feature_dim`` is used to initialize one.

    Returns:
        :class:`UPGDLearningResult` with the final state and the per-step
        4-column metrics array.
    """
    stream_key, init_key = jax.random.split(key)
    if learner_state is None:
        learner_state = learner.init(stream.feature_dim, init_key)
    stream_state = stream.init(stream_key)

    n_heads = learner.n_heads

    def step_fn(
        carry: tuple[UPGDState, Any], idx: Array
    ) -> tuple[tuple[UPGDState, Any], Array]:
        l_state, s_state = carry
        timestep, new_s_state = stream.step(s_state, idx)
        # Broadcast scalar/single-element target across heads.
        tgt = jnp.broadcast_to(jnp.squeeze(timestep.target), (n_heads,))
        result = learner.update(l_state, timestep.observation, tgt)
        return (result.state, new_s_state), result.metrics

    t0 = time.time()
    (final_learner, _), metrics = jax.lax.scan(
        step_fn, (learner_state, stream_state), jnp.arange(num_steps)
    )
    elapsed = time.time() - t0
    final_learner = final_learner.replace(uptime_s=final_learner.uptime_s + elapsed)  # type: ignore[attr-defined]
    return UPGDLearningResult(  # type: ignore[call-arg]
        state=final_learner, metrics=metrics
    )
