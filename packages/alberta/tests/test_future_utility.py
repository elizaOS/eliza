"""Tests for causal future-utility estimators."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.compositional_features import CompositionalFeatureLearner
from alberta_framework.core.feature_discovery import FixedBudgetFeatureLearner
from alberta_framework.core.future_utility import (
    contribution_trace_output_loss_reduction,
    normalize_future_utility_signal,
    one_step_output_loss_reduction,
    trace_decay_from_half_life,
)


def test_contribution_trace_matches_one_step_at_zero_decay() -> None:
    """Zero trace decay must recover the one-step LMS counterfactual exactly."""
    errors = jnp.array([2.0, 0.0], dtype=jnp.float32)
    features = jnp.array([1.0, 2.0], dtype=jnp.float32)
    active_mask = jnp.array([True, False])

    one_step = one_step_output_loss_reduction(
        errors=errors,
        feature_values=features,
        active_mask=active_mask,
        step_size_output=0.5,
        active_count=1.0,
    )
    traced, contribution_trace, energy_trace = contribution_trace_output_loss_reduction(
        errors=errors,
        feature_values=features,
        active_mask=active_mask,
        step_size_output=0.5,
        active_count=1.0,
        contribution_trace=jnp.zeros((2, 2), dtype=jnp.float32),
        feature_energy_trace=jnp.zeros(2, dtype=jnp.float32),
        trace_decay=0.0,
    )

    chex.assert_trees_all_close(traced, one_step)
    chex.assert_trees_all_close(
        contribution_trace,
        jnp.array([[2.0, 4.0], [0.0, 0.0]], dtype=jnp.float32),
    )
    chex.assert_trees_all_close(energy_trace, features**2)


def test_contribution_trace_has_no_future_label_leakage() -> None:
    """The first trace update cannot depend on labels from a later step."""
    errors = jnp.array([1.0], dtype=jnp.float32)
    features = jnp.array([1.0], dtype=jnp.float32)
    active_mask = jnp.array([True])
    contribution_trace = jnp.zeros((1, 1), dtype=jnp.float32)
    energy_trace = jnp.zeros(1, dtype=jnp.float32)
    first_a = contribution_trace_output_loss_reduction(
        errors=errors,
        feature_values=features,
        active_mask=active_mask,
        step_size_output=0.1,
        active_count=1.0,
        contribution_trace=contribution_trace,
        feature_energy_trace=energy_trace,
        trace_decay=0.9,
    )
    first_b = contribution_trace_output_loss_reduction(
        errors=jnp.array([1.0], dtype=jnp.float32),
        feature_values=jnp.array([1.0], dtype=jnp.float32),
        active_mask=jnp.array([True]),
        step_size_output=0.1,
        active_count=1.0,
        contribution_trace=jnp.zeros((1, 1), dtype=jnp.float32),
        feature_energy_trace=jnp.zeros(1, dtype=jnp.float32),
        trace_decay=0.9,
    )

    chex.assert_trees_all_close(first_a, first_b)

    second_a = contribution_trace_output_loss_reduction(
        errors=jnp.array([3.0], dtype=jnp.float32),
        feature_values=jnp.array([1.0], dtype=jnp.float32),
        active_mask=jnp.array([True]),
        step_size_output=0.1,
        active_count=1.0,
        contribution_trace=first_a[1],
        feature_energy_trace=first_a[2],
        trace_decay=0.9,
    )
    assert float(second_a[0][0, 0]) != float(first_a[0][0, 0])


def test_trace_decay_from_half_life() -> None:
    assert float(trace_decay_from_half_life(0.0)) == 0.0
    assert abs(float(trace_decay_from_half_life(10.0) ** 10) - 0.5) < 1e-6


def test_future_utility_normalization_is_finite_and_causal() -> None:
    signal = jnp.array([1.0, 4.0], dtype=jnp.float32)
    ages = jnp.array([0, 9], dtype=jnp.int32)
    normalized, second = normalize_future_utility_signal(
        signal,
        ages,
        second_moment=jnp.zeros(2, dtype=jnp.float32),
        moment_decay=0.9,
        utility_decay=0.99,
        mode="uncertainty_age",
    )

    chex.assert_tree_all_finite(normalized)
    chex.assert_tree_all_finite(second)
    assert float(second[1]) > float(second[0])


def test_feature_discovery_future_utility_config_roundtrip_extended_knobs() -> None:
    learner = FixedBudgetFeatureLearner(
        n_features=3,
        n_tasks=2,
        future_utility_mix=0.5,
        future_utility_trace_decay=0.8,
        future_utility_trace_mode="marginal",
        future_utility_normalization="uncertainty_age",
        future_utility_normalization_decay=0.9,
        future_utility_rare_task_power=0.5,
    )

    restored = FixedBudgetFeatureLearner.from_config(learner.to_config())

    assert restored.to_config()["future_utility_trace_decay"] == 0.8
    assert restored.to_config()["future_utility_trace_mode"] == "marginal"
    assert restored.to_config()["future_utility_normalization"] == "uncertainty_age"
    assert restored.to_config()["future_utility_normalization_decay"] == 0.9
    assert restored.to_config()["future_utility_rare_task_power"] == 0.5


def test_compositional_future_utility_config_roundtrip_extended_knobs() -> None:
    learner = CompositionalFeatureLearner(
        n_features=6,
        n_tasks=2,
        future_utility_mix=0.5,
        future_utility_trace_decay=0.8,
        future_utility_trace_mode="marginal",
        future_utility_normalization="uncertainty",
        future_utility_normalization_decay=0.9,
        future_utility_rare_task_power=0.5,
        future_utility_task_activity_decay=0.9,
        candidate_scoring_mode="energy_novelty",
        candidate_score_trace_decay=0.8,
        candidate_score_energy_epsilon=1e-5,
        candidate_novelty_weight=0.75,
        candidate_novelty_power=2.0,
        candidate_novelty_floor=0.1,
        generation_strategy="robust_recursive",
        parent_novelty_weight=0.1,
        parent_depth_prior=0.2,
        retention_depth_bonus=0.03,
        retention_slow_utility_decay=0.95,
        retention_tanh_min_count=2,
        retention_product_min_count=3,
    )

    restored = CompositionalFeatureLearner.from_config(learner.to_config())

    assert restored.to_config()["future_utility_trace_decay"] == 0.8
    assert restored.to_config()["future_utility_trace_mode"] == "marginal"
    assert restored.to_config()["future_utility_normalization"] == "uncertainty"
    assert restored.to_config()["future_utility_normalization_decay"] == 0.9
    assert restored.to_config()["future_utility_rare_task_power"] == 0.5
    assert restored.to_config()["future_utility_task_activity_decay"] == 0.9
    assert restored.to_config()["candidate_scoring_mode"] == "energy_novelty"
    assert restored.to_config()["candidate_score_trace_decay"] == 0.8
    assert restored.to_config()["candidate_score_energy_epsilon"] == 1e-5
    assert restored.to_config()["candidate_novelty_weight"] == 0.75
    assert restored.to_config()["candidate_novelty_power"] == 2.0
    assert restored.to_config()["candidate_novelty_floor"] == 0.1
    assert restored.to_config()["generation_strategy"] == "robust_recursive"
    assert restored.to_config()["parent_novelty_weight"] == 0.1
    assert restored.to_config()["parent_depth_prior"] == 0.2
    assert restored.to_config()["retention_depth_bonus"] == 0.03
    assert restored.to_config()["retention_slow_utility_decay"] == 0.95
    assert restored.to_config()["retention_tanh_min_count"] == 2
    assert restored.to_config()["retention_product_min_count"] == 3


def test_compositional_future_utility_metrics_remain_finite_with_variants() -> None:
    learner = CompositionalFeatureLearner(
        n_features=6,
        n_tasks=2,
        candidate_count=2,
        future_utility_mix=0.5,
        future_utility_trace_decay=0.7,
        future_utility_normalization="uncertainty_age",
        future_utility_rare_task_power=0.25,
        replacement_interval=0,
    )
    state = learner.init(feature_dim=3, key=jr.key(0))

    result = learner.update(
        state,
        jnp.array([1.0, -1.0, 0.5], dtype=jnp.float32),
        jnp.array([1.0, jnp.nan], dtype=jnp.float32),
    )

    chex.assert_tree_all_finite(result.metrics)
    chex.assert_tree_all_finite(result.state.utilities)
    chex.assert_tree_all_finite(result.state.candidate_utilities)
