"""Off-policy TD learner with importance sampling (Step 3 Phase E).

Implements per-decision importance sampling with optional Retrace-style
ratio clipping for stable off-policy linear value function learning.

Theoretical background:
    TD with linear function approximation is **not** guaranteed to
    converge under off-policy distributions (Baird 1995, Counterexample
    to TD with FA). Several remedies exist:

    1. Per-decision importance sampling (Precup, Sutton, Singh 2000):
       multiply each step's update by rho_t = pi(a_t|s_t) / b(a_t|s_t)
       so that on average we are simulating the on-policy distribution.
       Variance can be very large.
    2. Retrace ratio clipping (Munos et al. 2016): use
       rho_clipped = min(c, rho_t). Convergent for c <= 1; for c > 1 it
       trades bias for variance reduction.
    3. Gradient-TD (TDC, GQ-lambda) (Sutton, Maei, et al. 2009-2010):
       gradient descent on the projected Bellman error.
    4. Emphatic TD (Sutton, Mahmood, White 2016): emphasis traces F_t
       restore on-policy convergence proofs without a secondary weight
       vector.

    This module implements (1), (2), and ETD(lambda) from (4). Gradient-TD
    variants are deferred because they require a secondary weight vector.

The learner has a simple interface::

    learner = OffPolicyTDLinearLearner(step_size=0.05, retrace_clip=1.0)
    state = learner.init(feature_dim)
    for t in range(T):
        rho_t = pi(a_t | s_t) / b(a_t | s_t)
        result = learner.update(state, obs_t, reward, next_obs, gamma, rho_t)
        state = result.state

Setting ``rho_t = 1.0`` reduces this to standard semi-gradient TD(0).

Use cases (Step 3 DoD-5):
    - Counterfactual prediction: "what would value be under target policy?"
    - Auxiliary Horde demons learning about hand-specified target policies.
    - Baird counterexample / divergence-prevention demonstrations.

Reference:
    Precup, D., Sutton, R.S., & Singh, S. (2000). Eligibility traces for
    off-policy policy evaluation. *ICML*.
    Munos, R., Stepleton, T., Harutyunyan, A., & Bellemare, M. (2016).
    Safe and efficient off-policy reinforcement learning. *NeurIPS*.
"""

from __future__ import annotations

import functools
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float, Int

from alberta_framework.core.types import Observation

# =============================================================================
# State / result types
# =============================================================================


@chex.dataclass(frozen=True)
class OffPolicyTDState:
    """State for the off-policy linear TD learner.

    Attributes:
        weights: Weight vector for linear value approximation
        bias: Bias term
        eligibility_traces: Per-feature eligibility trace
        bias_eligibility_trace: Bias eligibility trace
        step_count: Number of updates applied
        birth_timestamp: Wall-clock seconds at init
        uptime_s: Cumulative wall-clock seconds spent in update calls
    """

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    eligibility_traces: Float[Array, " feature_dim"]
    bias_eligibility_trace: Float[Array, ""]
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class OffPolicyTDUpdateResult:
    """Result of an off-policy TD update.

    Attributes:
        state: Updated learner state
        prediction: V(s) computed before the update
        td_error: TD error delta = R + gamma * V(s') - V(s)
        rho_clipped: Importance-sampling ratio after clipping (so it can
            be logged for variance diagnostics)
        metrics: Array of shape (5,) with columns
            [squared_td_error, td_error, rho_clipped, mean_alpha, mean_trace]
    """

    state: OffPolicyTDState
    prediction: Float[Array, " 1"]
    td_error: Float[Array, ""]
    rho_clipped: Float[Array, ""]
    metrics: Float[Array, " 5"]


