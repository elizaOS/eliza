"""Horde learner: GVF demons sharing a trunk (Sutton et al. 2011).

Wraps ``MultiHeadMLPLearner`` to add:
- Per-demon gamma/lambda via ``HordeSpec``
- TD target computation for temporal demons (gamma > 0)
- GVF metadata and typed update results

Architecture decision: the trunk has no temporal trace decay (gamma=0).
Per-demon gamma/lambda applies only to heads. This avoids the
trace-error coupling problem: ``MultiHeadMLPLearner``'s VJP backward
pass folds per-head errors into the trunk cotangent *before* trace
accumulation, so trunk traces accumulate error-weighted gradients.
With trunk gamma=0, traces reset each step and this is correct.
If trunk gamma*lamda > 0, traces would carry biased error-gradient
products across steps, violating forward-view equivalence (Sutton &
Barto Ch. 12). This also avoids O(n_heads x trunk_params) memory
for per-demon trunk traces.

Reference: Sutton et al. 2011, "Horde: A Scalable Real-time Architecture
for Learning Knowledge from Unsupervised Sensorimotor Interaction"
"""

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
from alberta_framework.core.optimizers import Bounder
from alberta_framework.core.types import HordeSpec, TraceMode

# =============================================================================
# Types
# =============================================================================


@chex.dataclass(frozen=True)
class HordeUpdateResult:
    """Result of a single Horde update step.

    Attributes:
        state: Updated multi-head MLP learner state
        predictions: Predictions from all demons, shape ``(n_demons,)``
        td_errors: TD errors (target - prediction), shape ``(n_demons,)``.
            NaN for inactive demons.
        td_targets: Computed TD targets ``r + gamma * V(s')``,
            shape ``(n_demons,)``. NaN for inactive demons.
        per_demon_metrics: Per-demon metrics, shape ``(n_demons, 3)``.
            Columns: ``[squared_error, raw_error, mean_step_size]``.
            NaN for inactive demons.
        trunk_bounding_metric: Scalar trunk bounding metric
    """

    state: MultiHeadMLPState
    predictions: Float[Array, " n_demons"]
    td_errors: Float[Array, " n_demons"]
    td_targets: Float[Array, " n_demons"]
    per_demon_metrics: Float[Array, "n_demons 3"]
    trunk_bounding_metric: Float[Array, ""]


@chex.dataclass(frozen=True)
class HordeLearningResult:
    """Result from a Horde scan-based learning loop.

    Attributes:
        state: Final multi-head MLP learner state
        per_demon_metrics: Per-demon metrics over time,
            shape ``(num_steps, n_demons, 3)``
        td_errors: TD errors over time, shape ``(num_steps, n_demons)``
    """

    state: MultiHeadMLPState
    per_demon_metrics: Float[Array, "num_steps n_demons 3"]
    td_errors: Float[Array, "num_steps n_demons"]


@chex.dataclass(frozen=True)
class BatchedHordeResult:
    """Result from batched Horde learning loop.

    Attributes:
        states: Batched multi-head MLP learner states
        per_demon_metrics: Per-demon metrics,
            shape ``(n_seeds, num_steps, n_demons, 3)``
        td_errors: TD errors, shape ``(n_seeds, num_steps, n_demons)``
    """

    states: MultiHeadMLPState
    per_demon_metrics: Float[Array, "n_seeds num_steps n_demons 3"]
    td_errors: Float[Array, "n_seeds num_steps n_demons"]


@chex.dataclass(frozen=True)
class MixedHordeState:
    """State for a mixed shared/independent Horde."""

    shared_state: MultiHeadMLPState | None
    independent_state: Any | None
    step_count: Array = None  # type: ignore[assignment]
    birth_timestamp: float = 0.0
    uptime_s: float = 0.0


@chex.dataclass(frozen=True)
class MixedHordeLearningResult:
    """Result from a mixed Horde scan-based learning loop."""

    state: MixedHordeState
    per_demon_metrics: Float[Array, "num_steps n_demons 3"]
    td_errors: Float[Array, "num_steps n_demons"]


