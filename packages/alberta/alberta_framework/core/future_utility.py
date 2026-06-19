"""Causal future-utility estimators for feature discovery.

The estimators here intentionally use only information available at the
current time step.  They are not hindsight ablations.  The main signal is a
one-step counterfactual: how much the current squared prediction error would
drop if a feature's output weight received the LMS update implied by the
current residual.
"""

import jax.numpy as jnp
from jax import Array
from jaxtyping import Float


def trace_decay_from_half_life(half_life: float | Array) -> Float[Array, ""]:
    """Convert an eligibility half-life in steps to a trace decay.

    A half-life of ``0`` disables the trace.  Positive half-lives use
    ``0.5 ** (1 / half_life)`` so the trace contribution decays by half after
    that many time steps.
    """
    half_life_arr = jnp.asarray(half_life, dtype=jnp.float32)
    return jnp.where(
        half_life_arr <= 0.0,
        jnp.array(0.0, dtype=jnp.float32),
        jnp.power(jnp.array(0.5, dtype=jnp.float32), 1.0 / half_life_arr),
    )


def one_step_output_loss_reduction(
    errors: Float[Array, " n_tasks"],
    feature_values: Float[Array, " n_features"],
    active_mask: Array,
    step_size_output: float | Array,
    active_count: float | Array,
) -> Float[Array, "n_tasks n_features"]:
    """Estimate per-task future loss reduction for each feature.

    For output LMS,
    ``delta_w_ij = alpha * error_i * feature_j / active_count``.  If the same
    feature value recurred immediately, feature ``j`` would change prediction
    ``i`` by ``delta_y_ij = delta_w_ij * feature_j``.  The counterfactual
    reduction in ``0.5 * error_i ** 2`` is therefore
    ``error_i * delta_y_ij - 0.5 * delta_y_ij ** 2``.

    Negative reductions indicate overshoot and are clipped to zero because this
    function is used as a utility signal, not as a signed optimizer diagnostic.

    Args:
        errors: Current prediction residuals, with inactive tasks already zero.
        feature_values: Current active or candidate feature values.
        active_mask: Boolean mask of tasks observed at this step.
        step_size_output: Effective output-weight step size.
        active_count: Number of active tasks, lower-bounded by the caller.

    Returns:
        Non-negative per-task/per-feature predicted loss reductions with
        inactive tasks masked to zero.
    """
    step_size = jnp.asarray(step_size_output, dtype=jnp.float32)
    count = jnp.asarray(active_count, dtype=jnp.float32)
    delta_prediction = (
        step_size
        * errors[:, None]
        * (feature_values[None, :] ** 2)
        / jnp.maximum(count, 1.0)
    )
    reduction = errors[:, None] * delta_prediction - 0.5 * delta_prediction**2
    reduction = jnp.maximum(reduction, 0.0)
    return jnp.where(active_mask[:, None], reduction, 0.0)


def contribution_trace_output_loss_reduction(
    errors: Float[Array, " n_tasks"],
    feature_values: Float[Array, " n_features"],
    active_mask: Array,
    step_size_output: float | Array,
    active_count: float | Array,
    contribution_trace: Float[Array, "n_tasks n_features"],
    feature_energy_trace: Float[Array, " n_features"],
    trace_decay: float | Array,
) -> tuple[
    Float[Array, "n_tasks n_features"],
    Float[Array, "n_tasks n_features"],
    Float[Array, " n_features"],
]:
    """Estimate delayed usefulness from a TD(lambda)-style contribution trace.

    This variant traces the actual per-task/per-feature output contribution
    ``error_i * phi_j`` instead of maintaining separate residual and feature
    traces.  It is causal and temporally uniform: the trace is updated from
    the current sample and previous trace only, with no hindsight ablation or
    future labels.  With ``trace_decay == 0`` it is exactly the one-step LMS
    counterfactual in :func:`one_step_output_loss_reduction`.

    Args:
        errors: Current prediction residuals, with inactive tasks already zero.
        feature_values: Current active or candidate feature values.
        active_mask: Boolean mask of tasks observed at this step.
        step_size_output: Effective output-weight step size.
        active_count: Number of active tasks, lower-bounded by the caller.
        contribution_trace: Previous trace of ``error_i * phi_j``.
        feature_energy_trace: Previous discounted squared-feature trace.
        trace_decay: Discount applied to traces before adding the current step.

    Returns:
        ``(reductions, new_contribution_trace, new_feature_energy_trace)``.
    """
    decay = jnp.asarray(trace_decay, dtype=jnp.float32)
    step_size = jnp.asarray(step_size_output, dtype=jnp.float32)
    count = jnp.asarray(active_count, dtype=jnp.float32)

    active_errors = jnp.where(active_mask, errors, 0.0)
    decayed_contribution = decay * contribution_trace
    new_contribution_trace = decayed_contribution + (
        active_errors[:, None] * feature_values[None, :]
    )
    new_contribution_trace = jnp.where(
        active_mask[:, None],
        new_contribution_trace,
        decayed_contribution,
    )
    new_feature_energy_trace = decay * feature_energy_trace + feature_values**2

    delta_weight = (
        step_size
        * active_errors[:, None]
        * feature_values[None, :]
        / jnp.maximum(count, 1.0)
    )
    reduction = (
        delta_weight * new_contribution_trace
        - 0.5 * (delta_weight**2) * new_feature_energy_trace[None, :]
    )
    reduction = jnp.maximum(reduction, 0.0)
    return (
        jnp.where(active_mask[:, None], reduction, 0.0),
        new_contribution_trace,
        new_feature_energy_trace,
    )