@chex.dataclass(frozen=True)
class ETDState:
    """State for the emphatic TD(lambda) linear learner.

    Attributes:
        weights: Weight vector for linear value approximation
        bias: Bias term
        eligibility_traces: Emphatic eligibility trace
        bias_eligibility_trace: Emphatic eligibility trace for the bias
        follow_on_trace: Scalar follow-on trace ``F_t``
        emphasis: Scalar emphasis ``M_t`` from the latest update
        step_count: Number of updates applied
        birth_timestamp: Wall-clock seconds at init
        uptime_s: Cumulative wall-clock seconds spent in update calls
    """

    weights: Float[Array, " feature_dim"]
    bias: Float[Array, ""]
    eligibility_traces: Float[Array, " feature_dim"]
    bias_eligibility_trace: Float[Array, ""]
    follow_on_trace: Float[Array, ""]
    emphasis: Float[Array, ""]
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class ETDUpdateResult:
    """Result of an emphatic TD(lambda) update.

    Attributes:
        state: Updated learner state
        prediction: V(s) computed before the update
        td_error: TD error delta = R + gamma * V(s') - V(s)
        follow_on_trace: Updated follow-on trace ``F_t``
        emphasis: Updated scalar emphasis ``M_t``
        metrics: Array of shape (7,) with columns
            [squared_td_error, td_error, rho, mean_alpha, mean_trace,
            follow_on_trace, emphasis]
    """

    state: ETDState
    prediction: Float[Array, " 1"]
    td_error: Float[Array, ""]
    follow_on_trace: Float[Array, ""]
    emphasis: Float[Array, ""]
    metrics: Float[Array, " 7"]


@chex.dataclass(frozen=True)
class GradientTDState:
    """State for linear off-policy Gradient-TD/TDC prediction.

    The bias is represented by an appended constant feature, so all vectors have
    shape ``feature_dim + 1``.
    """

    weights: Float[Array, " augmented_feature_dim"]
    secondary_weights: Float[Array, " augmented_feature_dim"]
    eligibility_traces: Float[Array, " augmented_feature_dim"]
    step_count: Int[Array, ""] = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class GradientTDUpdateResult:
    """Result of one linear Gradient-TD/TDC update."""

    state: GradientTDState
    prediction: Float[Array, " 1"]
    td_error: Float[Array, ""]
    rho_clipped: Float[Array, ""]
    metrics: Float[Array, " 6"]


@chex.dataclass(frozen=True)
class GradientTDArrayResult:
    """Result from scanning Gradient-TD/TDC over transition arrays."""

    state: GradientTDState
    predictions: Float[Array, " num_steps"]
    td_errors: Float[Array, " num_steps"]
    rho_clipped: Float[Array, " num_steps"]
    metrics: Float[Array, "num_steps 6"]


# =============================================================================
# Learner
# =============================================================================


