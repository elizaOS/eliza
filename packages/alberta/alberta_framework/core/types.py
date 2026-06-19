"""Type definitions for the Alberta Framework.

This module defines the core data types used throughout the framework,
using chex dataclasses for JAX compatibility and jaxtyping for shape annotations.
"""

import enum
import time
from collections.abc import Sequence
from typing import Any

import chex
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.normalizers import (
    AnyNormalizerState,
)

# Type aliases for clarity
Observation = Array  # x_t: feature vector
Target = Array  # y*_t: desired output
Prediction = Array  # y_t: model output
Reward = float  # r_t: scalar reward


@chex.dataclass(frozen=True)
class TimeStep:
    """Single experience from an experience stream.

    Attributes:
        observation: Feature vector x_t
        target: Desired output y*_t (for supervised learning)
    """

    observation: Float[Array, " feature_dim"]
    target: Float[Array, " 1"]


@chex.dataclass(frozen=True)
class LMSState:
    """State for the LMS (Least Mean Square) optimizer.

    LMS uses a fixed step-size, so state only tracks the step-size parameter.

    Attributes:
        step_size: Fixed learning rate alpha
    """

    step_size: Float[Array, ""]


@chex.dataclass(frozen=True)
class IDBDState:
    """State for the IDBD (Incremental Delta-Bar-Delta) optimizer.

    IDBD maintains per-weight adaptive step-sizes that are meta-learned
    based on the correlation of successive gradients.

    Reference: Sutton 1992, "Adapting Bias by Gradient Descent"

    Attributes:
        log_step_sizes: Log of per-weight step-sizes (log alpha_i)
        traces: Per-weight traces h_i for gradient correlation
        meta_step_size: Meta learning rate beta for adapting step-sizes
        bias_step_size: Step-size for the bias term
        bias_trace: Trace for the bias term
    """

    log_step_sizes: Float[Array, " feature_dim"]  # log(alpha_i) for numerical stability
    traces: Float[Array, " feature_dim"]  # h_i: trace of weight-feature products
    meta_step_size: Float[Array, ""]  # beta: step-size for the step-sizes
    bias_step_size: Float[Array, ""]  # Step-size for bias
    bias_trace: Float[Array, ""]  # Trace for bias


@chex.dataclass(frozen=True)
class AutostepState:
    """State for the Autostep optimizer.

    Autostep is a tuning-free step-size adaptation algorithm that adapts
    per-weight step-sizes based on meta-gradient correlation, with
    self-regulated normalizers to stabilize the meta-update.

    Reference: Mahmood et al. 2012, "Tuning-free step-size adaptation", Table 1

    Attributes:
        step_sizes: Per-weight step-sizes (alpha_i)
        traces: Per-weight traces for gradient correlation (h_i)
        normalizers: Running normalizer of meta-gradient magnitude |delta*x*h| (v_i)
        meta_step_size: Meta learning rate mu for adapting step-sizes
        tau: Time constant for normalizer adaptation (higher = slower decay)
        bias_step_size: Step-size for the bias term
        bias_trace: Trace for the bias term
        bias_normalizer: Normalizer for the bias meta-gradient
    """

    step_sizes: Float[Array, " feature_dim"]  # alpha_i
    traces: Float[Array, " feature_dim"]  # h_i
    normalizers: Float[Array, " feature_dim"]  # v_i: running normalizer of |δ*x*h|
    meta_step_size: Float[Array, ""]  # mu
    tau: Float[Array, ""]  # time constant for normalizer
    bias_step_size: Float[Array, ""]
    bias_trace: Float[Array, ""]
    bias_normalizer: Float[Array, ""]


