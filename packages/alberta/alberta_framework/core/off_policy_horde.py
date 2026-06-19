"""Off-policy nonlinear Horde backend for Step 3.

This module adds a JAX/scan-compatible Horde-style learner that accepts one
importance-sampling ratio per demon on every transition.  The implemented
backend is a stable first nonlinear backend: clipped, per-demon, weighted
semi-gradient TD with a shared nonlinear trunk and per-head traces.  It is not
full Gradient-TD/GQ/TDC; those algorithms require secondary weights and MSPBE
correction terms that are still separate from this shared-trunk backend.
"""

from __future__ import annotations

import functools
import time
from typing import Any, cast

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float

from alberta_framework.core.multi_head_learner import (
    AnyOptimizer,
    MultiHeadMLPLearner,
    MultiHeadMLPState,
)
from alberta_framework.core.normalizers import (
    EMANormalizerState,
    Normalizer,
    WelfordNormalizerState,
)
from alberta_framework.core.optimizers import LMS, Bounder
from alberta_framework.core.types import HordeSpec, MLPParams, TraceMode


def _extract_mean_step_size(opt_state: Any) -> Array:
    """Extract a scalar mean step-size from an optimizer state."""
    if hasattr(opt_state, "step_sizes"):
        return jnp.mean(opt_state.step_sizes)
    if hasattr(opt_state, "log_step_sizes"):
        return jnp.mean(jnp.exp(opt_state.log_step_sizes))
    if hasattr(opt_state, "step_size"):
        return jnp.asarray(opt_state.step_size, dtype=jnp.float32)
    return jnp.array(0.0, dtype=jnp.float32)


@chex.dataclass(frozen=True)
class OffPolicyHordeUpdateResult:
    """Result of one off-policy Horde update.

    Attributes:
        state: Updated shared-trunk multi-head learner state.
        predictions: Predictions at ``s_t``, shape ``(n_demons,)``.
        next_predictions: Bootstrap predictions at ``s_{t+1}``.
        td_targets: TD targets ``c_t + gamma_t V(s_{t+1})``.
        td_errors: Unweighted TD errors.
        rhos: Raw importance-sampling ratios.
        clipped_rhos: Ratios after update clipping.
        trace_coefficients: Ratios after trace clipping.
        per_demon_metrics: Shape ``(n_demons, 6)`` with columns
            ``[squared_td_error, td_error, rho, clipped_rho, trace_coeff,
            mean_step_size]``.
        trunk_bounding_metric: Scalar metric returned by the bounder.
    """

    state: MultiHeadMLPState
    predictions: Float[Array, " n_demons"]
    next_predictions: Float[Array, " n_demons"]
    td_targets: Float[Array, " n_demons"]
    td_errors: Float[Array, " n_demons"]
    rhos: Float[Array, " n_demons"]
    clipped_rhos: Float[Array, " n_demons"]
    trace_coefficients: Float[Array, " n_demons"]
    per_demon_metrics: Float[Array, "n_demons 6"]
    trunk_bounding_metric: Float[Array, ""]


@chex.dataclass(frozen=True)
class OffPolicyHordeLearningResult:
    """Result from a scan-based off-policy Horde learning loop."""

    state: MultiHeadMLPState
    per_demon_metrics: Float[Array, "num_steps n_demons 6"]
    td_errors: Float[Array, "num_steps n_demons"]
    clipped_rhos: Float[Array, "num_steps n_demons"]


@chex.dataclass(frozen=True)
class NonlinearSharedGTDHordeState:
    """State for a single-hidden-layer shared-trunk Gradient-TD Horde.

    The secondary weights are stored per demon and match the nonzero gradient
    support for that demon: shared trunk parameters plus that demon's output
    head. This is the corrected off-policy backend; unlike
    :class:`OffPolicyHordeLearner`, it carries secondary weights.
    """

    trunk_w: Float[Array, "hidden_dim feature_dim"]
    trunk_b: Float[Array, " hidden_dim"]
    head_w: Float[Array, "n_demons hidden_dim"]
    head_b: Float[Array, " n_demons"]
    secondary_trunk_w: Float[Array, "n_demons hidden_dim feature_dim"]
    secondary_trunk_b: Float[Array, "n_demons hidden_dim"]
    secondary_head_w: Float[Array, "n_demons hidden_dim"]
    secondary_head_b: Float[Array, " n_demons"]
    step_count: Float[Array, ""]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class NonlinearSharedGTDHordeUpdateResult:
    """Result from one corrected nonlinear shared-trunk off-policy update."""

    state: NonlinearSharedGTDHordeState
    predictions: Float[Array, " n_demons"]
    next_predictions: Float[Array, " n_demons"]
    td_targets: Float[Array, " n_demons"]
    td_errors: Float[Array, " n_demons"]
    clipped_rhos: Float[Array, " n_demons"]
    correction_norms: Float[Array, " n_demons"]
    secondary_norms: Float[Array, " n_demons"]


