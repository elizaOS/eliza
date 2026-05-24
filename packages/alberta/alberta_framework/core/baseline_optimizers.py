# mypy: disable-error-code="call-arg"
"""Baseline optimizers for continual supervised learning.

Implements baseline optimizers named in the Alberta Plan
(Sutton, Bowling & Pilarski 2022) for Step 1 -- continual supervised
learning with given features:

- AdaGain (Jacobsen et al. 2019)
- Adam (Kingma & Ba 2014)
- RMSprop (Tieleman & Hinton 2012)
- NADALINE -- Normalized Adaptive Linear Element (Sutton 1988b),
  i.e. per-feature normalized LMS

These complement the meta-learning optimizers (LMS, IDBD, Autostep,
ObGD) in :mod:`alberta_framework.core.optimizers` and serve as
reference baselines that any new step-size adaptation method should
beat in the continual setting.

Each optimizer follows the :class:`~alberta_framework.core.optimizers.Optimizer`
protocol: a linear ``update(state, error, observation)`` path returning
:class:`~alberta_framework.core.optimizers.OptimizerUpdate`, and an MLP
path via ``init_for_shape`` / ``update_from_gradient``.

References:
- Jacobsen, A., Schlegel, M., Linke, C., Degris, T., White, A., & White, M.
  (2019). "Meta-Descent for Online, Continual Prediction".
- Kingma, D.P. & Ba, J. (2014). "Adam: A Method for Stochastic
  Optimization" (arXiv: 1412.6980)
- Tieleman, T. & Hinton, G. (2012). "Lecture 6.5 -- rmsprop", COURSERA:
  Neural Networks for Machine Learning
- Sutton, R.S. (1988). "Learning to predict by the methods of temporal
  differences". Machine Learning, 3(1).
- Sutton, R.S., Bowling, M. & Pilarski, P.M. (2022). "The Alberta Plan
  for AI Research" (arXiv: 2208.11173)
"""

from typing import Any

import chex
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float

from alberta_framework.core.optimizers import Optimizer, OptimizerUpdate

# =============================================================================
# State dataclasses
# =============================================================================


@chex.dataclass(frozen=True)
class AdamState:
    """State for the linear Adam optimizer.

    Per-weight first and second moment EMAs plus a step counter for
    bias correction. Bias term has its own scalar moments (since the
    bias gradient is just the error and a per-feature moment array
    would be ill-shaped).

    Attributes:
        m: First moment EMA (per weight)
        v: Second moment EMA (per weight)
        bias_m: First moment EMA for the bias
        bias_v: Second moment EMA for the bias
        t: Time step counter for bias correction
        step_size: Base learning rate (alpha)
        beta1: Decay rate for first moment
        beta2: Decay rate for second moment
        eps: Small constant for numerical stability
    """

    m: Float[Array, " feature_dim"]
    v: Float[Array, " feature_dim"]
    bias_m: Float[Array, ""]
    bias_v: Float[Array, ""]
    t: Float[Array, ""]
    step_size: Float[Array, ""]
    beta1: Float[Array, ""]
    beta2: Float[Array, ""]
    eps: Float[Array, ""]


@chex.dataclass(frozen=True)
class AdamParamState:
    """Per-parameter Adam state for arbitrary-shape parameters (MLP path).

    Mirrors :class:`AdamState` but without the bias-specific scalars --
    each parameter (weight matrix or bias vector) gets its own
    :class:`AdamParamState`.

    Attributes:
        m: First moment EMA, same shape as the parameter
        v: Second moment EMA, same shape as the parameter
        t: Time step counter (scalar) for bias correction
        step_size: Base learning rate (alpha)
        beta1: Decay rate for first moment
        beta2: Decay rate for second moment
        eps: Small constant for numerical stability
    """

    m: Array
    v: Array
    t: Float[Array, ""]
    step_size: Float[Array, ""]
    beta1: Float[Array, ""]
    beta2: Float[Array, ""]
    eps: Float[Array, ""]


@chex.dataclass(frozen=True)
class AdaGainState:
    """State for the AdaGain optimizer.

    Attributes:
        step_sizes: Per-feature adaptive step-sizes
        gradient_trace: Exponential trace of recent linear gradients
        bias_step_size: Adaptive step-size for the bias
        bias_gradient_trace: Exponential trace of recent bias gradients
        meta_step_size: Meta learning rate for gain adaptation
        forgetting_rate: Trace interpolation rate
    """

    step_sizes: Float[Array, " feature_dim"]
    gradient_trace: Float[Array, " feature_dim"]
    bias_step_size: Float[Array, ""]
    bias_gradient_trace: Float[Array, ""]
    meta_step_size: Float[Array, ""]
    forgetting_rate: Float[Array, ""]