@chex.dataclass(frozen=True)
class AutostepGTDLambdaState:
    """State for the Autostep-for-GTD(lambda) optimizer.

    Implements the supervised limit of the Autostep-style normalized
    GTD(lambda) update from Kearney, Veeriah, Travnik, Pilarski & Sutton 2019,
    "Learning Feature Relevance Through Step Size Adaptation in
    Temporal-Difference Learning". The optimizer carries an eligibility trace
    ``z_i`` and a per-decision importance-sampling ratio so the same code path
    handles both linear supervised learning (``gamma=0``, ``lamda=0``,
    ``rho=1``) and GTD(lambda) prediction.

    Attributes:
        step_sizes: Per-weight step-sizes ``alpha_i``
        traces: Per-weight h-traces for gradient correlation ``h_i``
        normalizers: Self-regulated meta-gradient normalizers ``v_i``
        eligibility_traces: GTD(lambda) eligibility traces ``z_i``
        meta_step_size: Meta learning rate ``mu``
        tau: Time constant for normalizer adaptation
        trace_decay: Eligibility trace decay ``lamda``
            (``0`` recovers Autostep)
        bias_step_size: Step-size for the bias term
        bias_trace: Trace for the bias term
        bias_normalizer: Normalizer for the bias meta-gradient
        bias_eligibility_trace: Bias eligibility trace
    """

    step_sizes: Float[Array, " feature_dim"]
    traces: Float[Array, " feature_dim"]
    normalizers: Float[Array, " feature_dim"]
    eligibility_traces: Float[Array, " feature_dim"]
    meta_step_size: Float[Array, ""]
    tau: Float[Array, ""]
    trace_decay: Float[Array, ""]
    bias_step_size: Float[Array, ""]
    bias_trace: Float[Array, ""]
    bias_normalizer: Float[Array, ""]
    bias_eligibility_trace: Float[Array, ""]


@chex.dataclass(frozen=True)
class IDBDParamState:
    """Per-parameter IDBD state for use with arbitrary-shape parameters.

    Used by ``IDBD.init_for_shape`` / ``IDBD.update_from_gradient``
    for MLP (or other multi-parameter) learners. Unlike ``IDBDState``,
    this type has no bias-specific fields -- each parameter (weight matrix,
    bias vector) gets its own ``IDBDParamState``.

    Implements Meyer's adaptation of IDBD for nonlinear models: replaces
    ``x^2`` in the h-decay term with ``(dy/dw)^2`` (squared prediction
    gradients), which generalizes IDBD to arbitrary architectures.

    Reference: Meyer, https://github.com/ejmejm/phd_research

    Attributes:
        log_step_sizes: Log of per-element step-sizes, same shape as the parameter
        traces: Per-element h traces for gradient correlation
        meta_step_size: Meta learning rate beta
    """

    log_step_sizes: Array  # same shape as the parameter
    traces: Array  # same shape as the parameter
    meta_step_size: Float[Array, ""]


@chex.dataclass(frozen=True)
class AutostepParamState:
    """Per-parameter Autostep state for use with arbitrary-shape parameters.

    Used by ``Autostep.init_for_shape`` / ``Autostep.update_from_gradient``
    for MLP (or other multi-parameter) learners. Unlike ``AutostepState``,
    this type has no bias-specific fields -- each parameter (weight matrix,
    bias vector) gets its own ``AutostepParamState``.

    Attributes:
        step_sizes: Per-element step-sizes, same shape as the parameter
        traces: Per-element traces for gradient correlation
        normalizers: Running normalizer of meta-gradient magnitude |delta*z*h|
        meta_step_size: Meta learning rate mu
        tau: Time constant for normalizer adaptation
    """

    step_sizes: Array  # same shape as the parameter
    traces: Array  # same shape as the parameter
    normalizers: Array  # same shape as the parameter
    meta_step_size: Float[Array, ""]
    tau: Float[Array, ""]


@chex.dataclass(frozen=True)
class ObGDState:
    """State for the ObGD (Observation-bounded Gradient Descent) optimizer.

    ObGD prevents overshooting by dynamically bounding the effective step-size
    based on the magnitude of the TD error and eligibility traces. When the
    combined update magnitude would be too large, the step-size is scaled down.

    For supervised learning (gamma=0, lamda=0), traces equal the current
    observation each step, making ObGD equivalent to LMS with dynamic
    step-size bounding.

    Reference: Elsayed et al. 2024, "Streaming Deep Reinforcement Learning
    Finally Works"

    Attributes:
        step_size: Base learning rate alpha
        kappa: Bounding sensitivity parameter (higher = more conservative)
        traces: Per-weight eligibility traces z_i
        bias_trace: Eligibility trace for the bias term
        gamma: Discount factor for trace decay
        lamda: Eligibility trace decay parameter lambda
    """

    step_size: Float[Array, ""]
    kappa: Float[Array, ""]
    traces: Float[Array, " feature_dim"]
    bias_trace: Float[Array, ""]
    gamma: Float[Array, ""]
    lamda: Float[Array, ""]


