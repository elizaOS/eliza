"""Feature relevance diagnostics for MultiHeadMLPLearner.

Extracts per-feature, per-head relevance metrics from existing learner state
without modifying the update/predict hot path. Designed for periodic diagnostic
reporting in daemon deployments (e.g. rlsecd).

Tier 1 metrics are zero-cost (state extraction only, no forward pass).
Tier 2 metrics (feature sensitivity) require a Jacobian computation.
"""

from typing import Any

import chex
import jax
import jax.numpy as jnp
from jax import Array

from alberta_framework.core.multi_head_learner import MultiHeadMLPLearner, MultiHeadMLPState


@chex.dataclass(frozen=True)
class FeatureRelevance:
    """Per-feature and per-head relevance metrics extracted from learner state.

    All fields are derived from existing ``MultiHeadMLPState`` arrays.
    No forward pass is required.

    Attributes:
        weight_relevance: Path-norm relevance from input features to each head.
            Shape ``(n_heads, feature_dim)``.
        step_size_activity: Mean absolute step-size on input layer per feature.
            Shape ``(feature_dim,)``.
        trace_activity: Mean absolute trunk trace magnitude on input layer
            per feature. Shape ``(feature_dim,)``.
        normalizer_mean: Per-feature normalizer mean estimate, or None if no
            normalizer. Shape ``(feature_dim,)``.
        normalizer_std: Per-feature normalizer std estimate, or None if no
            normalizer. Shape ``(feature_dim,)``.
        head_reliance: L1 norm of each head's weight vector over the last
            hidden layer. Shape ``(n_heads, hidden_dim_last)``.
        head_mean_step_size: Mean step-size per head, or None if optimizer
            has no per-weight step-sizes. Shape ``(n_heads,)``.
    """

    weight_relevance: Array  # (n_heads, feature_dim)
    step_size_activity: Array  # (feature_dim,)
    trace_activity: Array  # (feature_dim,)
    normalizer_mean: Array | None  # (feature_dim,)
    normalizer_std: Array | None  # (feature_dim,)
    head_reliance: Array  # (n_heads, hidden_dim_last)
    head_mean_step_size: Array | None  # (n_heads,)