class OffPolicyTDLinearLearner:
    """Off-policy linear TD(lambda) with per-decision IS and Retrace clipping.

    The update rule is::

        rho_t = pi(a_t|s_t) / b(a_t|s_t)               (provided externally)
        rho_clipped = min(c, rho_t)                     (Retrace clipping)
        delta_t = R_{t+1} + gamma_t * V(s_{t+1}) - V(s_t)
        e_t = gamma_t * lambda_t * rho_clipped * e_{t-1} + phi_t
        w_{t+1} = w_t + alpha * delta_t * rho_clipped * e_t

    Setting ``retrace_clip = inf`` recovers naive per-decision IS.
    Setting ``retrace_clip = 1.0`` gives the Retrace-c=1 update which is
    convergent under standard conditions. Setting ``rho_t = 1`` always
    recovers on-policy semi-gradient TD(lambda).

    Attributes:
        step_size: Learning rate alpha
        trace_decay: Eligibility trace decay lambda
        retrace_clip: Maximum allowed importance ratio (Inf to disable)
    """

    def __init__(
        self,
        step_size: float = 0.05,
        trace_decay: float = 0.0,
        retrace_clip: float = 1.0,
    ):
        """Initialize the off-policy TD learner.

        Args:
            step_size: Learning rate alpha (scalar)
            trace_decay: Eligibility trace decay lambda in [0, 1]
            retrace_clip: Maximum allowed importance ratio (default 1.0
                is the safe Retrace-c=1 choice; pass float("inf") to
                disable clipping).
        """
        if step_size <= 0:
            raise ValueError(f"step_size must be positive; got {step_size}")
        if not 0.0 <= trace_decay <= 1.0:
            raise ValueError(f"trace_decay must lie in [0, 1]; got {trace_decay}")
        if retrace_clip <= 0:
            raise ValueError(f"retrace_clip must be positive; got {retrace_clip}")
        self._step_size = step_size
        self._trace_decay = trace_decay
        self._retrace_clip = retrace_clip

    @property
    def step_size(self) -> float:
        """Learning rate alpha."""
        return self._step_size

    @property
    def trace_decay(self) -> float:
        """Trace decay lambda."""
        return self._trace_decay

    @property
    def retrace_clip(self) -> float:
        """IS-ratio clip (Retrace c)."""
        return self._retrace_clip

    def init(self, feature_dim: int) -> OffPolicyTDState:
        """Initialize learner state with zero weights and zero traces."""
        return OffPolicyTDState(  # type: ignore[call-arg]
            weights=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias=jnp.array(0.0, dtype=jnp.float32),
            eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self, state: OffPolicyTDState, observation: Observation
    ) -> Float[Array, " 1"]:
        """Compute V(s) = w . phi(s) + b."""
        return jnp.atleast_1d(jnp.dot(state.weights, observation) + state.bias)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: OffPolicyTDState,
        observation: Observation,
        reward: Array,
        next_observation: Observation,
        gamma: Array,
        rho: Array,
    ) -> OffPolicyTDUpdateResult:
        """Apply one off-policy TD update.

        Args:
            state: Current learner state
            observation: Current feature vector phi(s_t)
            reward: Reward R_{t+1}
            next_observation: Next feature vector phi(s_{t+1})
            gamma: State-dependent discount gamma_t (0 at terminal)
            rho: Importance-sampling ratio pi(a_t|s_t) / b(a_t|s_t).
                Pass 1.0 for on-policy data.

        Returns:
            ``OffPolicyTDUpdateResult`` with updated state, prediction,
            TD error, clipped IS ratio, and a metrics array of shape (5,).
        """
        alpha = jnp.asarray(self._step_size, dtype=jnp.float32)
        lam = jnp.asarray(self._trace_decay, dtype=jnp.float32)
        clip = jnp.asarray(self._retrace_clip, dtype=jnp.float32)
        gamma_s = jnp.squeeze(gamma).astype(jnp.float32)
        reward_s = jnp.squeeze(reward).astype(jnp.float32)
        rho_s = jnp.squeeze(rho).astype(jnp.float32)

        rho_clipped = jnp.minimum(rho_s, clip)

        v_t = jnp.dot(state.weights, observation) + state.bias
        v_next = jnp.dot(state.weights, next_observation) + state.bias
        td_error = reward_s + gamma_s * v_next - v_t

        # IS-weighted accumulating eligibility trace
        decay = gamma_s * lam * rho_clipped
        new_e = decay * state.eligibility_traces + observation
        new_e_b = decay * state.bias_eligibility_trace + 1.0

        # Update with rho_clipped * delta * e
        scaled_update = alpha * rho_clipped * td_error
        new_weights = state.weights + scaled_update * new_e
        new_bias = state.bias + scaled_update * new_e_b

        new_state = OffPolicyTDState(  # type: ignore[call-arg]
            weights=new_weights,
            bias=new_bias,
            eligibility_traces=new_e,
            bias_eligibility_trace=new_e_b,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        squared_td = td_error**2
        mean_e = jnp.mean(jnp.abs(new_e))
        metrics = jnp.array(
            [squared_td, td_error, rho_clipped, alpha, mean_e],
            dtype=jnp.float32,
        )

        return OffPolicyTDUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            prediction=jnp.atleast_1d(v_t),
            td_error=jnp.asarray(td_error),
            rho_clipped=jnp.asarray(rho_clipped),
            metrics=metrics,
        )

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "type": "OffPolicyTDLinearLearner",
            "step_size": self._step_size,
            "trace_decay": self._trace_decay,
            "retrace_clip": self._retrace_clip,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> OffPolicyTDLinearLearner:
        """Reconstruct from dict."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


class ETDLinearLearner:
    """Off-policy linear emphatic TD(lambda).

    ETD(lambda) replaces Retrace's clipped per-decision trace with a
    follow-on trace and scalar emphasis:

    ``F_t = rho_t * gamma_t * F_{t-1} + i_t``
    ``M_t = lambda * i_t + (1 - lambda) * F_t``
    ``e_t = rho_t * (gamma_t * lambda * e_{t-1} + M_t * phi_t)``
    ``w_{t+1} = w_t + alpha * delta_t * e_t``

    The single-step API advances the follow-on trace with the current
    transition's ratio and discount. With ``rho=1``, ``gamma=0``, and
    ``lambda=0``, this reduces to the standard LMS/TD(0) terminating update.

    Attributes:
        step_size: Learning rate alpha
        trace_decay: Eligibility trace decay lambda
    """

    def __init__(
        self,
        step_size: float = 0.05,
        trace_decay: float = 0.0,
    ):
        """Initialize the emphatic TD learner.

        Args:
            step_size: Learning rate alpha (scalar)
            trace_decay: Eligibility trace decay lambda in [0, 1]
        """
        if step_size <= 0:
            raise ValueError(f"step_size must be positive; got {step_size}")
        if not 0.0 <= trace_decay <= 1.0:
            raise ValueError(f"trace_decay must lie in [0, 1]; got {trace_decay}")
        self._step_size = step_size
        self._trace_decay = trace_decay

    @property
    def step_size(self) -> float:
        """Learning rate alpha."""
        return self._step_size

    @property
    def trace_decay(self) -> float:
        """Trace decay lambda."""
        return self._trace_decay

    def init(self, feature_dim: int) -> ETDState:
        """Initialize learner state with zero weights and zero traces."""
        return ETDState(  # type: ignore[call-arg]
            weights=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias=jnp.array(0.0, dtype=jnp.float32),
            eligibility_traces=jnp.zeros(feature_dim, dtype=jnp.float32),
            bias_eligibility_trace=jnp.array(0.0, dtype=jnp.float32),
            follow_on_trace=jnp.array(0.0, dtype=jnp.float32),
            emphasis=jnp.array(0.0, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: ETDState, observation: Observation) -> Float[Array, " 1"]:
        """Compute V(s) = w . phi(s) + b."""
        return jnp.atleast_1d(jnp.dot(state.weights, observation) + state.bias)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: ETDState,
        observation: Observation,
        reward: Array,
        next_observation: Observation,
        gamma: Array,
        rho: Array,
        interest: Array | float = 1.0,
    ) -> ETDUpdateResult:
        """Apply one ETD(lambda) update.

        Args:
            state: Current learner state
            observation: Current feature vector phi(s_t)
            reward: Reward R_{t+1}
            next_observation: Next feature vector phi(s_{t+1})
            gamma: State-dependent discount gamma (0 at terminal)
            rho: Importance-sampling ratio pi(a_t|s_t) / b(a_t|s_t).
            interest: State interest i_t. Defaults to 1.0.

        Returns:
            ``ETDUpdateResult`` with updated state, prediction, TD error,
            follow-on trace, emphasis, and a metrics array of shape (7,).
        """
        alpha = jnp.asarray(self._step_size, dtype=jnp.float32)
        lam = jnp.asarray(self._trace_decay, dtype=jnp.float32)
        gamma_s = jnp.squeeze(gamma).astype(jnp.float32)
        reward_s = jnp.squeeze(reward).astype(jnp.float32)
        rho_s = jnp.squeeze(rho).astype(jnp.float32)
        interest_s = jnp.squeeze(jnp.asarray(interest, dtype=jnp.float32))

        v_t = jnp.dot(state.weights, observation) + state.bias
        v_next = jnp.dot(state.weights, next_observation) + state.bias
        td_error = reward_s + gamma_s * v_next - v_t

        follow_on = rho_s * gamma_s * state.follow_on_trace + interest_s
        emphasis = lam * interest_s + (1.0 - lam) * follow_on

        trace_decay = gamma_s * lam
        new_e = rho_s * (trace_decay * state.eligibility_traces + emphasis * observation)
        new_e_b = rho_s * (trace_decay * state.bias_eligibility_trace + emphasis)

        new_weights = state.weights + alpha * td_error * new_e
        new_bias = state.bias + alpha * td_error * new_e_b

        new_state = ETDState(  # type: ignore[call-arg]
            weights=new_weights,
            bias=new_bias,
            eligibility_traces=new_e,
            bias_eligibility_trace=new_e_b,
            follow_on_trace=follow_on,
            emphasis=emphasis,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        squared_td = td_error**2
        mean_e = jnp.mean(jnp.abs(new_e))
        metrics = jnp.array(
            [squared_td, td_error, rho_s, alpha, mean_e, follow_on, emphasis],
            dtype=jnp.float32,
        )

        return ETDUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            prediction=jnp.atleast_1d(v_t),
            td_error=jnp.asarray(td_error),
            follow_on_trace=jnp.asarray(follow_on),
            emphasis=jnp.asarray(emphasis),
            metrics=metrics,
        )

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "type": "ETDLinearLearner",
            "step_size": self._step_size,
            "trace_decay": self._trace_decay,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> ETDLinearLearner:
        """Reconstruct from dict."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