@chex.dataclass(frozen=True)
class LearnerState:
    """State for a linear learner.

    Attributes:
        weights: Weight vector for linear prediction
        bias: Bias term
        optimizer_state: State maintained by the optimizer
        normalizer_state: Optional state for online feature normalization
    """

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    optimizer_state: (
        LMSState | IDBDState | AutostepState | AutostepGTDLambdaState | ObGDState
    )
    normalizer_state: AnyNormalizerState | None = None
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class StepSizeTrackingConfig:
    """Configuration for recording per-weight step-sizes during training.

    Attributes:
        interval: Record step-sizes every N steps
        include_bias: Whether to also record the bias step-size
    """

    interval: int
    include_bias: bool = True


@chex.dataclass(frozen=True)
class StepSizeHistory:
    """History of per-weight step-sizes recorded during training.

    Attributes:
        step_sizes: Per-weight step-sizes at each recording, shape (num_recordings, num_weights)
        bias_step_sizes: Bias step-sizes at each recording, shape (num_recordings,) or None
        recording_indices: Step indices where recordings were made, shape (num_recordings,)
        normalizers: Autostep's per-weight normalizers (v_i) at each recording,
            shape (num_recordings, num_weights) or None. Only populated for Autostep optimizer.
    """

    step_sizes: Float[Array, "num_recordings feature_dim"]
    bias_step_sizes: Float[Array, " num_recordings"] | None
    recording_indices: Int[Array, " num_recordings"]
    normalizers: Float[Array, "num_recordings feature_dim"] | None = None


@chex.dataclass(frozen=True)
class NormalizerTrackingConfig:
    """Configuration for recording per-feature normalizer state during training.

    Attributes:
        interval: Record normalizer state every N steps
    """

    interval: int


@chex.dataclass(frozen=True)
class NormalizerHistory:
    """History of per-feature normalizer state recorded during training.

    Used for analyzing how the normalizer (EMA or Welford) adapts to
    distribution shifts (reactive lag diagnostic).

    Attributes:
        means: Per-feature mean estimates at each recording, shape (num_recordings, feature_dim)
        variances: Per-feature variance estimates at each recording,
            shape (num_recordings, feature_dim)
        recording_indices: Step indices where recordings were made, shape (num_recordings,)
    """

    means: Float[Array, "num_recordings feature_dim"]
    variances: Float[Array, "num_recordings feature_dim"]
    recording_indices: Int[Array, " num_recordings"]


@chex.dataclass(frozen=True)
class BatchedLearningResult:
    """Result from batched learning loop across multiple seeds.

    Used with ``run_learning_loop_batched`` for vmap-based GPU parallelization.

    Attributes:
        states: Batched learner states - each array has shape (num_seeds, ...)
        metrics: Metrics array with shape (num_seeds, num_steps, num_cols)
            where num_cols is 3 (no normalizer) or 4 (with normalizer)
        step_size_history: Optional step-size history with batched shapes,
            or None if tracking was disabled
        normalizer_history: Optional normalizer history with batched shapes,
            or None if tracking was disabled
    """

    states: LearnerState  # Batched: each array has shape (num_seeds, ...)
    metrics: Array
    step_size_history: StepSizeHistory | None
    normalizer_history: NormalizerHistory | None = None


# =============================================================================
# MLP Types (Step 2 of Alberta Plan)
# =============================================================================


@chex.dataclass(frozen=True)
class MLPParams:
    """Parameters for a multi-layer perceptron.

    Uses tuples of arrays (not lists) for proper JAX PyTree handling.

    Attributes:
        weights: Tuple of weight matrices, one per layer
        biases: Tuple of bias vectors, one per layer
    """

    weights: tuple[Array, ...]
    biases: tuple[Array, ...]


@chex.dataclass(frozen=True)
class MLPLearnerState:
    """State for an MLP learner.

    Attributes:
        params: MLP parameters (weights and biases for each layer)
        optimizer_states: Tuple of per-parameter optimizer states (weights + biases)
        traces: Tuple of per-parameter eligibility traces
        normalizer_state: Optional state for online feature normalization
        neuron_utility: Per-hidden-unit EMA of gradient L2 norm; one array of
            shape ``(h_i,)`` per hidden layer.  ``None`` when tracking is
            disabled (``MLPLearner(track_neuron_utility=False)``).
    """

    params: MLPParams
    optimizer_states: tuple[LMSState | AutostepState | AutostepParamState | IDBDParamState, ...]
    traces: tuple[Array, ...]
    normalizer_state: AnyNormalizerState | None = None
    neuron_utility: tuple[Array, ...] | None = None
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class BatchedMLPResult:
    """Result from batched MLP learning loop across multiple seeds.

    Used with ``run_mlp_learning_loop_batched`` for vmap-based GPU parallelization.

    Attributes:
        states: Batched MLP learner states - each array has shape (num_seeds, ...)
        metrics: Metrics array with shape (num_seeds, num_steps, num_cols)
            where num_cols is 3 (no normalizer) or 4 (with normalizer)
        normalizer_history: Optional normalizer history with batched shapes,
            or None if tracking was disabled
    """

    states: MLPLearnerState  # Batched: each array has shape (num_seeds, ...)
    metrics: Array
    normalizer_history: NormalizerHistory | None = None