# =============================================================================
# HordeLearner
# =============================================================================


class HordeLearner:
    """Horde: GVF demons sharing a trunk (Sutton et al. 2011).

    Wraps ``MultiHeadMLPLearner``. Adds:
    - Per-demon gamma/lambda from ``HordeSpec``
    - TD target computation for temporal demons (gamma > 0)
    - GVF metadata

    The trunk uses gamma=0, lamda=0 (no temporal trace decay on shared
    features). Each head uses its own ``gamma * lambda`` product for
    trace decay, set via ``per_head_gamma_lamda`` on the inner learner.

    For all-gamma=0 Hordes (e.g. rlsecd's 5 prediction heads), this
    produces identical results to ``MultiHeadMLPLearner`` since the
    TD target reduces to just the cumulant.

    Single-Step (Daemon) Usage
    --------------------------
    Both ``predict()`` and ``update()`` work with single unbatched
    observations (1D arrays). JIT-compiled automatically.

    Attributes:
        horde_spec: The HordeSpec defining all demons
        n_demons: Number of demons (heads)
    """

    def __init__(
        self,
        horde_spec: HordeSpec,
        hidden_sizes: tuple[int, ...] = (128, 128),
        optimizer: AnyOptimizer | None = None,
        step_size: float = 1.0,
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
    ):
        """Initialize the Horde learner.

        Args:
            horde_spec: Specification of all GVF demons
            hidden_sizes: Tuple of hidden layer sizes (default: two layers of 128)
            optimizer: Optimizer for weight updates. Defaults to LMS(step_size).
            step_size: Base learning rate (used only when optimizer is None)
            bounder: Optional update bounder (e.g. ObGDBounding)
            normalizer: Optional feature normalizer
            sparsity: Fraction of weights zeroed out per neuron (default: 0.9)
            leaky_relu_slope: Negative slope for LeakyReLU (default: 0.01)
            use_layer_norm: Whether to apply parameterless layer normalization
            head_optimizer: Optional separate optimizer for heads
            trace_mode: Eligibility trace mode (ACCUMULATING or REPLACING)
            utility_decay: EMA decay for hidden-unit utility diagnostics.
        """
        self._horde_spec = horde_spec
        self._hidden_sizes = hidden_sizes
        self._step_size = step_size
        self._sparsity = sparsity
        self._leaky_relu_slope = leaky_relu_slope
        self._use_layer_norm = use_layer_norm
        self._trace_mode = trace_mode
        self._utility_decay = utility_decay

        # Compute per-head gamma*lambda products
        per_head_gl = tuple(
            float(d.gamma * d.lamda) for d in horde_spec.demons
        )

        self._learner = MultiHeadMLPLearner(
            n_heads=len(horde_spec.demons),
            hidden_sizes=hidden_sizes,
            optimizer=optimizer,
            step_size=step_size,
            bounder=bounder,
            gamma=0.0,  # trunk: no trace decay
            lamda=0.0,
            normalizer=normalizer,
            sparsity=sparsity,
            leaky_relu_slope=leaky_relu_slope,
            use_layer_norm=use_layer_norm,
            head_optimizer=head_optimizer,
            per_head_gamma_lamda=per_head_gl,
            trace_mode=trace_mode,
            utility_decay=utility_decay,
        )

    @property
    def horde_spec(self) -> HordeSpec:
        """The HordeSpec defining all demons."""
        return self._horde_spec

    @property
    def n_demons(self) -> int:
        """Number of demons (heads)."""
        return len(self._horde_spec.demons)

    @property
    def learner(self) -> MultiHeadMLPLearner:
        """The underlying MultiHeadMLPLearner."""
        return self._learner

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to dict.

        Returns:
            Dict with horde_spec and all MultiHeadMLPLearner constructor args.
        """
        learner_config = self._learner.to_config()
        # Remove fields managed by HordeLearner
        learner_config.pop("type", None)
        learner_config.pop("n_heads", None)
        learner_config.pop("gamma", None)
        learner_config.pop("lamda", None)
        learner_config.pop("per_head_gamma_lamda", None)
        # trace_mode is managed by HordeLearner, already in learner_config

        return {
            "type": "HordeLearner",
            "horde_spec": self._horde_spec.to_config(),
            **learner_config,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "HordeLearner":
        """Reconstruct from config dict.

        Args:
            config: Dict as produced by ``to_config()``

        Returns:
            Reconstructed HordeLearner
        """
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
        bounder = bounder_from_config(bounder_cfg) if bounder_cfg is not None else None
        normalizer_cfg = config.pop("normalizer", None)
        normalizer = (
            normalizer_from_config(normalizer_cfg) if normalizer_cfg is not None else None
        )
        head_opt_cfg = config.pop("head_optimizer", None)
        head_optimizer = (
            optimizer_from_config(head_opt_cfg) if head_opt_cfg is not None else None
        )

        trace_mode_str = config.pop("trace_mode", None)
        trace_mode = (
            TraceMode(trace_mode_str) if trace_mode_str is not None else TraceMode.ACCUMULATING
        )

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

    def init(self, feature_dim: int, key: Array) -> MultiHeadMLPState:
        """Initialize Horde learner state.

        Args:
            feature_dim: Dimension of the input feature vector
            key: JAX random key for weight initialization

        Returns:
            Initial MultiHeadMLPState
        """
        return self._learner.init(feature_dim, key)

    @functools.partial(jax.jit, static_argnums=(0,))
    def predict(self, state: MultiHeadMLPState, observation: Array) -> Array:
        """Compute predictions from all demons.

        Args:
            state: Current learner state
            observation: Input feature vector

        Returns:
            Array of shape ``(n_demons,)`` with one prediction per demon
        """
        return self._learner.predict(state, observation)  # type: ignore[no-any-return]

    @functools.partial(jax.jit, static_argnums=(0,))
    def update(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
    ) -> HordeUpdateResult:
        """Update Horde given observation, cumulants, and next observation.

        Computes TD targets ``r + gamma * V(s')`` for each demon, then
        delegates to ``MultiHeadMLPLearner.update()``. For gamma=0 demons,
        the target equals the cumulant.

        Args:
            state: Current state
            observation: Input feature vector, shape ``(feature_dim,)``
            cumulants: Per-demon pseudo-rewards, shape ``(n_demons,)``.
                NaN = inactive demon.
            next_observation: Next feature vector, shape ``(feature_dim,)``.
                Used for V(s') bootstrapping. For all-gamma=0 Hordes,
                this is required but doesn't affect results.

        Returns:
            HordeUpdateResult with updated state, predictions, TD errors,
            TD targets, and per-demon metrics
        """
        # 1. Compute V(s') for bootstrapping
        next_preds = self._learner.predict(state, next_observation)

        # 2. TD targets: r + gamma * V(s')
        # For gamma=0 demons: target = cumulant (single-step prediction)
        # NaN cumulants stay NaN (inactive demons)
        gammas = self._horde_spec.gammas
        targets = cumulants + gammas * next_preds

        # 3. Delegate to MultiHeadMLPLearner
        result = self._learner.update(state, observation, targets)

        return HordeUpdateResult(  # type: ignore[call-arg]
            state=result.state,
            predictions=result.predictions,
            td_errors=result.errors,
            td_targets=targets,
            per_demon_metrics=result.per_head_metrics,
            trunk_bounding_metric=result.trunk_bounding_metric,
        )

    @functools.partial(jax.jit, static_argnums=(0,))
    def update_with_discounts(
        self,
        state: MultiHeadMLPState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
        discounts: Array,
    ) -> HordeUpdateResult:
        """Update Horde with explicit per-demon transition discounts.

        This is the same TD update as :meth:`update`, except callers supply the
        effective discount vector for this transition. It lets control adapters
        zero the value head at episode boundaries while keeping the Horde's
        fixed GVF metadata and per-head trace decay intact.

        Args:
            state: Current state.
            observation: Input feature vector, shape ``(feature_dim,)``.
            cumulants: Per-demon pseudo-rewards, shape ``(n_demons,)``.
                NaN = inactive demon.
            next_observation: Next feature vector, shape ``(feature_dim,)``.
            discounts: Effective per-demon discounts for this transition,
                shape ``(n_demons,)``.

        Returns:
            HordeUpdateResult with updated state and TD metrics.
        """
        next_preds = self._learner.predict(state, next_observation)
        discounts = jnp.asarray(discounts, dtype=jnp.float32)
        targets = cumulants + discounts * next_preds
        result = self._learner.update(state, observation, targets)

        return HordeUpdateResult(  # type: ignore[call-arg]
            state=result.state,
            predictions=result.predictions,
            td_errors=result.errors,
            td_targets=targets,
            per_demon_metrics=result.per_head_metrics,
            trunk_bounding_metric=result.trunk_bounding_metric,
        )


# =============================================================================
# Mixed Horde
# =============================================================================


class MixedHorde:
    """Route demons to shared or independent Horde implementations.

    Demons with ``gamma * lambda == 0`` use the shared-trunk
    :class:`HordeLearner`; demons with temporal traces use
    ``IndependentDemonHorde`` so nonlinear trunk traces remain forward-view
    correct. Public predictions, targets, and metrics are returned in the
    original demon order.
    """

    def __init__(
        self,
        horde_spec: HordeSpec,
        hidden_sizes: tuple[int, ...] = (128, 128),
        optimizer: AnyOptimizer | None = None,
        step_size: float = 1.0,
        bounder: Bounder | None = None,
        normalizer: (
            Normalizer[EMANormalizerState] | Normalizer[WelfordNormalizerState] | None
        ) = None,
        sparsity: float = 0.9,
        leaky_relu_slope: float = 0.01,
        use_layer_norm: bool = True,
        head_optimizer: AnyOptimizer | None = None,
        trace_mode: TraceMode = TraceMode.ACCUMULATING,
    ):
        from alberta_framework.core.independent_demon_horde import (
            IndependentDemonHorde,
        )

        self._horde_spec = horde_spec
        self._hidden_sizes = hidden_sizes
        self._optimizer = optimizer
        self._step_size = step_size
        self._bounder = bounder
        self._normalizer = normalizer
        self._sparsity = sparsity
        self._leaky_relu_slope = leaky_relu_slope
        self._use_layer_norm = use_layer_norm
        self._head_optimizer = head_optimizer
        self._trace_mode = trace_mode

        self._shared_indices = tuple(
            i for i, d in enumerate(horde_spec.demons) if float(d.gamma * d.lamda) == 0.0
        )
        self._independent_indices = tuple(
            i for i, d in enumerate(horde_spec.demons) if float(d.gamma * d.lamda) != 0.0
        )

        common_kwargs: dict[str, Any] = {
            "hidden_sizes": hidden_sizes,
            "optimizer": optimizer,
            "step_size": step_size,
            "bounder": bounder,
            "normalizer": normalizer,
            "sparsity": sparsity,
            "leaky_relu_slope": leaky_relu_slope,
            "use_layer_norm": use_layer_norm,
            "head_optimizer": head_optimizer,
            "trace_mode": trace_mode,
        }
        self._shared_horde = (
            HordeLearner(
                horde_spec=self._subset_spec(self._shared_indices),
                **common_kwargs,
            )
            if self._shared_indices
            else None
        )
        self._independent_horde = (
            IndependentDemonHorde(
                horde_spec=self._subset_spec(self._independent_indices),
                **common_kwargs,
            )
            if self._independent_indices
            else None
        )

    @property
    def horde_spec(self) -> HordeSpec:
        """The full HordeSpec in original demon order."""
        return self._horde_spec

    @property
    def n_demons(self) -> int:
        """Number of demons."""
        return len(self._horde_spec.demons)

    @property
    def shared_indices(self) -> tuple[int, ...]:
        """Original demon indices routed to the shared Horde."""
        return self._shared_indices

    @property
    def independent_indices(self) -> tuple[int, ...]:
        """Original demon indices routed to independent demons."""
        return self._independent_indices

    @property
    def shared_horde(self) -> HordeLearner | None:
        """Shared-trunk learner, if any demons route there."""
        return self._shared_horde

    @property
    def independent_horde(self) -> Any | None:
        """Independent-demon learner, if any demons route there."""
        return self._independent_horde

    def _subset_spec(self, indices: tuple[int, ...]) -> HordeSpec:
        return HordeSpec(
            demons=tuple(self._horde_spec.demons[i] for i in indices),
            gammas=self._horde_spec.gammas[jnp.asarray(indices, dtype=jnp.int32)],
            lamdas=self._horde_spec.lamdas[jnp.asarray(indices, dtype=jnp.int32)],
        )

    def to_config(self) -> dict[str, Any]:
        """Serialize learner configuration to dict."""
        return {
            "type": "MixedHorde",
            "horde_spec": self._horde_spec.to_config(),
            "hidden_sizes": list(self._hidden_sizes),
            "optimizer": (
                self._optimizer.to_config() if self._optimizer is not None else None
            ),
            "bounder": (
                self._bounder.to_config() if self._bounder is not None else None
            ),
            "normalizer": (
                self._normalizer.to_config() if self._normalizer is not None else None
            ),
            "head_optimizer": (
                self._head_optimizer.to_config()
                if self._head_optimizer is not None
                else None
            ),
            "step_size": self._step_size,
            "sparsity": self._sparsity,
            "leaky_relu_slope": self._leaky_relu_slope,
            "use_layer_norm": self._use_layer_norm,
            "trace_mode": self._trace_mode.value,
        }

    @classmethod
    def from_config(cls, config: dict[str, Any]) -> "MixedHorde":
        """Reconstruct from config dict."""
        from alberta_framework.core.normalizers import normalizer_from_config
        from alberta_framework.core.optimizers import (
            bounder_from_config,
            optimizer_from_config,
        )

        config = dict(config)
        config.pop("type", None)
        horde_spec = HordeSpec.from_config(config.pop("horde_spec"))
        opt_cfg = config.pop("optimizer", None)
        optimizer = optimizer_from_config(opt_cfg) if opt_cfg is not None else None
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
        trace_mode_str = config.pop("trace_mode", None)
        trace_mode = (
            TraceMode(trace_mode_str) if trace_mode_str is not None else TraceMode.ACCUMULATING
        )
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

    def init(self, feature_dim: int, key: Array) -> MixedHordeState:
        """Initialize mixed Horde state."""
        if self._shared_horde is not None and self._independent_horde is not None:
            shared_key, independent_key = jax.random.split(key)
        else:
            shared_key = independent_key = key
        shared_state = (
            self._shared_horde.init(feature_dim, shared_key)
            if self._shared_horde is not None
            else None
        )
        independent_state = (
            self._independent_horde.init(feature_dim, independent_key)
            if self._independent_horde is not None
            else None
        )
        return MixedHordeState(
            shared_state=shared_state,
            independent_state=independent_state,
            step_count=jnp.array(0, dtype=jnp.int32),
            birth_timestamp=time.time(),
            uptime_s=0.0,
        )

    def predict(self, state: MixedHordeState, observation: Array) -> Array:
        """Compute predictions in original demon order."""
        preds = jnp.full((self.n_demons,), jnp.nan, dtype=jnp.float32)
        if self._shared_horde is not None:
            shared_state = cast(MultiHeadMLPState, state.shared_state)
            shared_preds = self._shared_horde.predict(shared_state, observation)
            preds = preds.at[jnp.asarray(self._shared_indices, dtype=jnp.int32)].set(
                shared_preds
            )
        if self._independent_horde is not None:
            independent_preds = self._independent_horde.predict(
                state.independent_state, observation
            )
            preds = preds.at[
                jnp.asarray(self._independent_indices, dtype=jnp.int32)
            ].set(independent_preds)
        return preds

    def update(
        self,
        state: MixedHordeState,
        observation: Array,
        cumulants: Array,
        next_observation: Array,
    ) -> HordeUpdateResult:
        """Update routed demons and return outputs in original demon order."""
        predictions = jnp.full((self.n_demons,), jnp.nan, dtype=jnp.float32)
        td_errors = jnp.full((self.n_demons,), jnp.nan, dtype=jnp.float32)
        td_targets = jnp.full((self.n_demons,), jnp.nan, dtype=jnp.float32)
        per_demon_metrics = jnp.full((self.n_demons, 3), jnp.nan, dtype=jnp.float32)
        trunk_bounding_metric = jnp.array(1.0, dtype=jnp.float32)
        new_shared_state = state.shared_state
        new_independent_state = state.independent_state

        if self._shared_horde is not None:
            idx = jnp.asarray(self._shared_indices, dtype=jnp.int32)
            shared_result = self._shared_horde.update(
                cast(MultiHeadMLPState, state.shared_state),
                observation,
                cumulants[idx],
                next_observation,
            )
            new_shared_state = shared_result.state
            predictions = predictions.at[idx].set(shared_result.predictions)
            td_errors = td_errors.at[idx].set(shared_result.td_errors)
            td_targets = td_targets.at[idx].set(shared_result.td_targets)
            per_demon_metrics = per_demon_metrics.at[idx].set(
                shared_result.per_demon_metrics
            )
            trunk_bounding_metric = shared_result.trunk_bounding_metric

        if self._independent_horde is not None:
            idx = jnp.asarray(self._independent_indices, dtype=jnp.int32)
            independent_result = self._independent_horde.update(
                state.independent_state,
                observation,
                cumulants[idx],
                next_observation,
            )
            new_independent_state = independent_result.state
            predictions = predictions.at[idx].set(independent_result.predictions)
            td_errors = td_errors.at[idx].set(independent_result.td_errors)
            td_targets = td_targets.at[idx].set(independent_result.td_targets)
            per_demon_metrics = per_demon_metrics.at[idx].set(
                independent_result.per_demon_metrics
            )

        new_state = MixedHordeState(
            shared_state=new_shared_state,
            independent_state=new_independent_state,
            step_count=state.step_count + 1,
            birth_timestamp=state.birth_timestamp,
            uptime_s=state.uptime_s,
        )
        return HordeUpdateResult(
            state=new_state,
            predictions=predictions,
            td_errors=td_errors,
            td_targets=td_targets,
            per_demon_metrics=per_demon_metrics,
            trunk_bounding_metric=trunk_bounding_metric,
        )


# =============================================================================
# Learning Loops
# =============================================================================


def run_horde_learning_loop(
    horde: HordeLearner,
    state: MultiHeadMLPState,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
) -> HordeLearningResult:
    """Run Horde learning loop using ``jax.lax.scan``.

    Scans over ``(obs, cumulants, next_obs)`` triples.

    Args:
        horde: Horde learner
        state: Initial learner state
        observations: Input observations, shape ``(num_steps, feature_dim)``
        cumulants: Per-demon cumulants, shape ``(num_steps, n_demons)``.
            NaN = inactive demon for that step.
        next_observations: Next observations, shape ``(num_steps, feature_dim)``

    Returns:
        HordeLearningResult with final state, per-demon metrics, and TD errors
    """

    def step_fn(
        carry: MultiHeadMLPState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[MultiHeadMLPState, tuple[Array, Array]]:
        l_state = carry
        obs, cums, next_obs = inputs
        result = horde.update(l_state, obs, cums, next_obs)
        return result.state, (result.per_demon_metrics, result.td_errors)

    t0 = time.time()
    final_state, (per_demon_metrics, td_errors) = jax.lax.scan(
        step_fn, state, (observations, cumulants, next_observations)
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(uptime_s=final_state.uptime_s + elapsed)  # type: ignore[attr-defined]

    return HordeLearningResult(  # type: ignore[call-arg]
        state=final_state,
        per_demon_metrics=per_demon_metrics,
        td_errors=td_errors,
    )


def run_mixed_horde_learning_loop(
    horde: MixedHorde,
    state: MixedHordeState,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
) -> MixedHordeLearningResult:
    """Run a mixed Horde learning loop using ``jax.lax.scan``."""

    def step_fn(
        carry: MixedHordeState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[MixedHordeState, tuple[Array, Array]]:
        obs, cums, next_obs = inputs
        result = horde.update(carry, obs, cums, next_obs)
        return result.state, (result.per_demon_metrics, result.td_errors)

    t0 = time.time()
    final_state, (per_demon_metrics, td_errors) = jax.lax.scan(
        step_fn, state, (observations, cumulants, next_observations)
    )
    elapsed = time.time() - t0
    final_state = final_state.replace(  # type: ignore[attr-defined]
        uptime_s=final_state.uptime_s + elapsed
    )
    return MixedHordeLearningResult(  # type: ignore[call-arg]
        state=final_state,
        per_demon_metrics=per_demon_metrics,
        td_errors=td_errors,
    )


def run_horde_learning_loop_final_state(
    horde: HordeLearner,
    state: MultiHeadMLPState,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
) -> MultiHeadMLPState:
    """Run a Horde scan and return only the final learner state.

    Throughput benchmarks use this helper to avoid materializing the full
    metrics trace when only the final state is needed.
    """

    def step_fn(
        carry: MultiHeadMLPState,
        inputs: tuple[Array, Array, Array],
    ) -> tuple[MultiHeadMLPState, None]:
        obs, cums, next_obs = inputs
        result = horde.update(carry, obs, cums, next_obs)
        return result.state, None

    t0 = time.time()
    final_state, _ = jax.lax.scan(
        step_fn,
        state,
        (observations, cumulants, next_observations),
    )
    elapsed = time.time() - t0
    return cast(
        MultiHeadMLPState,
        final_state.replace(uptime_s=final_state.uptime_s + elapsed),  # type: ignore[attr-defined]
    )


def run_horde_learning_loop_batched(
    horde: HordeLearner,
    observations: Array,
    cumulants: Array,
    next_observations: Array,
    keys: Array,
) -> BatchedHordeResult:
    """Run Horde learning loop across seeds using ``jax.vmap``.

    Each seed produces an independently initialized state. All seeds
    share the same observations, cumulants, and next observations.

    Args:
        horde: Horde learner
        observations: Shared observations, shape ``(num_steps, feature_dim)``
        cumulants: Shared cumulants, shape ``(num_steps, n_demons)``
        next_observations: Shared next observations,
            shape ``(num_steps, feature_dim)``
        keys: JAX random keys, shape ``(n_seeds,)`` or ``(n_seeds, 2)``

    Returns:
        BatchedHordeResult with batched states, per-demon metrics, and TD errors
    """
    feature_dim = observations.shape[1]

    def single_run(key: Array) -> tuple[MultiHeadMLPState, Array, Array]:
        init_state = horde.init(feature_dim, key)
        result = run_horde_learning_loop(
            horde, init_state, observations, cumulants, next_observations
        )
        return result.state, result.per_demon_metrics, result.td_errors

    t0 = time.time()
    batched_states, batched_metrics, batched_td_errors = jax.vmap(single_run)(keys)
    elapsed = time.time() - t0
    batched_states = batched_states.replace(  # type: ignore[attr-defined]
        uptime_s=batched_states.uptime_s + elapsed
    )

    return BatchedHordeResult(  # type: ignore[call-arg]
        states=batched_states,
        per_demon_metrics=batched_metrics,
        td_errors=batched_td_errors,
    )