def compute_feature_relevance(state: MultiHeadMLPState) -> FeatureRelevance:
    """Extract per-feature relevance metrics from multi-head learner state.

    All metrics are computed from existing state arrays via small matrix
    multiplies. Typical cost: ~10-50us after JIT for a (64,64) trunk
    with 5 heads and 12 features.

    Args:
        state: Current multi-head MLP learner state.

    Returns:
        ``FeatureRelevance`` dataclass with all Tier 1 metrics.
    """
    n_heads = len(state.head_params.weights)
    n_trunk_layers = len(state.trunk_params.weights)

    # --- Weight relevance (path-norm) ---
    # Build path through trunk: |W0|, then |W1| @ path, ...
    # trunk_params.weights[0] has shape (H0, feature_dim)
    if n_trunk_layers > 0:
        path = jnp.abs(state.trunk_params.weights[0])  # (H0, feature_dim)
        for i in range(1, n_trunk_layers):
            path = jnp.abs(state.trunk_params.weights[i]) @ path  # (H_i, feature_dim)

        # Per-head: |head_w[h]| @ path -> (1, feature_dim) -> squeeze to (feature_dim,)
        weight_relevance_list = []
        for h in range(n_heads):
            head_w = jnp.abs(state.head_params.weights[h])  # (1, H_last)
            rel = head_w @ path  # (1, feature_dim)
            weight_relevance_list.append(jnp.squeeze(rel, axis=0))
        weight_relevance = jnp.stack(weight_relevance_list)  # (n_heads, feature_dim)
    else:
        # No trunk: heads project directly from input features
        weight_relevance_list = []
        for h in range(n_heads):
            weight_relevance_list.append(jnp.abs(jnp.squeeze(state.head_params.weights[h], axis=0)))
        weight_relevance = jnp.stack(weight_relevance_list)

    # --- Step-size activity on input layer ---
    # Trunk optimizer states are interleaved: (w0, b0, w1, b1, ...)
    # Index 0 = input weights optimizer state
    if n_trunk_layers > 0:
        input_opt_state = state.trunk_optimizer_states[0]
        if hasattr(input_opt_state, "step_sizes"):
            # AutostepParamState: step_sizes has shape (H0, feature_dim)
            step_size_activity = jnp.mean(jnp.abs(input_opt_state.step_sizes), axis=0)
        elif hasattr(input_opt_state, "step_size"):
            # LMSState: scalar step_size, uniform across features
            feature_dim = state.trunk_params.weights[0].shape[1]
            step_size_activity = jnp.full(feature_dim, jnp.abs(input_opt_state.step_size))
        else:
            feature_dim = state.trunk_params.weights[0].shape[1]
            step_size_activity = jnp.zeros(feature_dim)
    else:
        # No trunk layers — use head info
        feature_dim = state.head_params.weights[0].shape[1]
        head_step_sizes = []
        for h in range(n_heads):
            head_w_opt = state.head_optimizer_states[h][0]
            if hasattr(head_w_opt, "step_sizes"):
                head_step_sizes.append(jnp.squeeze(jnp.abs(head_w_opt.step_sizes), axis=0))
            elif hasattr(head_w_opt, "step_size"):
                head_step_sizes.append(jnp.full(feature_dim, jnp.abs(head_w_opt.step_size)))
        step_size_activity = (
            jnp.mean(jnp.stack(head_step_sizes), axis=0)
            if head_step_sizes
            else jnp.zeros(feature_dim)
        )

    # --- Trace activity on input layer ---
    # trunk_traces interleaved: (w0, b0, w1, b1, ...)
    # Index 0 = input weight traces, shape (H0, feature_dim)
    if n_trunk_layers > 0:
        input_traces = state.trunk_traces[0]  # (H0, feature_dim)
        trace_activity = jnp.mean(jnp.abs(input_traces), axis=0)  # (feature_dim,)
    else:
        feature_dim = state.head_params.weights[0].shape[1]
        head_trace_weights = [
            jnp.squeeze(jnp.abs(state.head_traces[h][0]), axis=0)
            for h in range(n_heads)
        ]
        trace_activity = (
            jnp.mean(jnp.stack(head_trace_weights), axis=0)
            if head_trace_weights
            else jnp.zeros(feature_dim)
        )

    # --- Normalizer state ---
    normalizer_mean = None
    normalizer_std = None
    if state.normalizer_state is not None:
        normalizer_mean = state.normalizer_state.mean
        normalizer_std = jnp.sqrt(state.normalizer_state.var + 1e-8)

    # --- Head reliance ---
    # |head_params.weights[h]| squeezed to (H_last,)
    head_reliance_list = []
    for h in range(n_heads):
        head_reliance_list.append(jnp.abs(jnp.squeeze(state.head_params.weights[h], axis=0)))
    head_reliance = jnp.stack(head_reliance_list)  # (n_heads, H_last)

    # --- Head mean step-size ---
    head_mean_step_size = None
    if n_heads > 0:
        first_head_w_opt = state.head_optimizer_states[0][0]
        if hasattr(first_head_w_opt, "step_sizes"):
            head_ss_list = []
            for h in range(n_heads):
                w_opt = state.head_optimizer_states[h][0]
                head_ss_list.append(jnp.mean(w_opt.step_sizes))
            head_mean_step_size = jnp.array(head_ss_list)

    return FeatureRelevance(
        weight_relevance=weight_relevance,
        step_size_activity=step_size_activity,
        trace_activity=trace_activity,
        normalizer_mean=normalizer_mean,
        normalizer_std=normalizer_std,
        head_reliance=head_reliance,
        head_mean_step_size=head_mean_step_size,
    )