# =============================================================================
# TD Learning Types (for Step 3+ of Alberta Plan)
# =============================================================================


@chex.dataclass(frozen=True)
class TDTimeStep:
    """Single experience from a TD stream.

    Represents a transition (s, r, s', gamma) for temporal-difference learning.

    Attributes:
        observation: Feature vector phi(s)
        reward: Reward R received
        next_observation: Feature vector phi(s')
        gamma: Discount factor gamma_t (0 at terminal states)
    """

    observation: Float[Array, " feature_dim"]
    reward: Float[Array, ""]
    next_observation: Float[Array, " feature_dim"]
    gamma: Float[Array, ""]


@chex.dataclass(frozen=True)
class TDIDBDState:
    """State for the TD-IDBD (Temporal-Difference IDBD) optimizer.

    TD-IDBD extends IDBD to temporal-difference learning with eligibility traces.
    Maintains per-weight adaptive step-sizes that are meta-learned based on
    gradient correlation in the TD setting.

    Reference: Kearney et al. 2019, "Learning Feature Relevance Through Step Size
    Adaptation in Temporal-Difference Learning"

    Attributes:
        log_step_sizes: Log of per-weight step-sizes (log alpha_i)
        eligibility_traces: Eligibility traces z_i for temporal credit assignment
        h_traces: Per-weight h traces for gradient correlation
        meta_step_size: Meta learning rate theta for adapting step-sizes
        trace_decay: Eligibility trace decay parameter lambda
        bias_log_step_size: Log step-size for the bias term
        bias_eligibility_trace: Eligibility trace for the bias
        bias_h_trace: h trace for the bias term
    """

    log_step_sizes: Float[Array, " feature_dim"]
    eligibility_traces: Float[Array, " feature_dim"]
    h_traces: Float[Array, " feature_dim"]
    meta_step_size: Float[Array, ""]
    trace_decay: Float[Array, ""]
    bias_log_step_size: Float[Array, ""]
    bias_eligibility_trace: Float[Array, ""]
    bias_h_trace: Float[Array, ""]


@chex.dataclass(frozen=True)
class AutoTDIDBDState:
    """State for the AutoTDIDBD optimizer.

    AutoTDIDBD adds AutoStep-style normalization to TDIDBD for improved stability.
    Includes normalizers for the meta-weight updates and effective step-size
    normalization to prevent overshooting.

    Reference: Kearney et al. 2019, Algorithm 6

    Attributes:
        log_step_sizes: Log of per-weight step-sizes (log alpha_i)
        eligibility_traces: Eligibility traces z_i
        h_traces: Per-weight h traces for gradient correlation
        normalizers: Running max of absolute gradient correlations (eta_i)
        meta_step_size: Meta learning rate theta
        trace_decay: Eligibility trace decay parameter lambda
        normalizer_decay: Decay parameter tau for normalizers
        bias_log_step_size: Log step-size for the bias term
        bias_eligibility_trace: Eligibility trace for the bias
        bias_h_trace: h trace for the bias term
        bias_normalizer: Normalizer for the bias gradient correlation
    """

    log_step_sizes: Float[Array, " feature_dim"]
    eligibility_traces: Float[Array, " feature_dim"]
    h_traces: Float[Array, " feature_dim"]
    normalizers: Float[Array, " feature_dim"]
    meta_step_size: Float[Array, ""]
    trace_decay: Float[Array, ""]
    normalizer_decay: Float[Array, ""]
    bias_log_step_size: Float[Array, ""]
    bias_eligibility_trace: Float[Array, ""]
    bias_h_trace: Float[Array, ""]
    bias_normalizer: Float[Array, ""]


