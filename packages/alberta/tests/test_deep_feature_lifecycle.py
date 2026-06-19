"""Tests for native deep MLP feature generation and testing."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.deep_feature_lifecycle import (
    DeepFeatureGeneratingMultiHeadMLPLearner,
    DeepFeatureLifecycleConfig,
    DeepFeatureLifecycleState,
    run_deep_feature_lifecycle_arrays,
)
from alberta_framework.core.optimizers import ObGDBounding


class TestDeepFeatureLifecycleConfig:
    """Config serialization and validation."""

    def test_roundtrip(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=3,
            candidate_step_size=0.02,
            candidate_weight_step_size=0.01,
            candidate_perturbation_std=0.001,
            candidate_normalized_updates=True,
            candidate_update_epsilon=0.01,
            promotion_interval=7,
            min_unit_age=5,
            candidate_min_age=4,
            promotion_ratio=1.2,
            promotion_layer_mode="final",
            promotion_utility_mode="mean_normalized",
            replacement_warmup_steps=11,
            replacement_utility_quantile=0.5,
            layer_promotion_budget=1,
            early_promotion_outgoing_mode="preserve",
            candidate_init="orthogonalized",
            active_candidate_perturbation_std=0.02,
            function_preserving_promotion=True,
            promotion_output_change_threshold=0.5,
            candidate_perturbation_utility_scaled=True,
            active_perturbation_std=0.001,
            active_perturbation_beta=1.5,
            active_perturbation_warmup_steps=13,
            active_perturbation_ramp_steps=17,
            active_perturbation_interval=3,
            soft_gated_candidates=True,
            candidate_gate_init=0.01,
            candidate_gate_step_size=0.02,
            candidate_gate_l1=0.001,
            candidate_gate_max_abs=0.1,
            soft_gate_layer_mode="all",
            refresh_on_failed_promotion=False,
        )
        restored = DeepFeatureLifecycleConfig.from_config(config.to_config())
        assert restored == config

    def test_learner_roundtrip(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(8, 4),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=2
            ),
            step_size=0.03,
            bounder=ObGDBounding(kappa=2.0),
            sparsity=0.5,
            use_layer_norm=True,
        )
        restored = DeepFeatureGeneratingMultiHeadMLPLearner.from_config(
            learner.to_config()
        )
        assert restored.to_config() == learner.to_config()


class TestDeepFeatureLifecycleState:
    """Candidate banks should match deep MLP layer inputs."""

    def test_init_shapes_for_two_hidden_layers(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(6, 5),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=4
            ),
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=7, key=jr.key(0))
        assert isinstance(state, DeepFeatureLifecycleState)
        assert len(state.candidate_weights) == 2
        chex.assert_shape(state.candidate_weights[0], (4, 7))
        chex.assert_shape(state.candidate_weights[1], (4, 6))
        chex.assert_shape(state.candidate_output_weights[0], (3, 4))
        chex.assert_shape(state.candidate_output_weights[1], (3, 4))
        chex.assert_shape(state.candidate_gates[0], (4,))
        chex.assert_shape(state.candidate_gates[1], (4,))
        chex.assert_shape(state.candidate_target_units[0], (4,))
        chex.assert_shape(state.candidate_target_units[1], (4,))
        chex.assert_shape(state.unit_ages[0], (6,))
        chex.assert_shape(state.unit_ages[1], (5,))

    def test_soft_gate_initialization_uses_configured_value(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(5,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=3,
                soft_gated_candidates=True,
                candidate_gate_init=0.02,
            ),
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=4, key=jr.key(19))

        chex.assert_trees_all_close(
            state.candidate_gates[0],
            jnp.full((3,), 0.02, dtype=jnp.float32),
        )
        chex.assert_trees_all_close(
            state.candidate_target_units[0],
            jnp.array([0, 1, 2], dtype=jnp.int32),
        )

    def test_update_trains_candidate_readouts_and_ages(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(5,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=3,
                candidate_step_size=0.1,
                promotion_interval=1000,
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=4, key=jr.key(1))
        obs = jnp.array([0.3, -0.4, 0.5, 1.0], dtype=jnp.float32)
        targets = jnp.array([1.0, -0.5], dtype=jnp.float32)

        result = learner.update(state, obs, targets)

        assert int(result.state.candidate_ages[0][0]) == 1
        assert int(result.state.unit_ages[0][0]) == 1
        assert jnp.any(result.state.candidate_output_weights[0] != 0.0)
        chex.assert_shape(result.lifecycle_metrics, (4,))
        chex.assert_shape(result.promotions_made, (1,))

    def test_residual_gradient_imprinting_updates_candidate_inputs(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(5,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=3,
                candidate_step_size=0.1,
                candidate_weight_step_size=0.1,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=4, key=jr.key(11))
        state = state.replace(  # type: ignore[attr-defined]
            candidate_output_weights=(
                jnp.ones_like(state.candidate_output_weights[0]),
            )
        )
        old_weights = state.candidate_weights[0]

        result = learner.update(
            state,
            jnp.array([0.3, -0.4, 0.5, 1.0], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        assert jnp.any(result.state.candidate_weights[0] != old_weights)
        chex.assert_tree_all_finite(result.state.candidate_weights[0])

    def test_normalized_candidate_readout_scales_large_activation_step(self) -> None:
        obs = jnp.array([0.3, -0.4, 0.5, 1.0], dtype=jnp.float32)
        target = jnp.array([1.0], dtype=jnp.float32)
        raw = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(5,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=1,
                candidate_step_size=1.0,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        normalized = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(5,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=1,
                candidate_step_size=1.0,
                candidate_normalized_updates=True,
                candidate_update_epsilon=1e-3,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        raw_state = raw.init(feature_dim=4, key=jr.key(26))
        norm_state = normalized.init(feature_dim=4, key=jr.key(26))
        raw_state = raw_state.replace(  # type: ignore[attr-defined]
            candidate_weights=(jnp.zeros_like(raw_state.candidate_weights[0]),),
            candidate_biases=(jnp.array([10.0], dtype=jnp.float32),),
        )
        norm_state = norm_state.replace(  # type: ignore[attr-defined]
            candidate_weights=(jnp.zeros_like(norm_state.candidate_weights[0]),),
            candidate_biases=(jnp.array([10.0], dtype=jnp.float32),),
        )

        raw_result = raw.update(raw_state, obs, target)
        norm_result = normalized.update(norm_state, obs, target)

        raw_step = raw_result.state.candidate_output_weights[0][0, 0]
        norm_step = norm_result.state.candidate_output_weights[0][0, 0]
        assert norm_step < raw_step
        chex.assert_trees_all_close(norm_step, raw_step / 100.001, rtol=1e-5)

    def test_soft_gate_update_changes_gate_without_shape_change(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=2,
                soft_gated_candidates=True,
                candidate_gate_init=0.0,
                candidate_gate_step_size=0.5,
                candidate_weight_step_size=0.1,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(20))
        state = state.replace(  # type: ignore[attr-defined]
            mlp_state=state.mlp_state.replace(  # type: ignore[attr-defined]
                head_params=state.mlp_state.head_params.replace(  # type: ignore[attr-defined]
                    weights=(jnp.ones_like(state.mlp_state.head_params.weights[0]),)
                )
            )
        )
        old_gates = state.candidate_gates[0]

        result = learner.update(
            state,
            jnp.array([0.4, -0.2, 0.7], dtype=jnp.float32),
            jnp.array([1.0], dtype=jnp.float32),
        )

        assert jnp.any(result.state.candidate_gates[0] != old_gates)
        chex.assert_shape(result.state.candidate_gates[0], (2,))
        chex.assert_shape(result.state.mlp_state.trunk_params.weights[0], (4, 3))
        chex.assert_tree_all_finite(result.state.candidate_gates[0])

    def test_orthogonalized_candidate_init_preserves_shapes(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(2,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=3,
                candidate_init="orthogonalized",
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=8, key=jr.key(12))

        chex.assert_shape(state.candidate_weights[0], (3, 8))
        overlaps = state.candidate_weights[0] @ state.mlp_state.trunk_params.weights[0].T
        chex.assert_trees_all_close(overlaps, jnp.zeros_like(overlaps), atol=1e-5)

    def test_active_perturbation_candidate_init_copies_target_units(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=6,
                candidate_init="active_perturbation",
                active_candidate_perturbation_std=0.0,
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(22))

        chex.assert_trees_all_close(
            state.candidate_weights[0],
            state.mlp_state.trunk_params.weights[0][state.candidate_target_units[0]],
        )


class TestDeepFeaturePromotion:
    """Promotion should replace an active hidden unit with a tested candidate."""

    def test_final_layer_promotion_uses_candidate_weights_and_shadow_readout(
        self,
    ) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=2,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(2))

        candidate_row = jnp.array([0.7, -0.2, 0.4], dtype=jnp.float32)
        candidate_out = jnp.array([1.5, -0.75], dtype=jnp.float32)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([5.0, 0.01, 5.0, 5.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(
                state.candidate_weights[0].at[0].set(candidate_row),
            ),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(candidate_out),
            ),
            candidate_utilities=(jnp.array([10.0, 0.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10, 10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0, 0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 1
        promoted_row = result.state.mlp_state.trunk_params.weights[0][1]
        chex.assert_trees_all_close(promoted_row, candidate_row)
        assert int(result.state.unit_ages[0][1]) == 0
        chex.assert_trees_all_close(
            result.state.mlp_state.head_params.weights[0][0, 1],
            candidate_out[0],
        )
        chex.assert_trees_all_close(
            result.state.mlp_state.head_params.weights[1][0, 1],
            candidate_out[1],
        )

    def test_soft_gated_candidate_hardens_into_live_target_unit(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            soft_gated_candidates=True,
            candidate_gate_init=0.05,
            candidate_gate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            promotion_layer_mode="final",
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(21))
        candidate_row = jnp.array([0.7, -0.2, 0.4], dtype=jnp.float32)
        old_head_weight = state.mlp_state.head_params.weights[0][0, 2]
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([5.0, 5.0, 0.01, 5.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),),
            candidate_target_units=(jnp.array([2], dtype=jnp.int32),),
            candidate_utilities=(jnp.array([10.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 1
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][2],
            candidate_row,
        )
        chex.assert_trees_all_close(
            result.state.mlp_state.head_params.weights[0][0, 2],
            old_head_weight,
        )
        assert int(result.state.unit_ages[0][2]) == 0

    def test_replacement_quantile_protects_high_utility_units(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            replacement_utility_quantile=0.25,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(13))
        candidate_row = jnp.array([0.2, 0.3, -0.4], dtype=jnp.float32)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([0.1, 100.0, 0.2, 0.3], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(jnp.array([1.0])),
            ),
            candidate_utilities=(jnp.array([200.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            candidate_row,
        )
        assert int(result.state.unit_ages[0][0]) == 0
        assert int(result.state.unit_ages[0][1]) > 0

    def test_final_layer_mode_only_promotes_final_hidden_layer(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            promotion_layer_mode="final",
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4, 3),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(14))
        first_row = jnp.array([0.2, -0.3, 0.4], dtype=jnp.float32)
        final_row = jnp.array([0.5, -0.6, 0.7, -0.8], dtype=jnp.float32)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(
                jnp.array([0.1, 10.0, 10.0, 10.0], dtype=jnp.float32),
                jnp.array([0.1, 10.0, 10.0], dtype=jnp.float32),
            ),
            unit_ages=(
                jnp.array([10, 10, 10, 10], dtype=jnp.int32),
                jnp.array([10, 10, 10], dtype=jnp.int32),
            ),
            candidate_weights=(
                state.candidate_weights[0].at[0].set(first_row),
                state.candidate_weights[1].at[0].set(final_row),
            ),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(jnp.array([1.0])),
                state.candidate_output_weights[1].at[:, 0].set(jnp.array([1.0])),
            ),
            candidate_utilities=(
                jnp.array([100.0], dtype=jnp.float32),
                jnp.array([100.0], dtype=jnp.float32),
            ),
            candidate_ages=(
                jnp.array([10], dtype=jnp.int32),
                jnp.array([10], dtype=jnp.int32),
            ),
        )
        original_first = state.mlp_state.trunk_params.weights[0][0]

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        chex.assert_trees_all_close(result.promotions_made, jnp.array([0, 1]))
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            original_first,
        )
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[1][0],
            final_row,
        )

    def test_replacement_warmup_blocks_scheduled_promotion(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            replacement_warmup_steps=5,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(15))
        candidate_row = jnp.array([0.2, 0.3, -0.4], dtype=jnp.float32)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([0.1, 10.0, 10.0, 10.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(jnp.array([1.0])),
            ),
            candidate_utilities=(jnp.array([100.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10], dtype=jnp.int32),),
        )
        original_row = state.mlp_state.trunk_params.weights[0][0]

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 0
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            original_row,
        )

    def test_preserve_outgoing_keeps_downstream_column_on_early_promotion(
        self,
    ) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            promotion_layer_mode="first",
            early_promotion_outgoing_mode="preserve",
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4, 3),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(17))
        candidate_row = jnp.array([0.2, -0.3, 0.4], dtype=jnp.float32)
        original_outgoing = state.mlp_state.trunk_params.weights[1][:, 0]
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(
                jnp.array([0.1, 10.0, 10.0, 10.0], dtype=jnp.float32),
                jnp.array([10.0, 10.0, 10.0], dtype=jnp.float32),
            ),
            unit_ages=(
                jnp.array([10, 10, 10, 10], dtype=jnp.int32),
                jnp.array([10, 10, 10], dtype=jnp.int32),
            ),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),)
            + (state.candidate_weights[1],),
            candidate_utilities=(
                jnp.array([100.0], dtype=jnp.float32),
                jnp.array([0.0], dtype=jnp.float32),
            ),
            candidate_ages=(
                jnp.array([10], dtype=jnp.int32),
                jnp.array([10], dtype=jnp.int32),
            ),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 1
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            candidate_row,
        )
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[1][:, 0],
            original_outgoing,
        )
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_traces[2][:, 0],
            jnp.zeros_like(result.state.mlp_state.trunk_traces[2][:, 0]),
        )

    def test_function_preserving_final_promotion_keeps_current_prediction(
        self,
    ) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            function_preserving_promotion=True,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        obs = jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32)
        state = learner.init(feature_dim=3, key=jr.key(23))
        candidate_row = jnp.array([2.0, -1.5, 0.75], dtype=jnp.float32)
        old_head_weights = state.mlp_state.head_params.weights
        before = learner.predict(state, obs)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([0.01, 5.0, 5.0, 5.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(
                    jnp.array([100.0, -100.0], dtype=jnp.float32)
                ),
            ),
            candidate_utilities=(jnp.array([10.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            obs,
            jnp.array([0.0, 0.0], dtype=jnp.float32),
        )
        after = learner.predict(result.state, obs)

        assert int(result.promotions_made[0]) == 1
        chex.assert_trees_all_close(after, before, atol=1e-5)
        chex.assert_trees_all_close(
            result.state.mlp_state.head_params.weights,
            old_head_weights,
        )

    def test_function_preserving_early_promotion_compensates_next_bias(
        self,
    ) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            promotion_layer_mode="first",
            function_preserving_promotion=True,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4, 3),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        obs = jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32)
        state = learner.init(feature_dim=3, key=jr.key(24))
        candidate_row = jnp.array([2.0, -1.5, 0.75], dtype=jnp.float32)
        before = learner.predict(state, obs)
        old_next_col = state.mlp_state.trunk_params.weights[1][:, 0]
        old_next_bias = state.mlp_state.trunk_params.biases[1]
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(
                jnp.array([0.01, 5.0, 5.0, 5.0], dtype=jnp.float32),
                jnp.array([5.0, 5.0, 5.0], dtype=jnp.float32),
            ),
            unit_ages=(
                jnp.array([10, 10, 10, 10], dtype=jnp.int32),
                jnp.array([10, 10, 10], dtype=jnp.int32),
            ),
            candidate_weights=(state.candidate_weights[0].at[0].set(candidate_row),)
            + (state.candidate_weights[1],),
            candidate_utilities=(
                jnp.array([10.0], dtype=jnp.float32),
                jnp.array([0.0], dtype=jnp.float32),
            ),
            candidate_ages=(
                jnp.array([10], dtype=jnp.int32),
                jnp.array([10], dtype=jnp.int32),
            ),
        )

        result = learner.update(state, obs, jnp.array([0.0], dtype=jnp.float32))
        after = learner.predict(result.state, obs)

        assert int(result.promotions_made[0]) == 1
        chex.assert_trees_all_close(after, before, atol=1e-5)
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[1][:, 0],
            old_next_col,
        )
        assert jnp.any(result.state.mlp_state.trunk_params.biases[1] != old_next_bias)

    def test_output_change_threshold_blocks_disruptive_promotion(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=1,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=0.0,
            function_preserving_promotion=True,
            promotion_output_change_threshold=1e-8,
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(25))
        original_row = state.mlp_state.trunk_params.weights[0][0]
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(jnp.array([0.01, 5.0, 5.0, 5.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(
                state.candidate_weights[0].at[0].set(
                    jnp.array([10.0, -10.0, 5.0], dtype=jnp.float32)
                ),
            ),
            candidate_utilities=(jnp.array([10.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 0
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            original_row,
        )

    def test_mean_normalized_utility_can_promote_below_raw_active_utility(self) -> None:
        config = DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
            candidate_count=2,
            candidate_step_size=0.0,
            candidate_utility_decay=0.999,
            active_utility_decay=0.999,
            promotion_interval=1,
            min_unit_age=0,
            candidate_min_age=0,
            promotion_ratio=1.0,
            promotion_utility_mode="mean_normalized",
            refresh_on_failed_promotion=False,
        )
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=config,
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(16))
        candidate_row = jnp.array([0.2, 0.3, -0.4], dtype=jnp.float32)
        state = state.replace(  # type: ignore[attr-defined]
            active_utilities=(
                jnp.array([10.0, 1000.0, 1000.0, 1000.0], dtype=jnp.float32),
            ),
            unit_ages=(jnp.array([10, 10, 10, 10], dtype=jnp.int32),),
            candidate_weights=(
                state.candidate_weights[0].at[0].set(candidate_row),
            ),
            candidate_output_weights=(
                state.candidate_output_weights[0].at[:, 0].set(jnp.array([1.0])),
            ),
            candidate_utilities=(jnp.array([2.0, 0.0], dtype=jnp.float32),),
            candidate_ages=(jnp.array([10, 10], dtype=jnp.int32),),
        )

        result = learner.update(
            state,
            jnp.array([0.1, 0.2, -0.3], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        assert int(result.promotions_made[0]) == 1
        chex.assert_trees_all_close(
            result.state.mlp_state.trunk_params.weights[0][0],
            candidate_row,
        )

    def test_scan_loop_returns_metrics(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=2,
                promotion_interval=5,
                min_unit_age=2,
                candidate_min_age=2,
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(3))
        observations = jnp.ones((8, 3), dtype=jnp.float32)
        targets = jnp.ones((8, 1), dtype=jnp.float32)

        result = run_deep_feature_lifecycle_arrays(
            learner,
            state,
            observations,
            targets,
        )

        chex.assert_shape(result.per_head_metrics, (8, 1, 3))
        chex.assert_shape(result.lifecycle_metrics, (8, 4))
        chex.assert_shape(result.promotions_made, (8, 1))
        chex.assert_tree_all_finite(result.lifecycle_metrics)

    def test_scan_loop_predictions_remain_finite_without_shape_drift(self) -> None:
        learner = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(5, 4),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=2,
                candidate_weight_step_size=0.01,
                candidate_perturbation_std=1e-4,
                promotion_interval=2,
                min_unit_age=0,
                candidate_min_age=0,
                promotion_ratio=0.0,
                layer_promotion_budget=1,
            ),
            step_size=0.01,
            sparsity=0.0,
            use_layer_norm=True,
        )
        state = learner.init(feature_dim=3, key=jr.key(4))
        observations = jnp.ones((6, 3), dtype=jnp.float32)
        targets = jnp.ones((6, 2), dtype=jnp.float32)

        result = run_deep_feature_lifecycle_arrays(
            learner,
            state,
            observations,
            targets,
        )
        prediction = learner.predict(result.state, observations[-1])

        chex.assert_shape(result.state.mlp_state.trunk_params.weights[0], (5, 3))
        chex.assert_shape(result.state.mlp_state.trunk_params.weights[1], (4, 5))
        chex.assert_shape(result.state.candidate_weights[0], (2, 3))
        chex.assert_shape(result.state.candidate_weights[1], (2, 5))
        chex.assert_shape(prediction, (2,))
        chex.assert_tree_all_finite(prediction)

    def test_active_perturbation_changes_trunk_only_after_warmup(self) -> None:
        obs = jnp.array([0.3, -0.4, 0.5], dtype=jnp.float32)
        target = jnp.array([1.0], dtype=jnp.float32)
        blocked = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=1,
                active_perturbation_std=1e-2,
                active_perturbation_warmup_steps=10,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        blocked_state = blocked.init(feature_dim=3, key=jr.key(18))
        blocked_result = blocked.update(blocked_state, obs, target)
        chex.assert_trees_all_close(
            blocked_result.state.mlp_state.trunk_params.weights[0],
            blocked_state.mlp_state.trunk_params.weights[0],
        )

        active = DeepFeatureGeneratingMultiHeadMLPLearner(
            n_heads=1,
            hidden_sizes=(4,),
            lifecycle_config=DeepFeatureLifecycleConfig(  # type: ignore[call-arg]
                candidate_count=1,
                active_perturbation_std=1e-2,
                active_perturbation_warmup_steps=0,
                promotion_interval=1000,
            ),
            step_size=0.0,
            sparsity=0.0,
            use_layer_norm=False,
        )
        active_state = active.init(feature_dim=3, key=jr.key(18))
        active_result = active.update(active_state, obs, target)

        assert jnp.any(
            active_result.state.mlp_state.trunk_params.weights[0]
            != active_state.mlp_state.trunk_params.weights[0]
        )
        chex.assert_tree_all_finite(active_result.state.mlp_state.trunk_params.weights[0])
