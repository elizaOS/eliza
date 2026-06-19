"""Tests for the compositional DAG feature learner (Step 2)."""

import chex
import jax.numpy as jnp
import jax.random as jr
import numpy as np

from alberta_framework.core.compositional_features import (
    CANDIDATE_SELECTOR_HEDGE,
    CANDIDATE_SELECTOR_LEGACY,
    DEFAULT_GENERATOR_META_POLICY_NAMES,
    GENERATION_ROBUST_RECURSIVE,
    OP_PRODUCT,
    OP_RAW,
    OP_TANH,
    CompositionalFeatureLearner,
    CompositionalFeatureState,
    FiniteCandidateSelector,
    _compute_feature_values,
    _imprint_candidate_output_weights,
    run_compositional_arrays,
)


def _assert_valid_active_dag(
    state: CompositionalFeatureState,
    feature_dim: int,
    max_depth: int,
) -> None:
    """Check active-bank topological and depth invariants."""
    ops = np.asarray(state.ops)
    parent_a = np.asarray(state.parent_a)
    parent_b = np.asarray(state.parent_b)
    depth = np.asarray(state.depth)

    for i, op in enumerate(ops):
        if op == OP_RAW:
            assert 0 <= parent_a[i] < feature_dim
            assert parent_b[i] == -1
            assert depth[i] == 0
        else:
            assert 0 <= parent_a[i] < i
            assert 0 <= parent_b[i] < i
            expected_depth = max(depth[parent_a[i]], depth[parent_b[i]]) + 1
            assert depth[i] == expected_depth
            assert depth[i] <= max_depth