# Union type for TD optimizer states
TDOptimizerState = TDIDBDState | AutoTDIDBDState


@chex.dataclass(frozen=True)
class TDLearnerState:
    """State for a TD linear learner.

    Attributes:
        weights: Weight vector for linear value function approximation
        bias: Bias term
        optimizer_state: State maintained by the TD optimizer
    """

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    optimizer_state: TDOptimizerState
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


def create_obgd_state(
    feature_dim: int,
    step_size: float = 1.0,
    kappa: float = 2.0,
    gamma: float = 0.0,
    lamda: float = 0.0,
) -> ObGDState:
    """Create initial ObGD optimizer state.

    Args:
        feature_dim: Dimension of the feature vector
        step_size: Base learning rate (default: 1.0)
        kappa: Bounding sensitivity parameter (default: 2.0)
        gamma: Discount factor for trace decay (default: 0.0 for supervised)
        lamda: Eligibility trace decay parameter (default: 0.0 for supervised)

    Returns:
        Initial ObGD state
    """
    return ObGDState(
        step_size=jnp.array(step_size, dtype=jnp.float32),
        kappa=jnp.array(kappa, dtype=jnp.float32),
        traces=jnp.zeros(feature_dim, dtype=jnp.float32),
        bias_trace=jnp.array(0.0, dtype=jnp.float32),
        gamma=jnp.array(gamma, dtype=jnp.float32),
        lamda=jnp.array(lamda, dtype=jnp.float32),
    )


def create_tdidbd_state(
    feature_dim: int,
    initial_step_size: float = 0.01,
    meta_step_size: float = 0.01,
    trace_decay: float = 0.0,
) -> TDIDBDState:
    """Create initial TD-IDBD optimizer state.

    Args:
        feature_dim: Dimension of the feature vector
        initial_step_size: Initial per-weight step-size
        meta_step_size: Meta learning rate theta for adapting step-sizes
        trace_decay: Eligibility trace decay parameter lambda (0 = TD(0))

    Returns:
        Initial TD-IDBD state
    """
    return TDIDBDState(
        log_step_sizes=jnp.full(feature_dim, jnp.log(initial_step_size), dtype=jnp.float32),
        eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
        h_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
        meta_step_size=jnp.array(meta_step_size, dtype=jnp.float32),
        trace_decay=jnp.array(trace_decay, dtype=jnp.float32),
        bias_log_step_size=jnp.array(jnp.log(initial_step_size), dtype=jnp.float32),
        bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
        bias_h_trace=jnp.array(0.0, dtype=jnp.float32),
    )


def create_autotdidbd_state(
    feature_dim: int,
    initial_step_size: float = 0.01,
    meta_step_size: float = 0.01,
    trace_decay: float = 0.0,
    normalizer_decay: float = 10000.0,
) -> AutoTDIDBDState:
    """Create initial AutoTDIDBD optimizer state.

    Args:
        feature_dim: Dimension of the feature vector
        initial_step_size: Initial per-weight step-size
        meta_step_size: Meta learning rate theta for adapting step-sizes
        trace_decay: Eligibility trace decay parameter lambda (0 = TD(0))
        normalizer_decay: Decay parameter tau for normalizers (default: 10000)

    Returns:
        Initial AutoTDIDBD state
    """
    return AutoTDIDBDState(
        log_step_sizes=jnp.full(feature_dim, jnp.log(initial_step_size), dtype=jnp.float32),
        eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
        h_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
        normalizers=jnp.ones(feature_dim, dtype=jnp.float32),
        meta_step_size=jnp.array(meta_step_size, dtype=jnp.float32),
        trace_decay=jnp.array(trace_decay, dtype=jnp.float32),
        normalizer_decay=jnp.array(normalizer_decay, dtype=jnp.float32),
        bias_log_step_size=jnp.array(jnp.log(initial_step_size), dtype=jnp.float32),
        bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
        bias_h_trace=jnp.array(0.0, dtype=jnp.float32),
        bias_normalizer=jnp.array(1.0, dtype=jnp.float32),
    )


def agent_age_s(state: object) -> float:
    """Compute agent age in seconds (wall-clock time since birth).

    Args:
        state: Any learner state with a ``birth_timestamp`` attribute

    Returns:
        Seconds elapsed since the agent was initialized
    """
    return time.time() - getattr(state, "birth_timestamp", 0.0)