@chex.dataclass(frozen=True)
class RMSpropState:
    """State for the linear RMSprop optimizer.

    Per-weight EMA of squared gradients plus a scalar EMA for the bias.

    Attributes:
        v: Squared-gradient EMA (per weight)
        bias_v: Squared-gradient EMA for the bias
        step_size: Base learning rate (alpha)
        decay: EMA decay rate (rho)
        eps: Small constant for numerical stability
    """

    v: Float[Array, " feature_dim"]
    bias_v: Float[Array, ""]
    step_size: Float[Array, ""]
    decay: Float[Array, ""]
    eps: Float[Array, ""]


@chex.dataclass(frozen=True)
class RMSpropParamState:
    """Per-parameter RMSprop state for arbitrary-shape parameters.

    Attributes:
        v: Squared-gradient EMA, same shape as the parameter
        step_size: Base learning rate
        decay: EMA decay rate
        eps: Numerical stability constant
    """

    v: Array
    step_size: Float[Array, ""]
    decay: Float[Array, ""]
    eps: Float[Array, ""]


@chex.dataclass(frozen=True)
class NadalineState:
    """State for the NADALINE optimizer.

    NADALINE (Sutton 1988b -- Normalized ADAptive LINear Element) is
    per-feature normalized LMS: each weight is updated with a step that
    divides by an online estimate of its feature's second moment
    ``E[x_i^2]``. The bias uses plain LMS (no normalization since x_b=1).

    Attributes:
        feature_second_moment: EMA of ``x_i^2`` per weight
        step_size: Base learning rate (alpha)
        decay: EMA decay rate for ``E[x_i^2]``
        eps: Floor for the denominator to avoid division by zero
    """

    feature_second_moment: Float[Array, " feature_dim"]
    step_size: Float[Array, ""]
    decay: Float[Array, ""]
    eps: Float[Array, ""]


# =============================================================================
# AdaGain
# =============================================================================


class AdaGain(Optimizer[Any]):
    """AdaGain-style meta-descent optimizer for linear prediction.

    The implementation keeps one gain per feature and adapts it from the
    correlation between the current gradient and an exponential trace of past
    gradients. Positive correlation increases a gain; negative correlation
    decreases it. The update is intentionally narrow because AdaGain is used
    here as a Step 1 public baseline, not as a deep-network optimizer.
    """

    def __init__(
        self,
        initial_step_size: float = 0.05,
        meta_step_size: float = 0.001,
        forgetting_rate: float = 0.1,
    ):
        """Initialize AdaGain.

        Args:
            initial_step_size: Initial per-feature gain
            meta_step_size: Multiplicative meta-update rate
            forgetting_rate: Interpolation rate for the gradient trace
        """
        self._initial_step_size = initial_step_size
        self._meta_step_size = meta_step_size
        self._forgetting_rate = forgetting_rate

    def to_config(self) -> dict[str, Any]:
        """Serialize configuration to dict."""
        return {
            "type": "AdaGain",
            "initial_step_size": self._initial_step_size,
            "meta_step_size": self._meta_step_size,
            "forgetting_rate": self._forgetting_rate,
        }

    def init(self, feature_dim: int) -> AdaGainState:
        """Initialize AdaGain state."""
        return AdaGainState(
            step_sizes=jnp.full(
                feature_dim, self._initial_step_size, dtype=jnp.float32
            ),
            gradient_trace=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_step_size=jnp.array(self._initial_step_size, dtype=jnp.float32),
            bias_gradient_trace=jnp.array(0.0, dtype=jnp.float32),
            meta_step_size=jnp.array(self._meta_step_size, dtype=jnp.float32),
            forgetting_rate=jnp.array(self._forgetting_rate, dtype=jnp.float32),
        )

    def update(
        self,
        state: AdaGainState,
        error: Array,
        observation: Array,
    ) -> OptimizerUpdate:
        """Compute one AdaGain linear update."""
        error_scalar = jnp.squeeze(error)
        gradient = error_scalar * observation
        bias_gradient = error_scalar

        gain_correlation = gradient * state.gradient_trace
        bias_correlation = bias_gradient * state.bias_gradient_trace

        new_step_sizes = state.step_sizes * jnp.exp(
            state.meta_step_size * gain_correlation
        )
        new_bias_step_size = state.bias_step_size * jnp.exp(
            state.meta_step_size * bias_correlation
        )
        new_step_sizes = jnp.clip(new_step_sizes, 1e-8, 1.0)
        new_bias_step_size = jnp.clip(new_bias_step_size, 1e-8, 1.0)

        weight_delta = new_step_sizes * gradient
        bias_delta = new_bias_step_size * bias_gradient

        trace_mix = state.forgetting_rate
        new_gradient_trace = (
            (1.0 - trace_mix) * state.gradient_trace + trace_mix * gradient
        )
        new_bias_gradient_trace = (
            (1.0 - trace_mix) * state.bias_gradient_trace
            + trace_mix * bias_gradient
        )

        new_state = AdaGainState(
            step_sizes=new_step_sizes,
            gradient_trace=new_gradient_trace,
            bias_step_size=new_bias_step_size,
            bias_gradient_trace=new_bias_gradient_trace,
            meta_step_size=state.meta_step_size,
            forgetting_rate=state.forgetting_rate,
        )
        return OptimizerUpdate(
            weight_delta=weight_delta,
            bias_delta=bias_delta,
            new_state=new_state,
            metrics={
                "mean_step_size": jnp.mean(new_step_sizes),
                "min_step_size": jnp.min(new_step_sizes),
                "max_step_size": jnp.max(new_step_sizes),
            },
        )


