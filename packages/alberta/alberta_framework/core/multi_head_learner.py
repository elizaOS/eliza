"""Multi-head MLP learner for multi-task continual learning.

Implements a shared-trunk, multi-head MLP architecture where hidden layers
are shared across prediction heads. Each head can be independently active
or inactive at each time step (NaN targets = inactive).

Architecture: ``Input -> [Dense(H) -> LayerNorm -> LeakyReLU] x N -> {Head_i: Dense(1)} x n_heads``

When ``use_layer_norm=False``:
``Input -> [Dense(H) -> LeakyReLU] x N -> {Head_i: Dense(1)} x n_heads``

The update uses VJP with accumulated cotangents to perform a single backward
pass through the trunk regardless of the number of heads.

Reference: Elsayed et al. 2024, "Streaming Deep Reinforcement Learning Finally Works"
"""

import functools
import math
import time
from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array
from jaxtyping import Float

from alberta_framework.core.initializers import sparse_init
from alberta_framework.core.normalizers import (
    AnyNormalizerState,
    EMANormalizerState,
    Normalizer,
    WelfordNormalizerState,
)
from alberta_framework.core.optimizers import (
    LMS,
    Bounder,
    Optimizer,
)
from alberta_framework.core.types import (
    AutostepParamState,
    AutostepState,
    IDBDParamState,
    IDBDState,
    LMSState,
    MLPParams,
    ObGDState,
    TraceMode,
)


def _extract_mean_step_size(
    opt_state: LMSState | AutostepParamState | IDBDParamState,
) -> Array:
    """Extract mean step-size from an optimizer state.

    Works at JAX trace time since it dispatches on Python-level attributes.
    """
    if hasattr(opt_state, "step_sizes"):
        # AutostepParamState
        return jnp.mean(opt_state.step_sizes)
    if hasattr(opt_state, "log_step_sizes"):
        # IDBDParamState
        return jnp.mean(jnp.exp(opt_state.log_step_sizes))
    if hasattr(opt_state, "step_size"):
        # LMSState
        return opt_state.step_size
    return jnp.array(0.0, dtype=jnp.float32)


# =============================================================================
# Types
# =============================================================================


@chex.dataclass(frozen=True)
class MultiHeadMLPState:
    """State for a multi-head MLP learner.

    The trunk (shared hidden layers) and heads (per-task output layers)
    maintain separate parameters, optimizer states, and eligibility traces.

    Trunk optimizer states and traces use an interleaved layout
    ``(w0, b0, w1, b1, ...)`` matching the ``MLPLearner`` convention.
    Head optimizer states and traces use a nested layout
    ``((w_opt, b_opt), ...)`` indexed by head.

    Attributes:
        trunk_params: Shared hidden layer parameters
        head_params: Per-head output layer parameters.
            ``weights[i]`` / ``biases[i]`` = head *i*.
        trunk_optimizer_states: Interleaved ``(w0, b0, w1, b1, ...)``
            optimizer states for trunk layers
        head_optimizer_states: Per-head ``((w_opt, b_opt), ...)``
        trunk_traces: Interleaved ``(w0, b0, w1, b1, ...)``
            eligibility traces for trunk layers
        head_traces: Per-head ``((w_trace, b_trace), ...)``
        hidden_unit_utilities: EMA utility diagnostics for each hidden layer,
            shape ``(hidden_sizes[layer],)``. Empty for linear models.
        normalizer_state: Optional online feature normalizer state
        step_count: Scalar step counter
    """

    trunk_params: MLPParams
    head_params: MLPParams
    trunk_optimizer_states: tuple[
        LMSState | AutostepState | AutostepParamState | IDBDParamState, ...
    ]
    head_optimizer_states: tuple[Any, ...]  # tuple of (w_opt, b_opt) tuples
    trunk_traces: tuple[Array, ...]
    head_traces: tuple[Any, ...]  # tuple of (w_trace, b_trace) tuples
    hidden_unit_utilities: tuple[Array, ...] = ()
    normalizer_state: AnyNormalizerState | None = None
    step_count: Array = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class MultiHeadMLPUpdateResult:
    """Result of a multi-head MLP learner update step.

    Attributes:
        state: Updated multi-head MLP learner state
        predictions: Predictions from all heads, shape ``(n_heads,)``
        errors: Prediction errors, shape ``(n_heads,)``. NaN for inactive heads.
        per_head_metrics: Per-head metrics, shape ``(n_heads, 3)``.
            Columns: ``[squared_error, raw_error, mean_step_size]``.
            NaN for inactive heads.
        trunk_bounding_metric: Scalar trunk bounding metric
    """

    state: MultiHeadMLPState
    predictions: Float[Array, " n_heads"]
    errors: Float[Array, " n_heads"]
    per_head_metrics: Float[Array, "n_heads 3"]
    trunk_bounding_metric: Float[Array, ""]