def agent_uptime_s(state: object) -> float:
    """Return the agent's cumulative active uptime in seconds.

    Args:
        state: Any learner state with an ``uptime_s`` attribute

    Returns:
        Cumulative seconds the agent has spent inside learning loops
    """
    return float(getattr(state, "uptime_s", 0.0))


# =============================================================================
# GVF / Horde Types (Step 3 of Alberta Plan)
# =============================================================================


class DemonType(enum.Enum):
    """Type of GVF demon.

    A prediction demon has a fixed policy and learns to predict.
    A control demon learns a policy (e.g. via SARSA) — Step 4.
    """

    PREDICTION = "prediction"
    CONTROL = "control"


class TraceMode(enum.Enum):
    """Eligibility trace accumulation mode.

    ACCUMULATING: Standard accumulating traces (Sutton & Barto, default).
        ``e_t = gamma * lambda * e_{t-1} + grad_t``

    REPLACING: Replacing traces (Singh & Sutton 1996).
        For each parameter element, if the current gradient is nonzero,
        replace the trace with the gradient; otherwise decay the old trace.
        ``e_t[i] = grad_t[i]  if grad_t[i] != 0  else  gamma * lambda * e_{t-1}[i]``

    For gamma*lambda=0 both modes produce identical results (trace = gradient).
    """

    ACCUMULATING = "accumulating"
    REPLACING = "replacing"


@chex.dataclass(frozen=True)
class GVFSpec:
    """One GVF demon's question functions (Sutton et al. 2011).

    Declarative, not callable — JAX pytree-compatible.
    Cumulant values are computed externally and passed as arrays.

    Attributes:
        name: Human-readable name for this demon
        demon_type: Whether this is a prediction or control demon
        gamma: Pseudo-termination discount (0.0 = single-step prediction)
        lamda: Trace decay parameter (0.0 = no eligibility traces)
        cumulant_index: Index into targets array, or -1 for external cumulant
        terminal_reward: Terminal pseudo-reward z (default 0.0)
    """

    name: str
    demon_type: DemonType
    gamma: float
    lamda: float
    cumulant_index: int
    terminal_reward: float = 0.0

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict.

        Returns:
            Dict with all fields needed to recreate the GVFSpec.
        """
        return {
            "name": self.name,
            "demon_type": self.demon_type.value,
            "gamma": self.gamma,
            "lamda": self.lamda,
            "cumulant_index": self.cumulant_index,
            "terminal_reward": self.terminal_reward,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "GVFSpec":
        """Reconstruct from config dict.

        Args:
            config: Dict as produced by ``to_config()``

        Returns:
            Reconstructed GVFSpec
        """
        config = dict(config)
        config["demon_type"] = DemonType(config["demon_type"])
        return cls(**config)


@chex.dataclass(frozen=True)
class HordeSpec:
    """Collection of GVF demons, one per head.

    Attributes:
        demons: Tuple of GVFSpec, one per demon/head
        gammas: Pre-computed gamma array for JIT, shape ``(n_demons,)``
        lamdas: Pre-computed lambda array for JIT, shape ``(n_demons,)``
    """

    demons: tuple[GVFSpec, ...]
    gammas: Float[Array, " n_demons"]
    lamdas: Float[Array, " n_demons"]

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict.

        Returns:
            Dict with demons list, each serialized via ``GVFSpec.to_config()``.
        """
        return {
            "demons": [d.to_config() for d in self.demons],
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "HordeSpec":
        """Reconstruct from config dict.

        Args:
            config: Dict as produced by ``to_config()``

        Returns:
            Reconstructed HordeSpec via ``create_horde_spec``
        """
        demons = [GVFSpec.from_config(d) for d in config["demons"]]
        return create_horde_spec(demons)


def create_horde_spec(demons: Sequence[GVFSpec]) -> HordeSpec:
    """Create a HordeSpec from a sequence of GVFSpec demons.

    Pre-computes gamma and lambda arrays for efficient JIT usage.

    Args:
        demons: Sequence of GVFSpec, one per demon/head

    Returns:
        HordeSpec with pre-computed arrays
    """
    demons_tuple = tuple(demons)
    gammas = jnp.array([d.gamma for d in demons_tuple], dtype=jnp.float32)
    lamdas = jnp.array([d.lamda for d in demons_tuple], dtype=jnp.float32)
    return HordeSpec(demons=demons_tuple, gammas=gammas, lamdas=lamdas)