# =============================================================================
# Adam
# =============================================================================


class Adam(Optimizer[Any]):
    """Adam optimizer (Kingma & Ba 2014).

    Maintains per-weight first and second moment EMAs of the gradient,
    bias-corrects them at each step, and takes an effective step
    ``alpha * m_hat / (sqrt(v_hat) + eps)``.

    For the linear path (:meth:`update`), the gradient at weight ``i``
    is ``error * x_i`` and the bias gradient is ``error``.

    For the MLP path (:meth:`update_from_gradient`), the gradient is
    pre-computed by the caller (e.g. an eligibility trace or a VJP
    cotangent), and the returned step does NOT include the error --
    callers apply ``param += step`` directly.

    Reference: Kingma, D.P. & Ba, J. (2014). "Adam: A Method for
    Stochastic Optimization" (arXiv: 1412.6980)

    Attributes:
        step_size: Base learning rate alpha (default 0.001)
        beta1: First moment decay (default 0.9)
        beta2: Second moment decay (default 0.999)
        eps: Numerical stability constant (default 1e-8)
    """

    def __init__(
        self,
        step_size: float = 0.001,
        beta1: float = 0.9,
        beta2: float = 0.999,
        eps: float = 1e-8,
    ):
        """Initialize Adam optimizer.

        Args:
            step_size: Base learning rate alpha
            beta1: Exponential decay rate for the first moment
            beta2: Exponential decay rate for the second moment
            eps: Small constant added to the denominator
        """
        self._step_size = step_size
        self._beta1 = beta1
        self._beta2 = beta2
        self._eps = eps

    def to_config(self) -> dict[str, Any]:
        """Serialize configuration to dict."""
        return {
            "type": "Adam",
            "step_size": self._step_size,
            "beta1": self._beta1,
            "beta2": self._beta2,
            "eps": self._eps,
        }

    def init(self, feature_dim: int) -> AdamState:
        """Initialize Adam state.

        Args:
            feature_dim: Dimension of weight vector

        Returns:
            Adam state with zero-initialized moments and ``t = 0``
        """
        return AdamState(
            m=jnp.zeros(feature_dim, dtype=jnp.float32),
            v=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_m=jnp.array(0.0, dtype=jnp.float32),
            bias_v=jnp.array(0.0, dtype=jnp.float32),
            t=jnp.array(0.0, dtype=jnp.float32),
            step_size=jnp.array(self._step_size, dtype=jnp.float32),
            beta1=jnp.array(self._beta1, dtype=jnp.float32),
            beta2=jnp.array(self._beta2, dtype=jnp.float32),
            eps=jnp.array(self._eps, dtype=jnp.float32),
        )

    def init_for_shape(self, shape: tuple[int, ...]) -> AdamParamState:
        """Initialize Adam state for arbitrary-shape parameters.

        Args:
            shape: Shape of the parameter array

        Returns:
            ``AdamParamState`` with arrays matching the given shape
        """
        return AdamParamState(
            m=jnp.zeros(shape, dtype=jnp.float32),
            v=jnp.zeros(shape, dtype=jnp.float32),
            t=jnp.array(0.0, dtype=jnp.float32),
            step_size=jnp.array(self._step_size, dtype=jnp.float32),
            beta1=jnp.array(self._beta1, dtype=jnp.float32),
            beta2=jnp.array(self._beta2, dtype=jnp.float32),
            eps=jnp.array(self._eps, dtype=jnp.float32),
        )

    def update_from_gradient(
        self,
        state: AdamParamState,
        gradient: Array,
        error: Array | None = None,
    ) -> tuple[Array, AdamParamState]:
        """Compute Adam step from a pre-computed gradient (MLP path).

        The returned step has the SAME sign as the descent step, i.e.
        callers apply ``param -= step`` to minimize loss when the
        gradient is the loss gradient. When the gradient is the
        prediction gradient ``dy/dw`` and the caller wants to do
        ``param += error * step``, ``error`` should be passed so it is
        folded into the moment EMAs.

        When ``error`` is ``None``, the gradient is assumed to already
        be the loss gradient and is used as-is.

        Args:
            state: Current per-parameter Adam state
            gradient: Pre-computed gradient (any shape matching state)
            error: Optional prediction error scalar. When provided, the
                effective gradient becomes ``-error * gradient`` (loss
                gradient direction for ``loss = 0.5 * error^2``).

        Returns:
            ``(step, new_state)`` -- step has the same shape as gradient
        """
        if error is not None:
            g = -jnp.squeeze(error) * gradient
        else:
            g = gradient

        new_t = state.t + 1.0
        new_m = state.beta1 * state.m + (1.0 - state.beta1) * g
        new_v = state.beta2 * state.v + (1.0 - state.beta2) * g**2

        m_hat = new_m / (1.0 - state.beta1**new_t)
        v_hat = new_v / (1.0 - state.beta2**new_t)

        step = state.step_size * m_hat / (jnp.sqrt(v_hat) + state.eps)

        new_state = AdamParamState(
            m=new_m,
            v=new_v,
            t=new_t,
            step_size=state.step_size,
            beta1=state.beta1,
            beta2=state.beta2,
            eps=state.eps,
        )
        return step, new_state

    def update(
        self,
        state: AdamState,
        error: Array,
        observation: Array,
    ) -> OptimizerUpdate:
        """Compute Adam weight update (linear path).

        The gradient of the squared-error loss
        ``L = 0.5 * (target - prediction)^2`` w.r.t. weight ``w_i`` is
        ``-error * x_i``; the gradient w.r.t. the bias is ``-error``.
        Since Adam descends along the negative gradient, the resulting
        update ``w += step`` ends up adding a positive multiple of
        ``error * x_i``.

        Args:
            state: Current Adam state
            error: Prediction error scalar
            observation: Feature vector

        Returns:
            ``OptimizerUpdate`` with weight and bias deltas and updated state
        """
        error_scalar = jnp.squeeze(error)
        # Loss gradient: -error * observation, -error
        g = -error_scalar * observation
        g_b = -error_scalar

        new_t = state.t + 1.0
        new_m = state.beta1 * state.m + (1.0 - state.beta1) * g
        new_v = state.beta2 * state.v + (1.0 - state.beta2) * g**2
        new_bias_m = state.beta1 * state.bias_m + (1.0 - state.beta1) * g_b
        new_bias_v = state.beta2 * state.bias_v + (1.0 - state.beta2) * g_b**2

        m_hat = new_m / (1.0 - state.beta1**new_t)
        v_hat = new_v / (1.0 - state.beta2**new_t)
        bias_m_hat = new_bias_m / (1.0 - state.beta1**new_t)
        bias_v_hat = new_bias_v / (1.0 - state.beta2**new_t)

        # Descent step is alpha * m_hat / (sqrt(v_hat) + eps); we apply
        # weight_delta = -descent_step so that the resulting update
        # w += weight_delta moves in the direction that reduces loss.
        weight_delta = -state.step_size * m_hat / (jnp.sqrt(v_hat) + state.eps)
        bias_delta = -state.step_size * bias_m_hat / (jnp.sqrt(bias_v_hat) + state.eps)

        new_state = AdamState(
            m=new_m,
            v=new_v,
            bias_m=new_bias_m,
            bias_v=new_bias_v,
            t=new_t,
            step_size=state.step_size,
            beta1=state.beta1,
            beta2=state.beta2,
            eps=state.eps,
        )

        return OptimizerUpdate(
            weight_delta=weight_delta,
            bias_delta=bias_delta,
            new_state=new_state,
            metrics={
                "step_size": state.step_size,
                "mean_m": jnp.mean(new_m),
                "mean_v": jnp.mean(new_v),
                "t": new_t,
            },
        )


