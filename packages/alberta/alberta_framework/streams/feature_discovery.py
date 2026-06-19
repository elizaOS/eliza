"""Step 2 feature-discovery streams.

These streams are designed for the Alberta Plan's Step 2 setting:
continual supervised learning with vector-valued targets, nonlinear latent
features, and changing feature relevance.  The latent features are known to the
stream but hidden from learners, which makes the benchmark useful for evaluating
feature construction and replacement methods under a fixed resource budget.
"""

from typing import Any

import chex
import jax.numpy as jnp
import jax.random as jr
from jax import Array
from jaxtyping import Float, Int, PRNGKeyArray

from alberta_framework.core.types import TimeStep


@chex.dataclass(frozen=True)
class NonlinearFeatureDiscoveryState:
    """State for ``NonlinearFeatureDiscoveryStream``.

    Attributes:
        key: PRNG key for sample generation.
        latent_weights: Hidden feature weights, shape ``(n_latents, feature_dim)``.
        latent_biases: Hidden feature biases, shape ``(n_latents,)``.
        context_weights: Per-context task weights over latent features,
            shape ``(n_contexts, n_tasks, n_latents)``.
        linear_weights: Small direct linear component, shape
            ``(n_tasks, feature_dim)``.
        step_count: Number of generated samples.
    """

    key: PRNGKeyArray
    latent_weights: Float[Array, "n_latents feature_dim"]
    latent_biases: Float[Array, " n_latents"]
    context_weights: Float[Array, "n_contexts n_tasks n_latents"]
    linear_weights: Float[Array, "n_tasks feature_dim"]
    step_count: Int[Array, ""]


@chex.dataclass(frozen=True)
class InteractionFeatureDiscoveryState:
    """State for ``InteractionFeatureDiscoveryStream``.

    The hidden oracle features are pairwise products ``x_i * x_j``.  The pair
    list is fixed, while context weights determine which products are useful.
    """

    key: PRNGKeyArray
    pair_left: Int[Array, " n_pairs"]
    pair_right: Int[Array, " n_pairs"]
    context_weights: Float[Array, "n_contexts n_tasks n_pairs"]
    linear_weights: Float[Array, "n_tasks feature_dim"]
    step_count: Int[Array, ""]