class TestCompositionalFeatureLearner:
    """Tests for the compositional DAG feature learner."""

    def test_init_shapes(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=10,
            n_tasks=3,
            candidate_count=4,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))

        chex.assert_shape(state.ops, (10,))
        chex.assert_shape(state.parent_a, (10,))
        chex.assert_shape(state.parent_b, (10,))
        chex.assert_shape(state.theta, (10, 2))
        chex.assert_shape(state.depth, (10,))
        chex.assert_shape(state.output_weights, (3, 10))
        chex.assert_shape(state.output_bias, (3,))
        chex.assert_shape(state.utilities, (10,))
        chex.assert_shape(state.utility_error_trace, (3,))
        chex.assert_shape(state.utility_feature_trace, (10,))
        chex.assert_shape(state.utility_feature_energy_trace, (10,))
        chex.assert_shape(state.feature_score_residual_trace, (3, 10))
        chex.assert_shape(state.feature_score_energy_trace, (10,))
        chex.assert_shape(state.retention_slow_utilities, (10,))
        chex.assert_shape(state.ages, (10,))
        chex.assert_shape(state.candidate_ops, (4,))
        chex.assert_shape(state.candidate_parent_a, (4,))
        chex.assert_shape(state.candidate_parent_b, (4,))
        chex.assert_shape(state.candidate_theta, (4, 2))
        chex.assert_shape(state.candidate_output_weights, (3, 4))
        chex.assert_shape(state.candidate_utility_feature_trace, (4,))
        chex.assert_shape(state.candidate_utility_feature_energy_trace, (4,))
        chex.assert_shape(state.candidate_score_residual_trace, (3, 4))
        chex.assert_shape(state.candidate_score_energy_trace, (4,))
        chex.assert_shape(state.candidate_retention_slow_utilities, (4,))
        chex.assert_shape(state.candidate_active_correlation_trace, (4, 10))
        chex.assert_shape(state.candidate_selector_log_weights, (4,))
        chex.assert_shape(state.candidate_selector_cumulative_loss, (4,))
        chex.assert_shape(state.candidate_selector_action_counts, (4,))

        # The first feature_dim slots should be raw passthroughs.
        ops_np = np.asarray(state.ops)
        assert (ops_np[:4] == OP_RAW).all()
        # And every composed slot must reference earlier slots only.
        pa_np = np.asarray(state.parent_a)
        pb_np = np.asarray(state.parent_b)
        for i in range(4, 10):
            assert pa_np[i] < i
            assert pb_np[i] < i

    def test_forward_pass_topological_order(self) -> None:
        """Build a tiny DAG by hand and verify the forward gives the right values."""
        # Slots: [raw 0, raw 1, product(0, 1)] -> values [x[0], x[1], x[0]*x[1]]
        ops = jnp.array([OP_RAW, OP_RAW, OP_PRODUCT], dtype=jnp.int32)
        parent_a = jnp.array([0, 1, 0], dtype=jnp.int32)
        parent_b = jnp.array([-1, -1, 1], dtype=jnp.int32)
        theta = jnp.zeros((3, 2), dtype=jnp.float32)
        observation = jnp.array([2.0, 3.0], dtype=jnp.float32)

        values = _compute_feature_values(ops, parent_a, parent_b, theta, observation)
        np.testing.assert_allclose(np.asarray(values), [2.0, 3.0, 6.0])

    def test_forward_pass_composes_constructed_features(self) -> None:
        """Depth-2 features can use earlier constructed features as parents."""
        # slot 3 = x0 * x1, slot 4 = slot3 * x2.  This is a genuine
        # feature-of-feature composition, not a pair-product over raw inputs.
        ops = jnp.array(
            [OP_RAW, OP_RAW, OP_RAW, OP_PRODUCT, OP_PRODUCT],
            dtype=jnp.int32,
        )
        parent_a = jnp.array([0, 1, 2, 0, 3], dtype=jnp.int32)
        parent_b = jnp.array([-1, -1, -1, 1, 2], dtype=jnp.int32)
        theta = jnp.zeros((5, 2), dtype=jnp.float32)
        observation = jnp.array([2.0, 2.0, 2.0], dtype=jnp.float32)

        values = _compute_feature_values(ops, parent_a, parent_b, theta, observation)
        np.testing.assert_allclose(np.asarray(values), [2.0, 2.0, 2.0, 4.0, 8.0])

    def test_candidate_features_can_use_constructed_active_parents(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=4,
            n_tasks=1,
            candidate_count=1,
        )
        state = learner.init(feature_dim=3, key=jr.key(7))

        # Active slot 3 is a constructed pair product; the candidate composes
        # that constructed slot with raw slot 2 to make a triple product.
        state = state.replace(  # type: ignore[attr-defined]
            ops=state.ops.at[3].set(OP_PRODUCT),
            parent_a=state.parent_a.at[3].set(0),
            parent_b=state.parent_b.at[3].set(1),
            depth=state.depth.at[3].set(1),
            candidate_ops=state.candidate_ops.at[0].set(OP_PRODUCT),
            candidate_parent_a=state.candidate_parent_a.at[0].set(3),
            candidate_parent_b=state.candidate_parent_b.at[0].set(2),
            candidate_depth=state.candidate_depth.at[0].set(2),
        )
        observation = jnp.array([2.0, 2.0, 2.0], dtype=jnp.float32)
        active_values = learner.constructed_features(state, observation)

        candidate_values = learner._candidate_features(
            state, active_values, observation
        )

        np.testing.assert_allclose(np.asarray(active_values[3]), 4.0)
        np.testing.assert_allclose(np.asarray(candidate_values), [8.0])

    def test_predict_shapes(self) -> None:
        learner = CompositionalFeatureLearner(n_features=8, n_tasks=2)
        state = learner.init(feature_dim=4, key=jr.key(1))
        observation = jnp.array([0.1, -0.2, 0.3, 0.4], dtype=jnp.float32)

        prediction = learner.predict(state, observation)
        chex.assert_shape(prediction, (2,))
        chex.assert_tree_all_finite(prediction)

    def test_update_returns_finite_metrics(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=8,
            n_tasks=2,
            candidate_count=3,
            replacement_interval=10,
        )
        state = learner.init(feature_dim=4, key=jr.key(2))

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

    def test_finite_candidate_selector_probabilities_remain_normalized(self) -> None:
        selector = FiniteCandidateSelector(
            n_candidates=3,
            learning_rate=0.7,
            update_rule=CANDIDATE_SELECTOR_HEDGE,
        )
        state = selector.init()

        for losses in (
            jnp.array([0.2, 0.5, 0.8], dtype=jnp.float32),
            jnp.array([0.1, jnp.nan, 0.9], dtype=jnp.float32),
            jnp.array([0.4, 0.3, 0.6], dtype=jnp.float32),
        ):
            probabilities = selector.probabilities(state)
            chex.assert_shape(probabilities, (3,))
            np.testing.assert_allclose(float(jnp.sum(probabilities)), 1.0, rtol=1e-6)
            assert float(jnp.min(probabilities)) >= 0.0
            state = selector.update(state, losses).state

        probabilities = selector.probabilities(state)
        np.testing.assert_allclose(float(jnp.sum(probabilities)), 1.0, rtol=1e-6)

    def test_finite_candidate_selector_lower_loss_gains_mass(self) -> None:
        selector = FiniteCandidateSelector(
            n_candidates=3,
            learning_rate=1.0,
            update_rule=CANDIDATE_SELECTOR_HEDGE,
        )
        state = selector.init()
        initial = selector.probabilities(state)

        for _ in range(10):
            state = selector.update(
                state,
                jnp.array([0.05, 0.70, 0.70], dtype=jnp.float32),
            ).state

        final = selector.probabilities(state)
        assert float(final[0]) > float(initial[0])
        assert float(final[0]) > float(final[1])
        assert float(final[0]) > float(final[2])

    def test_finite_candidate_selector_regret_metadata_has_assumptions(self) -> None:
        selector = FiniteCandidateSelector(
            n_candidates=4,
            learning_rate=0.5,
            update_rule=CANDIDATE_SELECTOR_HEDGE,
        )

        metadata = selector.regret_metadata(horizon=20)

        assert metadata["algorithm"] == CANDIDATE_SELECTOR_HEDGE
        assert metadata["candidate_count"] == 4
        assert metadata["assumptions"]["finite_candidate_set"] is True
        assert metadata["assumptions"]["fixed_candidate_identities"] is True
        assert metadata["assumptions"]["loss_lower_bound"] == 0.0
        assert metadata["assumptions"]["loss_upper_bound"] == 1.0
        assert metadata["assumptions"]["comparator"] == "best fixed candidate in hindsight"
        assert metadata["regret_bound"] > 0.0
        assert "ln(K)/eta" in metadata["regret_statement"]

    def test_future_utility_credits_unweighted_candidate(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=2,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.5,
            utility_decay=0.0,
            replacement_interval=0,
            future_utility_mix=1.0,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(13))
        state = state.replace(  # type: ignore[attr-defined]
            output_weights=jnp.zeros((1, 2), dtype=jnp.float32),
            candidate_output_weights=jnp.zeros((1, 1), dtype=jnp.float32),
            candidate_ops=state.candidate_ops.at[0].set(OP_RAW),
            candidate_parent_a=state.candidate_parent_a.at[0].set(0),
            candidate_parent_b=state.candidate_parent_b.at[0].set(-1),
        )

        result = learner.update(
            state,
            jnp.array([1.0, 1.0], dtype=jnp.float32),
            jnp.array([2.0], dtype=jnp.float32),
        )

        assert float(result.state.utilities[0]) == 1.5
        assert float(result.state.candidate_utilities[0]) == 1.5

    def test_energy_novelty_scoring_normalizes_candidate_scale(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=2,
            n_tasks=1,
            candidate_count=2,
            step_size_output=0.0,
            utility_decay=0.0,
            replacement_interval=0,
            candidate_scoring_mode="energy_novelty",
            candidate_score_trace_decay=0.0,
            candidate_novelty_weight=0.0,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(21)).replace(  # type: ignore[attr-defined]
            output_weights=jnp.zeros((1, 2), dtype=jnp.float32),
            candidate_output_weights=jnp.zeros((1, 2), dtype=jnp.float32),
            candidate_ops=jnp.array([OP_RAW, OP_RAW], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0, 1], dtype=jnp.int32),
            candidate_parent_b=jnp.array([-1, -1], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, 10.0], dtype=jnp.float32),
            jnp.array([2.0], dtype=jnp.float32),
        )

        np.testing.assert_allclose(
            np.asarray(result.state.candidate_utilities),
            np.asarray([2.0, 2.0], dtype=np.float32),
            rtol=1e-5,
        )

    def test_energy_novelty_scoring_penalizes_redundant_candidates(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=2,
            n_tasks=1,
            candidate_count=2,
            step_size_output=0.0,
            utility_decay=0.0,
            replacement_interval=0,
            candidate_scoring_mode="energy_novelty",
            candidate_score_trace_decay=0.9,
            candidate_novelty_weight=1.0,
            candidate_novelty_floor=0.05,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(22)).replace(  # type: ignore[attr-defined]
            output_weights=jnp.zeros((1, 2), dtype=jnp.float32),
            candidate_output_weights=jnp.zeros((1, 2), dtype=jnp.float32),
            candidate_ops=jnp.array([OP_RAW, OP_PRODUCT], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0, 0], dtype=jnp.int32),
            candidate_parent_b=jnp.array([-1, 1], dtype=jnp.int32),
        )
        observations = [
            jnp.array([1.0, 1.0], dtype=jnp.float32),
            jnp.array([1.0, -1.0], dtype=jnp.float32),
            jnp.array([-1.0, 1.0], dtype=jnp.float32),
            jnp.array([-1.0, -1.0], dtype=jnp.float32),
        ]
        for observation in observations:
            target = jnp.array(
                [observation[0] + observation[0] * observation[1]],
                dtype=jnp.float32,
            )
            state = learner.update(state, observation, target).state

        assert float(state.candidate_utilities[1]) > float(
            state.candidate_utilities[0]
        )
        assert float(state.candidate_utilities[0]) > 0.0

    def test_slow_retention_blocks_fast_only_deletion(self) -> None:
        """Opt-in hysteresis deletes only when fast and slow utility are low."""
        learner = CompositionalFeatureLearner(
            n_features=3,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=1.0,
            retention_slow_utility_decay=0.9,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(24)).replace(  # type: ignore[attr-defined]
            ops=jnp.array([OP_RAW, OP_RAW, OP_PRODUCT], dtype=jnp.int32),
            parent_a=jnp.array([0, 1, 0], dtype=jnp.int32),
            parent_b=jnp.array([-1, -1, 1], dtype=jnp.int32),
            depth=jnp.array([0, 0, 1], dtype=jnp.int32),
            utilities=jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32),
            retention_slow_utilities=jnp.array([0.0, 0.0, 10.0], dtype=jnp.float32),
            candidate_ops=jnp.array([OP_TANH], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0], dtype=jnp.int32),
            candidate_parent_b=jnp.array([1], dtype=jnp.int32),
            candidate_depth=jnp.array([1], dtype=jnp.int32),
            candidate_utilities=jnp.array([1.0], dtype=jnp.float32),
            candidate_ages=jnp.array([5], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, -1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == -1
        assert int(result.state.ops[2]) == OP_PRODUCT
        assert float(result.state.retention_slow_utilities[2]) > 8.0

    def test_default_retention_path_still_allows_fast_promotion(self) -> None:
        """Disabled slow retention preserves the historical fast-utility path."""
        learner = CompositionalFeatureLearner(
            n_features=3,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=1.0,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(25)).replace(  # type: ignore[attr-defined]
            ops=jnp.array([OP_RAW, OP_RAW, OP_PRODUCT], dtype=jnp.int32),
            parent_a=jnp.array([0, 1, 0], dtype=jnp.int32),
            parent_b=jnp.array([-1, -1, 1], dtype=jnp.int32),
            depth=jnp.array([0, 0, 1], dtype=jnp.int32),
            utilities=jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32),
            retention_slow_utilities=jnp.array([0.0, 0.0, 10.0], dtype=jnp.float32),
            candidate_ops=jnp.array([OP_TANH], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0], dtype=jnp.int32),
            candidate_parent_b=jnp.array([1], dtype=jnp.int32),
            candidate_depth=jnp.array([1], dtype=jnp.int32),
            candidate_utilities=jnp.array([1.0], dtype=jnp.float32),
            candidate_ages=jnp.array([5], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, -1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == 2
        assert int(result.promoted_candidate) == 0
        assert int(result.state.ops[2]) == OP_TANH

    def test_tanh_family_quota_protects_smooth_scaffold(self) -> None:
        """Family protection can keep the last smooth basis from early churn."""
        learner = CompositionalFeatureLearner(
            n_features=3,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=1.0,
            retention_tanh_min_count=1,
            use_obgd=False,
        )
        state = learner.init(feature_dim=2, key=jr.key(26)).replace(  # type: ignore[attr-defined]
            ops=jnp.array([OP_RAW, OP_RAW, OP_TANH], dtype=jnp.int32),
            parent_a=jnp.array([0, 1, 0], dtype=jnp.int32),
            parent_b=jnp.array([-1, -1, 1], dtype=jnp.int32),
            theta=jnp.array(
                [[0.0, 0.0], [0.0, 0.0], [1.0, -1.0]], dtype=jnp.float32
            ),
            depth=jnp.array([0, 0, 1], dtype=jnp.int32),
            utilities=jnp.array([0.0, 0.0, 0.0], dtype=jnp.float32),
            candidate_ops=jnp.array([OP_PRODUCT], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0], dtype=jnp.int32),
            candidate_parent_b=jnp.array([1], dtype=jnp.int32),
            candidate_depth=jnp.array([1], dtype=jnp.int32),
            candidate_utilities=jnp.array([1.0], dtype=jnp.float32),
            candidate_ages=jnp.array([5], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, -1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == -1
        assert int(result.state.ops[2]) == OP_TANH

    def test_trace_future_utility_credits_recursive_candidate_alignment(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=4,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.1,
            utility_decay=0.0,
            replacement_interval=0,
            future_utility_mix=1.0,
            future_utility_trace_decay=0.9,
            use_obgd=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(14))
        state = state.replace(  # type: ignore[attr-defined]
            ops=state.ops.at[3].set(OP_PRODUCT),
            parent_a=state.parent_a.at[3].set(0),
            parent_b=state.parent_b.at[3].set(1),
            depth=state.depth.at[3].set(1),
            output_weights=jnp.zeros((1, 4), dtype=jnp.float32),
            candidate_output_weights=jnp.zeros((1, 1), dtype=jnp.float32),
            candidate_ops=state.candidate_ops.at[0].set(OP_PRODUCT),
            candidate_parent_a=state.candidate_parent_a.at[0].set(3),
            candidate_parent_b=state.candidate_parent_b.at[0].set(2),
            candidate_depth=state.candidate_depth.at[0].set(2),
        )

        first = learner.update(
            state,
            jnp.array([1.0, 1.0, 1.0], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )
        second = learner.update(
            first.state,
            jnp.array([1.0, 1.0, 1.0], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        assert int(second.state.candidate_depth[0]) == 2
        assert int(second.state.candidate_parent_a[0]) == 3
        assert float(second.state.candidate_utilities[0]) > 0.0
        assert (
            float(second.state.candidate_utilities[0])
            > float(first.state.candidate_utilities[0])
        )

    def test_config_roundtrip_keeps_future_utility_mix(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=2,
            future_utility_mix=0.3,
            future_utility_trace_decay=0.8,
            candidate_scoring_mode="energy_novelty",
            candidate_score_trace_decay=0.7,
            candidate_novelty_weight=0.5,
            operation_prior=(0.0, 0.6, 0.0, 0.4, 0.0),
        )

        restored = CompositionalFeatureLearner.from_config(learner.to_config())

        assert restored.to_config()["future_utility_mix"] == 0.3
        assert restored.to_config()["future_utility_trace_decay"] == 0.8
        assert restored.to_config()["candidate_scoring_mode"] == "energy_novelty"
        assert restored.to_config()["candidate_score_trace_decay"] == 0.7
        assert restored.to_config()["candidate_novelty_weight"] == 0.5
        assert restored.to_config()["operation_prior"] == [0.0, 0.6, 0.0, 0.4, 0.0]

    def test_operation_prior_rejects_invalid_probability_vector(self) -> None:
        invalid_priors = (
            (0.0, 1.0),
            (0.0, 0.0, 0.0, 0.0, 0.0),
            (0.0, -1.0, 0.0, 2.0, 0.0),
        )
        for prior in invalid_priors:
            try:
                CompositionalFeatureLearner(
                    n_features=8,
                    n_tasks=1,
                    operation_prior=prior,
                )
            except ValueError:
                pass
            else:
                raise AssertionError("invalid operation prior was accepted")

    def test_replacement_event_occurs(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=2,
            candidate_count=0,
            replacement_interval=1,
            min_feature_age=0,
        )
        state = learner.init(feature_dim=3, key=jr.key(3))
        result = learner.update(
            state,
            jnp.ones(3, dtype=jnp.float32),
            jnp.array([0.5, -0.25], dtype=jnp.float32),
        )

        assert float(result.metrics[5]) == 1.0
        assert int(result.replaced_slot) >= 0
        # The replaced slot is composed (not a raw passthrough).
        replaced = int(result.replaced_slot)
        assert replaced >= 3, f"raw-input slot {replaced} should not be replaced"
        assert int(result.state.ages[replaced]) == 0

    def test_cascade_replacement(self) -> None:
        """When a parent is replaced, its descendants must also be replaced."""
        # Build a deterministic state where slot 4 references slot 3, so
        # replacing slot 3 must also trigger a refill on slot 4.
        learner = CompositionalFeatureLearner(
            n_features=5,
            n_tasks=1,
            candidate_count=0,
            replacement_interval=1,
            min_feature_age=0,
        )
        feature_dim = 3
        state = learner.init(feature_dim=feature_dim, key=jr.key(4))

        # Manually rewire slots 3 and 4 so:
        #   slot 3 = product(0, 1)            depth = 1
        #   slot 4 = product(3, 2)            depth = 2
        # Then we make slot 3 the lowest-utility candidate by zeroing its
        # utility and giving everything else high utility.
        ops = state.ops.at[3].set(OP_PRODUCT).at[4].set(OP_PRODUCT)
        parent_a = state.parent_a.at[3].set(0).at[4].set(3)
        parent_b = state.parent_b.at[3].set(1).at[4].set(2)
        depth = state.depth.at[3].set(1).at[4].set(2)
        utilities = jnp.array([10.0, 10.0, 10.0, 0.0, 10.0], dtype=jnp.float32)
        ages = jnp.array([10, 10, 10, 10, 10], dtype=jnp.int32)
        # Mark slot 4 with a unique theta value so we can tell it's been
        # refilled by checking the theta vector changes.
        theta = state.theta.at[4].set(jnp.array([7.5, 7.5], dtype=jnp.float32))

        state = state.replace(  # type: ignore[attr-defined]
            ops=ops,
            parent_a=parent_a,
            parent_b=parent_b,
            depth=depth,
            utilities=utilities,
            ages=ages,
            theta=theta,
        )

        result = learner.update(
            state,
            jnp.array([0.5, 0.4, 0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        # Slot 3 should be selected for replacement.
        assert int(result.replaced_slot) == 3
        # Slot 4 referenced slot 3, so its theta must change as a result of
        # the cascade refill.
        assert not np.allclose(
            np.asarray(result.state.theta[4]),
            np.asarray(theta[4]),
        ), "slot 4 should have been cascade-replaced after slot 3 was replaced"
        _assert_valid_active_dag(result.state, feature_dim, learner.max_depth)

    def test_candidate_with_no_compatible_destination_does_not_promote(self) -> None:
        """A high-utility candidate must not promote without a valid slot.

        Candidate parents refer into the active bank, not into a topological
        prefix.  If the best candidate depends on a slot at or after the
        latest active slot, no replacement destination can preserve the strict
        parent < child invariant.  In that case the active bank should be left
        alone.
        """
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=1,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=0.0,
        )
        feature_dim = 3
        state = learner.init(feature_dim=feature_dim, key=jr.key(8))

        ops = state.ops.at[3].set(OP_PRODUCT).at[4].set(OP_PRODUCT).at[5].set(OP_PRODUCT)
        parent_a = state.parent_a.at[3].set(0).at[4].set(3).at[5].set(0)
        parent_b = state.parent_b.at[3].set(1).at[4].set(2).at[5].set(2)
        depth = state.depth.at[3].set(1).at[4].set(2).at[5].set(1)
        theta = state.theta.at[4].set(jnp.array([7.5, 7.5], dtype=jnp.float32))

        state = state.replace(  # type: ignore[attr-defined]
            ops=ops,
            parent_a=parent_a,
            parent_b=parent_b,
            depth=depth,
            theta=theta,
            output_weights=jnp.zeros_like(state.output_weights),
            utilities=jnp.array([10.0, 10.0, 10.0, 0.0, 5.0, 5.0], dtype=jnp.float32),
            ages=jnp.full((6,), 10, dtype=jnp.int32),
            candidate_ops=state.candidate_ops.at[0].set(OP_PRODUCT),
            # Invalid for any promotion destination because no slot is > 5.
            candidate_parent_a=state.candidate_parent_a.at[0].set(5),
            candidate_parent_b=state.candidate_parent_b.at[0].set(2),
            candidate_depth=state.candidate_depth.at[0].set(2),
            candidate_output_weights=jnp.zeros_like(state.candidate_output_weights),
            candidate_utilities=jnp.array([100.0], dtype=jnp.float32),
            candidate_ages=jnp.array([10], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([0.5, 0.4, 0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == -1
        assert int(result.promoted_candidate) == -1
        np.testing.assert_array_equal(
            np.asarray(result.state.parent_a), np.asarray(parent_a)
        )
        np.testing.assert_array_equal(
            np.asarray(result.state.parent_b), np.asarray(parent_b)
        )
        np.testing.assert_array_equal(np.asarray(result.state.ops), np.asarray(ops))
        np.testing.assert_allclose(
            np.asarray(result.state.theta[4]), np.asarray(theta[4])
        )
        _assert_valid_active_dag(result.state, feature_dim, learner.max_depth)

    def test_candidate_promotion_uses_compatible_later_slot(self) -> None:
        """High-utility candidates can promote into a later compatible slot."""
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            step_size_theta=0.0,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=0.0,
        )
        feature_dim = 3
        state = learner.init(feature_dim=feature_dim, key=jr.key(18))
        state = state.replace(  # type: ignore[attr-defined]
            ops=state.ops.at[3].set(OP_PRODUCT).at[4].set(OP_PRODUCT).at[5].set(
                OP_PRODUCT
            ),
            parent_a=state.parent_a.at[3].set(0).at[4].set(3).at[5].set(0),
            parent_b=state.parent_b.at[3].set(1).at[4].set(2).at[5].set(2),
            depth=state.depth.at[3].set(1).at[4].set(2).at[5].set(1),
            utilities=jnp.array([10.0, 10.0, 10.0, 0.0, 5.0, 5.0], dtype=jnp.float32),
            ages=jnp.full((6,), 10, dtype=jnp.int32),
            candidate_ops=state.candidate_ops.at[0].set(OP_PRODUCT),
            candidate_parent_a=state.candidate_parent_a.at[0].set(4),
            candidate_parent_b=state.candidate_parent_b.at[0].set(2),
            candidate_depth=state.candidate_depth.at[0].set(3),
            candidate_output_weights=state.candidate_output_weights.at[0, 0].set(1.0),
            candidate_utilities=jnp.array([100.0], dtype=jnp.float32),
            candidate_ages=jnp.array([10], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([0.5, 0.4, 0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == 5
        assert int(result.promoted_candidate) == 0
        assert int(result.state.parent_a[5]) == 4
        assert int(result.state.parent_b[5]) == 2
        _assert_valid_active_dag(result.state, feature_dim, learner.max_depth)

    def test_legacy_promote_rule_preserved_unless_selector_enabled(self) -> None:
        """Default promotion remains utility argmax; selector is opt-in."""
        common_kwargs = dict(
            n_features=5,
            n_tasks=1,
            candidate_count=2,
            step_size_output=0.0,
            step_size_theta=0.0,
            utility_decay=0.99,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=0.0,
            use_obgd=False,
        )
        legacy = CompositionalFeatureLearner(**common_kwargs)
        selector = CompositionalFeatureLearner(
            **common_kwargs,
            candidate_selector=CANDIDATE_SELECTOR_HEDGE,
            candidate_selector_learning_rate=0.1,
        )
        state = legacy.init(feature_dim=3, key=jr.key(27)).replace(  # type: ignore[attr-defined]
            ops=jnp.array(
                [OP_RAW, OP_RAW, OP_RAW, OP_PRODUCT, OP_PRODUCT],
                dtype=jnp.int32,
            ),
            parent_a=jnp.array([0, 1, 2, 0, 0], dtype=jnp.int32),
            parent_b=jnp.array([-1, -1, -1, 1, 2], dtype=jnp.int32),
            depth=jnp.array([0, 0, 0, 1, 1], dtype=jnp.int32),
            utilities=jnp.array([10.0, 10.0, 10.0, 0.0, 1.0], dtype=jnp.float32),
            ages=jnp.full((5,), 10, dtype=jnp.int32),
            candidate_ops=jnp.array([OP_PRODUCT, OP_PRODUCT], dtype=jnp.int32),
            candidate_parent_a=jnp.array([0, 0], dtype=jnp.int32),
            candidate_parent_b=jnp.array([1, 2], dtype=jnp.int32),
            candidate_depth=jnp.array([1, 1], dtype=jnp.int32),
            candidate_utilities=jnp.array([100.0, 90.0], dtype=jnp.float32),
            candidate_ages=jnp.array([10, 10], dtype=jnp.int32),
        )
        biased_selector_state = state.replace(  # type: ignore[attr-defined]
            candidate_selector_log_weights=jnp.array([-20.0, 20.0], dtype=jnp.float32)
        )

        legacy_result = legacy.update(
            state,
            jnp.array([1.0, 1.0, 1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )
        selector_result = selector.update(
            biased_selector_state,
            jnp.array([1.0, 1.0, 1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert legacy.to_config()["candidate_selector"] == CANDIDATE_SELECTOR_LEGACY
        assert int(legacy_result.promoted_candidate) == 0
        assert int(selector_result.promoted_candidate) == 1

    def test_candidate_refresh_respects_min_age(self) -> None:
        """New candidates must get a real evaluation window before recycling."""
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=1,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=3,
            promotion_margin=10.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(9))
        original_candidate_ops = state.candidate_ops
        original_candidate_parent_a = state.candidate_parent_a
        original_candidate_parent_b = state.candidate_parent_b
        original_candidate_theta = state.candidate_theta
        original_candidate_depth = state.candidate_depth

        result = learner.update(
            state,
            jnp.array([0.5, 0.4, 0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promoted_candidate) == -1
        assert int(result.state.candidate_ages[0]) == 1
        np.testing.assert_array_equal(
            np.asarray(result.state.candidate_ops), np.asarray(original_candidate_ops)
        )
        np.testing.assert_array_equal(
            np.asarray(result.state.candidate_parent_a),
            np.asarray(original_candidate_parent_a),
        )
        np.testing.assert_array_equal(
            np.asarray(result.state.candidate_parent_b),
            np.asarray(original_candidate_parent_b),
        )
        np.testing.assert_array_equal(
            np.asarray(result.state.candidate_depth), np.asarray(original_candidate_depth)
        )
        np.testing.assert_allclose(
            np.asarray(result.state.candidate_theta),
            np.asarray(original_candidate_theta),
        )

    def test_candidate_output_imprint_is_residual_aligned(self) -> None:
        """Refreshed candidates get a small residual-aligned shadow head."""
        errors = jnp.array([2.0, -4.0, 0.0], dtype=jnp.float32)
        candidate_value = jnp.array(3.0, dtype=jnp.float32)
        active_count = jnp.array(2.0, dtype=jnp.float32)

        weights = _imprint_candidate_output_weights(
            errors,
            candidate_value,
            active_count,
        )
        chex.assert_shape(weights, (3,))
        assert float(weights[0]) > 0.0
        assert float(weights[1]) < 0.0
        assert float(weights[2]) == 0.0
        # Damping keeps the imprint well below the one-sample least-squares fit.
        np.testing.assert_allclose(
            np.asarray(weights),
            np.asarray(0.1 * errors * candidate_value / ((3.0 * 3.0 + 1.0) * 2.0)),
        )

    def test_generator_meta_config_roundtrip(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=8,
            n_tasks=2,
            candidate_count=3,
            learn_generator_resources=True,
            generator_resource_contexts=2,
            generator_resource_learning_rate=0.7,
            generator_resource_discount=0.9,
            generator_resource_exploration=0.05,
            generator_resource_advantage_clip=3.0,
            generator_resource_cost_weight=0.1,
        )

        restored = CompositionalFeatureLearner.from_config(learner.to_config())

        assert restored.to_config() == learner.to_config()

    def test_generator_meta_contextual_allocation_updates_from_provenance(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=2,
            replacement_interval=0,
            learn_generator_resources=True,
            generator_resource_contexts=2,
            generator_resource_learning_rate=2.0,
            generator_resource_discount=1.0,
            generator_resource_exploration=0.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(10))
        policy_count = len(DEFAULT_GENERATOR_META_POLICY_NAMES)
        state = state.replace(  # type: ignore[attr-defined]
            utilities=jnp.array([0.0, 0.0, 0.0, 10.0, 0.0, 0.0], dtype=jnp.float32),
            feature_generator_policy=jnp.array([0, 0, 0, 2, 1, 1], dtype=jnp.int32),
            candidate_generator_policy=jnp.array([0, 1], dtype=jnp.int32),
            generator_resource_state=state.generator_resource_state.replace(  # type: ignore[attr-defined]
                log_weights=jnp.zeros((2, policy_count), dtype=jnp.float32)
            ),
        )

        result = learner.update(
            state,
            jnp.ones(3, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
            context_id=1,
        )

        weights_ctx0 = learner._generator_resource_manager.weights(
            result.state.generator_resource_state,
            0,
        )
        weights_ctx1 = learner._generator_resource_manager.weights(
            result.state.generator_resource_state,
            1,
        )
        assert int(jnp.argmax(weights_ctx1)) == 2
        np.testing.assert_allclose(
            np.asarray(weights_ctx0),
            np.full(policy_count, 1.0 / policy_count),
            rtol=1e-6,
        )

    def test_generator_meta_policy_controls_candidate_construction(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=1,
            replacement_interval=1,
            min_feature_age=100,
            candidate_min_age=0,
            promotion_margin=1000.0,
            learn_generator_resources=True,
            generator_resource_learning_rate=0.0,
            generator_resource_exploration=0.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(11))
        # Policy index 2 is the residual-tanh policy in the default table.
        state = state.replace(  # type: ignore[attr-defined]
            generator_resource_state=state.generator_resource_state.replace(  # type: ignore[attr-defined]
                log_weights=jnp.array([[-10.0, -10.0, 10.0, -10.0]], dtype=jnp.float32)
            ),
            candidate_utilities=jnp.array([0.0], dtype=jnp.float32),
            candidate_ages=jnp.array([10], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([0.2, -0.4, 0.6], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        assert int(result.state.candidate_ops[0]) == OP_TANH
        assert int(result.state.candidate_generator_policy[0]) == 2

    def test_generator_meta_policy_changes_replacement_rate(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=0,
            replacement_interval=10,
            min_feature_age=1000,
            learn_generator_resources=True,
            generator_resource_learning_rate=0.0,
            generator_resource_exploration=0.0,
        )
        conservative = learner.init(feature_dim=3, key=jr.key(12)).replace(  # type: ignore[attr-defined]
            generator_resource_state=learner.init(
                feature_dim=3, key=jr.key(12)
            ).generator_resource_state.replace(  # type: ignore[attr-defined]
                log_weights=jnp.array([[10.0, -10.0, -10.0, -10.0]], dtype=jnp.float32)
            )
        )
        aggressive = learner.init(feature_dim=3, key=jr.key(12)).replace(  # type: ignore[attr-defined]
            generator_resource_state=learner.init(
                feature_dim=3, key=jr.key(12)
            ).generator_resource_state.replace(  # type: ignore[attr-defined]
                log_weights=jnp.array([[-10.0, -10.0, -10.0, 10.0]], dtype=jnp.float32)
            )
        )

        conservative_result = learner.update(
            conservative,
            jnp.ones(3, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )
        aggressive_result = learner.update(
            aggressive,
            jnp.ones(3, dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert (
            float(aggressive_result.state.replacement_accumulator)
            > float(conservative_result.state.replacement_accumulator)
        )

    def test_recursive_product_generation_initializes_depth2_candidates(self) -> None:
        """Opt-in recursive-product mode scaffolds pair products and depth-2 candidates."""
        learner = CompositionalFeatureLearner(
            n_features=10,
            n_tasks=1,
            candidate_count=4,
            generation_strategy="recursive_product",
            max_depth=3,
        )
        state = learner.init(feature_dim=4, key=jr.key(16))

        np.testing.assert_array_equal(
            np.asarray(state.ops[4:]), np.full(6, OP_PRODUCT)
        )
        np.testing.assert_array_equal(np.asarray(state.depth[4:]), np.ones(6))
        np.testing.assert_array_equal(
            np.asarray(state.candidate_ops), np.full(4, OP_PRODUCT)
        )
        assert (np.asarray(state.candidate_parent_a) >= 4).all()
        assert (np.asarray(state.candidate_parent_b) < 4).all()
        np.testing.assert_array_equal(
            np.asarray(state.candidate_depth), np.full(4, 2)
        )

    def test_robust_recursive_generation_uses_recursive_scaffold_priors(self) -> None:
        """The single-mechanism path starts with reusable recursive candidates."""
        learner = CompositionalFeatureLearner(
            n_features=10,
            n_tasks=1,
            candidate_count=4,
            generation_strategy=GENERATION_ROBUST_RECURSIVE,
            parent_novelty_weight=0.1,
            parent_depth_prior=0.2,
            retention_depth_bonus=0.05,
            max_depth=3,
        )
        state = learner.init(feature_dim=4, key=jr.key(17))

        np.testing.assert_array_equal(
            np.asarray(state.ops[4:]), np.full(6, OP_PRODUCT)
        )
        np.testing.assert_array_equal(
            np.asarray(state.candidate_ops), np.full(4, OP_PRODUCT)
        )
        assert (np.asarray(state.candidate_parent_a) >= 4).all()
        assert (np.asarray(state.candidate_parent_b) < 4).all()
        assert learner.to_config()["parent_novelty_weight"] == 0.1
        assert learner.to_config()["parent_depth_prior"] == 0.2
        assert learner.to_config()["retention_depth_bonus"] == 0.05

    def test_robust_recursive_can_seed_signed_tanh_scaffolds(self) -> None:
        """Optional nonlinear scaffolds are task-agnostic signed raw-pair tanh ops."""
        learner = CompositionalFeatureLearner(
            n_features=13,
            n_tasks=1,
            candidate_count=2,
            generation_strategy=GENERATION_ROBUST_RECURSIVE,
            signed_tanh_scaffold_count=3,
            max_depth=3,
        )
        state = learner.init(feature_dim=3, key=jr.key(20))

        np.testing.assert_array_equal(
            np.asarray(state.ops[3:9]), np.full(6, OP_PRODUCT)
        )
        np.testing.assert_array_equal(
            np.asarray(state.ops[9:12]), np.full(3, OP_TANH)
        )
        np.testing.assert_allclose(
            np.asarray(state.theta[9:12]),
            np.asarray([[1.0, -1.0], [-1.0, 1.0], [1.0, 1.0]], dtype=np.float32),
        )
        assert learner.to_config()["signed_tanh_scaffold_count"] == 3

    def test_mutation_generation_anchors_high_utility_parent(self) -> None:
        """Mutation search should mutate around the highest-score parent."""
        learner = CompositionalFeatureLearner(
            n_features=4,
            n_tasks=1,
            max_depth=4,
            generation_strategy="mutation",
            parent_temperature=0.5,
        )
        depth = jnp.array([0, 0, 1, 1], dtype=jnp.int32)
        utilities = jnp.array([1e-12, 1e-12, 1e12, 1e-12], dtype=jnp.float32)

        _, parent_a, parent_b, _, new_depth = learner._generate_one(
            jr.key(12),
            depth,
            utilities,
        )

        assert int(parent_a) == 2
        assert 0 <= int(parent_b) < 4
        assert int(new_depth) <= learner.max_depth

    def test_residual_imprint_refresh_initializes_candidate_weights(self) -> None:
        """Residual-imprint refresh gives new candidates immediate residual credit."""
        learner = CompositionalFeatureLearner(
            n_features=6,
            n_tasks=1,
            candidate_count=1,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=1_000_000.0,
            generation_strategy="residual_imprint",
            candidate_imprint_scale=0.5,
        )
        state = learner.init(feature_dim=3, key=jr.key(10))
        state = state.replace(  # type: ignore[attr-defined]
            ages=jnp.full((6,), 10, dtype=jnp.int32),
            candidate_ages=jnp.array([10], dtype=jnp.int32),
            candidate_utilities=jnp.array([0.0], dtype=jnp.float32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, 0.75, -0.5], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        assert int(result.promoted_candidate) == -1
        assert float(jnp.linalg.norm(result.state.candidate_output_weights)) > 0.0

    def test_tanh_candidate_theta_trains_while_in_shadow_bank(self) -> None:
        """Nonlinear candidates adapt before promotion using their shadow head."""
        learner = CompositionalFeatureLearner(
            n_features=4,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            step_size_theta=0.1,
            replacement_interval=0,
            use_obgd=False,
            train_candidate_theta=True,
        )
        state = learner.init(feature_dim=3, key=jr.key(19))
        state = state.replace(  # type: ignore[attr-defined]
            output_weights=jnp.zeros_like(state.output_weights),
            output_bias=jnp.zeros_like(state.output_bias),
            candidate_ops=state.candidate_ops.at[0].set(OP_TANH),
            candidate_parent_a=state.candidate_parent_a.at[0].set(0),
            candidate_parent_b=state.candidate_parent_b.at[0].set(1),
            candidate_theta=state.candidate_theta.at[0].set(
                jnp.array([0.0, 0.0], dtype=jnp.float32)
            ),
            candidate_output_weights=state.candidate_output_weights.at[0, 0].set(1.0),
        )

        result = learner.update(
            state,
            jnp.array([1.0, -1.0, 0.5], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        np.testing.assert_allclose(
            np.asarray(result.state.candidate_theta[0]),
            np.asarray([0.1, -0.1], dtype=np.float32),
            rtol=1e-6,
        )
        assert learner.to_config()["train_candidate_theta"] is True

    def test_promotion_blend_preserves_some_active_output_weight(self) -> None:
        """Blend mode reduces output churn when a candidate is promoted."""
        learner = CompositionalFeatureLearner(
            n_features=4,
            n_tasks=1,
            candidate_count=1,
            step_size_output=0.0,
            step_size_theta=0.0,
            replacement_interval=1,
            min_feature_age=0,
            candidate_min_age=0,
            promotion_margin=0.0,
            promotion_blend=0.25,
            promotion_output_mode="blend",
            candidate_imprint_scale=0.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(11))
        state = state.replace(  # type: ignore[attr-defined]
            ops=state.ops.at[3].set(OP_PRODUCT),
            parent_a=state.parent_a.at[3].set(0),
            parent_b=state.parent_b.at[3].set(1),
            depth=state.depth.at[3].set(1),
            output_weights=state.output_weights.at[0, 3].set(2.0),
            utilities=jnp.array([10.0, 10.0, 10.0, 0.0], dtype=jnp.float32),
            ages=jnp.full((4,), 10, dtype=jnp.int32),
            candidate_ops=state.candidate_ops.at[0].set(OP_PRODUCT),
            candidate_parent_a=state.candidate_parent_a.at[0].set(0),
            candidate_parent_b=state.candidate_parent_b.at[0].set(1),
            candidate_depth=state.candidate_depth.at[0].set(1),
            candidate_output_weights=state.candidate_output_weights.at[0, 0].set(6.0),
            candidate_utilities=jnp.array([100.0], dtype=jnp.float32),
            candidate_ages=jnp.array([10], dtype=jnp.int32),
        )

        result = learner.update(
            state,
            jnp.array([1.0, 1.0, 1.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.replaced_slot) == 3
        assert int(result.promoted_candidate) == 0
        np.testing.assert_allclose(
            np.asarray(result.state.output_weights[0, 3]),
            3.0,
            rtol=1e-6,
        )

    def test_compositional_can_fit_polynomial(self) -> None:
        """Acceptance test: learner reduces MSE on y = x[0]*x[1]*x[2] target.

        The target ``y = x[0] * x[1] * x[2]`` requires the learner to
        compose two products: one over a pair of raw inputs, then another
        between that product and the remaining raw input.  Random search
        over the compositional DAG is genuinely noisy on this task, so the
        test fixes a single seed and an aggressive replacement schedule
        that consistently discovers the structure within the 5000-step
        budget; we then check that the early-window mean MSE drops by at
        least 50% by the end of the run.

        This is the science test for compositional feature discovery: a
        depth-2 product chain cannot be expressed by raw or pairwise
        learners, only by one that composes features of features.
        """
        rng = np.random.default_rng(0)
        num_steps = 5000
        feature_dim = 4
        observations = rng.standard_normal((num_steps, feature_dim)).astype(np.float32)
        target_signal = (
            observations[:, 0] * observations[:, 1] * observations[:, 2]
        )
        noise = 0.05 * rng.standard_normal(num_steps).astype(np.float32)
        targets = (target_signal + noise)[:, None]

        learner = CompositionalFeatureLearner(
            n_features=20,
            n_tasks=1,
            candidate_count=20,
            step_size_output=0.05,
            step_size_theta=0.005,
            utility_decay=0.99,
            replacement_interval=20,
            min_feature_age=40,
            candidate_min_age=20,
            promotion_margin=1.05,
            promotion_blend=0.5,
            max_depth=3,
            use_obgd=True,
            obgd_kappa=2.0,
        )
        state = learner.init(feature_dim=feature_dim, key=jr.key(3))
        result = run_compositional_arrays(
            learner,
            state,
            jnp.asarray(observations),
            jnp.asarray(targets),
        )
        mse_history = np.asarray(result.metrics[:, 0])
        chex.assert_tree_all_finite(result.metrics)

        window = 500
        initial_mse = float(np.mean(mse_history[:window]))
        final_mse = float(np.mean(mse_history[-window:]))
        # The window-mean MSE should drop substantially.  A 50% drop is a
        # generous bound that still demonstrates compositional discovery.
        assert final_mse < 0.5 * initial_mse, (
            f"final MSE {final_mse:.4f} must be at least 50% lower than initial "
            f"MSE {initial_mse:.4f}"
        )

    def test_to_from_config_roundtrip(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=12,
            n_tasks=3,
            candidate_count=5,
            step_size_output=0.02,
            step_size_theta=0.004,
            utility_decay=0.99,
            replacement_interval=300,
            min_feature_age=120,
            candidate_min_age=60,
            promotion_margin=1.1,
            promotion_blend=0.25,
            promotion_output_mode="blend",
            max_depth=5,
            use_obgd=False,
            obgd_kappa=1.5,
            generation_strategy="residual_imprint",
            parent_temperature=0.75,
            parent_novelty_weight=0.2,
            parent_depth_prior=0.3,
            retention_depth_bonus=0.04,
            residual_guidance=0.5,
            candidate_imprint_scale=0.2,
            candidate_scoring_mode="energy_novelty",
            candidate_score_trace_decay=0.8,
            candidate_score_energy_epsilon=1e-5,
            candidate_novelty_weight=0.25,
            candidate_novelty_power=1.5,
            candidate_novelty_floor=0.1,
            candidate_selector=CANDIDATE_SELECTOR_HEDGE,
            candidate_selector_learning_rate=0.4,
            candidate_selector_exploration=0.05,
            retention_slow_utility_decay=0.95,
            retention_tanh_min_count=2,
            retention_product_min_count=4,
        )
        config = learner.to_config()
        clone = CompositionalFeatureLearner.from_config(config)
        assert clone.to_config() == config

    def test_constructed_and_augmented_features(self) -> None:
        learner = CompositionalFeatureLearner(n_features=7, n_tasks=2)
        state = learner.init(feature_dim=3, key=jr.key(5))
        observation = jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32)

        features = learner.constructed_features(state, observation)
        augmented = learner.augmented_observation(state, observation)

        chex.assert_shape(features, (7,))
        chex.assert_shape(augmented, (10,))
        chex.assert_tree_all_finite(features)
        chex.assert_tree_all_finite(augmented)

        # The first feature_dim entries of `features` should equal the
        # observation because slots [0, feature_dim) are raw passthroughs.
        np.testing.assert_allclose(
            np.asarray(features[:3]), np.asarray(observation)
        )

    def test_scan_loop_runs(self) -> None:
        learner = CompositionalFeatureLearner(
            n_features=10,
            n_tasks=2,
            candidate_count=4,
            replacement_interval=20,
            min_feature_age=10,
            candidate_min_age=5,
        )
        state = learner.init(feature_dim=3, key=jr.key(6))
        observations = jnp.asarray(
            np.random.RandomState(0).standard_normal((50, 3)).astype(np.float32)
        )
        targets = jnp.asarray(
            np.random.RandomState(1).standard_normal((50, 2)).astype(np.float32)
        )
        result = run_compositional_arrays(learner, state, observations, targets)

        chex.assert_shape(result.metrics, (50, 7))
        chex.assert_tree_all_finite(result.metrics)
        assert int(result.state.step_count) == 50
        # Sanity check the resulting state retains the type.
        assert isinstance(result.state, CompositionalFeatureState)