# =============================================================================
# RMSprop
# =============================================================================


class RMSprop(Optimizer[Any]):
    """RMSprop optimizer (Tieleman & Hinton 2012).

    Maintains a per-weight EMA of squared gradients and divides each
    step by ``sqrt(v) + eps``, providing per-parameter adaptive scaling
    without bias correction.

    Reference: Tieleman, T. & Hinton, G. (2012). "Lecture 6.5 --
    rmsprop: Divide the gradient by a running average of its recent
    magnitude", COURSERA: Neural Networks for Machine Learning.

    Attributes:
        step_size: Base learning rate alpha (default 0.001)
        decay: Squared-gradient EMA decay rho (default 0.99)
        eps: Numerical stability constant (default 1e-8)
    """

    def __init__(
        self,
        step_size: float = 0.001,
        decay: float = 0.99,
        eps: float = 1e-8,
    ):
        """Initialize RMSprop optimizer.

        Args:
            step_size: Base learning rate alpha
            decay: Decay rate for the squared-gradient EMA
            eps: Small constant added to the denominator
        """
        self._step_size = step_size
        self._decay = decay
        self._eps = eps

    def to_config(self) -> dict[str, Any]:
        """Serialize configuration to dict."""
        return {
            "type": "RMSprop",
            "step_size": self._step_size,
            "decay": self._decay,
            "eps": self._eps,
        }

    def init(self, feature_dim: int) -> RMSpropState:
        """Initialize RMSprop state.

        Args:
            feature_dim: Dimension of weight vector

        Returns:
            RMSprop state with zero-initialized squared-gradient EMA
        """
        return RMSpropState(
            v=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_v=jnp.array(0.0, dtype=jnp.float32),
            step_size=jnp.array(self._step_size, dtype=jnp.float32),
            decay=jnp.array(self._decay, dtype=jnp.float32),
            eps=jnp.array(self._eps, dtype=jnp.float32),
        )

    def init_for_shape(self, shape: tuple[int, ...]) -> RMSpropParamState:
        """Initialize RMSprop state for arbitrary-shape parameters.

        Args:
            shape: Shape of the parameter array

        Returns:
            ``RMSpropParamState`` with arrays matching the given shape
        """
        return RMSpropParamState(
            v=jnp.zeros(shape, dtype=jnp.float32),
            step_size=jnp.array(self._step_size, dtype=jnp.float32),
            decay=jnp.array(self._decay, dtype=jnp.float32),
            eps=jnp.array(self._eps, dtype=jnp.float32),
        )

    def update_from_gradient(
        self,
        state: RMSpropParamState,
        gradient: Array,
        error: Array | None = None,
    ) -> tuple[Array, RMSpropParamState]:
        """Compute RMSprop step from a pre-computed gradient (MLP path).

        When ``error`` is supplied, the effective gradient is treated as
        ``-error * gradient`` (loss gradient for squared error); when it
        is ``None`` the gradient is used as-is (already a loss gradient).

        Args:
            state: Current per-parameter RMSprop state
            gradient: Pre-computed gradient (any shape matching state)
            error: Optional prediction error scalar

        Returns:
            ``(step, new_state)`` -- step has the same shape as gradient
        """
        if error is not None:
            g = -jnp.squeeze(error) * gradient
        else:
            g = gradient

        new_v = state.decay * state.v + (1.0 - state.decay) * g**2
        step = state.step_size * g / (jnp.sqrt(new_v) + state.eps)

        new_state = RMSpropParamState(
            v=new_v,
            step_size=state.step_size,
            decay=state.decay,
            eps=state.eps,
        )
        return step, new_state

    def update(
        self,
        state: RMSpropState,
        error: Array,
        observation: Array,
    ) -> OptimizerUpdate:
        """Compute RMSprop weight update (linear path).

        The squared-error loss gradient w.r.t. weight ``i`` is
        ``-error * x_i`` and w.r.t. the bias is ``-error``. The descent
        step is ``alpha * g / (sqrt(v) + eps)``; the returned weight
        delta is the negative of that descent step so that ``w += delta``
        moves in the loss-reducing direction.

        Args:
            state: Current RMSprop state
            error: Prediction error scalar
            observation: Feature vector

        Returns:
            ``OptimizerUpdate`` with weight and bias deltas and updated state
        """
        error_scalar = jnp.squeeze(error)
        g = -error_scalar * observation
        g_b = -error_scalar

        new_v = state.decay * state.v + (1.0 - state.decay) * g**2
        new_bias_v = state.decay * state.bias_v + (1.0 - state.decay) * g_b**2

        weight_delta = -state.step_size * g / (jnp.sqrt(new_v) + state.eps)
        bias_delta = -state.step_size * g_b / (jnp.sqrt(new_bias_v) + state.eps)

        new_state = RMSpropState(
            v=new_v,
            bias_v=new_bias_v,
            step_size=state.step_size,
            decay=state.decay,
            eps=state.eps,
        )

        return OptimizerUpdate(
            weight_delta=weight_delta,
            bias_delta=bias_delta,
            new_state=new_state,
            metrics={
                "step_size": state.step_size,
                "mean_v": jnp.mean(new_v),
            },
        )