class NonlinearFeatureDiscoveryStream:
    """Non-stationary multitask stream with hidden nonlinear features.

    Observations are raw vectors ``x_t``.  Targets are vector-valued:

    ``y*_t = W_c phi(x_t) + L x_t + noise``

    where ``phi`` is a fixed bank of hidden nonlinear features and ``W_c``
    changes by context.  This creates a controlled Step 2 benchmark: useful
    nonlinear features exist, relevance shifts over time, and the learner has
    only a limited budget of representable features.
    """

    def __init__(
        self,
        feature_dim: int,
        n_tasks: int = 4,
        n_latents: int = 32,
        n_contexts: int = 8,
        context_length: int = 500,
        active_latents_per_context: int = 6,
        feature_std: float = 1.0,
        latent_scale: float = 1.0,
        linear_scale: float = 0.05,
        noise_std: float = 0.01,
    ):
        """Initialize the nonlinear feature-discovery stream.

        Args:
            feature_dim: Raw observation dimension.
            n_tasks: Number of supervised output heads.
            n_latents: Number of hidden oracle nonlinear features.
            n_contexts: Number of recurring relevance contexts.
            context_length: Number of steps before switching context.
            active_latents_per_context: Expected number of useful latent
                features per task/context.
            feature_std: Standard deviation of raw observations.
            latent_scale: Scale of oracle latent weights.
            linear_scale: Scale of the direct linear target component.
            noise_std: Standard deviation of target noise.
        """
        if feature_dim < 1:
            raise ValueError("feature_dim must be positive")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if n_latents < 1:
            raise ValueError("n_latents must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if context_length < 1:
            raise ValueError("context_length must be positive")
        if active_latents_per_context < 1:
            raise ValueError("active_latents_per_context must be positive")

        self._feature_dim = feature_dim
        self._n_tasks = n_tasks
        self._n_latents = n_latents
        self._n_contexts = n_contexts
        self._context_length = context_length
        self._active_latents_per_context = active_latents_per_context
        self._feature_std = feature_std
        self._latent_scale = latent_scale
        self._linear_scale = linear_scale
        self._noise_std = noise_std

    @property
    def feature_dim(self) -> int:
        """Return the raw observation dimension."""
        return self._feature_dim

    @property
    def target_dim(self) -> int:
        """Return the number of supervised tasks."""
        return self._n_tasks

    @property
    def n_latents(self) -> int:
        """Return the number of hidden oracle features."""
        return self._n_latents

    def init(self, key: Array) -> NonlinearFeatureDiscoveryState:
        """Initialize stream state."""
        key, k_latent, k_bias, k_ctx, k_mask, k_linear = jr.split(key, 6)

        latent_weights = (
            self._latent_scale
            * jr.normal(k_latent, (self._n_latents, self._feature_dim), dtype=jnp.float32)
            / jnp.sqrt(float(self._feature_dim))
        )
        latent_biases = 0.25 * jr.normal(k_bias, (self._n_latents,), dtype=jnp.float32)

        dense_context_weights = jr.normal(
            k_ctx,
            (self._n_contexts, self._n_tasks, self._n_latents),
            dtype=jnp.float32,
        )
        keep_prob = min(1.0, self._active_latents_per_context / self._n_latents)
        mask = jr.bernoulli(
            k_mask,
            keep_prob,
            (self._n_contexts, self._n_tasks, self._n_latents),
        )
        context_weights = dense_context_weights * mask.astype(jnp.float32)
        norm = jnp.sqrt(jnp.maximum(jnp.sum(mask, axis=-1, keepdims=True), 1.0))
        context_weights = context_weights / norm

        linear_weights = self._linear_scale * jr.normal(
            k_linear, (self._n_tasks, self._feature_dim), dtype=jnp.float32
        )

        return NonlinearFeatureDiscoveryState(
            key=key,
            latent_weights=latent_weights,
            latent_biases=latent_biases,
            context_weights=context_weights,
            linear_weights=linear_weights,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: NonlinearFeatureDiscoveryState,
        idx: Array,
    ) -> tuple[TimeStep, NonlinearFeatureDiscoveryState]:
        """Generate one multitask supervised sample."""
        del idx
        key, k_x, k_noise = jr.split(state.key, 3)

        x = self._feature_std * jr.normal(
            k_x, (self._feature_dim,), dtype=jnp.float32
        )
        latents = jnp.tanh(state.latent_weights @ x + state.latent_biases)

        context_idx = (state.step_count // self._context_length) % self._n_contexts
        task_weights = state.context_weights[context_idx]
        target = task_weights @ latents + state.linear_weights @ x
        noise = self._noise_std * jr.normal(k_noise, (self._n_tasks,), dtype=jnp.float32)
        target = target + noise

        timestep = TimeStep(observation=x, target=target)
        new_state = state.replace(key=key, step_count=state.step_count + 1)  # type: ignore[attr-defined]
        return timestep, new_state


def collect_feature_discovery_stream(
    stream: Any,
    num_steps: int,
    key: Array,
) -> tuple[Array, Array]:
    """Collect a fixed array view of a feature-discovery stream.

    This helper is for controlled experiments where multiple learners should
    see the exact same stream.  It still uses the one-step stream interface and
    ``jax.lax.scan``; it does not imply experience replay inside a learner.
    """
    import jax

    state = stream.init(key)

    def step_fn(
        carry: Any,
        idx: Array,
    ) -> tuple[Any, tuple[Array, Array]]:
        timestep, new_state = stream.step(carry, idx)
        return new_state, (timestep.observation, timestep.target)

    _, (observations, targets) = jax.lax.scan(
        step_fn, state, jnp.arange(num_steps)
    )
    return observations, targets


class InteractionFeatureDiscoveryStream:
    """Non-stationary stream whose useful features are pairwise products.

    This benchmark gives Step 2 a sharper target than generic MLP learning.
    The useful nonlinear features are literal combinations of existing raw
    features:

    ``phi_ij(x_t) = x_t[i] * x_t[j]``

    The learner observes only ``x_t`` and vector target ``y*_t``.  Contexts
    change which products matter, so a bounded learner must rank and replace
    features rather than merely grow capacity.
    """

    def __init__(
        self,
        feature_dim: int,
        n_tasks: int = 4,
        n_contexts: int = 8,
        context_length: int = 500,
        active_pairs_per_context: int = 6,
        feature_std: float = 1.0,
        linear_scale: float = 0.01,
        noise_std: float = 0.01,
        include_squares: bool = False,
    ):
        """Initialize the interaction stream.

        Args:
            feature_dim: Raw observation dimension.
            n_tasks: Number of supervised output heads.
            n_contexts: Number of recurring relevance contexts.
            context_length: Steps before switching context.
            active_pairs_per_context: Expected active pair-products per
                task/context.
            feature_std: Standard deviation of raw observations.
            linear_scale: Scale of the small direct linear component.
            noise_std: Standard deviation of target noise.
            include_squares: Whether to include ``x_i * x_i`` oracle features.
        """
        if feature_dim < 2:
            raise ValueError("feature_dim must be at least 2")
        if n_tasks < 1:
            raise ValueError("n_tasks must be positive")
        if n_contexts < 1:
            raise ValueError("n_contexts must be positive")
        if context_length < 1:
            raise ValueError("context_length must be positive")
        if active_pairs_per_context < 1:
            raise ValueError("active_pairs_per_context must be positive")

        self._feature_dim = feature_dim
        self._n_tasks = n_tasks
        self._n_contexts = n_contexts
        self._context_length = context_length
        self._active_pairs_per_context = active_pairs_per_context
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

    def _pairs(self) -> tuple[Array, Array]:
        pairs = []
        for i in range(self._feature_dim):
            start = i if self._include_squares else i + 1
            for j in range(start, self._feature_dim):
                pairs.append((i, j))
        arr = jnp.array(pairs, dtype=jnp.int32)
        return arr[:, 0], arr[:, 1]

    def init(self, key: Array) -> InteractionFeatureDiscoveryState:
        """Initialize stream state."""
        key, k_ctx, k_mask, k_linear = jr.split(key, 4)
        pair_left, pair_right = self._pairs()
        n_pairs = pair_left.shape[0]

        dense_context_weights = jr.normal(
            k_ctx,
            (self._n_contexts, self._n_tasks, n_pairs),
            dtype=jnp.float32,
        )
        active_count = min(self._active_pairs_per_context, n_pairs)
        mask_scores = jr.uniform(
            k_mask,
            (self._n_contexts, self._n_tasks, n_pairs),
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

        return InteractionFeatureDiscoveryState(
            key=key,
            pair_left=pair_left,
            pair_right=pair_right,
            context_weights=context_weights,
            linear_weights=linear_weights,
            step_count=jnp.array(0, dtype=jnp.int32),
        )

    def step(
        self,
        state: InteractionFeatureDiscoveryState,
        idx: Array,
    ) -> tuple[TimeStep, InteractionFeatureDiscoveryState]:
        """Generate one multitask interaction sample."""
        del idx
        key, k_x, k_noise = jr.split(state.key, 3)
        x = self._feature_std * jr.normal(
            k_x, (self._feature_dim,), dtype=jnp.float32
        )
        interactions = x[state.pair_left] * x[state.pair_right]
        context_idx = (state.step_count // self._context_length) % self._n_contexts
        task_weights = state.context_weights[context_idx]
        target = task_weights @ interactions + state.linear_weights @ x
        noise = self._noise_std * jr.normal(k_noise, (self._n_tasks,), dtype=jnp.float32)
        target = target + noise

        timestep = TimeStep(observation=x, target=target)
        new_state = state.replace(key=key, step_count=state.step_count + 1)  # type: ignore[attr-defined]
        return timestep, new_state