def trace_output_loss_reduction(
    errors: Float[Array, " n_tasks"],
    feature_values: Float[Array, " n_features"],
    active_mask: Array,
    step_size_output: float | Array,
    active_count: float | Array,
    error_trace: Float[Array, " n_tasks"],
    feature_trace: Float[Array, " n_features"],
    feature_energy_trace: Float[Array, " n_features"],
    trace_decay: float | Array,
) -> tuple[
    Float[Array, "n_tasks n_features"],
    Float[Array, " n_tasks"],
    Float[Array, " n_features"],
    Float[Array, " n_features"],
]:
    """Estimate temporally extended output-loss reduction with causal traces.

    The one-step estimator asks how much the current squared error would drop
    if the same feature value recurred immediately.  This variant keeps
    discounted traces of recent residuals, feature values, and feature energy,
    then evaluates the same current LMS output-weight update against that
    recurring-context proxy:

    ``sum_h decay^h e_{t-h} phi_{j,t-h}``.

    This is not a hindsight ablation and it does not peek at future samples.
    It is a causal provenance signal: features that repeatedly co-occur with
    the same residual direction receive more credit than one-step spikes.
    With ``trace_decay == 0`` it reduces exactly to
    :func:`one_step_output_loss_reduction`.

    Args:
        errors: Current prediction residuals, with inactive tasks already zero.
        feature_values: Current active or candidate feature values.
        active_mask: Boolean mask of tasks observed at this step.
        step_size_output: Effective output-weight step size.
        active_count: Number of active tasks, lower-bounded by the caller.
        error_trace: Previous discounted residual trace per task.
        feature_trace: Previous discounted feature-value trace.
        feature_energy_trace: Previous discounted squared-feature trace.
        trace_decay: Discount applied to traces before adding the current step.

    Returns:
        A tuple ``(reductions, new_error_trace, new_feature_trace,
        new_feature_energy_trace)``.  ``reductions`` is non-negative and masked
        for inactive tasks.
    """
    decay = jnp.asarray(trace_decay, dtype=jnp.float32)
    step_size = jnp.asarray(step_size_output, dtype=jnp.float32)
    count = jnp.asarray(active_count, dtype=jnp.float32)

    active_errors = jnp.where(active_mask, errors, 0.0)
    new_error_trace = decay * error_trace + active_errors
    new_error_trace = jnp.where(active_mask, new_error_trace, decay * error_trace)
    new_feature_trace = decay * feature_trace + feature_values
    new_feature_energy_trace = decay * feature_energy_trace + feature_values**2

    delta_weight = (
        step_size
        * active_errors[:, None]
        * feature_values[None, :]
        / jnp.maximum(count, 1.0)
    )
    recurring_error_feature = new_error_trace[:, None] * new_feature_trace[None, :]
    recurring_feature_energy = new_feature_energy_trace[None, :]
    reduction = (
        delta_weight * recurring_error_feature
        - 0.5 * (delta_weight**2) * recurring_feature_energy
    )
    reduction = jnp.maximum(reduction, 0.0)
    return (
        jnp.where(active_mask[:, None], reduction, 0.0),
        new_error_trace,
        new_feature_trace,
        new_feature_energy_trace,
    )


def normalize_future_utility_signal(
    signal: Float[Array, " n_features"],
    ages: Array,
    second_moment: Float[Array, " n_features"],
    moment_decay: float | Array,
    utility_decay: float | Array,
    mode: str,
) -> tuple[Float[Array, " n_features"], Float[Array, " n_features"]]:
    """Apply optional causal age/uncertainty normalization to utility signals.

    ``"age"`` debiases the current EMA warm-up so young features are compared
    against older features on the same scale.  ``"uncertainty"`` divides by an
    online RMS of the signal, favoring consistent usefulness over rare spikes.
    ``"uncertainty_age"`` applies both.  The second moment is updated from the
    current signal only, so this remains causal.
    """
    decay = jnp.asarray(moment_decay, dtype=jnp.float32)
    utility_decay_arr = jnp.asarray(utility_decay, dtype=jnp.float32)
    new_second_moment = decay * second_moment + (1.0 - decay) * signal**2
    normalized = signal

    if mode in {"age", "uncertainty_age"}:
        age_float = jnp.maximum(ages.astype(jnp.float32), 0.0) + 1.0
        debias = 1.0 - jnp.power(utility_decay_arr, age_float)
        normalized = normalized / jnp.maximum(debias, 1e-3)

    if mode in {"uncertainty", "uncertainty_age"}:
        normalized = normalized / jnp.sqrt(new_second_moment + 1e-6)

    return normalized, new_second_moment
