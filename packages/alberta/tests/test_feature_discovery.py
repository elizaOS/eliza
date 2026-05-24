"""Tests for Step 2 fixed-budget feature discovery."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    FixedBudgetFeatureLearner,
    FixedBudgetInteractionLearner,
    InteractionFeatureDiscoveryStream,
    NonlinearFeatureDiscoveryStream,
    collect_feature_discovery_stream,
    run_feature_discovery_arrays,
    run_feature_discovery_loop,
    run_interaction_feature_arrays,
)
from alberta_framework.core.feature_discovery import (
    GENERATOR_IMPRINT,
    GENERATOR_MUTATE_PARENT,
    GENERATOR_RANDOM,
)
from alberta_framework.core.future_utility import (
    one_step_output_loss_reduction,
    trace_output_loss_reduction,
)


def test_one_step_output_loss_reduction_is_causal_lms_counterfactual() -> None:
    reductions = one_step_output_loss_reduction(
        errors=jnp.array([2.0, 0.0], dtype=jnp.float32),
        feature_values=jnp.array([1.0, 2.0], dtype=jnp.float32),
        active_mask=jnp.array([True, False]),
        step_size_output=0.5,
        active_count=1.0,
    )

    chex.assert_shape(reductions, (2, 2))
    # Feature 0: delta_y = 0.5 * 2 * 1**2 = 1, so loss reduction is
    # 2 * 1 - 0.5 * 1**2 = 1.5.
    assert float(reductions[0, 0]) == 1.5
    # Feature 1 overshoots the residual: delta_y = 4, so the signed reduction
    # would be zero after clipping.
    assert float(reductions[0, 1]) == 0.0
    assert float(reductions[1, 0]) == 0.0


def test_trace_output_loss_reduction_matches_one_step_at_zero_decay() -> None:
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
    traced, error_trace, feature_trace, feature_energy_trace = (
        trace_output_loss_reduction(
            errors=errors,
            feature_values=features,
            active_mask=active_mask,
            step_size_output=0.5,
            active_count=1.0,
            error_trace=jnp.zeros(2, dtype=jnp.float32),
            feature_trace=jnp.zeros(2, dtype=jnp.float32),
            feature_energy_trace=jnp.zeros(2, dtype=jnp.float32),
            trace_decay=0.0,
        )
    )

    chex.assert_trees_all_close(traced, one_step)
    chex.assert_trees_all_close(error_trace, errors)
    chex.assert_trees_all_close(feature_trace, features)
    chex.assert_trees_all_close(feature_energy_trace, features**2)


def test_trace_output_loss_reduction_credits_recurring_alignment() -> None:
    _, error_trace, feature_trace, feature_energy_trace = (
        trace_output_loss_reduction(
            errors=jnp.array([1.0], dtype=jnp.float32),
            feature_values=jnp.array([1.0], dtype=jnp.float32),
            active_mask=jnp.array([True]),
            step_size_output=0.1,
            active_count=1.0,
            error_trace=jnp.zeros(1, dtype=jnp.float32),
            feature_trace=jnp.zeros(1, dtype=jnp.float32),
            feature_energy_trace=jnp.zeros(1, dtype=jnp.float32),
            trace_decay=0.9,
        )
    )
    traced, _, _, _ = trace_output_loss_reduction(
        errors=jnp.array([1.0], dtype=jnp.float32),
        feature_values=jnp.array([1.0], dtype=jnp.float32),
        active_mask=jnp.array([True]),
        step_size_output=0.1,
        active_count=1.0,
        error_trace=error_trace,
        feature_trace=feature_trace,
        feature_energy_trace=feature_energy_trace,
        trace_decay=0.9,
    )
    one_step = one_step_output_loss_reduction(
        errors=jnp.array([1.0], dtype=jnp.float32),
        feature_values=jnp.array([1.0], dtype=jnp.float32),
        active_mask=jnp.array([True]),
        step_size_output=0.1,
        active_count=1.0,
    )

    assert float(traced[0, 0]) > float(one_step[0, 0])


class TestNonlinearFeatureDiscoveryStream:
    """Tests for the Step 2 nonlinear multitask benchmark stream."""

    def test_step_shapes(self) -> None:
        stream = NonlinearFeatureDiscoveryStream(
            feature_dim=6,
            n_tasks=3,
            n_latents=8,
            context_length=5,
        )
        state = stream.init(jr.key(0))
        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (6,))
        chex.assert_shape(timestep.target, (3,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)
        assert int(new_state.step_count) == 1

    def test_collect_stream_shapes(self) -> None:
        stream = NonlinearFeatureDiscoveryStream(
            feature_dim=5,
            n_tasks=2,
            n_latents=6,
        )
        observations, targets = collect_feature_discovery_stream(
            stream, num_steps=12, key=jr.key(1)
        )

        chex.assert_shape(observations, (12, 5))
        chex.assert_shape(targets, (12, 2))
        chex.assert_tree_all_finite(observations)
        chex.assert_tree_all_finite(targets)


class TestInteractionFeatureDiscoveryStream:
    """Tests for the hidden pair-product Step 2 benchmark stream."""

    def test_step_shapes(self) -> None:
        stream = InteractionFeatureDiscoveryStream(
            feature_dim=6,
            n_tasks=3,
            context_length=5,
            active_pairs_per_context=2,
        )
        state = stream.init(jr.key(8))
        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (6,))
        chex.assert_shape(timestep.target, (3,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)
        assert int(new_state.step_count) == 1


class TestFixedBudgetFeatureLearner:
    """Tests for explicit feature construction, utility, and replacement."""

    def test_init_shapes(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=7,
            n_tasks=3,
            candidate_count=4,
        )
        state = learner.init(feature_dim=5, key=jr.key(2))

        chex.assert_shape(state.feature_weights, (7, 5))
        chex.assert_shape(state.output_weights, (3, 7))
        chex.assert_shape(state.utilities, (7,))
        chex.assert_shape(state.task_activity_ema, (3,))
        chex.assert_shape(state.candidate_weights, (4, 5))
        chex.assert_shape(state.candidate_output_weights, (3, 4))

    def test_update_returns_finite_metrics(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=8,
            n_tasks=2,
            candidate_count=3,
            replacement_interval=10,
        )
        state = learner.init(feature_dim=4, key=jr.key(3))

        result = learner.update(
            state,
            jnp.array([0.1, -0.2, 0.3, 0.4], dtype=jnp.float32),
            jnp.array([1.0, -1.0], dtype=jnp.float32),
        )

        chex.assert_shape(result.predictions, (2,))
        chex.assert_shape(result.errors, (2,))
        chex.assert_shape(result.metrics, (7,))
        chex.assert_tree_all_finite(result.metrics)
        assert int(result.state.step_count) == 1

    def test_constructed_and_augmented_feature_shapes(self) -> None:
        learner = FixedBudgetFeatureLearner(n_features=6, n_tasks=2)
        state = learner.init(feature_dim=4, key=jr.key(14))
        observation = jnp.array([0.1, -0.2, 0.3, 0.4], dtype=jnp.float32)

        features = learner.constructed_features(state, observation)
        augmented = learner.augmented_observation(state, observation)

        chex.assert_shape(features, (6,))
        chex.assert_shape(augmented, (10,))
        chex.assert_tree_all_finite(features)
        chex.assert_tree_all_finite(augmented)

    def test_random_replacement_event_occurs(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=5,
            n_tasks=2,
            replacement_interval=1,
            min_feature_age=0,
            candidate_count=0,
            generator_mix=(1.0, 0.0, 0.0),
        )
        state = learner.init(feature_dim=4, key=jr.key(4))
        result = learner.update(
            state,
            jnp.ones(4, dtype=jnp.float32),
            jnp.array([0.5, -0.25], dtype=jnp.float32),
        )

        assert float(result.metrics[5]) == 1.0
        assert int(result.replaced_slot) >= 0
        assert int(result.state.ages[result.replaced_slot]) == 0
        assert int(result.state.feature_generator[result.replaced_slot]) in {
            GENERATOR_RANDOM,
            GENERATOR_MUTATE_PARENT,
            GENERATOR_IMPRINT,
        }

    def test_scan_loop_shapes(self) -> None:
        stream = NonlinearFeatureDiscoveryStream(
            feature_dim=4,
            n_tasks=2,
            n_latents=8,
            context_length=8,
        )
        learner = FixedBudgetFeatureLearner(
            n_features=8,
            n_tasks=2,
            replacement_interval=5,
            min_feature_age=3,
            candidate_count=2,
            candidate_min_age=2,
        )
        result = run_feature_discovery_loop(
            learner, stream, num_steps=15, key=jr.key(5)
        )

        chex.assert_shape(result.metrics, (15, 7))
        chex.assert_tree_all_finite(result.metrics)
        assert int(result.state.step_count) == 15

    def test_array_loop_shapes(self) -> None:
        stream = NonlinearFeatureDiscoveryStream(
            feature_dim=4,
            n_tasks=2,
            n_latents=8,
        )
        observations, targets = collect_feature_discovery_stream(
            stream, num_steps=10, key=jr.key(6)
        )
        learner = FixedBudgetFeatureLearner(
            n_features=8,
            n_tasks=2,
            replacement_interval=0,
        )
        state = learner.init(feature_dim=4, key=jr.key(7))
        result = run_feature_discovery_arrays(learner, state, observations, targets)

        chex.assert_shape(result.metrics, (10, 7))
        chex.assert_tree_all_finite(result.metrics)

    def test_feature_learner_active_task_balancing_removes_nan_head_dilution(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=1,
            n_tasks=4,
            utility_task_balancing="active",
        )
        signal = learner._output_utility_signal(
            jnp.array([[2.0], [0.0], [0.0], [0.0]], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
            jnp.array([True, False, False, False]),
            jnp.zeros(4, dtype=jnp.float32),
        )

        assert float(signal[0]) == 2.0

    def test_feature_learner_inverse_frequency_uses_rare_head_ema(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=1,
            n_tasks=5,
            utility_task_balancing="active_inverse_frequency",
            task_activity_decay=0.99,
        )
        active_mask = jnp.array([False, False, False, False, True])
        activity = learner._task_activity_update(
            jnp.zeros(5, dtype=jnp.float32),
            active_mask,
        )
        signal = learner._output_utility_signal(
            jnp.array([[0.0], [0.0], [0.0], [0.0], [2.0]], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
            active_mask,
            activity,
        )

        assert abs(float(signal[0]) - 200.0) < 1e-4

    def test_feature_learner_utility_retention_slows_off_context_decay(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=1,
            n_tasks=1,
            utility_decay=0.0,
            utility_retention_decay=0.9,
            replacement_interval=0,
        )
        state = learner.init(feature_dim=2, key=jr.key(21))
        state = state.replace(utilities=jnp.array([1.0], dtype=jnp.float32))  # type: ignore[attr-defined]

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert abs(float(result.state.utilities[0]) - 0.9) < 1e-6

    def test_feature_learner_config_roundtrip_keeps_utility_knobs(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=3,
            n_tasks=2,
            utility_aggregation="topk",
            utility_top_k=2,
            utility_task_balancing="active_inverse_frequency",
            task_activity_decay=0.9,
            future_utility_mix=0.25,
            utility_retention_decay=0.999,
        )

        restored = FixedBudgetFeatureLearner.from_config(learner.to_config())

        assert restored.to_config()["utility_aggregation"] == "topk"
        assert restored.to_config()["utility_top_k"] == 2
        assert (
            restored.to_config()["utility_task_balancing"]
            == "active_inverse_frequency"
        )
        assert restored.to_config()["task_activity_decay"] == 0.9
        assert restored.to_config()["future_utility_mix"] == 0.25
        assert restored.to_config()["utility_retention_decay"] == 0.999

    def test_feature_learner_future_utility_credits_unweighted_candidate(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=1,
            n_tasks=1,
            step_size_output=0.5,
            utility_decay=0.0,
            replacement_interval=0,
            candidate_count=1,
            future_utility_mix=1.0,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(24))
        state = state.replace(  # type: ignore[attr-defined]
            feature_weights=jnp.array([[1.0, 0.0]], dtype=jnp.float32),
            candidate_weights=jnp.array([[1.0, 0.0]], dtype=jnp.float32),
        )
        observation = jnp.array([1.0, 0.0], dtype=jnp.float32)

        result = learner.update(
            state,
            observation,
            jnp.array([2.0], dtype=jnp.float32),
        )
        features = learner.constructed_features(state, observation)
        expected = one_step_output_loss_reduction(
            errors=jnp.array([2.0], dtype=jnp.float32),
            feature_values=features,
            active_mask=jnp.array([True]),
            step_size_output=0.5,
            active_count=1.0,
        )[0, 0]

        assert abs(float(result.state.utilities[0] - expected)) < 1e-6
        assert abs(float(result.state.candidate_utilities[0] - expected)) < 1e-6

    def test_feature_resource_manager_learns_generator_preferences(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=3,
            n_tasks=1,
            utility_decay=0.99,
            replacement_interval=0,
            learn_feature_resources=True,
            resource_learning_rate=1.0,
            resource_exploration=0.0,
        )
        state = learner.init(feature_dim=2, key=jr.key(22))
        state = state.replace(  # type: ignore[attr-defined]
            utilities=jnp.array([0.0, 0.0, 10.0], dtype=jnp.float32),
            feature_generator=jnp.array(
                [GENERATOR_RANDOM, GENERATOR_MUTATE_PARENT, GENERATOR_IMPRINT],
                dtype=jnp.int32,
            ),
            generator_log_weights=jnp.zeros(3, dtype=jnp.float32),
        )

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(jnp.argmax(result.state.generator_log_weights)) == GENERATOR_IMPRINT

    def test_feature_resource_manager_changes_replacement_rate(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=3,
            n_tasks=1,
            replacement_interval=10,
            min_feature_age=1000,
            learn_feature_resources=True,
            resource_learning_rate=0.0,
            resource_exploration=0.0,
        )
        conservative = learner.init(feature_dim=2, key=jr.key(23)).replace(  # type: ignore[attr-defined]
            plasticity_log_weights=jnp.array([4.0, 0.0, -4.0], dtype=jnp.float32)
        )
        aggressive = learner.init(feature_dim=2, key=jr.key(23)).replace(  # type: ignore[attr-defined]
            plasticity_log_weights=jnp.array([-4.0, 0.0, 4.0], dtype=jnp.float32)
        )
        obs = jnp.ones(2, dtype=jnp.float32)
        target = jnp.array([0.0], dtype=jnp.float32)

        conservative_result = learner.update(conservative, obs, target)
        aggressive_result = learner.update(aggressive, obs, target)

        assert (
            float(aggressive_result.state.replacement_accumulator)
            > float(conservative_result.state.replacement_accumulator)
        )

    def test_feature_resource_manager_config_roundtrip(self) -> None:
        learner = FixedBudgetFeatureLearner(
            n_features=3,
            n_tasks=2,
            learn_feature_resources=True,
            resource_learning_rate=0.7,
            resource_discount=0.9,
            resource_exploration=0.05,
            plasticity_replacement_multipliers=(0.25, 1.0, 4.0),
            plasticity_promotion_margin_multipliers=(1.5, 1.0, 0.5),
        )

        restored = FixedBudgetFeatureLearner.from_config(learner.to_config())

        assert restored.to_config() == learner.to_config()


class TestFixedBudgetInteractionLearner:
    """Tests for pairwise feature construction, utility, and replacement."""

    def test_init_shapes(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=7,
            n_tasks=3,
            candidate_count=4,
        )
        state = learner.init(feature_dim=5, key=jr.key(9))

        chex.assert_shape(state.feature_left, (7,))
        chex.assert_shape(state.feature_right, (7,))
        chex.assert_shape(state.output_weights, (3, 7))
        chex.assert_shape(state.utilities, (7,))
        chex.assert_shape(state.task_activity_ema, (3,))
        chex.assert_shape(state.candidate_left, (4,))
        chex.assert_shape(state.candidate_output_weights, (3, 4))

    def test_all_pairs_candidate_strategy_covers_pair_space(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=4,
            n_tasks=2,
            candidate_count=6,
            candidate_strategy="all_pairs",
            refresh_candidates=False,
            refresh_promoted_candidate=False,
        )
        state = learner.init(feature_dim=4, key=jr.key(14))

        candidate_pairs = {
            (int(left), int(right))
            for left, right in zip(state.candidate_left, state.candidate_right, strict=True)
        }

        assert candidate_pairs == {
            (0, 1),
            (0, 2),
            (0, 3),
            (1, 2),
            (1, 3),
            (2, 3),
        }

    def test_constructed_and_augmented_feature_shapes(self) -> None:
        learner = FixedBudgetInteractionLearner(n_features=6, n_tasks=2)
        state = learner.init(feature_dim=4, key=jr.key(15))
        observation = jnp.array([0.1, -0.2, 0.3, 0.4], dtype=jnp.float32)

        features = learner.constructed_features(state, observation)
        augmented = learner.augmented_observation(state, observation)

        chex.assert_shape(features, (6,))
        chex.assert_shape(augmented, (10,))
        chex.assert_tree_all_finite(features)
        chex.assert_tree_all_finite(augmented)

    def test_update_returns_finite_metrics(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=8,
            n_tasks=2,
            candidate_count=3,
            replacement_interval=10,
        )
        state = learner.init(feature_dim=4, key=jr.key(10))

        result = learner.update(
            state,
            jnp.array([0.1, -0.2, 0.3, 0.4], dtype=jnp.float32),
            jnp.array([1.0, -1.0], dtype=jnp.float32),
        )

        chex.assert_shape(result.predictions, (2,))
        chex.assert_shape(result.errors, (2,))
        chex.assert_shape(result.metrics, (7,))
        chex.assert_tree_all_finite(result.metrics)
        assert int(result.state.step_count) == 1

    def test_max_utility_aggregation_does_not_dilute_rare_task_head(self) -> None:
        mean_learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=4,
            utility_decay=0.0,
            replacement_interval=0,
            utility_aggregation="mean",
        )
        max_learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=4,
            utility_decay=0.0,
            replacement_interval=0,
            utility_aggregation="max",
        )
        mean_state = mean_learner.init(feature_dim=2, key=jr.key(16))
        max_state = max_learner.init(feature_dim=2, key=jr.key(16))
        rare_head_weights = jnp.array([[2.0], [0.0], [0.0], [0.0]], dtype=jnp.float32)
        mean_state = mean_state.replace(output_weights=rare_head_weights)  # type: ignore[attr-defined]
        max_state = max_state.replace(output_weights=rare_head_weights)  # type: ignore[attr-defined]
        observation = jnp.ones(2, dtype=jnp.float32)
        targets = jnp.array([0.0, jnp.nan, jnp.nan, jnp.nan], dtype=jnp.float32)

        mean_result = mean_learner.update(mean_state, observation, targets)
        max_result = max_learner.update(max_state, observation, targets)

        assert float(mean_result.state.utilities[0]) == 0.5
        assert float(max_result.state.utilities[0]) == 2.0

    def test_topk_utility_aggregation_averages_largest_heads(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=4,
            utility_decay=0.0,
            replacement_interval=0,
            utility_aggregation="topk",
            utility_top_k=2,
        )
        state = learner.init(feature_dim=2, key=jr.key(18))
        state = state.replace(  # type: ignore[attr-defined]
            output_weights=jnp.array([[4.0], [2.0], [0.5], [0.0]], dtype=jnp.float32)
        )

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.zeros(4, dtype=jnp.float32),
        )

        assert float(result.state.utilities[0]) == 3.0

    def test_active_task_balancing_removes_nan_head_dilution(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=4,
            utility_decay=0.0,
            replacement_interval=0,
            utility_task_balancing="active",
        )
        state = learner.init(feature_dim=2, key=jr.key(19))
        state = state.replace(  # type: ignore[attr-defined]
            output_weights=jnp.array([[2.0], [0.0], [0.0], [0.0]], dtype=jnp.float32)
        )

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.array([0.0, jnp.nan, jnp.nan, jnp.nan], dtype=jnp.float32),
        )

        assert float(result.state.utilities[0]) == 2.0
        assert float(result.state.task_activity_ema[0]) > 0.0
        assert float(result.state.task_activity_ema[1]) == 0.0

    def test_inverse_frequency_replacement_keeps_rare_oracle_pair(self) -> None:
        mean_learner = FixedBudgetInteractionLearner(
            n_features=2,
            n_tasks=5,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_count=0,
            generator_mix=(1.0, 0.0, 0.0),
            utility_task_balancing="none",
            task_activity_decay=0.99,
            use_obgd=False,
        )
        protected_learner = FixedBudgetInteractionLearner(
            n_features=2,
            n_tasks=5,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_count=0,
            generator_mix=(1.0, 0.0, 0.0),
            utility_task_balancing="active_inverse_frequency",
            task_activity_decay=0.99,
            use_obgd=False,
        )
        state = mean_learner.init(feature_dim=4, key=jr.key(25))
        output_weights = jnp.zeros((5, 2), dtype=jnp.float32).at[4, 0].set(1.0)
        state = state.replace(  # type: ignore[attr-defined]
            feature_left=jnp.array([0, 2], dtype=jnp.int32),
            feature_right=jnp.array([1, 3], dtype=jnp.int32),
            output_weights=output_weights,
            utilities=jnp.array([0.0, 0.5], dtype=jnp.float32),
            ages=jnp.array([10, 10], dtype=jnp.int32),
        )
        protected_state = protected_learner.init(feature_dim=4, key=jr.key(25))
        protected_state = protected_state.replace(  # type: ignore[attr-defined]
            feature_left=state.feature_left,
            feature_right=state.feature_right,
            output_weights=state.output_weights,
            utilities=state.utilities,
            ages=state.ages,
        )
        observation = jnp.array([1.0, 1.0, 0.0, 0.0], dtype=jnp.float32)
        targets = jnp.array([jnp.nan, jnp.nan, jnp.nan, jnp.nan, 0.0])

        mean_result = mean_learner.update(state, observation, targets)
        protected_result = protected_learner.update(
            protected_state,
            observation,
            targets,
        )

        assert int(mean_result.replaced_slot) == 0
        assert int(protected_result.replaced_slot) == 1

    def test_future_utility_mix_credits_new_candidate_weights(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=1,
            step_size_output=0.5,
            utility_decay=0.0,
            replacement_interval=0,
            candidate_count=1,
            future_utility_mix=1.0,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(20))

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.array([2.0], dtype=jnp.float32),
        )

        assert float(result.state.utilities[0]) == 1.5
        assert float(result.state.candidate_utilities[0]) == 1.5

    def test_interaction_config_roundtrip_keeps_utility_knobs(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=3,
            n_tasks=2,
            utility_aggregation="topk",
            utility_top_k=2,
            utility_task_balancing="active_inverse_frequency",
            task_activity_decay=0.9,
            future_utility_mix=0.25,
        )

        restored = FixedBudgetInteractionLearner.from_config(learner.to_config())

        assert restored.to_config()["utility_aggregation"] == "topk"
        assert restored.to_config()["utility_top_k"] == 2
        assert (
            restored.to_config()["utility_task_balancing"]
            == "active_inverse_frequency"
        )
        assert restored.to_config()["task_activity_decay"] == 0.9
        assert restored.to_config()["future_utility_mix"] == 0.25

    def test_utility_retention_slows_off_context_decay(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=1,
            n_tasks=1,
            utility_decay=0.0,
            utility_retention_decay=0.9,
            replacement_interval=0,
        )
        state = learner.init(feature_dim=2, key=jr.key(17))
        state = state.replace(utilities=jnp.array([1.0], dtype=jnp.float32))  # type: ignore[attr-defined]

        result = learner.update(
            state,
            jnp.ones(2, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert abs(float(result.state.utilities[0]) - 0.9) < 1e-6

    def test_random_replacement_event_occurs(self) -> None:
        learner = FixedBudgetInteractionLearner(
            n_features=5,
            n_tasks=2,
            replacement_interval=1,
            min_feature_age=0,
            candidate_count=0,
            generator_mix=(1.0, 0.0, 0.0),
        )
        state = learner.init(feature_dim=4, key=jr.key(11))
        result = learner.update(
            state,
            jnp.ones(4, dtype=jnp.float32),
            jnp.array([0.5, -0.25], dtype=jnp.float32),
        )

        assert float(result.metrics[5]) == 1.0
        assert int(result.replaced_slot) >= 0
        assert int(result.state.ages[result.replaced_slot]) == 0

    def test_array_loop_shapes(self) -> None:
        stream = InteractionFeatureDiscoveryStream(
            feature_dim=5,
            n_tasks=2,
            context_length=8,
            active_pairs_per_context=2,
        )
        observations, targets = collect_feature_discovery_stream(
            stream, num_steps=10, key=jr.key(12)
        )
        learner = FixedBudgetInteractionLearner(
            n_features=8,
            n_tasks=2,
            replacement_interval=0,
        )
        state = learner.init(feature_dim=5, key=jr.key(13))
        result = run_interaction_feature_arrays(learner, state, observations, targets)

        chex.assert_shape(result.metrics, (10, 7))
        chex.assert_tree_all_finite(result.metrics)
