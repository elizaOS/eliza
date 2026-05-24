"""Out-of-hypothesis-class Step 2 benchmark streams.

These streams test feature *construction* rather than feature *selection*.
The existing Step 2 streams (``InteractionFeatureDiscoveryStream``,
``NonlinearFeatureDiscoveryStream``) place the oracle features inside the
learner's hypothesis class -- the learner is given pair-products and the
stream uses pair-products, so "discovery" reduces to selecting the right
items from a known pool.

The Alberta Plan Step 2 demands construction of features from existing
features in the general case.  To probe that, the streams here generate
targets whose minimal representation lies *outside* a 1-layer pair-product
or tanh feature bank:

* ``OutOfClassPolynomialStream`` -- degree-3 polynomial targets requiring
  triple products ``x_i * x_j * x_l``.  A pair-product learner can only fit
  the marginal pair structure; a learner that composes pair-products with
  raw features (``(x_i * x_j) * x_l``) can fit the targets exactly.

* ``FrequencyMismatchStream`` -- targets are sums of trigonometric features
  ``sin(omega * x + phi)``.  Tanh / pair-product banks cannot represent
  sin(x) and must compose many surrogate features to approximate it.

* ``CompositionalStream`` -- targets are 2-hidden-layer tanh networks.
  A 1-layer feature bank cannot represent the targets exactly; only a
  compositional DAG that builds features-of-features can.
"""

import chex
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int, PRNGKeyArray

from alberta_framework.core.types import TimeStep

# =============================================================================
# OutOfClassPolynomialStream -- degree-3 polynomial targets
# =============================================================================


@chex.dataclass(frozen=True)
class OutOfClassPolynomialState:
    """State for ``OutOfClassPolynomialStream``.

    The hidden oracle features are unordered triple products
    ``x_i * x_j * x_l``.  The triple list is fixed; per-context weights
    determine which triples are useful for each task.

    Attributes:
        key: PRNG key for sample generation.
        triples_left: First index of each triple, shape ``(n_triples,)``.
        triples_middle: Middle index of each triple, shape ``(n_triples,)``.
        triples_right: Third index of each triple, shape ``(n_triples,)``.
        context_weights: Per-context task weights over triples,
            shape ``(n_contexts, n_tasks, n_triples)``.
        linear_weights: Small direct linear component, shape
            ``(n_tasks, feature_dim)``.
        step_count: Number of generated samples so far.
    """

    key: PRNGKeyArray
    triples_left: Int[Array, " n_triples"]
    triples_middle: Int[Array, " n_triples"]
    triples_right: Int[Array, " n_triples"]
    context_weights: Float[Array, "n_contexts n_tasks n_triples"]
    linear_weights: Float[Array, "n_tasks feature_dim"]
    step_count: Int[Array, ""]