class GradientTDLinearLearner:
    """Linear off-policy Gradient-TD/TDC learner with secondary weights.

    This implements the linear TDC/GTD(lambda)-style correction with an
    auxiliary weight vector, descending the projected Bellman-error objective in
    the standard linear setting:

    ``delta = r + gamma theta^T phi' - theta^T phi``
    ``e = rho * (phi + gamma * lambda * e)``
    ``theta += alpha * (delta * e - gamma * (1 - lambda) * (h^T e) * phi')``
    ``h += beta * (delta * e - (h^T phi) * phi)``

    The implementation is intentionally linear. Nonlinear shared-trunk GTD is a
    separate approximation problem; this class supplies the exact secondary
    weight correction missing from semi-gradient off-policy TD/Horde.
    """

    def __init__(
        self,
        step_size: float = 0.01,
        secondary_step_size: float = 0.05,
        trace_decay: float = 0.0,
        ratio_clip: float = 10.0,
    ):
        """Initialize the learner."""
        if step_size <= 0.0:
            raise ValueError(f"step_size must be positive; got {step_size}")
        if secondary_step_size < 0.0:
            raise ValueError(
                "secondary_step_size must be non-negative; "
                f"got {secondary_step_size}"
            )
        if not 0.0 <= trace_decay <= 1.0:
            raise ValueError(f"trace_decay must lie in [0, 1]; got {trace_decay}")
        if ratio_clip <= 0.0:
            raise ValueError(f"ratio_clip must be positive; got {ratio_clip}")
        self._step_size = step_size
        self._secondary_step_size = secondary_step_size
        self._trace_decay = trace_decay
        self._ratio_clip = ratio_clip

    @property
    def step_size(self) -> float:
        """Primary learning rate."""
        return self._step_size

    @property
    def secondary_step_size(self) -> float:
        """Secondary-weight learning rate."""
        return self._secondary_step_size

    @property
    def trace_decay(self) -> float:
        """Eligibility trace decay."""
        return self._trace_decay

    @property
    def ratio_clip(self) -> float:
        """Importance-ratio clip."""
        return self._ratio_clip

    def init(self, feature_dim: int) -> GradientTDState:
        """Initialize primary weights, secondary weights, and traces."""
        augmented_dim = feature_dim + 1
        return GradientTDState(  # type: ignore[call-arg]
            weights=jnp.zeros(augmented_dim, dtype=jnp.float32),
            secondary_weights=jnp.zeros(augmented_dim, dtype=jnp.float32),
            eligibility_traces=jnp.zeros(augmented_dim, dtype=jnp.float32),
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @staticmethod
    def _augment(observation: Observation) -> Array:
        """Append the bias feature."""
        return jnp.concatenate(
            (
                jnp.asarray(observation, dtype=jnp.float32),
                jnp.ones((1,), dtype=jnp.float32),
            )
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(
        self, state: GradientTDState, observation: Observation
    ) -> Float[Array, " 1"]:
        """Compute ``theta^T phi`` with an appended bias feature."""
        return jnp.atleast_1d(jnp.dot(state.weights, self._augment(observation)))

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: GradientTDState,
        observation: Observation,
        reward: Array,
        next_observation: Observation,
        gamma: Array,
        rho: Array,
    ) -> GradientTDUpdateResult:
        """Apply one off-policy Gradient-TD/TDC update."""
        alpha = jnp.asarray(self._step_size, dtype=jnp.float32)
        beta = jnp.asarray(self._secondary_step_size, dtype=jnp.float32)
        lam = jnp.asarray(self._trace_decay, dtype=jnp.float32)
        ratio_clip = jnp.asarray(self._ratio_clip, dtype=jnp.float32)
        gamma_s = jnp.squeeze(gamma).astype(jnp.float32)
        reward_s = jnp.squeeze(reward).astype(jnp.float32)
        rho_s = jnp.squeeze(rho).astype(jnp.float32)
        rho_clipped = jnp.minimum(jnp.maximum(rho_s, 0.0), ratio_clip)

        phi = self._augment(observation)
        next_phi = self._augment(next_observation)
        prediction = jnp.dot(state.weights, phi)
        next_prediction = jnp.dot(state.weights, next_phi)
        td_error = reward_s + gamma_s * next_prediction - prediction

        traces = rho_clipped * (phi + gamma_s * lam * state.eligibility_traces)
        secondary_dot_trace = jnp.dot(state.secondary_weights, traces)
        secondary_dot_phi = jnp.dot(state.secondary_weights, phi)

        primary_step = alpha * (
            td_error * traces
            - gamma_s * (1.0 - lam) * secondary_dot_trace * next_phi
        )
        secondary_step = beta * (td_error * traces - secondary_dot_phi * phi)

        new_state = GradientTDState(  # type: ignore[call-arg]
            weights=state.weights + primary_step,
            secondary_weights=state.secondary_weights + secondary_step,
            eligibility_traces=traces,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )
        metrics = jnp.array(
            [
                td_error**2,
                td_error,
                rho_clipped,
                jnp.sqrt(jnp.mean(new_state.weights**2)),
                jnp.sqrt(jnp.mean(new_state.secondary_weights**2)),
                jnp.mean(jnp.abs(traces)),
            ],
            dtype=jnp.float32,
        )
        return GradientTDUpdateResult(  # type: ignore[call-arg]
            state=new_state,
            prediction=jnp.atleast_1d(prediction),
            td_error=jnp.asarray(td_error),
            rho_clipped=jnp.asarray(rho_clipped),
            metrics=metrics,
        )

    def to_config(self) -> dict[str, Any]:
        """Serialize to dict."""
        return {
            "type": "GradientTDLinearLearner",
            "step_size": self._step_size,
            "secondary_step_size": self._secondary_step_size,
            "trace_decay": self._trace_decay,
            "ratio_clip": self._ratio_clip,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> GradientTDLinearLearner:
        """Reconstruct from dict."""
        config = dict(config)
        config.pop("type", None)
        return cls(**config)


def run_gradient_td_learning_loop(
    learner: GradientTDLinearLearner,
    state: GradientTDState,
    observations: Array,
    rewards: Array,
    next_observations: Array,
    gammas: Array,
    rhos: Array,
) -> GradientTDArrayResult:
    """Run Gradient-TD/TDC over arrays using ``jax.lax.scan``."""

    def step_fn(
        carry: GradientTDState,
        inputs: tuple[Array, Array, Array, Array, Array],
    ) -> tuple[GradientTDState, tuple[Array, Array, Array, Array]]:
        obs, reward, next_obs, gamma, rho = inputs
        result = learner.update(carry, obs, reward, next_obs, gamma, rho)
        return (
            result.state,
            (
                result.prediction[0],
                result.td_error,
                result.rho_clipped,
                result.metrics,
            ),
        )

    t0 = time.time()
    final_state, (predictions, td_errors, rho_clipped, metrics) = jax.lax.scan(
        step_fn,
        state,
        (observations, rewards, next_observations, gammas, rhos),
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.uptime_s + elapsed
    )
    return GradientTDArrayResult(  # type: ignore[call-arg]
        state=final_state,
        predictions=predictions,
        td_errors=td_errors,
        rho_clipped=rho_clipped,
        metrics=metrics,
    )