def compute_feature_sensitivity(
    learner: MultiHeadMLPLearner,
    state: MultiHeadMLPState,
    observation: Array,
) -> Array:
    """Compute per-head sensitivity to each input feature via Jacobian.

    Uses ``jax.jacrev`` to compute ``d(pred_h)/d(obs_f)`` for all heads
    and features. This is a Tier 2 metric requiring one forward pass
    per output (5 for 5 heads). Typical cost: ~100-500us for a (64,64)
    trunk.

    ``jacrev`` is used because output dim (n_heads) < input dim
    (feature_dim), making reverse-mode more efficient.

    Args:
        learner: The multi-head MLP learner instance.
        state: Current learner state.
        observation: Input feature vector, shape ``(feature_dim,)``.

    Returns:
        Jacobian array of shape ``(n_heads, feature_dim)`` where entry
        ``[h, f]`` is the sensitivity of head ``h``'s prediction to
        feature ``f`` at this observation.
    """

    def predict_fn(obs: Array) -> Array:
        preds: Array = learner.predict(state, obs)
        return preds

    jacobian: Array = jax.jacrev(predict_fn)(observation)  # (n_heads, feature_dim)
    return jacobian


def relevance_to_dict(
    relevance: FeatureRelevance,
    feature_names: list[str] | None = None,
    head_names: list[str] | None = None,
) -> dict[str, Any]:
    """Convert FeatureRelevance to a JSON-serializable dict.

    Produces a structured dict suitable for logging or inspection.
    Includes ``normalized_weight_relevance`` when normalizer state is
    available, which scales weight relevance by normalizer std to give
    relevance in raw input units.

    Args:
        relevance: FeatureRelevance from ``compute_feature_relevance``.
        feature_names: Optional list of feature names. If None, uses
            ``"feature_0"``, ``"feature_1"``, etc.
        head_names: Optional list of head names. If None, uses
            ``"head_0"``, ``"head_1"``, etc.

    Returns:
        Nested dict with ``"trunk"`` and ``"per_head"`` sections.
    """
    n_heads, feature_dim = relevance.weight_relevance.shape
    h_last = relevance.head_reliance.shape[1]

    if feature_names is None:
        feature_names = [f"feature_{i}" for i in range(feature_dim)]
    if head_names is None:
        head_names = [f"head_{i}" for i in range(n_heads)]

    # Trunk-level metrics
    trunk: dict[str, Any] = {
        "step_size_activity": {
            feature_names[f]: float(relevance.step_size_activity[f]) for f in range(feature_dim)
        },
        "trace_activity": {
            feature_names[f]: float(relevance.trace_activity[f]) for f in range(feature_dim)
        },
    }

    if relevance.normalizer_mean is not None:
        trunk["normalizer_mean"] = {
            feature_names[f]: float(relevance.normalizer_mean[f]) for f in range(feature_dim)
        }
    if relevance.normalizer_std is not None:
        trunk["normalizer_std"] = {
            feature_names[f]: float(relevance.normalizer_std[f]) for f in range(feature_dim)
        }

    # Compute normalized weight relevance if normalizer is available
    has_norm_std = relevance.normalizer_std is not None

    # Per-head metrics
    per_head: dict[str, Any] = {}
    for h in range(n_heads):
        head_dict: dict[str, Any] = {
            "weight_relevance": {
                feature_names[f]: float(relevance.weight_relevance[h, f])
                for f in range(feature_dim)
            },
        }
        if has_norm_std and relevance.normalizer_std is not None:
            norm_rel = relevance.weight_relevance[h] * relevance.normalizer_std
            head_dict["normalized_weight_relevance"] = {
                feature_names[f]: float(norm_rel[f]) for f in range(feature_dim)
            }
        head_dict["head_reliance"] = {
            f"neuron_{j}": float(relevance.head_reliance[h, j]) for j in range(h_last)
        }
        if relevance.head_mean_step_size is not None:
            head_dict["mean_step_size"] = float(relevance.head_mean_step_size[h])

        per_head[head_names[h]] = head_dict

    return {"trunk": trunk, "per_head": per_head}
