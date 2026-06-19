# mypy: disable-error-code="call-arg,name-defined"
"""Single Step 2 learner combining UPGD with fixed-budget prototype memory.

The learner keeps the two mechanisms that survived the Step 2 pressure tests:
target-structure UPGD for differentiable plastic features and a D20-style
multi-prototype memory for retained one-hot class views.  Both components
update on every step.  Their predictions are blended by one learned scalar plus
causal confidence/reliability signals, so the deployed object is one learner
rather than a route-selecting portfolio.
"""

from __future__ import annotations

import functools
from dataclasses import asdict, dataclass
from typing import Any, Literal

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float

from alberta_framework.core.optimizers import ObGDBounding
from alberta_framework.core.prototype_memory import (
    PrototypeMemoryConfig,
    PrototypeMemoryLearner,
    PrototypeMemoryState,
)
from alberta_framework.core.upgd import UPGDLearner, UPGDState

UPGDMemoryReadoutMode = Literal["linear_mse", "softmax_ce"]


@dataclass(frozen=True)
class UPGDMemoryConfig:
    """Configuration for :class:`UPGDMemoryLearner`.

    Args:
        feature_dim: Observation dimensionality.
        n_heads: Output dimensionality.  For classification this is the number
            of one-hot classes.
        hidden_sizes: UPGD hidden-layer widths.
        readout_mode: UPGD readout/loss mode.  ``"softmax_ce"`` is the intended
            mode when prototype memory is active.
        upgd_step_size: Base UPGD step-size.
        upgd_head_step_size_multiplier: Fixed multiplier for output-head
            weight and bias updates.
        upgd_head_bias_step_size_multiplier: Extra multiplier for output-head
            bias updates after ``upgd_head_step_size_multiplier``.
        upgd_head_loss_pressure_gate_ratio: Fast/slow loss ratio at which the
            output head receives an additional plasticity multiplier.
        upgd_head_loss_pressure_multiplier: Maximum additional output-head
            plasticity under loss pressure.
        upgd_head_loss_pressure_warmup_steps: Initial updates before
            loss-pressure head plasticity is enabled.
        upgd_head_repetition_multiplier: Maximum additional output-head
            plasticity under repeated-target pressure.
        upgd_head_repetition_decay: EMA decay for repeated-target detection.
        upgd_head_repetition_delta_threshold: Mean absolute target-vector
            change treated as a repeated target.
        upgd_head_repetition_pressure_threshold: Repetition EMA level below
            which repeated-target pressure is ignored.
        upgd_head_repetition_warmup_steps: Initial updates before
            repeated-target head plasticity is enabled.
        slots_per_class: Fixed prototype slots per class.
        memory_update_rate: EMA rate for matched prototypes.
        initial_novelty_threshold: Initial mean-squared distance threshold for
            allocating a fresh prototype.
        memory_bandwidth: Distance-to-logit bandwidth for prototype memory.
        initial_memory_logit: Learned base logit for memory-vs-UPGD blending.
        memory_logit_step_size: Online gradient step-size for the blend logit.
        confidence_logit_scale: Fixed coefficient for memory confidence minus
            UPGD confidence.
        reliability_logit_scale: Fixed coefficient for UPGD loss EMA minus
            memory loss EMA.
        reliability_decay: EMA decay for component losses and allocation rate.
        target_trace_blend_scale: Optional update-time blend toward the
            previous target vector under repeated-target pressure.  This is a
            causal temporal prior for prequential streams with persistent
            targets.  It defaults to zero, and ordinary ``predict`` calls stay
            observation-based so held-out batch evaluation is not biased toward
            the last observed target.
        target_trace_pressure_threshold: Repetition EMA level below which the
            target-trace prior is ignored.
        novelty_adaptation_rate: Online log-threshold adaptation step-size.
        target_allocation_rate: Target prototype allocation frequency.  When
            allocation EMA is higher than this, the threshold rises; when lower,
            it falls.
        min_novelty_threshold: Lower threshold clamp.
        max_novelty_threshold: Upper threshold clamp.
    """

    feature_dim: int
    n_heads: int
    hidden_sizes: tuple[int, ...] = (64,)
    readout_mode: UPGDMemoryReadoutMode = "softmax_ce"
    upgd_step_size: float = 0.03
    upgd_head_step_size_multiplier: float = 1.0
    upgd_head_bias_step_size_multiplier: float = 1.0
    upgd_head_loss_pressure_gate_ratio: float = 0.0
    upgd_head_loss_pressure_multiplier: float = 0.0
    upgd_head_loss_pressure_warmup_steps: int = 0
    upgd_head_repetition_multiplier: float = 0.0
    upgd_head_repetition_decay: float = 0.9
    upgd_head_repetition_delta_threshold: float = 0.05
    upgd_head_repetition_pressure_threshold: float = 0.0
    upgd_head_repetition_warmup_steps: int = 0
    slots_per_class: int = 20
    memory_update_rate: float = 0.3
    initial_novelty_threshold: float = 0.08
    memory_bandwidth: float = 0.01
    initial_memory_logit: float = 0.0
    memory_logit_step_size: float = 0.25
    confidence_logit_scale: float = 2.0
    reliability_logit_scale: float = 8.0
    reliability_decay: float = 0.98
    target_trace_blend_scale: float = 0.8
    target_trace_pressure_threshold: float = 0.5
    novelty_adaptation_rate: float = 0.02
    target_allocation_rate: float = 0.18
    min_novelty_threshold: float = 1e-4
    max_novelty_threshold: float = 1.0

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable representation."""
        payload = asdict(self)
        payload["hidden_sizes"] = list(self.hidden_sizes)
        return payload

    def to_config(self) -> dict[str, object]:
        """Serialize to a plain config dictionary."""
        payload = self.to_dict()
        payload["type"] = "UPGDMemoryConfig"
        return payload

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> UPGDMemoryConfig:
        """Reconstruct from :meth:`to_config` output."""
        payload = dict(config)
        payload.pop("type", None)
        if "hidden_sizes" in payload:
            payload["hidden_sizes"] = tuple(payload["hidden_sizes"])
        return cls(**payload)


@chex.dataclass(frozen=True)
class UPGDMemoryState:
    """State for :class:`UPGDMemoryLearner`."""

    upgd_state: UPGDState
    memory_state: PrototypeMemoryState
    memory_logit: Array
    novelty_log_threshold: Array
    upgd_loss_ema: Array
    memory_loss_ema: Array
    blended_loss_ema: Array
    allocation_ema: Array
    step_count: Array


@chex.dataclass(frozen=True)
class UPGDMemoryUpdateResult:
    """Result of one UPGD-memory update."""

    state: UPGDMemoryState
    predictions: Float[Array, " n_heads"]
    errors: Float[Array, " n_heads"]
    metrics: Float[Array, " 10"]


@chex.dataclass(frozen=True)
class UPGDMemoryLearningResult:
    """Result from :func:`run_upgd_memory_arrays`."""

    state: UPGDMemoryState
    predictions: Float[Array, "steps n_heads"]
    metrics: Float[Array, "steps 10"]


def _validate_config(config: UPGDMemoryConfig) -> None:
    if config.feature_dim < 1:
        raise ValueError("feature_dim must be positive")
    if config.n_heads < 2:
        raise ValueError("n_heads must be at least 2")
    if any(size < 1 for size in config.hidden_sizes):
        raise ValueError("hidden_sizes must contain only positive widths")
    if config.readout_mode not in {"linear_mse", "softmax_ce"}:
        raise ValueError("readout_mode must be 'linear_mse' or 'softmax_ce'")
    if config.upgd_step_size <= 0.0:
        raise ValueError("upgd_step_size must be positive")
    if config.upgd_head_step_size_multiplier <= 0.0:
        raise ValueError("upgd_head_step_size_multiplier must be positive")
    if config.upgd_head_bias_step_size_multiplier < 0.0:
        raise ValueError(
            "upgd_head_bias_step_size_multiplier must be non-negative"
        )
    if config.upgd_head_loss_pressure_gate_ratio < 0.0:
        raise ValueError(
            "upgd_head_loss_pressure_gate_ratio must be non-negative"
        )
    if config.upgd_head_loss_pressure_multiplier < 0.0:
        raise ValueError(
            "upgd_head_loss_pressure_multiplier must be non-negative"
        )
    if config.upgd_head_loss_pressure_warmup_steps < 0:
        raise ValueError(
            "upgd_head_loss_pressure_warmup_steps must be non-negative"
        )
    if config.upgd_head_repetition_multiplier < 0.0:
        raise ValueError("upgd_head_repetition_multiplier must be non-negative")
    if not 0.0 <= config.upgd_head_repetition_decay < 1.0:
        raise ValueError("upgd_head_repetition_decay must be in [0, 1)")
    if config.upgd_head_repetition_delta_threshold < 0.0:
        raise ValueError(
            "upgd_head_repetition_delta_threshold must be non-negative"
        )
    if not 0.0 <= config.upgd_head_repetition_pressure_threshold < 1.0:
        raise ValueError(
            "upgd_head_repetition_pressure_threshold must be in [0, 1)"
        )
    if config.upgd_head_repetition_warmup_steps < 0:
        raise ValueError(
            "upgd_head_repetition_warmup_steps must be non-negative"
        )
    if config.slots_per_class < 1:
        raise ValueError("slots_per_class must be positive")
    if not 0.0 < config.memory_update_rate <= 1.0:
        raise ValueError("memory_update_rate must be in (0, 1]")
    if config.initial_novelty_threshold <= 0.0:
        raise ValueError("initial_novelty_threshold must be positive")
    if config.memory_bandwidth <= 0.0:
        raise ValueError("memory_bandwidth must be positive")
    if config.memory_logit_step_size < 0.0:
        raise ValueError("memory_logit_step_size must be non-negative")
    if not 0.0 <= config.reliability_decay < 1.0:
        raise ValueError("reliability_decay must be in [0, 1)")
    if not 0.0 <= config.target_trace_blend_scale <= 1.0:
        raise ValueError("target_trace_blend_scale must be in [0, 1]")
    if not 0.0 <= config.target_trace_pressure_threshold < 1.0:
        raise ValueError("target_trace_pressure_threshold must be in [0, 1)")
    if config.novelty_adaptation_rate < 0.0:
        raise ValueError("novelty_adaptation_rate must be non-negative")
    if not 0.0 <= config.target_allocation_rate <= 1.0:
        raise ValueError("target_allocation_rate must be in [0, 1]")
    if config.min_novelty_threshold <= 0.0:
        raise ValueError("min_novelty_threshold must be positive")
    if config.max_novelty_threshold < config.min_novelty_threshold:
        raise ValueError("max_novelty_threshold must be >= min_novelty_threshold")


def _active_mse(prediction: Array, target: Array) -> Array:
    active = jnp.isfinite(target)
    safe_target = jnp.where(active, target, 0.0)
    squared = jnp.where(active, (prediction - safe_target) ** 2, 0.0)
    return jnp.sum(squared) / jnp.maximum(jnp.sum(active.astype(jnp.float32)), 1.0)


def _normalize_simplex(prediction: Array) -> Array:
    clipped = jnp.maximum(prediction, 0.0)
    return clipped / jnp.maximum(jnp.sum(clipped), 1e-12)


class UPGDMemoryLearner:
    """UPGD plus adaptive fixed-budget prototype memory as one learner."""

    def __init__(self, config: UPGDMemoryConfig):
        _validate_config(config)
        self._config = config
        self._upgd = UPGDLearner(
            n_heads=config.n_heads,
            hidden_sizes=config.hidden_sizes,
            step_size=config.upgd_step_size,
            bounder=ObGDBounding(kappa=0.5),
            sparsity=0.5,
            use_layer_norm=True,
            perturbation_sigma=1e-4,
            perturbation_noise="rademacher",
            utility_decay=0.995,
            perturbation_beta=2.0,
            perturbation_interval=16,
            loss_normalization="target_structure",
            readout_mode=config.readout_mode,
            track_unit_utilities=False,
            track_gradient_history=False,
            head_step_size_multiplier=config.upgd_head_step_size_multiplier,
            head_bias_step_size_multiplier=(
                config.upgd_head_bias_step_size_multiplier
            ),
            head_loss_pressure_gate_ratio=(
                config.upgd_head_loss_pressure_gate_ratio
            ),
            head_loss_pressure_multiplier=(
                config.upgd_head_loss_pressure_multiplier
            ),
            head_loss_pressure_warmup_steps=(
                config.upgd_head_loss_pressure_warmup_steps
            ),
            head_repetition_multiplier=config.upgd_head_repetition_multiplier,
            head_repetition_decay=config.upgd_head_repetition_decay,
            head_repetition_delta_threshold=(
                config.upgd_head_repetition_delta_threshold
            ),
            head_repetition_pressure_threshold=(
                config.upgd_head_repetition_pressure_threshold
            ),
            head_repetition_warmup_steps=(
                config.upgd_head_repetition_warmup_steps
            ),
        )
        self._memory = PrototypeMemoryLearner(
            PrototypeMemoryConfig(
                feature_dim=config.feature_dim,
                n_classes=config.n_heads,
                slots_per_class=config.slots_per_class,
                update_rate=config.memory_update_rate,
                novelty_threshold=config.initial_novelty_threshold,
                bandwidth=config.memory_bandwidth,
            )
        )

    @property
    def config(self) -> UPGDMemoryConfig:
        """Learner configuration."""
        return self._config

    @property
    def upgd(self) -> UPGDLearner:
        """Underlying UPGD component."""
        return self._upgd

    @property
    def memory(self) -> PrototypeMemoryLearner:
        """Underlying fixed-budget prototype memory component."""
        return self._memory

    def to_config(self) -> dict[str, object]:
        """Serialize the learner configuration."""
        return {
            "type": "UPGDMemoryLearner",
            "config": self._config.to_config(),
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> UPGDMemoryLearner:
        """Reconstruct from :meth:`to_config` output."""
        return cls(UPGDMemoryConfig.from_config(dict(config["config"])))

    def init(self, key: Array | None = None) -> UPGDMemoryState:
        """Initialize both components and adaptive blend state."""
        if key is None:
            key = jr.key(0)
        cfg = self._config
        return UPGDMemoryState(
            upgd_state=self._upgd.init(cfg.feature_dim, key),
            memory_state=self._memory.init(),
            memory_logit=jnp.asarray(cfg.initial_memory_logit, dtype=jnp.float32),
            novelty_log_threshold=jnp.log(
                jnp.asarray(cfg.initial_novelty_threshold, dtype=jnp.float32)
            ),
            upgd_loss_ema=jnp.array(0.0, dtype=jnp.float32),
            memory_loss_ema=jnp.array(0.0, dtype=jnp.float32),
            blended_loss_ema=jnp.array(0.0, dtype=jnp.float32),
            allocation_ema=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def _blend_gate(
        self,
        state: UPGDMemoryState,
        upgd_prediction: Array,
        memory_prediction: Array,
    ) -> Array:
        active_memory = (jnp.sum(state.memory_state.counts > 0.0) > 0).astype(
            jnp.float32
        )
        confidence_delta = jnp.max(memory_prediction) - jnp.max(upgd_prediction)
        reliability_delta = state.upgd_loss_ema - state.memory_loss_ema
        logit = (
            state.memory_logit
            + self._config.confidence_logit_scale * confidence_delta
            + self._config.reliability_logit_scale * reliability_delta
        )
        return active_memory * jax.nn.sigmoid(logit)

    def _blend_predictions(
        self,
        state: UPGDMemoryState,
        upgd_prediction: Array,
        memory_prediction: Array,
        *,
        include_target_trace: bool,
    ) -> tuple[Array, Array]:
        gate = self._blend_gate(state, upgd_prediction, memory_prediction)
        prediction = (1.0 - gate) * upgd_prediction + gate * memory_prediction
        if self._config.readout_mode == "softmax_ce":
            prediction = _normalize_simplex(prediction)
        trace_scale = jnp.where(
            include_target_trace,
            jnp.asarray(self._config.target_trace_blend_scale, dtype=jnp.float32),
            jnp.array(0.0, dtype=jnp.float32),
        )
        threshold = jnp.asarray(
            self._config.target_trace_pressure_threshold,
            dtype=jnp.float32,
        )
        trace_pressure = jnp.clip(
            (state.upgd_state.target_repeat_ema - threshold)
            / jnp.maximum(1.0 - threshold, 1e-6),
            0.0,
            1.0,
        )
        trace_gate = trace_scale * trace_pressure
        trace_prediction = _normalize_simplex(state.upgd_state.previous_targets)
        prediction = (1.0 - trace_gate) * prediction + trace_gate * trace_prediction
        if self._config.readout_mode == "softmax_ce":
            prediction = _normalize_simplex(prediction)
        return prediction, gate

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self,
        state: UPGDMemoryState,
        observation: Float[Array, " feature_dim"],
    ) -> Float[Array, " n_heads"]:
        """Predict with the current learned UPGD-memory blend."""
        upgd_prediction = self._upgd.predict(state.upgd_state, observation)
        memory_prediction = self._memory.predict(state.memory_state, observation)
        prediction, _gate = self._blend_predictions(
            state,
            upgd_prediction,
            memory_prediction,
            include_target_trace=False,
        )
        return prediction

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: UPGDMemoryState,
        observation: Float[Array, " feature_dim"],
        target: Float[Array, " n_heads"],
    ) -> UPGDMemoryUpdateResult:
        """Update UPGD, memory, blend reliability, and novelty threshold."""
        upgd_prediction = self._upgd.predict(state.upgd_state, observation)
        memory_prediction = self._memory.predict(state.memory_state, observation)
        prediction, gate = self._blend_predictions(
            state,
            upgd_prediction,
            memory_prediction,
            include_target_trace=True,
        )
        safe_target = jnp.where(jnp.isfinite(target), target, 0.0)
        errors = prediction - safe_target
        blended_loss = _active_mse(prediction, target)
        upgd_loss = _active_mse(upgd_prediction, target)
        memory_loss = _active_mse(memory_prediction, target)

        active = jnp.isfinite(target)
        dloss_dgate = jnp.sum(
            jnp.where(
                active,
                (prediction - safe_target) * (memory_prediction - upgd_prediction),
                0.0,
            )
        ) / jnp.maximum(jnp.sum(active.astype(jnp.float32)), 1.0)
        dloss_dlogit = dloss_dgate * gate * (1.0 - gate)
        next_memory_logit = state.memory_logit - (
            jnp.asarray(self._config.memory_logit_step_size, dtype=jnp.float32)
            * dloss_dlogit
        )
        next_memory_logit = jnp.clip(next_memory_logit, -8.0, 8.0)

        threshold = jnp.exp(state.novelty_log_threshold)
        upgd_result = self._upgd.update(state.upgd_state, observation, target)
        memory_result = self._memory.update_with_novelty_threshold(
            state.memory_state,
            observation,
            target,
            threshold,
        )
        allocated = memory_result.metrics[5]
        decay = jnp.asarray(self._config.reliability_decay, dtype=jnp.float32)
        one_minus_decay = 1.0 - decay
        next_allocation_ema = decay * state.allocation_ema + one_minus_decay * allocated
        allocation_error = next_allocation_ema - jnp.asarray(
            self._config.target_allocation_rate,
            dtype=jnp.float32,
        )
        next_log_threshold = state.novelty_log_threshold + (
            jnp.asarray(self._config.novelty_adaptation_rate, dtype=jnp.float32)
            * allocation_error
        )
        next_log_threshold = jnp.clip(
            next_log_threshold,
            jnp.log(jnp.asarray(self._config.min_novelty_threshold, dtype=jnp.float32)),
            jnp.log(jnp.asarray(self._config.max_novelty_threshold, dtype=jnp.float32)),
        )

        next_state = UPGDMemoryState(
            upgd_state=upgd_result.state,
            memory_state=memory_result.state,
            memory_logit=next_memory_logit,
            novelty_log_threshold=next_log_threshold,
            upgd_loss_ema=decay * state.upgd_loss_ema + one_minus_decay * upgd_loss,
            memory_loss_ema=decay * state.memory_loss_ema + one_minus_decay * memory_loss,
            blended_loss_ema=(
                decay * state.blended_loss_ema + one_minus_decay * blended_loss
            ),
            allocation_ema=next_allocation_ema,
            step_count=state.step_count + 1,
        )
        metrics = jnp.asarray(
            [
                blended_loss,
                upgd_loss,
                memory_loss,
                gate,
                next_memory_logit,
                threshold,
                next_allocation_ema,
                jnp.sum(memory_result.state.counts > 0.0).astype(jnp.float32),
                jnp.max(upgd_prediction),
                jnp.max(memory_prediction),
            ],
            dtype=jnp.float32,
        )
        return UPGDMemoryUpdateResult(
            state=next_state,
            predictions=prediction,
            errors=errors,
            metrics=metrics,
        )


def run_upgd_memory_arrays(
    learner: UPGDMemoryLearner,
    state: UPGDMemoryState,
    observations: Float[Array, "steps feature_dim"],
    targets: Float[Array, "steps n_heads"],
) -> UPGDMemoryLearningResult:
    """Run a UPGD-memory learner over arrays with ``jax.lax.scan``.

    Metric columns are ``blend_mse, upgd_mse, memory_mse, gate, memory_logit,
    novelty_threshold, allocation_ema, active_prototypes, upgd_conf,
    memory_conf``.
    """

    def step_fn(
        carry: UPGDMemoryState,
        batch: tuple[Array, Array],
    ) -> tuple[UPGDMemoryState, tuple[Array, Array]]:
        observation, target = batch
        result = learner.update(carry, observation, target)
        return result.state, (result.predictions, result.metrics)

    final_state, (predictions, metrics) = jax.lax.scan(
        step_fn,
        state,
        (observations, targets),
    )
    return UPGDMemoryLearningResult(
        state=final_state,
        predictions=predictions,
        metrics=metrics,
    )