@chex.dataclass(frozen=True)
class NonlinearSharedGTDHordeLearningResult:
    """Scan result for corrected nonlinear shared-trunk off-policy Horde."""

    state: NonlinearSharedGTDHordeState
    td_errors: Float[Array, "num_steps n_demons"]
    clipped_rhos: Float[Array, "num_steps n_demons"]
    correction_norms: Float[Array, "num_steps n_demons"]
    secondary_norms: Float[Array, "num_steps n_demons"]


class OffPolicyHordeLearner:
    """Nonlinear off-policy Horde with per-demon importance ratios.

    The update is a clipped off-policy semi-gradient TD backend:

    ``delta_i = c_i + gamma_i V_i(s') - V_i(s)``

    ``effective_error_i = min(rho_i, ratio_clip) * delta_i``

    The shared trunk receives the summed current-step cotangent
    ``sum_i effective_error_i grad_h V_i(s)``.  Per-head traces use
    ``gamma_i * lambda_i * min(rho_i, trace_ratio_clip)`` as the transition
    trace coefficient.  This keeps the nonlinear shared trunk on the same
    conservative footing as ``HordeLearner`` while making head traces and all
    demon updates ratio-aware.

    Full GTD/GQ/TDC MSPBE correction is intentionally out of scope for this
    first backend because it requires secondary weights and a different
    objective.  See ``docs/research/step3_off_policy_horde.md`` for the exact
    boundary.
    """

    def __init__(
        self,
        horde_spec: HordeSpec,
        hidden_sizes: tuple[int, ...] = (128, 128),
        optimizer: AnyOptimizer | None = None,
        step_size: float = 0.01,
        bounder: Bounder | None = None,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        head_optimizer: AnyOptimizer | None = None,
        trace_mode: TraceMode = TraceMode.ACCUMULATING,
        utility_decay: float = 0.99,
        ratio_clip: float = 1.0,
        trace_ratio_clip: float = 1.0,
        min_behavior_probability: float = 1e-6,
    ):
        """Initialize an off-policy Horde backend.

        Args:
            horde_spec: GVF metadata, one demon per head.
            hidden_sizes: Shared trunk hidden sizes. ``()`` gives linear heads.
            optimizer: Optimizer for trunk and heads unless ``head_optimizer``
                is provided.
            step_size: LMS step-size used when ``optimizer`` is omitted.
            bounder: Optional update bounder.
            normalizer: Optional online input normalizer.
            sparsity: Sparse initialization fraction.
            leaky_relu_slope: LeakyReLU negative slope.
            use_layer_norm: Whether the trunk uses parameterless layer norm.
            head_optimizer: Optional separate output-head optimizer.
            trace_mode: Accumulating or replacing head traces.
            utility_decay: Hidden-unit utility EMA decay.
            ratio_clip: Clip for the current TD update ratio.
            trace_ratio_clip: Clip for the eligibility-trace ratio.
            min_behavior_probability: Denominator floor for probability API.
        """
        if ratio_clip <= 0.0:
            raise ValueError(f"ratio_clip must be positive; got {ratio_clip}")
        if trace_ratio_clip <= 0.0:
            raise ValueError(
                f"trace_ratio_clip must be positive; got {trace_ratio_clip}"
            )
        if min_behavior_probability <= 0.0:
            raise ValueError(
                "min_behavior_probability must be positive; "
                f"got {min_behavior_probability}"
            )

        self._horde_spec = horde_spec
        self._hidden_sizes = hidden_sizes
        self._optimizer: AnyOptimizer = optimizer or LMS(step_size=step_size)
        self._head_optimizer = head_optimizer
        self._bounder = bounder
        self._normalizer = normalizer
        self._sparsity = sparsity
        self._leaky_relu_slope = leaky_relu_slope
        self._use_layer_norm = use_layer_norm
        self._trace_mode = trace_mode
        self._utility_decay = utility_decay
        self._ratio_clip = ratio_clip
        self._trace_ratio_clip = trace_ratio_clip
        self._min_behavior_probability = min_behavior_probability

        # The wrapped learner supplies initialization, prediction, optimizer
        # states, normalizer state, and MLP forward utilities.  This backend
        # owns the update rule because off-policy ratios are transition-local.
        self._learner = MultiHeadMLPLearner(
            n_heads=len(horde_spec.demons),
            hidden_sizes=hidden_sizes,
            optimizer=self._optimizer,
            step_size=step_size,
            bounder=bounder,
            gamma=0.0,
            lamda=0.0,
            normalizer=normalizer,
            sparsity=sparsity,
            leaky_relu_slope=leaky_relu_slope,
            use_layer_norm=use_layer_norm,
            head_optimizer=head_optimizer,
            per_head_gamma_lamda=tuple(0.0 for _ in horde_spec.demons),
            trace_mode=trace_mode,
            utility_decay=utility_decay,
        )

    @property
    def horde_spec(self) -> HordeSpec:
        """The GVF specification."""
        return self._horde_spec

    @property
    def n_demons(self) -> int:
        """Number of demons."""
        return len(self._horde_spec.demons)

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """Underlying multi-head MLP learner used for init/predict."""
        return self._learner

    @property
    def ratio_clip(self) -> float:
        """Current-step update ratio clip."""
        return self._ratio_clip

    @property
    def trace_ratio_clip(self) -> float:
        """Eligibility-trace ratio clip."""
        return self._trace_ratio_clip

    def init(self, feature_dim: int, key: Array) -> MultiHeadMLPState:
        """Initialize learner state."""
        return self._learner.init(feature_dim, key)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: MultiHeadMLPState, observation: Array) -> Array:
        """Predict all demon values for one observation."""
        return self._learner.predict(state, observation)  # type: ignore[no-any-return]


    def update(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        rhos: Array,
    ) -> OffPolicyHordeUpdateResult:
        """Alias for :meth:`update_with_ratios`."""
        return self.update_with_ratios(
            state,
            observation,
            cumulants,
            next_observation,
            rhos,
        )

    def update_with_ratios(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        rhos: Array,
    ) -> OffPolicyHordeUpdateResult:
        """Update using explicit per-demon importance ratios."""
        return cast(
            OffPolicyHordeUpdateResult,
            self.update_with_ratios_and_discounts(
                state,
                observation,
                cumulants,
                next_observation,
                rhos,
                self._horde_spec.gammas,
            ),
        )

    def update_with_probabilities(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        target_probabilities: Array,
        behavior_probabilities: Array,
    ) -> OffPolicyHordeUpdateResult:
        """Update from target/behavior probabilities instead of ratios."""
        behavior = jnp.maximum(
            behavior_probabilities,
            jnp.asarray(self._min_behavior_probability, dtype=jnp.float32),
        )
        rhos = target_probabilities / behavior
        return self.update_with_ratios(
            state,
            observation,
            cumulants,
            next_observation,
            rhos,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_with_ratios_and_discounts(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        rhos: Array,
        discounts: Array,
    ) -> OffPolicyHordeUpdateResult:
        """Update using explicit ratios and transition discounts."""
        n_demons = self.n_demons
        replacing = self._trace_mode == TraceMode.REPLACING

        rhos = jnp.asarray(rhos, dtype=jnp.float32)
        discounts = jnp.asarray(discounts, dtype=jnp.float32)
        clipped_rhos = jnp.minimum(
            jnp.maximum(rhos, 0.0),
            jnp.asarray(self._ratio_clip, dtype=jnp.float32),
        )
        trace_coefficients = jnp.minimum(
            jnp.maximum(rhos, 0.0),
            jnp.asarray(self._trace_ratio_clip, dtype=jnp.float32),
        )

        next_predictions = self._learner.predict(state, next_observation)
        td_targets = cumulants + discounts * next_predictions
        active_mask = ~jnp.isnan(td_targets)
        safe_targets = jnp.where(active_mask, td_targets, 0.0)

        obs = observation
        new_normalizer_state = state.normalizer_state
        if self._normalizer is not None and state.normalizer_state is not None:
            normalizer: Any = self._normalizer
            obs, new_normalizer_state = normalizer.normalize(
                state.normalizer_state,
                observation,
            )

        slope = self._leaky_relu_slope
        use_layer_norm = self._use_layer_norm

        def trunk_fn(
            weights: tuple[Array, ...],
            biases: tuple[Array, ...],
        ) -> Array:
            return MultiHeadMLPLearner._trunk_forward(
                weights,
                biases,
                obs,
                slope,
                use_layer_norm,
            )

        hidden, trunk_vjp_fn = jax.vjp(
            trunk_fn,
            state.trunk_params.weights,
            state.trunk_params.biases,
        )
        _, activations = MultiHeadMLPLearner._trunk_forward_with_activations(
            state.trunk_params.weights,
            state.trunk_params.biases,
            obs,
            self._leaky_relu_slope,
            self._use_layer_norm,
        )

        cotangent = jnp.zeros(hidden.shape[0], dtype=jnp.float32)
        predictions_list: list[Array] = []
        td_errors_list: list[Array] = []
        effective_errors_list: list[Array] = []

        for i in range(n_demons):
            pred_i = MultiHeadMLPLearner._head_forward(
                state.head_params.weights[i],
                state.head_params.biases[i],
                hidden,
            )
            td_error_i = safe_targets[i] - pred_i
            masked_td_error_i = jnp.where(active_mask[i], td_error_i, 0.0)
            effective_error_i = clipped_rhos[i] * masked_td_error_i

            predictions_list.append(pred_i)
            td_errors_list.append(
                jnp.where(active_mask[i], td_error_i, jnp.nan)
            )
            effective_errors_list.append(effective_error_i)
            cotangent = cotangent + effective_error_i * jnp.squeeze(
                state.head_params.weights[i]
            )

        predictions = jnp.stack(predictions_list)
        td_errors = jnp.stack(td_errors_list)
        effective_errors = jnp.stack(effective_errors_list)

        trunk_weight_grads, trunk_bias_grads = trunk_vjp_fn(cotangent)

        utility_decay = jnp.asarray(self._utility_decay, dtype=jnp.float32)
        new_hidden_unit_utilities: list[Array] = []
        for i in range(len(activations)):
            old_utility = (
                state.hidden_unit_utilities[i]
                if len(state.hidden_unit_utilities) > i
                else jnp.zeros_like(activations[i])
            )
            utility_signal = jnp.abs(activations[i] * trunk_bias_grads[i])
            new_hidden_unit_utilities.append(
                utility_decay * old_utility
                + (1.0 - utility_decay) * utility_signal
            )

        new_trunk_traces: list[Array] = []
        trunk_steps: list[Array] = []
        new_trunk_opt_states: list[Any] = []
        n_trunk_layers = len(state.trunk_params.weights)

        for i in range(n_trunk_layers):
            w_grad_i = trunk_weight_grads[i]
            old_w_trace = state.trunk_traces[2 * i]
            if replacing:
                new_w_trace = jnp.where(w_grad_i != 0.0, w_grad_i, old_w_trace * 0.0)
            else:
                new_w_trace = w_grad_i
            new_trunk_traces.append(new_w_trace)
            w_step, new_w_opt = self._optimizer.update_from_gradient(
                state.trunk_optimizer_states[2 * i],
                new_w_trace,
                error=None,
            )
            trunk_steps.append(w_step)
            new_trunk_opt_states.append(new_w_opt)

            b_grad_i = trunk_bias_grads[i]
            old_b_trace = state.trunk_traces[2 * i + 1]
            if replacing:
                new_b_trace = jnp.where(b_grad_i != 0.0, b_grad_i, old_b_trace * 0.0)
            else:
                new_b_trace = b_grad_i
            new_trunk_traces.append(new_b_trace)
            b_step, new_b_opt = self._optimizer.update_from_gradient(
                state.trunk_optimizer_states[2 * i + 1],
                new_b_trace,
                error=None,
            )
            trunk_steps.append(b_step)
            new_trunk_opt_states.append(new_b_opt)

        trunk_bounding_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._bounder is not None and n_trunk_layers > 0:
            trunk_params_flat: list[Array] = []
            for i in range(n_trunk_layers):
                trunk_params_flat.append(state.trunk_params.weights[i])
                trunk_params_flat.append(state.trunk_params.biases[i])
            bounded_trunk_steps, trunk_bounding_metric = self._bounder.bound(
                tuple(trunk_steps),
                jnp.array(1.0, dtype=jnp.float32),
                tuple(trunk_params_flat),
            )
            trunk_steps = list(bounded_trunk_steps)
            new_trunk_traces = [trunk_bounding_metric * t for t in new_trunk_traces]

        new_trunk_weights: list[Array] = []
        new_trunk_biases: list[Array] = []
        for i in range(n_trunk_layers):
            new_trunk_weights.append(
                state.trunk_params.weights[i] + trunk_steps[2 * i]
            )
            new_trunk_biases.append(
                state.trunk_params.biases[i] + trunk_steps[2 * i + 1]
            )

        new_trunk_params = MLPParams(
            weights=tuple(new_trunk_weights),
            biases=tuple(new_trunk_biases),
        )  # type: ignore[call-arg]

        new_head_weights: list[Array] = []
        new_head_biases: list[Array] = []
        new_head_traces: list[tuple[Array, Array]] = []
        new_head_opt_states: list[tuple[Any, Any]] = []
        per_demon_metrics: list[Array] = []
        head_optimizer = self._head_optimizer or self._optimizer
        lamdas = self._horde_spec.lamdas

        for i in range(n_demons):
            head_w = state.head_params.weights[i]
            head_b = state.head_params.biases[i]
            old_w_trace, old_b_trace = state.head_traces[i]
            old_w_opt, old_b_opt = state.head_optimizer_states[i]

            w_grad = hidden.reshape(1, -1)
            b_grad = jnp.ones(1, dtype=jnp.float32)
            head_gl = discounts[i] * lamdas[i] * trace_coefficients[i]

            if replacing:
                new_w_trace = jnp.where(
                    w_grad != 0.0,
                    w_grad,
                    head_gl * old_w_trace,
                )
                new_b_trace = jnp.where(
                    b_grad != 0.0,
                    b_grad,
                    head_gl * old_b_trace,
                )
            else:
                new_w_trace = head_gl * old_w_trace + w_grad
                new_b_trace = head_gl * old_b_trace + b_grad

            error_i = effective_errors[i]
            w_step, new_w_opt = head_optimizer.update_from_gradient(
                old_w_opt,
                new_w_trace,
                error=error_i,
            )
            b_step, new_b_opt = head_optimizer.update_from_gradient(
                old_b_opt,
                new_b_trace,
                error=error_i,
            )

            if self._bounder is not None:
                bounded_head_steps, bound_scale = self._bounder.bound(
                    (w_step, b_step),
                    error_i,
                    (head_w, head_b),
                )
                w_step, b_step = bounded_head_steps
                new_w_trace = bound_scale * new_w_trace
                new_b_trace = bound_scale * new_b_trace

            new_w = head_w + error_i * w_step
            new_b = head_b + error_i * b_step

            new_w = jnp.where(active_mask[i], new_w, head_w)
            new_b = jnp.where(active_mask[i], new_b, head_b)
            new_w_trace = jnp.where(active_mask[i], new_w_trace, old_w_trace)
            new_b_trace = jnp.where(active_mask[i], new_b_trace, old_b_trace)
            new_w_opt = jax.tree.map(
                lambda new, old: jnp.where(active_mask[i], new, old),
                new_w_opt,
                old_w_opt,
            )
            new_b_opt = jax.tree.map(
                lambda new, old: jnp.where(active_mask[i], new, old),
                new_b_opt,
                old_b_opt,
            )

            new_head_weights.append(new_w)
            new_head_biases.append(new_b)
            new_head_traces.append((new_w_trace, new_b_trace))
            new_head_opt_states.append((new_w_opt, new_b_opt))

            se_i = jnp.where(active_mask[i], td_errors[i] ** 2, jnp.nan)
            raw_error_i = jnp.where(active_mask[i], td_errors[i], jnp.nan)
            rho_i = jnp.where(active_mask[i], rhos[i], jnp.nan)
            clipped_rho_i = jnp.where(active_mask[i], clipped_rhos[i], jnp.nan)
            trace_coeff_i = jnp.where(
                active_mask[i],
                trace_coefficients[i],
                jnp.nan,
            )
            mean_ss_i = jnp.where(
                active_mask[i],
                _extract_mean_step_size(new_w_opt),
                jnp.nan,
            )
            per_demon_metrics.append(
                jnp.array(
                    [
                        se_i,
                        raw_error_i,
                        rho_i,
                        clipped_rho_i,
                        trace_coeff_i,
                        mean_ss_i,
                    ]
                )
            )

        new_head_params = MLPParams(
            weights=tuple(new_head_weights),
            biases=tuple(new_head_biases),
        )  # type: ignore[call-arg]
        new_state = MultiHeadMLPState(
            trunk_params=new_trunk_params,
            head_params=new_head_params,
            trunk_optimizer_states=tuple(new_trunk_opt_states),
            head_optimizer_states=tuple(new_head_opt_states),
            trunk_traces=tuple(new_trunk_traces),
            head_traces=tuple(new_head_traces),
            hidden_unit_utilities=tuple(new_hidden_unit_utilities),
            normalizer_state=new_normalizer_state,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )  # type: ignore[call-arg]

        return OffPolicyHordeUpdateResult(
            state=new_state,
            predictions=predictions,
            next_predictions=next_predictions,
            td_targets=td_targets,
            td_errors=td_errors,
            rhos=rhos,
            clipped_rhos=jnp.where(active_mask, clipped_rhos, jnp.nan),
            trace_coefficients=jnp.where(active_mask, trace_coefficients, jnp.nan),
            per_demon_metrics=jnp.stack(per_demon_metrics),
            trunk_bounding_metric=trunk_bounding_metric,
        )  # type: ignore[call-arg]

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration."""
        return {
            "type": "OffPolicyHordeLearner",
            "horde_spec": self._horde_spec.to_config(),
            "hidden_sizes": list(self._hidden_sizes),
            "optimizer": self._optimizer.to_config(),
            "bounder": self._bounder.to_config() if self._bounder else None,
            "normalizer": self._normalizer.to_config() if self._normalizer else None,
            "sparsity": self._sparsity,
            "leaky_relu_slope": self._leaky_relu_slope,
            "use_layer_norm": self._use_layer_norm,
            "head_optimizer": (
                self._head_optimizer.to_config() if self._head_optimizer else None
            ),
            "trace_mode": self._trace_mode.value,
            "utility_decay": self._utility_decay,
            "ratio_clip": self._ratio_clip,
            "trace_ratio_clip": self._trace_ratio_clip,
            "min_behavior_probability": self._min_behavior_probability,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> OffPolicyHordeLearner:
        """Reconstruct a learner from :meth:`to_config`."""
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        config = dict(config)
        config.pop("type", None)
        horde_spec = HordeSpec.from_config(config.pop("horde_spec"))
        optimizer = optimizer_from_config(config.pop("optimizer"))
        bounder_cfg = config.pop("bounder", None)
        bounder = bounder_from_config(bounder_cfg) if bounder_cfg else None
        normalizer_cfg = config.pop("normalizer", None)
        normalizer = normalizer_from_config(normalizer_cfg) if normalizer_cfg else None
        head_optimizer_cfg = config.pop("head_optimizer", None)
        head_optimizer = (
            optimizer_from_config(head_optimizer_cfg)
            if head_optimizer_cfg
            else None
        )
        trace_mode = TraceMode(config.pop("trace_mode", TraceMode.ACCUMULATING.value))

        return cls(
            horde_spec=horde_spec,
            hidden_sizes=tuple(config.pop("hidden_sizes")),
            optimizer=optimizer,
            bounder=bounder,
            normalizer=normalizer,
            head_optimizer=head_optimizer,
            trace_mode=trace_mode,
            **config,
        )


class NonlinearSharedGTDHordeLearner:
    """Corrected nonlinear shared-trunk off-policy Horde.

    This learner implements a compact TDC/GTD-style correction for a
    single-hidden-layer shared trunk with one head per demon. It is intentionally
    separate from :class:`OffPolicyHordeLearner`, whose state is a
    ``MultiHeadMLPState`` without secondary weights.
    """

    def __init__(
        self,
        horde_spec: HordeSpec,
        hidden_size: int = 16,
        primary_step_size: float = 0.002,
        secondary_step_size: float = 1e-5,
        ratio_clip: float = 10.0,
        init_scale: float = 0.25,
    ) -> None:
        if hidden_size <= 0:
            raise ValueError("hidden_size must be positive")
        if primary_step_size <= 0.0:
            raise ValueError("primary_step_size must be positive")
        if secondary_step_size <= 0.0:
            raise ValueError("secondary_step_size must be positive")
        if ratio_clip <= 0.0:
            raise ValueError("ratio_clip must be positive")
        if init_scale <= 0.0:
            raise ValueError("init_scale must be positive")
        self._horde_spec = horde_spec
        self._hidden_size = hidden_size
        self._primary_step_size = primary_step_size
        self._secondary_step_size = secondary_step_size
        self._ratio_clip = ratio_clip
        self._init_scale = init_scale

    @property
    def horde_spec(self) -> HordeSpec:
        """The GVF specification."""
        return self._horde_spec

    @property
    def n_demons(self) -> int:
        """Number of demons."""
        return len(self._horde_spec.demons)

    def init(self, feature_dim: int, key: Array) -> NonlinearSharedGTDHordeState:
        """Initialize primary and secondary weights."""
        trunk_key, head_key = jax.random.split(key)
        trunk_w = self._init_scale * jax.random.normal(
            trunk_key,
            (self._hidden_size, feature_dim),
            dtype=jnp.float32,
        )
        head_w = self._init_scale * jax.random.normal(
            head_key,
            (self.n_demons, self._hidden_size),
            dtype=jnp.float32,
        )
        return NonlinearSharedGTDHordeState(  # type: ignore[call-arg]
            trunk_w=trunk_w,
            trunk_b=jnp.zeros(self._hidden_size, dtype=jnp.float32),
            head_w=head_w,
            head_b=jnp.zeros(self.n_demons, dtype=jnp.float32),
            secondary_trunk_w=jnp.zeros(
                (self.n_demons, self._hidden_size, feature_dim),
                dtype=jnp.float32,
            ),
            secondary_trunk_b=jnp.zeros(
                (self.n_demons, self._hidden_size),
                dtype=jnp.float32,
            ),
            secondary_head_w=jnp.zeros(
                (self.n_demons, self._hidden_size),
                dtype=jnp.float32,
            ),
            secondary_head_b=jnp.zeros(self.n_demons, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: NonlinearSharedGTDHordeState, observation: Array) -> Array:
        """Predict all demon values for one observation."""
        hidden = jnp.tanh(state.trunk_w @ observation + state.trunk_b)
        return state.head_w @ hidden + state.head_b

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_with_ratios_and_discounts(
        self,
        state: NonlinearSharedGTDHordeState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        rhos: Array,
        discounts: Array,
    ) -> NonlinearSharedGTDHordeUpdateResult:
        """Update with explicit per-demon ratios and discounts."""
        hidden = jnp.tanh(state.trunk_w @ observation + state.trunk_b)
        next_hidden = jnp.tanh(state.trunk_w @ next_observation + state.trunk_b)
        predictions = state.head_w @ hidden + state.head_b
        next_predictions = state.head_w @ next_hidden + state.head_b
        td_targets = cumulants + discounts * next_predictions
        td_errors = td_targets - predictions
        clipped_rhos = jnp.minimum(
            jnp.maximum(jnp.asarray(rhos, dtype=jnp.float32), 0.0),
            jnp.asarray(self._ratio_clip, dtype=jnp.float32),
        )

        primary_alpha = jnp.asarray(self._primary_step_size, dtype=jnp.float32)
        secondary_beta = jnp.asarray(self._secondary_step_size, dtype=jnp.float32)
        trunk_w_step = jnp.zeros_like(state.trunk_w)
        trunk_b_step = jnp.zeros_like(state.trunk_b)
        head_w_step = jnp.zeros_like(state.head_w)
        head_b_step = jnp.zeros_like(state.head_b)
        new_secondary_trunk_w = []
        new_secondary_trunk_b = []
        new_secondary_head_w = []
        new_secondary_head_b = []
        correction_norms = []
        secondary_norms = []

        for i in range(self.n_demons):
            one_minus_hidden_sq = 1.0 - hidden**2
            next_one_minus_hidden_sq = 1.0 - next_hidden**2
            grad_head_w = hidden
            grad_head_b = jnp.array(1.0, dtype=jnp.float32)
            grad_hidden = state.head_w[i] * one_minus_hidden_sq
            grad_trunk_w = grad_hidden[:, None] * observation[None, :]
            grad_trunk_b = grad_hidden

            next_grad_head_w = next_hidden
            next_grad_head_b = jnp.array(1.0, dtype=jnp.float32)
            next_grad_hidden = state.head_w[i] * next_one_minus_hidden_sq
            next_grad_trunk_w = next_grad_hidden[:, None] * next_observation[None, :]
            next_grad_trunk_b = next_grad_hidden

            secondary_dot = (
                jnp.vdot(state.secondary_trunk_w[i], grad_trunk_w)
                + jnp.vdot(state.secondary_trunk_b[i], grad_trunk_b)
                + jnp.vdot(state.secondary_head_w[i], grad_head_w)
                + state.secondary_head_b[i] * grad_head_b
            )
            correction_trunk_w = discounts[i] * secondary_dot * next_grad_trunk_w
            correction_trunk_b = discounts[i] * secondary_dot * next_grad_trunk_b
            correction_head_w = discounts[i] * secondary_dot * next_grad_head_w
            correction_head_b = discounts[i] * secondary_dot * next_grad_head_b
            rho_delta = clipped_rhos[i] * td_errors[i]

            trunk_w_step = trunk_w_step + primary_alpha * (
                rho_delta * grad_trunk_w - correction_trunk_w
            )
            trunk_b_step = trunk_b_step + primary_alpha * (
                rho_delta * grad_trunk_b - correction_trunk_b
            )
            head_w_step = head_w_step.at[i].add(
                primary_alpha * (rho_delta * grad_head_w - correction_head_w)
            )
            head_b_step = head_b_step.at[i].add(
                primary_alpha * (rho_delta * grad_head_b - correction_head_b)
            )

            sec_trunk_w = state.secondary_trunk_w[i] + secondary_beta * (
                rho_delta * grad_trunk_w - secondary_dot * grad_trunk_w
            )
            sec_trunk_b = state.secondary_trunk_b[i] + secondary_beta * (
                rho_delta * grad_trunk_b - secondary_dot * grad_trunk_b
            )
            sec_head_w = state.secondary_head_w[i] + secondary_beta * (
                rho_delta * grad_head_w - secondary_dot * grad_head_w
            )
            sec_head_b = state.secondary_head_b[i] + secondary_beta * (
                rho_delta * grad_head_b - secondary_dot * grad_head_b
            )
            new_secondary_trunk_w.append(sec_trunk_w)
            new_secondary_trunk_b.append(sec_trunk_b)
            new_secondary_head_w.append(sec_head_w)
            new_secondary_head_b.append(sec_head_b)
            correction_norms.append(
                jnp.sqrt(
                    jnp.vdot(correction_trunk_w, correction_trunk_w)
                    + jnp.vdot(correction_trunk_b, correction_trunk_b)
                    + jnp.vdot(correction_head_w, correction_head_w)
                    + correction_head_b**2
                )
            )
            secondary_norms.append(
                jnp.sqrt(
                    jnp.vdot(sec_trunk_w, sec_trunk_w)
                    + jnp.vdot(sec_trunk_b, sec_trunk_b)
                    + jnp.vdot(sec_head_w, sec_head_w)
                    + sec_head_b**2
                )
            )

        new_state = state.replace(  # type: ignore[attr-defined]
            trunk_w=state.trunk_w + trunk_w_step,
            trunk_b=state.trunk_b + trunk_b_step,
            head_w=state.head_w + head_w_step,
            head_b=state.head_b + head_b_step,
            secondary_trunk_w=jnp.stack(new_secondary_trunk_w),
            secondary_trunk_b=jnp.stack(new_secondary_trunk_b),
            secondary_head_w=jnp.stack(new_secondary_head_w),
            secondary_head_b=jnp.stack(new_secondary_head_b),
            step_count=state.step_count + 1,
        )
        return NonlinearSharedGTDHordeUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            predictions=predictions,
            next_predictions=next_predictions,
            td_targets=td_targets,
            td_errors=td_errors,
            clipped_rhos=clipped_rhos,
            correction_norms=jnp.stack(correction_norms),
            secondary_norms=jnp.stack(secondary_norms),
        )


def run_off_policy_horde_learning_loop(
    learner: OffPolicyHordeLearner,
    state: MultiHeadMLPState,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
    rhos: Array,
    discounts: Array | None = None,
) -> OffPolicyHordeLearningResult:
    """Run an off-policy Horde scan over transition arrays."""
    if discounts is None:
        discounts = jnp.broadcast_to(learner.horde_spec.gammas, cumulants.shape)

    def step_fn(
        carry: MultiHeadMLPState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[MultiHeadMLPState, tuple[Array, Array, Array]]:
        obs, cums, next_obs, rho_t, discount_t = inputs
        result = learner.update_with_ratios_and_discounts(
            carry,
            obs,
            cums,
            next_obs,
            rho_t,
            discount_t,
        )
        return (
            result.state,
            (
                result.per_demon_metrics,
                result.td_errors,
                result.clipped_rhos,
            ),
        )

    t0 = time.time()
    final_state, (per_demon_metrics, td_errors, clipped_rhos) = jax.lax.scan(
        step_fn,
        state,
        (observations, cumulants, next_observations, rhos, discounts),
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.uptime_s + elapsed
    )

    return OffPolicyHordeLearningResult(
        state=final_state,
        per_demon_metrics=per_demon_metrics,
        td_errors=td_errors,
        clipped_rhos=clipped_rhos,
    )  # type: ignore[call-arg]


def run_off_policy_horde_learning_loop_batched(
    learner: OffPolicyHordeLearner,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
    rhos: Array,
    keys: Array,
    discounts: Array | None = None,
) -> OffPolicyHordeLearningResult:
    """Run the off-policy Horde loop for multiple initialization keys."""

    def single_run(key: Array) -> tuple[MultiHeadMLPState, Array, Array, Array]:
        init_state = learner.init(observations.shape[1], key)
        result = run_off_policy_horde_learning_loop(
            learner,
            init_state,
            observations,
            cumulants,
            next_observations,
            rhos,
            discounts,
        )
        return (
            result.state,
            result.per_demon_metrics,
            result.td_errors,
            result.clipped_rhos,
        )

    states, per_demon_metrics, td_errors, clipped_rhos = jax.vmap(single_run)(keys)
    return OffPolicyHordeLearningResult(
        state=states,
        per_demon_metrics=per_demon_metrics,
        td_errors=td_errors,
        clipped_rhos=clipped_rhos,
    )  # type: ignore[call-arg]


__all__ = [
    "NonlinearSharedGTDHordeLearner",
    "NonlinearSharedGTDHordeLearningResult",
    "NonlinearSharedGTDHordeState",
    "NonlinearSharedGTDHordeUpdateResult",
    "OffPolicyHordeLearner",
    "OffPolicyHordeLearningResult",
    "OffPolicyHordeUpdateResult",
    "run_off_policy_horde_learning_loop",
    "run_off_policy_horde_learning_loop_batched",
]