# =============================================================================
# NADALINE
# =============================================================================


class NADALINE(Optimizer[Any]):
    """NADALINE optimizer -- Normalized ADAptive LINear Element (Sutton 1988b).

    Per-feature normalized LMS: each weight ``w_i`` is updated by
    ``alpha * error * x_i / max(eps, EMA(x_i^2))``. This compensates for
    features with very different scales and makes the effective step
    size for each weight roughly invariant to the magnitude of its
    feature. The bias term is updated with plain LMS (no normalization
    since the bias "feature" is constant 1).

    Attributes:
        step_size: Base learning rate alpha (default 0.01)
        decay: EMA decay rate for ``E[x_i^2]`` (default 0.99)
        eps: Floor for the denominator (default 1e-8)
    """

    def __init__(
        self,
        step_size: float = 0.01,
        decay: float = 0.99,
        eps: float = 1e-8,
    ):
        """Initialize NADALINE optimizer.

        Args:
            step_size: Base learning rate alpha
            decay: EMA decay rate for the per-feature second moment
            eps: Floor on the denominator to avoid division by zero
        """
        self._step_size = step_size
        self._decay = decay
        self._eps = eps

    def to_config(self) -> dict[str, Any]:
        """Serialize configuration to dict."""
        return {
            "type": "NADALINE",
            "step_size": self._step_size,
            "decay": self._decay,
            "eps": self._eps,
        }

    def init(self, feature_dim: int) -> NadalineState:
        """Initialize NADALINE state.

        Args:
            feature_dim: Dimension of weight vector

        Returns:
            NADALINE state with zero-initialized second-moment EMA
        """
        return NadalineState(
            feature_second_moment=jnp.zeros(feature_dim, dtype=jnp.float32),
            step_size=jnp.array(self._step_size, dtype=jnp.float32),
            decay=jnp.array(self._decay, dtype=jnp.float32),
            eps=jnp.array(self._eps, dtype=jnp.float32),
        )

    def update(
        self,
        state: NadalineState,
        error: Array,
        observation: Array,
    ) -> OptimizerUpdate:
        """Compute NADALINE weight update.

        Update rule:

        1. ``E[x_i^2] <- decay * E[x_i^2] + (1 - decay) * x_i^2``
        2. ``w_i += alpha * error * x_i / max(eps, E[x_i^2])``
        3. ``b += alpha * error`` (plain LMS for bias)

        Args:
            state: Current NADALINE state
            error: Prediction error scalar
            observation: Feature vector

        Returns:
            ``OptimizerUpdate`` with normalized weight delta and unnormalized
            bias delta.
        """
        error_scalar = jnp.squeeze(error)
        new_second_moment = (
            state.decay * state.feature_second_moment
            + (1.0 - state.decay) * observation**2
        )

        denom = jnp.maximum(state.eps, new_second_moment)
        weight_delta = state.step_size * error_scalar * observation / denom

        # Bias uses plain LMS -- no normalization (x_b == 1).
        bias_delta = state.step_size * error_scalar

        new_state = NadalineState(
            feature_second_moment=new_second_moment,
            step_size=state.step_size,
            decay=state.decay,
            eps=state.eps,
        )

        return OptimizerUpdate(
            weight_delta=weight_delta,
            bias_delta=bias_delta,
            new_state=new_state,
            metrics={
                "step_size": state.step_size,
                "mean_second_moment": jnp.mean(new_second_moment),
                "mean_denom": jnp.mean(denom),
            },
        )