@chex.dataclass(frozen=True)
class MultiHeadLearningResult:
    """Result from multi-head learning loop.

    Attributes:
        state: Final multi-head MLP learner state
        per_head_metrics: Per-head metrics over time,
            shape ``(num_steps, n_heads, 3)``
    """

    state: MultiHeadMLPState
    per_head_metrics: Float[Array, "num_steps n_heads 3"]


@chex.dataclass(frozen=True)
class BatchedMultiHeadResult:
    """Result from batched multi-head learning loop.

    Attributes:
        states: Batched multi-head MLP learner states
        per_head_metrics: Per-head metrics,
            shape ``(n_seeds, num_steps, n_heads, 3)``
    """

    states: MultiHeadMLPState
    per_head_metrics: Float[Array, "n_seeds num_steps n_heads 3"]


# =============================================================================
# Type alias (mirrors learners.py)
# =============================================================================

AnyOptimizer = (
    Optimizer[LMSState]
    | Optimizer[IDBDState]
    | Optimizer[AutostepState]
    | Optimizer[ObGDState]
    | Optimizer[AutostepParamState]
    | Optimizer[IDBDParamState]
)


# =============================================================================
# MultiHeadMLPLearner
# =============================================================================


class MultiHeadMLPLearner:
    """Multi-head MLP with shared trunk and independent prediction heads.

    Architecture:
    ``Input -> [Dense(H) -> LayerNorm -> LeakyReLU] x N -> {Head_i: Dense(1)} x n_heads``

    All hidden layers are shared (the *trunk*). Each head is an independent
    linear projection from the last hidden representation to a scalar.

    The ``update`` method uses VJP with accumulated cotangents so that
    only one backward pass through the trunk is needed regardless of the
    number of active heads.

    **Trunk trace constraint**: When ``hidden_sizes`` is non-empty (MLP mode),
    trunk ``gamma * lamda`` must be 0. The VJP backward pass folds per-head
    errors into the trunk cotangent *before* trace accumulation, so traces
    accumulate error-weighted gradients. For ``gamma * lamda = 0`` this is
    correct (traces reset each step). For ``gamma * lamda > 0`` it would
    produce biased trace updates that violate forward-view equivalence
    (Sutton & Barto Ch. 12). Use ``HordeLearner`` for per-head trace decay
    — it sets trunk ``gamma=0, lamda=0`` and applies per-head
    ``gamma * lambda`` only to the head layers. For linear baselines
    (``hidden_sizes=()``), there is no trunk, so any ``gamma * lamda`` is fine.

    Attributes:
        n_heads: Number of prediction heads
        hidden_sizes: Tuple of hidden layer sizes. Pass ``()`` for a multi-head
            linear model (heads project directly from input features).
        optimizer: Optimizer for per-weight step-size adaptation
        bounder: Optional update bounder (e.g. ObGDBounding)
        normalizer: Optional feature normalizer
        use_layer_norm: Whether to apply parameterless layer normalization
        gamma: Discount factor for trace decay
        lamda: Eligibility trace decay parameter
        sparsity: Fraction of weights zeroed out per output neuron
        leaky_relu_slope: Negative slope for LeakyReLU activation

    Single-Step (Daemon) Usage
    --------------------------
    Both ``predict()`` and ``update()`` work with single unbatched
    observations (1D arrays). This is the intended usage for daemon-style
    deployments where one observation arrives at a time.

    Both methods are JIT-compiled automatically. The first call triggers
    JAX's tracing; subsequent calls use the cached compilation. For
    low-latency startup, run a warmup call so the first real event is fast:

    ```python
    # At daemon startup, after learner.init():
    dummy_obs = jnp.zeros(feature_dim)
    dummy_targets = jnp.full(n_heads, jnp.nan)
    learner.predict(state, dummy_obs).block_until_ready()     # Warmup trace
    learner.update(state, dummy_obs, dummy_targets)            # Warmup trace
    # First real event will now be fast
    ```

    NaN target masking works per-step: pass ``jnp.nan`` for any head
    that should not update. Inactive heads preserve their params,
    traces, and optimizer states.
    """

    def __init__(
        self,
        n_heads: int,
        hidden_sizes: tuple[int, ...] = (128, 128),
        optimizer: AnyOptimizer | None = None,
        step_size: float = 1.0,
        bounder: Bounder | None = None,
        gamma: float = 0.0,
        lamda: float = 0.0,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        head_optimizer: AnyOptimizer | None = None,
        per_head_gamma_lamda: tuple[float, ...] | None = None,
        trace_mode: TraceMode = TraceMode.ACCUMULATING,
        utility_decay: float = 0.99,
    ):
        """Initialize the multi-head MLP learner.

        Args:
            n_heads: Number of prediction heads
            hidden_sizes: Tuple of hidden layer sizes (default: two layers of 128)
            optimizer: Optimizer for weight updates. Defaults to LMS(step_size).
                Must support ``init_for_shape`` and ``update_from_gradient``.
            step_size: Base learning rate (used only when optimizer is None)
            bounder: Optional update bounder (e.g. ObGDBounding)
            gamma: Discount factor for trace decay (default: 0.0 for supervised)
            lamda: Eligibility trace decay parameter (default: 0.0)
            normalizer: Optional feature normalizer
            sparsity: Fraction of weights zeroed out per neuron (default: 0.9)
            leaky_relu_slope: Negative slope for LeakyReLU (default: 0.01)
            use_layer_norm: Whether to apply parameterless layer normalization
                (default: True)
            head_optimizer: Optional separate optimizer for the output heads.
                When None (default), all layers use ``optimizer``. When set,
                trunk (hidden) layers use ``optimizer`` while each head uses
                ``head_optimizer``. This enables hybrid configurations like
                stable LMS for the trunk with adaptive Autostep for the heads.
            per_head_gamma_lamda: Optional per-head trace decay factors.
                When set, each head uses its own ``gamma * lambda`` product
                for trace decay instead of the global ``gamma * lamda``.
                Length must equal ``n_heads``. Used by ``HordeLearner``
                to assign per-demon discount/trace parameters.
            trace_mode: Eligibility trace mode. ``ACCUMULATING`` (default)
                uses standard ``e_t = gl * e_{t-1} + grad``.
                ``REPLACING`` sets the trace to the gradient where the
                gradient is nonzero, decaying the old trace elsewhere.
            utility_decay: EMA decay for hidden-unit utility diagnostics.
        """
        if not 0.0 <= utility_decay < 1.0:
            raise ValueError("utility_decay must be in [0, 1)")

        self._n_heads = n_heads
        self._hidden_sizes = hidden_sizes
        self._optimizer: AnyOptimizer = optimizer or LMS(step_size=step_size)
        self._head_optimizer: AnyOptimizer | None = head_optimizer
        self._bounder = bounder
        self._gamma = gamma
        self._lamda = lamda
        self._normalizer = normalizer
        self._sparsity = sparsity
        self._leaky_relu_slope = leaky_relu_slope
        self._use_layer_norm = use_layer_norm
        self._per_head_gl: tuple[float, ...] | None = per_head_gamma_lamda
        self._trace_mode = trace_mode
        self._utility_decay = utility_decay

        # Validate trunk trace constraint: gamma*lamda > 0 is only safe
        # when there is no trunk (linear baseline). With a trunk, the VJP
        # cotangent folds error into gradients before trace accumulation,
        # producing biased traces when gamma*lamda > 0.
        if gamma * lamda > 0 and len(hidden_sizes) > 0:
            msg = (
                f"Trunk gamma*lamda must be 0 when hidden_sizes is non-empty "
                f"(got gamma={gamma}, lamda={lamda}, hidden_sizes={hidden_sizes}). "
                f"The VJP backward pass bakes error into trunk gradients before "
                f"trace accumulation, which is only correct when traces reset "
                f"each step (gamma*lamda=0). Use HordeLearner for per-head "
                f"trace decay with a shared trunk."
            )
            raise ValueError(msg)

    @property
    def n_heads(self) -> int:
        """Number of prediction heads."""
        return self._n_heads

    @property
    def normalizer(
        self,
    ) -> Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None:
        """The feature normalizer, or None if normalization is disabled."""
        return self._normalizer

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to dict.

        Returns:
            Dict with all constructor arguments needed to recreate
            the learner via ``from_config()``.
        """
        config: dict[str, Any] = {
            "type": "MultiHeadMLPLearner",
            "n_heads": self._n_heads,
            "hidden_sizes": list(self._hidden_sizes),
            "optimizer": self._optimizer.to_config(),
            "bounder": self._bounder.to_config() if self._bounder is not None else None,
            "normalizer": (
                self._normalizer.to_config() if self._normalizer is not None else None
            ),
            "head_optimizer": (
                self._head_optimizer.to_config()
                if self._head_optimizer is not None
                else None
            ),
            "sparsity": self._sparsity,
            "leaky_relu_slope": self._leaky_relu_slope,
            "use_layer_norm": self._use_layer_norm,
            "gamma": self._gamma,
            "lamda": self._lamda,
            "per_head_gamma_lamda": (
                list(self._per_head_gl) if self._per_head_gl is not None else None
            ),
            "trace_mode": self._trace_mode.value,
            "utility_decay": self._utility_decay,
        }
        return config

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "MultiHeadMLPLearner":
        """Reconstruct learner from a config dict.

        Args:
            config: Dict as produced by ``to_config()``

        Returns:
            Reconstructed MultiHeadMLPLearner instance
        """
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        config = dict(config)
        config.pop("type", None)

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
            TraceMode(trace_mode_str) if trace_mode_str is not None else TraceMode.ACCUMULATING
        )

        return cls(
            n_heads=config.pop("n_heads"),
            hidden_sizes=tuple(config.pop("hidden_sizes")),
            optimizer=optimizer,
            bounder=bounder,
            normalizer=normalizer,
            head_optimizer=head_optimizer,
            per_head_gamma_lamda=per_head_gl,
            trace_mode=trace_mode,
            **config,
        )

    def init(self, feature_dim: int, key: Array) -> MultiHeadMLPState:
        """Initialize multi-head MLP learner state with sparse weights.

        Args:
            feature_dim: Dimension of the input feature vector
            key: JAX random key for weight initialization

        Returns:
            Initial state with sparse trunk weights, zero biases, and
            per-head output layers
        """
        # Trunk: [feature_dim, *hidden_sizes] — all hidden layers
        trunk_layer_sizes = [feature_dim, *self._hidden_sizes]

        trunk_weights: list[Array] = []
        trunk_biases: list[Array] = []
        trunk_traces: list[Array] = []
        trunk_opt_states: list[LMSState | AutostepParamState] = []

        for i in range(len(trunk_layer_sizes) - 1):
            fan_out = trunk_layer_sizes[i + 1]
            fan_in = trunk_layer_sizes[i]
            key, subkey = jax.random.split(key)
            w = sparse_init(subkey, (fan_out, fan_in), sparsity=self._sparsity)
            b = jnp.zeros(fan_out, dtype=jnp.float32)
            trunk_weights.append(w)
            trunk_biases.append(b)
            # Interleaved traces and optimizer states: w0, b0, w1, b1, ...
            trunk_traces.append(jnp.zeros_like(w))
            trunk_traces.append(jnp.zeros_like(b))
            trunk_opt_states.append(self._optimizer.init_for_shape(w.shape))
            trunk_opt_states.append(self._optimizer.init_for_shape(b.shape))

        trunk_params = MLPParams(
            weights=tuple(trunk_weights),
            biases=tuple(trunk_biases),
        )

        # Heads: n_heads output layers, each (1, h_last)
        # h_last = last hidden dim, or feature_dim when no trunk layers
        h_last = self._hidden_sizes[-1] if self._hidden_sizes else feature_dim
        head_weights: list[Array] = []
        head_biases: list[Array] = []
        head_traces_list: list[tuple[Array, Array]] = []
        head_opt_states_list: list[tuple[Any, ...]] = []

        head_opt = self._head_optimizer if self._head_optimizer is not None else self._optimizer
        for _ in range(self._n_heads):
            key, subkey = jax.random.split(key)
            w = sparse_init(subkey, (1, h_last), sparsity=self._sparsity)
            b = jnp.zeros(1, dtype=jnp.float32)
            head_weights.append(w)
            head_biases.append(b)
            head_traces_list.append((jnp.zeros_like(w), jnp.zeros_like(b)))
            head_opt_states_list.append((
                head_opt.init_for_shape(w.shape),
                head_opt.init_for_shape(b.shape),
            ))

        head_params = MLPParams(
            weights=tuple(head_weights),
            biases=tuple(head_biases),
        )

        normalizer_state = None
        if self._normalizer is not None:
            normalizer_state = self._normalizer.init(feature_dim)

        return MultiHeadMLPState(
            trunk_params=trunk_params,
            head_params=head_params,
            trunk_optimizer_states=tuple(trunk_opt_states),
            head_optimizer_states=tuple(head_opt_states_list),
            trunk_traces=tuple(trunk_traces),
            head_traces=tuple(head_traces_list),
            hidden_unit_utilities=tuple(
                jnp.zeros(hidden_size, dtype=jnp.float32)
                for hidden_size in self._hidden_sizes
            ),
            normalizer_state=normalizer_state,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    @staticmethod
    def _trunk_forward(
        weights: tuple[Array, ...],
        biases: tuple[Array, ...],
        observation: Array,
        leaky_relu_slope: float,
        use_layer_norm: bool = True,
    ) -> Array:
        """Pure forward pass through trunk (hidden layers only).

        Args:
            weights: Tuple of weight matrices for hidden layers
            biases: Tuple of bias vectors for hidden layers
            observation: Input feature vector
            leaky_relu_slope: Negative slope for LeakyReLU
            use_layer_norm: Whether to apply parameterless layer normalization

        Returns:
            Hidden representation of shape ``(H_last,)``
        """
        hidden, _ = MultiHeadMLPLearner._trunk_forward_with_activations(
            weights,
            biases,
            observation,
            leaky_relu_slope,
            use_layer_norm,
        )
        return hidden

    @staticmethod
    def _trunk_forward_with_activations(
        weights: tuple[Array, ...],
        biases: tuple[Array, ...],
        observation: Array,
        leaky_relu_slope: float,
        use_layer_norm: bool = True,
    ) -> tuple[Array, tuple[Array, ...]]:
        """Forward trunk and return each hidden layer activation."""
        if len(weights) == 0:
            return observation, ()

        activations: list[Array] = []
        x = observation
        for i in range(len(weights)):
            x = weights[i] @ x + biases[i]
            if use_layer_norm:
                mean = jnp.mean(x)
                var = jnp.var(x)
                x = (x - mean) / jnp.sqrt(var + 1e-5)
            x = jnp.where(x >= 0, x, leaky_relu_slope * x)
            activations.append(x)
        return x, tuple(activations)

    @staticmethod
    def _head_forward(head_w: Array, head_b: Array, hidden: Array) -> Array:
        """Forward a single head: ``squeeze(head_w @ hidden + head_b)``.

        Args:
            head_w: Head weight matrix, shape ``(1, H_last)``
            head_b: Head bias vector, shape ``(1,)``
            hidden: Trunk hidden representation, shape ``(H_last,)``

        Returns:
            Scalar prediction
        """
        return jnp.squeeze(head_w @ hidden + head_b)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: MultiHeadMLPState, observation: Array) -> Array:
        """Compute predictions from all heads.

        JIT-compiled automatically. First call triggers tracing; subsequent
        calls with the same learner instance use the cached compilation.

        Args:
            state: Current multi-head MLP learner state
            observation: Input feature vector

        Returns:
            Array of shape ``(n_heads,)`` with one prediction per head
        """
        obs = observation
        if self._normalizer is not None and state.normalizer_state is not None:
            obs = self._normalizer.normalize_only(state.normalizer_state, observation)

        hidden = self._trunk_forward(
            state.trunk_params.weights,
            state.trunk_params.biases,
            obs,
            self._leaky_relu_slope,
            self._use_layer_norm,
        )

        predictions = []
        for i in range(self._n_heads):
            pred = self._head_forward(
                state.head_params.weights[i],
                state.head_params.biases[i],
                hidden,
            )
            predictions.append(pred)

        return jnp.array(predictions)

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        targets: Array,
    ) -> MultiHeadMLPUpdateResult:
        """Update multi-head MLP given observation and per-head targets.

        JIT-compiled automatically. Uses VJP with accumulated cotangents
        for a single backward pass through the trunk. Error from each
        active head is folded into the trunk gradient before trace
        accumulation.

        Args:
            state: Current state
            observation: Input feature vector
            targets: Per-head targets, shape ``(n_heads,)``.
                NaN = inactive head.

        Returns:
            MultiHeadMLPUpdateResult with updated state, predictions,
            errors, and per-head metrics
        """
        n_heads = self._n_heads
        gamma_lamda = jnp.array(self._gamma * self._lamda, dtype=jnp.float32)
        replacing = self._trace_mode == TraceMode.REPLACING

        # 1. Handle NaN targets
        active_mask = ~jnp.isnan(targets)  # (n_heads,)
        safe_targets = jnp.where(active_mask, targets, 0.0)

        # 2. Normalize observation if needed
        obs = observation
        new_normalizer_state = state.normalizer_state
        if self._normalizer is not None and state.normalizer_state is not None:
            obs, new_normalizer_state = self._normalizer.normalize(
                state.normalizer_state, observation
            )

        # 3. Forward trunk via VJP
        slope = self._leaky_relu_slope
        ln = self._use_layer_norm

        def trunk_fn(
            weights: tuple[Array, ...], biases: tuple[Array, ...]
        ) -> tuple[Array, tuple[Array, ...]]:
            return self._trunk_forward_with_activations(weights, biases, obs, slope, ln)

        hidden, trunk_vjp_fn, activations = jax.vjp(
            trunk_fn,
            state.trunk_params.weights,
            state.trunk_params.biases,
            has_aux=True,
        )

        # 4. Per-head forward + compute errors + accumulate cotangent
        h_last = hidden.shape[0]
        cotangent = jnp.zeros(h_last, dtype=jnp.float32)
        predictions_list: list[Array] = []
        errors_list: list[Array] = []

        for i in range(n_heads):
            pred_i = self._head_forward(
                state.head_params.weights[i],
                state.head_params.biases[i],
                hidden,
            )
            error_i = safe_targets[i] - pred_i
            masked_error_i = jnp.where(active_mask[i], error_i, 0.0)

            predictions_list.append(pred_i)
            errors_list.append(jnp.where(active_mask[i], error_i, jnp.nan))

            # Accumulate cotangent: error_i * d(pred_i)/d(hidden)
            # d(pred_i)/d(hidden) = head_w_i squeezed to (H_last,)
            # NOTE: Error is folded into the cotangent here, so trunk VJP
            # gradients are error-weighted. This is safe because trunk
            # gamma*lamda=0 (validated in __init__), so traces reset each
            # step and the error-gradient coupling doesn't accumulate.
            cotangent = cotangent + masked_error_i * jnp.squeeze(
                state.head_params.weights[i]
            )

        predictions_arr = jnp.array(predictions_list)
        errors_arr = jnp.array(errors_list)

        # 5. One backward pass through trunk
        trunk_weight_grads, trunk_bias_grads = trunk_vjp_fn(cotangent)
        # These grads are already error-weighted

        # Hidden-unit utility diagnostics track the instantaneous contribution
        # ``|activation * downstream_gradient|`` as an EMA.  This is used by
        # higher-level feature lifecycle wrappers and is empty for linear heads.
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
                utility_decay * old_utility + (1.0 - utility_decay) * utility_signal
            )

        # 6. Update trunk traces and optimizer
        n_trunk_layers = len(state.trunk_params.weights)
        new_trunk_traces: list[Array] = []
        trunk_steps: list[Array] = []
        new_trunk_opt_states: list[LMSState | AutostepParamState] = []

        for i in range(n_trunk_layers):
            # Weight trace (index 2*i)
            w_grad_i = trunk_weight_grads[i]
            old_wt = state.trunk_traces[2 * i]
            if replacing:
                # Replacing: use grad where nonzero, else decay old trace
                new_wt = jnp.where(w_grad_i != 0.0, w_grad_i, gamma_lamda * old_wt)
            else:
                new_wt = gamma_lamda * old_wt + w_grad_i
            new_trunk_traces.append(new_wt)
            w_step, new_w_opt = self._optimizer.update_from_gradient(
                state.trunk_optimizer_states[2 * i], new_wt, error=None
            )
            trunk_steps.append(w_step)
            new_trunk_opt_states.append(new_w_opt)

            # Bias trace (index 2*i + 1)
            b_grad_i = trunk_bias_grads[i]
            old_bt = state.trunk_traces[2 * i + 1]
            if replacing:
                new_bt = jnp.where(b_grad_i != 0.0, b_grad_i, gamma_lamda * old_bt)
            else:
                new_bt = gamma_lamda * old_bt + b_grad_i
            new_trunk_traces.append(new_bt)
            b_step, new_b_opt = self._optimizer.update_from_gradient(
                state.trunk_optimizer_states[2 * i + 1], new_bt, error=None
            )
            trunk_steps.append(b_step)
            new_trunk_opt_states.append(new_b_opt)

        # Trunk bounding (pseudo_error=1.0 since error is in gradient)
        # Scale traces by the bounding factor for consistency with future updates
        trunk_bounding_metric = jnp.array(1.0, dtype=jnp.float32)
        if self._bounder is not None:
            trunk_params_flat: list[Array] = []
            for i in range(n_trunk_layers):
                trunk_params_flat.append(state.trunk_params.weights[i])
                trunk_params_flat.append(state.trunk_params.biases[i])
            bounded_trunk_steps, trunk_bounding_metric = self._bounder.bound(
                tuple(trunk_steps), jnp.array(1.0), tuple(trunk_params_flat)
            )
            trunk_steps = list(bounded_trunk_steps)
            new_trunk_traces = [trunk_bounding_metric * t for t in new_trunk_traces]

        # Apply trunk updates (no error multiply -- error already in gradient)
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
        )

        # 7. Per-head updates
        new_head_weights: list[Array] = []
        new_head_biases: list[Array] = []
        new_head_traces_list: list[tuple[Array, Array]] = []
        new_head_opt_states_list: list[tuple[Any, ...]] = []
        per_head_metrics_list: list[Array] = []

        for i in range(n_heads):
            head_w = state.head_params.weights[i]
            head_b = state.head_params.biases[i]
            old_w_trace, old_b_trace = state.head_traces[i]
            old_w_opt, old_b_opt = state.head_optimizer_states[i]

            # Head prediction gradient: d(pred_i)/d(head_w) = hidden
            w_grad = hidden.reshape(1, -1)  # (1, H_last)
            b_grad = jnp.ones(1, dtype=jnp.float32)

            # Update traces (per-head decay if configured)
            head_gl = (
                jnp.array(self._per_head_gl[i], dtype=jnp.float32)
                if self._per_head_gl is not None
                else gamma_lamda
            )
            if replacing:
                new_w_trace = jnp.where(w_grad != 0.0, w_grad, head_gl * old_w_trace)
                new_b_trace = jnp.where(b_grad != 0.0, b_grad, head_gl * old_b_trace)
            else:
                new_w_trace = head_gl * old_w_trace + w_grad
                new_b_trace = head_gl * old_b_trace + b_grad

            # Error for this head (masked to 0 for inactive)
            error_i = jnp.where(
                active_mask[i], safe_targets[i] - predictions_list[i], 0.0
            )

            # Optimizer step (with error for meta-learning)
            head_opt = self._head_optimizer if self._head_optimizer is not None else self._optimizer
            w_step, new_w_opt = head_opt.update_from_gradient(
                old_w_opt, new_w_trace, error=error_i
            )
            b_step, new_b_opt = head_opt.update_from_gradient(
                old_b_opt, new_b_trace, error=error_i
            )

            # Head bounding — scale traces by the bounding factor so that
            # future trace-based updates reflect the effective step magnitude
            if self._bounder is not None:
                bounded_head_steps, bound_scale = self._bounder.bound(
                    (w_step, b_step), error_i, (head_w, head_b)
                )
                w_step, b_step = bounded_head_steps
                new_w_trace = bound_scale * new_w_trace
                new_b_trace = bound_scale * new_b_trace

            # Apply: param += error_i * step
            new_w = head_w + error_i * w_step
            new_b = head_b + error_i * b_step

            # Mask: for inactive heads, keep old state
            new_w = jnp.where(active_mask[i], new_w, head_w)
            new_b = jnp.where(active_mask[i], new_b, head_b)
            new_w_trace = jnp.where(active_mask[i], new_w_trace, old_w_trace)
            new_b_trace = jnp.where(active_mask[i], new_b_trace, old_b_trace)

            # Mask optimizer states back to old for inactive heads
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
            new_head_traces_list.append((new_w_trace, new_b_trace))
            new_head_opt_states_list.append((new_w_opt, new_b_opt))

            # Per-head metrics
            se_i = jnp.where(active_mask[i], error_i**2, jnp.nan)
            raw_error_i = jnp.where(active_mask[i], error_i, jnp.nan)
            mean_ss_i = _extract_mean_step_size(new_w_opt)
            mean_ss_i = jnp.where(active_mask[i], mean_ss_i, jnp.nan)
            per_head_metrics_list.append(
                jnp.array([se_i, raw_error_i, mean_ss_i])
            )

        new_head_params = MLPParams(
            weights=tuple(new_head_weights),
            biases=tuple(new_head_biases),
        )

        new_state = MultiHeadMLPState(
            trunk_params=new_trunk_params,
            head_params=new_head_params,
            trunk_optimizer_states=tuple(new_trunk_opt_states),
            head_optimizer_states=tuple(new_head_opt_states_list),
            trunk_traces=tuple(new_trunk_traces),
            head_traces=tuple(new_head_traces_list),
            hidden_unit_utilities=tuple(new_hidden_unit_utilities),
            normalizer_state=new_normalizer_state,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )

        per_head_metrics = jnp.stack(per_head_metrics_list)  # (n_heads, 3)

        return MultiHeadMLPUpdateResult(
            state=new_state,
            predictions=predictions_arr,
            errors=errors_arr,
            per_head_metrics=per_head_metrics,
            trunk_bounding_metric=trunk_bounding_metric,
        )


def multi_head_metrics_to_dicts(
    result: MultiHeadMLPUpdateResult,
) -> list[dict[str, float] | None]:
    """Convert per-head metrics array to list of dicts for online use.

    Active heads get a dict with keys ``'squared_error'``, ``'error'``,
    ``'mean_step_size'``. Inactive heads get ``None``.

    Args:
        result: Update result from ``MultiHeadMLPLearner.update``

    Returns:
        List of ``n_heads`` entries, one per head
    """
    output: list[dict[str, float] | None] = []
    for i in range(result.per_head_metrics.shape[0]):
        se = float(result.per_head_metrics[i, 0])
        if math.isnan(se):
            output.append(None)
        else:
            output.append(
                {
                    "squared_error": se,
                    "error": float(result.per_head_metrics[i, 1]),
                    "mean_step_size": float(result.per_head_metrics[i, 2]),
                }
            )
    return output


# =============================================================================
# Learning Loops
# =============================================================================


def run_multi_head_learning_loop(
    learner: MultiHeadMLPLearner,
    state: MultiHeadMLPState,
    observations: Array,
    targets: Array,
) -> MultiHeadLearningResult:
    """Run multi-head learning loop using ``jax.lax.scan``.

    Scans over pre-provided observation and target arrays. This is
    designed for settings where data comes from an external source
    (e.g. security event logs) rather than from a ``ScanStream``.

    Args:
        learner: Multi-head MLP learner
        state: Initial learner state
        observations: Input observations, shape ``(num_steps, feature_dim)``
        targets: Per-head targets, shape ``(num_steps, n_heads)``.
            NaN = inactive head for that step.

    Returns:
        ``MultiHeadLearningResult`` with final state and per-head metrics
        of shape ``(num_steps, n_heads, 3)``
    """

    def step_fn(
        carry: MultiHeadMLPState, inputs: tuple[Array, Array]
    ) -> tuple[MultiHeadMLPState, Array]:
        l_state = carry
        obs, tgt = inputs
        result = learner.update(l_state, obs, tgt)
        return result.state, result.per_head_metrics

    t0 = time.time()
    final_state, per_head_metrics = jax.lax.scan(
        step_fn, state, (observations, targets)
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]

    return MultiHeadLearningResult(
        state=final_state,
        per_head_metrics=per_head_metrics,
    )


def run_multi_head_learning_loop_batched(
    learner: MultiHeadMLPLearner,
    observations: Array,
    targets: Array,
    keys: Array,
) -> BatchedMultiHeadResult:
    """Run multi-head learning loop across seeds using ``jax.vmap``.

    Each seed produces an independently initialized state (different
    sparse weight masks). All seeds share the same observations and
    targets.

    Args:
        learner: Multi-head MLP learner
        observations: Shared observations, shape ``(num_steps, feature_dim)``
        targets: Shared targets, shape ``(num_steps, n_heads)``.
            NaN = inactive head.
        keys: JAX random keys, shape ``(n_seeds,)`` or ``(n_seeds, 2)``

    Returns:
        ``BatchedMultiHeadResult`` with batched states and per-head metrics
        of shape ``(n_seeds, num_steps, n_heads, 3)``
    """
    feature_dim = observations.shape[1]

    def single_run(key: Array) -> tuple[MultiHeadMLPState, Array]:
        init_state = learner.init(feature_dim, key)
        result = run_multi_head_learning_loop(
            learner, init_state, observations, targets
        )
        return result.state, result.per_head_metrics

    t0 = time.time()
    batched_states, batched_metrics = jax.vmap(single_run)(keys)
    elapsed = time.time() - t0
    batched_states = batched_states.replace(  # type: ignore[attr-defined]
        uptime_s=batched_states.uptime_s + elapsed
    )

    return BatchedMultiHeadResult(
        states=batched_states,
        per_head_metrics=batched_metrics,
    )