class OutOfClassPolynomialStream:
    """Non-stationary stream whose useful features are triple products.

    Targets are degree-3 polynomial combinations:

    ``y*_k(x) = sum_{i<=j<=l} W_k[i,j,l] x_i x_j x_l + L_k . x + noise``

    where ``W_k`` is sparse (only ``active_triples_per_context`` triples
    nonzero per task per context).  A learner whose feature bank contains
    only pair products ``x_i * x_j`` cannot fit this exactly; a learner
    able to compose features (``(x_i * x_j) * x_l``) can.
    """

    def __init__(
        self,
        feature_dim: int = 8,
        n_tasks: int = 3,
        n_contexts: int = 4,
        context_length: int = 500,
        active_triples_per_context: int = 3,
        feature_std: float = 1.0,
        linear_scale: float = 0.05,
        noise_std: float = 0.05,
        include_squares: bool = False,
    ):
        """Initialize the out-of-class polynomial stream.

        Args:
            feature_dim: Raw observation dimension.
            n_tasks: Number of supervised output heads.
            n_contexts: Number of recurring relevance contexts.
            context_length: Steps before switching context.
            active_triples_per_context: Expected active triple products per
                task/context.
            feature_std: Standard deviation of raw observations.
            linear_scale: Scale of the small direct linear component.
            noise_std: Standard deviation of target noise.
            include_squares: Whether to include triples with repeated
                indices (``x_i^2 * x_j``, ``x_i^3``).  Default False, so
                the oracle uses strict ``i < j < l`` triples only.
        """
        if feature_dim < 3:
            raise ValueError("feature_dim must be at least 3")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if context_length < 1:
            raise ValueError("context_length must be positive")
        if active_triples_per_context < 1:
            raise ValueError("active_triples_per_context must be positive")

        self._feature_dim = feature_dim
        self._n_tasks = n_tasks
        self._n_contexts = n_contexts
        self._context_length = context_length
        self._active_triples_per_context = active_triples_per_context
        self._feature_std = feature_std
        self._linear_scale = linear_scale
        self._noise_std = noise_std
        self._include_squares = include_squares

    @property
    def feature_dim(self) -> int:
        """Return the raw observation dimension."""
        return self._feature_dim

    @property
    def target_dim(self) -> int:
        """Return the number of supervised tasks."""
        return self._n_tasks

    def _triples(self) -> tuple[Array, Array, Array]:
        """Enumerate all unordered triples (i, j, l).

        With ``include_squares=False``, returns strict ``i < j < l`` triples
        (count ``C(feature_dim, 3)``).  With ``include_squares=True``,
        returns ``i <= j <= l`` triples (count ``C(feature_dim+2, 3)``).

        The enumeration runs at construction time in plain Python and is
        materialized into JAX integer arrays, so it does not interact with
        JIT.

        Returns:
            Three Int arrays of equal length: left, middle, right indices.
        """
        triples: list[tuple[int, int, int]] = []
        for i in range(self._feature_dim):
            j_start = i if self._include_squares else i + 1
            for j in range(j_start, self._feature_dim):
                l_start = j if self._include_squares else j + 1
                for ell in range(l_start, self._feature_dim):
                    triples.append((i, j, ell))
        if not triples:
            raise ValueError(
                "feature_dim too small to enumerate any oracle triples"
            )
        arr = jnp.array(triples, dtype=jnp.int32)
        return arr[:, 0], arr[:, 1], arr[:, 2]

    def init(self, key: Array) -> OutOfClassPolynomialState:
        """Initialize stream state.

        Args:
            key: JAX PRNG key.

        Returns:
            Initialized ``OutOfClassPolynomialState``.
        """
        key, k_ctx, k_mask, k_linear = jr.split(key, 4)
        triples_left, triples_middle, triples_right = self._triples()
        n_triples = triples_left.shape[0]

        dense_context_weights = jr.normal(
            k_ctx,
            (self._n_contexts, self._n_tasks, n_triples),
            dtype=jnp.float32,
        )
        active_count = min(self._active_triples_per_context, n_triples)
        mask_scores = jr.uniform(
            k_mask,
            (self._n_contexts, self._n_tasks, n_triples),
            dtype=jnp.float32,
        )
        threshold = jnp.sort(mask_scores, axis=-1)[..., active_count - 1 : active_count]
        mask = mask_scores <= threshold
        context_weights = dense_context_weights * mask.astype(jnp.float32)
        norm = jnp.sqrt(jnp.maximum(jnp.sum(mask, axis=-1, keepdims=True), 1.0))
        context_weights = context_weights / norm

        linear_weights = self._linear_scale * jr.normal(
            k_linear, (self._n_tasks, self._feature_dim), dtype=jnp.float32
        )

        return OutOfClassPolynomialState(
            key=key,
            triples_left=triples_left,
            triples_middle=triples_middle,
            triples_right=triples_right,
            context_weights=context_weights,
            linear_weights=linear_weights,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: OutOfClassPolynomialState,
        idx: Array,
    ) -> tuple[TimeStep, OutOfClassPolynomialState]:
        """Generate one multitask polynomial sample.

        Args:
            state: Current stream state.
            idx: Step index (unused; kept for ``ScanStream`` protocol).

        Returns:
            Tuple of (``TimeStep``, new stream state).
        """
        del idx
        key, k_x, k_noise = jr.split(state.key, 3)
        x = self._feature_std * jr.normal(
            k_x, (self._feature_dim,), dtype=jnp.float32
        )
        triples = (
            x[state.triples_left]
            * x[state.triples_middle]
            * x[state.triples_right]
        )
        context_idx = (state.step_count // self._context_length) % self._n_contexts
        task_weights = state.context_weights[context_idx]
        target = task_weights @ triples + state.linear_weights @ x
        noise = self._noise_std * jr.normal(
            k_noise, (self._n_tasks,), dtype=jnp.float32
        )
        target = target + noise

        timestep = TimeStep(observation=x, target=target)
        new_state = state.replace(  # type: ignore[attr-defined]
            key=key, step_count=state.step_count + 1
        )
        return timestep, new_state


# =============================================================================
# FrequencyMismatchStream -- trigonometric targets
# =============================================================================


@chex.dataclass(frozen=True)
class FrequencyMismatchState:
    """State for ``FrequencyMismatchStream``.

    Each context defines a different set of trigonometric oracle features
    (frequency, phase, active input dimension, amplitude) per task and
    component.

    Attributes:
        key: PRNG key for sample generation.
        omegas: Per-context per-task per-component frequencies, shape
            ``(n_contexts, n_tasks, n_components_per_task)``.
        phases: Per-context per-task per-component phase offsets, shape
            ``(n_contexts, n_tasks, n_components_per_task)``.
        active_indices: Which input dimension each component listens to,
            shape ``(n_contexts, n_tasks, n_components_per_task)``.
        amplitudes: Per-context per-task per-component amplitudes,
            shape ``(n_contexts, n_tasks, n_components_per_task)``.
        step_count: Number of generated samples so far.
    """

    key: PRNGKeyArray
    omegas: Float[Array, "n_contexts n_tasks n_components"]
    phases: Float[Array, "n_contexts n_tasks n_components"]
    active_indices: Int[Array, "n_contexts n_tasks n_components"]
    amplitudes: Float[Array, "n_contexts n_tasks n_components"]
    step_count: Int[Array, ""]


class FrequencyMismatchStream:
    """Non-stationary stream whose targets are sums of sinusoids.

    Targets are sums of trigonometric features:

    ``y*_k(x) = sum_c A_kc sin(omega_kc x[i_kc] + phi_kc) + noise``

    where the per-context ``omega``, ``phi``, ``i``, and ``A`` are all
    fixed at ``init`` time.  A learner whose hypothesis class is built from
    tanh / pair-products cannot represent ``sin`` exactly; it must compose
    many surrogate features to approximate this oracle.
    """

    def __init__(
        self,
        feature_dim: int = 4,
        n_tasks: int = 2,
        n_components_per_task: int = 3,
        n_contexts: int = 4,
        context_length: int = 500,
        omega_min: float = 0.5,
        omega_max: float = 3.0,
        amplitude_scale: float = 1.0,
        noise_std: float = 0.05,
    ):
        """Initialize the frequency-mismatch stream.

        Args:
            feature_dim: Raw observation dimension.
            n_tasks: Number of supervised output heads.
            n_components_per_task: Number of sinusoidal components combined
                in each task target.
            n_contexts: Number of recurring relevance contexts.
            context_length: Steps before switching context.
            omega_min: Minimum sinusoid angular frequency.
            omega_max: Maximum sinusoid angular frequency.
            amplitude_scale: Scale of per-component amplitudes (drawn from
                a centered Gaussian times this factor).
            noise_std: Standard deviation of target noise.
        """
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if n_components_per_task < 1:
            raise ValueError("n_components_per_task must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if context_length < 1:
            raise ValueError("context_length must be positive")
        if omega_min <= 0:
            raise ValueError("omega_min must be positive")
        if omega_max <= omega_min:
            raise ValueError("omega_max must exceed omega_min")

        self._feature_dim = feature_dim
        self._n_tasks = n_tasks
        self._n_components_per_task = n_components_per_task
        self._n_contexts = n_contexts
        self._context_length = context_length
        self._omega_min = omega_min
        self._omega_max = omega_max
        self._amplitude_scale = amplitude_scale
        self._noise_std = noise_std

    @property
    def feature_dim(self) -> int:
        """Return the raw observation dimension."""
        return self._feature_dim

    @property
    def target_dim(self) -> int:
        """Return the number of supervised tasks."""
        return self._n_tasks

    def init(self, key: Array) -> FrequencyMismatchState:
        """Initialize stream state.

        Args:
            key: JAX PRNG key.

        Returns:
            Initialized ``FrequencyMismatchState``.
        """
        key, k_omega, k_phase, k_active, k_amp = jr.split(key, 5)
        shape = (
            self._n_contexts,
            self._n_tasks,
            self._n_components_per_task,
        )
        omegas = jr.uniform(
            k_omega, shape, dtype=jnp.float32,
            minval=self._omega_min, maxval=self._omega_max,
        )
        phases = jr.uniform(
            k_phase, shape, dtype=jnp.float32,
            minval=0.0, maxval=float(2 * jnp.pi),
        )
        active_indices = jr.randint(
            k_active, shape, minval=0, maxval=self._feature_dim, dtype=jnp.int32
        )
        amplitudes = self._amplitude_scale * jr.normal(
            k_amp, shape, dtype=jnp.float32
        )
        return FrequencyMismatchState(
            key=key,
            omegas=omegas,
            phases=phases,
            active_indices=active_indices,
            amplitudes=amplitudes,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: FrequencyMismatchState,
        idx: Array,
    ) -> tuple[TimeStep, FrequencyMismatchState]:
        """Generate one multitask sinusoidal sample.

        Args:
            state: Current stream state.
            idx: Step index (unused; kept for ``ScanStream`` protocol).

        Returns:
            Tuple of (``TimeStep``, new stream state).
        """
        del idx
        key, k_x, k_noise = jr.split(state.key, 3)
        # Sample x ~ Uniform[-pi, pi] so sin/cos cover their full range.
        x = jr.uniform(
            k_x, (self._feature_dim,), dtype=jnp.float32,
            minval=-float(jnp.pi), maxval=float(jnp.pi),
        )
        context_idx = (state.step_count // self._context_length) % self._n_contexts

        omegas = state.omegas[context_idx]              # (n_tasks, n_components)
        phases = state.phases[context_idx]              # (n_tasks, n_components)
        active = state.active_indices[context_idx]      # (n_tasks, n_components)
        amps = state.amplitudes[context_idx]            # (n_tasks, n_components)

        x_active = x[active]                            # (n_tasks, n_components)
        components = jnp.sin(omegas * x_active + phases)
        target = jnp.sum(amps * components, axis=-1)    # (n_tasks,)
        noise = self._noise_std * jr.normal(
            k_noise, (self._n_tasks,), dtype=jnp.float32
        )
        target = target + noise

        timestep = TimeStep(observation=x, target=target)
        new_state = state.replace(  # type: ignore[attr-defined]
            key=key, step_count=state.step_count + 1
        )
        return timestep, new_state


# =============================================================================
# CompositionalStream -- 2-hidden-layer tanh oracle
# =============================================================================


@chex.dataclass(frozen=True)
class CompositionalState:
    """State for ``CompositionalStream``.

    Each context defines a 2-hidden-layer tanh network whose output is
    summed against per-output amplitudes.  The targets are therefore
    representable only by composing features-of-features.

    Attributes:
        key: PRNG key for sample generation.
        inner_w: Inner weight matrices, shape
            ``(n_contexts, n_tasks, outer_components, inner_hidden, feature_dim)``.
        inner_b: Inner biases, shape
            ``(n_contexts, n_tasks, outer_components, inner_hidden)``.
        outer_w: Outer weight vectors, shape
            ``(n_contexts, n_tasks, outer_components, inner_hidden)``.
        outer_b: Outer biases, shape
            ``(n_contexts, n_tasks, outer_components)``.
        amplitudes: Per-component output scalings, shape
            ``(n_contexts, n_tasks, outer_components)``.
        step_count: Number of generated samples so far.
    """

    key: PRNGKeyArray
    inner_w: Float[Array, "n_contexts n_tasks outer inner feature_dim"]
    inner_b: Float[Array, "n_contexts n_tasks outer inner"]
    outer_w: Float[Array, "n_contexts n_tasks outer inner"]
    outer_b: Float[Array, "n_contexts n_tasks outer"]
    amplitudes: Float[Array, "n_contexts n_tasks outer"]
    step_count: Int[Array, ""]


class CompositionalStream:
    """Non-stationary stream whose targets are 2-hidden-layer tanh nets.

    Targets are computed as:

    ``inner = tanh(V x + c)``
    ``outer = tanh(W inner + b)``
    ``y*_k = a . outer + noise``

    A 1-layer feature bank (raw features, single-layer tanh, or pair
    products) cannot represent the targets exactly; only a compositional
    DAG that builds features-of-features can.
    """

    def __init__(
        self,
        feature_dim: int = 6,
        n_tasks: int = 3,
        inner_hidden: int = 4,
        outer_components: int = 5,
        n_contexts: int = 4,
        context_length: int = 500,
        feature_std: float = 1.0,
        weight_scale: float = 1.0,
        amplitude_scale: float = 1.0,
        noise_std: float = 0.05,
    ):
        """Initialize the compositional stream.

        Args:
            feature_dim: Raw observation dimension.
            n_tasks: Number of supervised output heads.
            inner_hidden: Width of the inner tanh layer per outer component.
            outer_components: Number of outer tanh components combined per
                task.
            n_contexts: Number of recurring relevance contexts.
            context_length: Steps before switching context.
            feature_std: Standard deviation of raw observations.
            weight_scale: Scale of per-layer weights (divided by sqrt(fan-in)
                for unit-variance pre-activations).
            amplitude_scale: Scale of per-component output amplitudes.
            noise_std: Standard deviation of target noise.
        """
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if inner_hidden < 1:
            raise ValueError("inner_hidden must be positive")
        if outer_components < 1:
            raise ValueError("outer_components must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if context_length < 1:
            raise ValueError("context_length must be positive")

        self._feature_dim = feature_dim
        self._n_tasks = n_tasks
        self._inner_hidden = inner_hidden
        self._outer_components = outer_components
        self._n_contexts = n_contexts
        self._context_length = context_length
        self._feature_std = feature_std
        self._weight_scale = weight_scale
        self._amplitude_scale = amplitude_scale
        self._noise_std = noise_std

    @property
    def feature_dim(self) -> int:
        """Return the raw observation dimension."""
        return self._feature_dim

    @property
    def target_dim(self) -> int:
        """Return the number of supervised tasks."""
        return self._n_tasks

    def init(self, key: Array) -> CompositionalState:
        """Initialize stream state.

        Args:
            key: JAX PRNG key.

        Returns:
            Initialized ``CompositionalState``.
        """
        key, k_iw, k_ib, k_ow, k_ob, k_amp = jr.split(key, 6)

        inner_shape = (
            self._n_contexts,
            self._n_tasks,
            self._outer_components,
            self._inner_hidden,
            self._feature_dim,
        )
        outer_shape = (
            self._n_contexts,
            self._n_tasks,
            self._outer_components,
            self._inner_hidden,
        )
        component_shape = (
            self._n_contexts,
            self._n_tasks,
            self._outer_components,
        )

        inner_w = (
            self._weight_scale
            * jr.normal(k_iw, inner_shape, dtype=jnp.float32)
            / jnp.sqrt(float(self._feature_dim))
        )
        inner_b = 0.25 * jr.normal(k_ib, outer_shape, dtype=jnp.float32)
        outer_w = (
            self._weight_scale
            * jr.normal(k_ow, outer_shape, dtype=jnp.float32)
            / jnp.sqrt(float(self._inner_hidden))
        )
        outer_b = 0.25 * jr.normal(k_ob, component_shape, dtype=jnp.float32)
        amplitudes = self._amplitude_scale * jr.normal(
            k_amp, component_shape, dtype=jnp.float32
        )

        return CompositionalState(
            key=key,
            inner_w=inner_w,
            inner_b=inner_b,
            outer_w=outer_w,
            outer_b=outer_b,
            amplitudes=amplitudes,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: CompositionalState,
        idx: Array,
    ) -> tuple[TimeStep, CompositionalState]:
        """Generate one multitask compositional sample.

        Args:
            state: Current stream state.
            idx: Step index (unused; kept for ``ScanStream`` protocol).

        Returns:
            Tuple of (``TimeStep``, new stream state).
        """
        del idx
        key, k_x, k_noise = jr.split(state.key, 3)
        x = self._feature_std * jr.normal(
            k_x, (self._feature_dim,), dtype=jnp.float32
        )
        context_idx = (state.step_count // self._context_length) % self._n_contexts

        # Pull this context's per-task per-component subnetworks.
        inner_w = state.inner_w[context_idx]    # (T, O, H, F)
        inner_b = state.inner_b[context_idx]    # (T, O, H)
        outer_w = state.outer_w[context_idx]    # (T, O, H)
        outer_b = state.outer_b[context_idx]    # (T, O)
        amps = state.amplitudes[context_idx]    # (T, O)

        # inner = tanh(V x + c) -> (T, O, H)
        inner_pre = jnp.einsum("tohf,f->toh", inner_w, x) + inner_b
        inner = jnp.tanh(inner_pre)
        # outer = tanh(W inner + b) -> (T, O)
        outer_pre = jnp.sum(outer_w * inner, axis=-1) + outer_b
        outer = jnp.tanh(outer_pre)
        # target_t = sum_o amps[t, o] * outer[t, o]
        target = jnp.sum(amps * outer, axis=-1)
        noise = self._noise_std * jr.normal(
            k_noise, (self._n_tasks,), dtype=jnp.float32
        )
        target = target + noise

        timestep = TimeStep(observation=x, target=target)
        new_state = state.replace(  # type: ignore[attr-defined]
            key=key, step_count=state.step_count + 1
        )
        return timestep, new_state
