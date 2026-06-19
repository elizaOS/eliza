"""Tests for the UPGD (Utility-based Perturbed Gradient Descent) learner."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework.core.optimizers import ObGDBounding
from alberta_framework.core.upgd import (
    UPGDLearner,
    UPGDLearningResult,
    run_upgd_arrays,
    run_upgd_loop,
)

# =============================================================================
# Init / shapes
# =============================================================================


class TestInitShapes:
    """Verify initial state has correct shapes."""

    def test_trunk_shapes(self):
        learner = UPGDLearner(
            n_heads=3, hidden_sizes=(32, 16), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=10, key=jr.key(0))

        assert len(state.trunk_params.weights) == 2
        chex.assert_shape(state.trunk_params.weights[0], (32, 10))
        chex.assert_shape(state.trunk_params.weights[1], (16, 32))
        chex.assert_shape(state.trunk_params.biases[0], (32,))
        chex.assert_shape(state.trunk_params.biases[1], (16,))

    def test_head_shapes(self):
        learner = UPGDLearner(
            n_heads=4, hidden_sizes=(16,), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=8, key=jr.key(0))
        assert len(state.head_params.weights) == 4
        assert len(state.readout_fast_head_params.weights) == 4
        for i in range(4):
            chex.assert_shape(state.head_params.weights[i], (1, 16))
            chex.assert_shape(state.head_params.biases[i], (1,))
            chex.assert_shape(state.readout_fast_head_params.weights[i], (1, 16))
            chex.assert_shape(state.readout_fast_head_params.biases[i], (1,))

    def test_hidden_plus_input_head_shapes(self):
        learner = UPGDLearner(
            n_heads=4,
            hidden_sizes=(16,),
            sparsity=0.0,
            perturbation_sigma=0.0,
            readout_input_mode="hidden_plus_input",
        )
        state = learner.init(feature_dim=8, key=jr.key(0))
        for i in range(4):
            chex.assert_shape(state.head_params.weights[i], (1, 24))
            chex.assert_shape(state.readout_fast_head_params.weights[i], (1, 24))

    def test_utility_shapes_match_weights(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(32, 16), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=10, key=jr.key(0))
        assert len(state.utilities) == 2
        chex.assert_shape(state.utilities[0], (32, 10))
        chex.assert_shape(state.utilities[1], (16, 32))

    def test_unit_utility_shapes_match_hidden_units(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(32, 16), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=10, key=jr.key(0))
        assert len(state.unit_utilities) == 2
        assert len(state.unit_long_utilities) == 2
        assert len(state.unit_gradient_emas) == 2
        assert len(state.unit_ages) == 2
        chex.assert_shape(state.unit_utilities[0], (32,))
        chex.assert_shape(state.unit_utilities[1], (16,))
        chex.assert_shape(state.unit_long_utilities[0], (32,))
        chex.assert_shape(state.unit_gradient_emas[0], (32,))
        chex.assert_shape(state.unit_ages[0], (32,))
        chex.assert_shape(state.unit_replacement_counts, (2,))
        chex.assert_shape(state.unit_replacement_accumulators, (2,))

    def test_utilities_initialized_to_zero(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        for u in state.utilities:
            chex.assert_trees_all_close(u, jnp.zeros_like(u))
        for u in state.unit_utilities:
            chex.assert_trees_all_close(u, jnp.zeros_like(u))
        for u in state.unit_long_utilities:
            chex.assert_trees_all_close(u, jnp.zeros_like(u))
        for u in state.unit_gradient_emas:
            chex.assert_trees_all_close(u, jnp.zeros_like(u))
        for age in state.unit_ages:
            chex.assert_trees_all_close(age, jnp.zeros_like(age))

    def test_step_count_is_zero(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        assert int(state.step_count) == 0

    def test_linear_baseline_no_utilities(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        assert len(state.utilities) == 0
        assert len(state.unit_utilities) == 0
        assert len(state.unit_long_utilities) == 0
        assert len(state.unit_gradient_emas) == 0
        assert len(state.unit_ages) == 0

    def test_step2_default_uses_target_structure_candidate(self):
        learner = UPGDLearner.step2_default(n_heads=3)
        cfg = learner.to_config()

        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["hidden_sizes"] == [32]
        assert cfg["perturbation_sigma"] == 1e-4
        assert cfg["perturbation_interval"] == 16
        assert cfg["perturbation_noise"] == "rademacher"
        assert cfg["bounder"] == {"type": "ObGDBounding", "kappa": 0.5}
        assert cfg["adaptive_kappa_mode"] == "none"
        assert cfg["meta_plasticity_mode"] == "none"
        assert cfg["track_unit_utilities"] is False
        assert cfg["track_gradient_history"] is False

    def test_step2_strict_digit_readout_default_uses_promoted_branch(self):
        learner = UPGDLearner.step2_strict_digit_readout_default(n_heads=10)
        cfg = learner.to_config()

        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["hidden_sizes"] == [64, 64]
        assert cfg["step_size"] == 0.018
        assert cfg["bounder"] == {"type": "ObGDBounding", "kappa": 0.5}
        assert cfg["perturbation_sigma"] == 1e-4
        assert cfg["perturbation_interval"] == 1
        assert cfg["head_repetition_multiplier"] == 0.75
        assert cfg["adaptive_kappa_mode"] == "loss_ratio"
        assert cfg["adaptive_kappa_min"] == 0.35
        assert cfg["adaptive_kappa_max"] == 0.65
        assert cfg["meta_plasticity_mode"] == "gradient_alignment"
        assert cfg["meta_plasticity_trunk_enabled"] is False
        assert cfg["readout_mode"] == "two_timescale_simplex"
        assert cfg["readout_fast_head_step_size_multiplier"] == 2.0
        assert cfg["readout_fast_trunk_gradient_multiplier"] == 2.0
        assert cfg["readout_fast_head_bounder_mode"] == "separate"
        assert cfg["readout_slow_simplex_gradient_multiplier"] == 0.0

    def test_step2_default_supports_softmax_ce_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="softmax_ce",
            step_size=0.02,
        )
        cfg = learner.to_config()

        assert cfg["hidden_sizes"] == [16]
        assert cfg["step_size"] == 0.02
        assert cfg["readout_mode"] == "softmax_ce"
        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["perturbation_noise"] == "rademacher"
        assert cfg["perturbation_interval"] == 16

    def test_step2_default_supports_softmax_mse_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="softmax_mse",
            step_size=0.02,
        )
        cfg = learner.to_config()
        state = learner.init(feature_dim=3, key=jr.key(0))
        observation = jnp.asarray([1.0, 0.0, -1.0], dtype=jnp.float32)
        target = jnp.eye(5, dtype=jnp.float32)[2]
        result = learner.update(state, observation, target)

        assert cfg["hidden_sizes"] == [16]
        assert cfg["step_size"] == 0.02
        assert cfg["readout_mode"] == "softmax_mse"
        assert cfg["readout_loss_mode"] == "softmax_mse"
        assert cfg["readout_prediction_mode"] == "softmax"
        chex.assert_shape(result.predictions, (5,))
        chex.assert_trees_all_close(jnp.sum(result.predictions), 1.0, atol=1e-5)
        chex.assert_tree_all_finite(result.metrics)

    def test_step2_default_supports_adaptive_simplex_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="adaptive_simplex",
            step_size=0.02,
        )
        cfg = learner.to_config()

        assert cfg["hidden_sizes"] == [16]
        assert cfg["step_size"] == 0.02
        assert cfg["readout_mode"] == "adaptive_simplex"
        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["perturbation_noise"] == "rademacher"
        assert cfg["perturbation_interval"] == 16

    def test_step2_default_supports_factorized_simplex_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="factorized_simplex",
            step_size=0.02,
            readout_label_adapter_step_size=0.3,
            readout_label_adapter_identity_regularization=0.002,
            readout_label_adapter_floor=1e-5,
        )
        cfg = learner.to_config()

        assert cfg["hidden_sizes"] == [16]
        assert cfg["step_size"] == 0.02
        assert cfg["readout_mode"] == "factorized_simplex"
        assert cfg["readout_loss_mode"] == "softmax_ce"
        assert cfg["readout_prediction_mode"] == "factorized_simplex"
        assert cfg["readout_label_adapter_step_size"] == 0.3
        assert cfg["readout_label_adapter_identity_regularization"] == 0.002
        assert cfg["readout_label_adapter_floor"] == 1e-5
        assert cfg["loss_normalization"] == "target_structure"
        assert cfg["perturbation_noise"] == "rademacher"
        assert cfg["perturbation_interval"] == 16

    def test_step2_default_supports_adaptive_factorized_simplex_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="adaptive_factorized_simplex",
            step_size=0.02,
            readout_label_adapter_step_size=0.3,
        )
        cfg = learner.to_config()

        assert cfg["readout_mode"] == "adaptive_factorized_simplex"
        assert cfg["readout_loss_mode"] == "adaptive_factorized_simplex"
        assert cfg["readout_prediction_mode"] == "adaptive_factorized_simplex"
        assert cfg["readout_label_adapter_step_size"] == 0.3

    def test_step2_default_supports_two_timescale_simplex_branch(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="two_timescale_simplex",
            step_size=0.02,
            readout_fast_head_step_size_multiplier=1.5,
            readout_fast_head_bias_step_size_multiplier=0.5,
            readout_fast_trunk_gradient_multiplier=0.25,
            readout_fast_head_bounder_mode="separate",
            readout_slow_simplex_gradient_multiplier=0.5,
        )
        cfg = learner.to_config()

        assert cfg["readout_mode"] == "two_timescale_simplex"
        assert cfg["readout_loss_mode"] == "two_timescale_simplex"
        assert cfg["readout_prediction_mode"] == "two_timescale_simplex"
        assert cfg["readout_fast_head_step_size_multiplier"] == 1.5
        assert cfg["readout_fast_head_bias_step_size_multiplier"] == 0.5
        assert cfg["readout_fast_trunk_gradient_multiplier"] == 0.25
        assert cfg["readout_fast_head_bounder_mode"] == "separate"
        assert cfg["readout_slow_simplex_gradient_multiplier"] == 0.5

    def test_step2_default_supports_decoupled_readout_modes(self):
        learner = UPGDLearner.step2_default(
            n_heads=5,
            hidden_sizes=(16,),
            readout_mode="linear_mse",
            readout_loss_mode="softmax_ce",
            readout_prediction_mode="identity",
            readout_robust_q=0.5,
        )
        cfg = learner.to_config()

        assert cfg["readout_mode"] == "linear_mse"
        assert cfg["readout_loss_mode"] == "softmax_ce"
        assert cfg["readout_prediction_mode"] == "identity"
        assert cfg["readout_robust_q"] == 0.5

    def test_step2_default_uses_lean_state_buffers(self):
        learner = UPGDLearner.step2_default(n_heads=3)
        state = learner.init(feature_dim=5, key=jr.key(0))

        assert len(state.unit_utilities) == 0
        assert len(state.unit_long_utilities) == 0
        assert len(state.unit_gradient_emas) == 0
        assert len(state.unit_ages) == 0
        assert state.unit_replacement_accumulators.shape == (0,)
        assert len(state.previous_trunk_weight_grads) == 0
        assert len(state.previous_trunk_bias_grads) == 0
        assert len(state.previous_head_weight_grads) == 0
        assert len(state.previous_head_bias_grads) == 0

        result = learner.update(state, jnp.ones(5), jnp.array([1.0, 0.0, 0.0]))
        assert len(result.state.unit_utilities) == 0
        assert len(result.state.previous_trunk_weight_grads) == 0
        chex.assert_tree_all_finite(result.metrics)


class TestValidation:
    """Invalid deployment configurations should fail before JIT compilation."""

    def test_rejects_invalid_core_dimensions(self):
        invalid_kwargs = [
            {"n_heads": 0},
            {"n_heads": 1, "hidden_sizes": (0,)},
            {"n_heads": 1, "step_size": -0.01},
            {"n_heads": 1, "perturbation_sigma": -1e-4},
            {"n_heads": 1, "perturbation_beta": -1.0},
            {"n_heads": 1, "sparsity": 1.1},
            {"n_heads": 1, "leaky_relu_slope": -0.01},
            {"n_heads": 1, "readout_simplex_bias_decay": -0.1},
            {"n_heads": 1, "readout_simplex_bias_decay": 1.1},
            {"n_heads": 1, "readout_simplex_bias_centering_rate": -0.1},
            {"n_heads": 1, "readout_simplex_bias_centering_rate": 1.1},
            {"n_heads": 1, "readout_loss_mode": "bad"},
            {"n_heads": 1, "readout_prediction_mode": "bad"},
            {"n_heads": 1, "readout_robust_q": 0.0},
            {"n_heads": 1, "readout_robust_q": 1.1},
            {"n_heads": 1, "readout_adaptive_gate_start": -0.1},
            {"n_heads": 1, "readout_adaptive_gate_start": 1.1},
            {"n_heads": 1, "readout_adaptive_gate_width": 0.0},
            {"n_heads": 1, "readout_label_adapter_step_size": -0.1},
            {
                "n_heads": 1,
                "readout_label_adapter_identity_regularization": -0.1,
            },
            {
                "n_heads": 1,
                "readout_label_adapter_entropy_regularization": -0.1,
            },
            {"n_heads": 1, "readout_label_adapter_floor": -1e-6},
            {"n_heads": 1, "readout_label_adapter_floor": 1.0},
            {"n_heads": 1, "readout_fast_head_step_size_multiplier": -0.1},
            {"n_heads": 1, "readout_fast_head_bias_step_size_multiplier": -0.1},
            {"n_heads": 1, "readout_fast_trunk_gradient_multiplier": -0.1},
            {"n_heads": 1, "readout_fast_head_bounder_mode": "bad"},
            {"n_heads": 1, "readout_slow_simplex_gradient_multiplier": -0.1},
        ]

        for kwargs in invalid_kwargs:
            try:
                UPGDLearner(**kwargs)
            except ValueError:
                pass
            else:
                raise AssertionError(f"expected ValueError for {kwargs}")

    def test_rejects_invalid_feature_dim(self):
        learner = UPGDLearner.step2_default(n_heads=2)
        try:
            learner.init(feature_dim=0, key=jr.key(0))
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError for feature_dim=0")


# =============================================================================
# Predict
# =============================================================================


class TestPredictShapes:
    """Predictions should have shape (n_heads,) for any input."""

    def test_returns_n_heads(self):
        learner = UPGDLearner(
            n_heads=5, hidden_sizes=(16,), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=7, key=jr.key(0))
        preds = learner.predict(state, jnp.ones(7))
        chex.assert_shape(preds, (5,))
        chex.assert_tree_all_finite(preds)

    def test_returns_n_heads_zero_input(self):
        learner = UPGDLearner(
            n_heads=3, hidden_sizes=(8, 4), sparsity=0.0, perturbation_sigma=0.0
        )
        state = learner.init(feature_dim=4, key=jr.key(0))
        preds = learner.predict(state, jnp.zeros(4))
        chex.assert_shape(preds, (3,))

    def test_softmax_readout_returns_probabilities(self):
        learner = UPGDLearner(
            n_heads=4,
            hidden_sizes=(8,),
            sparsity=0.0,
            perturbation_sigma=0.0,
            readout_mode="softmax_ce",
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        preds = learner.predict(state, jnp.ones(5))
        chex.assert_shape(preds, (4,))
        chex.assert_tree_all_finite(preds)
        chex.assert_trees_all_close(jnp.sum(preds), jnp.array(1.0), atol=1e-6)
        assert float(jnp.min(preds)) >= 0.0

    def test_softmax_prediction_mode_decouples_from_linear_loss(self):
        learner = UPGDLearner(
            n_heads=4,
            hidden_sizes=(8,),
            sparsity=0.0,
            perturbation_sigma=0.0,
            readout_mode="linear_mse",
            readout_loss_mode="linear_mse",
            readout_prediction_mode="softmax",
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        preds = learner.predict(state, jnp.ones(5))
        chex.assert_shape(preds, (4,))
        chex.assert_trees_all_close(jnp.sum(preds), jnp.array(1.0), atol=1e-6)
        assert float(jnp.min(preds)) >= 0.0

    def test_identity_prediction_mode_decouples_from_ce_loss(self):
        kwargs = {
            "n_heads": 4,
            "hidden_sizes": (8,),
            "sparsity": 0.0,
            "perturbation_sigma": 0.0,
        }
        decoupled = UPGDLearner(
            **kwargs,
            readout_mode="softmax_ce",
            readout_loss_mode="softmax_ce",
            readout_prediction_mode="identity",
        )
        linear = UPGDLearner(**kwargs, readout_mode="linear_mse")
        key = jr.key(19)
        decoupled_state = decoupled.init(feature_dim=5, key=key)
        linear_state = linear.init(feature_dim=5, key=key)
        obs = jnp.linspace(-1.0, 1.0, 5)

        chex.assert_trees_all_close(
            decoupled.predict(decoupled_state, obs),
            linear.predict(linear_state, obs),
            atol=1e-6,
        )

    def test_unit_clip_prediction_mode_bounds_logits(self):
        learner = UPGDLearner(
            n_heads=4,
            hidden_sizes=(8,),
            sparsity=0.0,
            perturbation_sigma=0.0,
            readout_mode="softmax_ce",
            readout_loss_mode="softmax_ce",
            readout_prediction_mode="unit_clip",
        )
        state = learner.init(feature_dim=5, key=jr.key(21))
        preds = learner.predict(state, jnp.ones(5))
        chex.assert_shape(preds, (4,))
        assert float(jnp.min(preds)) >= 0.0
        assert float(jnp.max(preds)) <= 1.0

    def test_adaptive_simplex_readout_interpolates_from_linear_to_softmax(self):
        kwargs = {
            "n_heads": 4,
            "hidden_sizes": (8,),
            "sparsity": 0.0,
            "perturbation_sigma": 0.0,
        }
        adaptive = UPGDLearner(**kwargs, readout_mode="adaptive_simplex")
        linear = UPGDLearner(**kwargs, readout_mode="linear_mse")
        softmax = UPGDLearner(**kwargs, readout_mode="softmax_ce")
        key = jr.key(17)
        adaptive_state = adaptive.init(feature_dim=5, key=key)
        linear_state = linear.init(feature_dim=5, key=key)
        softmax_state = softmax.init(feature_dim=5, key=key)
        obs = jnp.linspace(-1.0, 1.0, 5)

        zero_repeat_state = adaptive_state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(0.0, dtype=jnp.float32)
        )
        high_repeat_state = adaptive_state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(1.0, dtype=jnp.float32),
        )

        chex.assert_trees_all_close(
            adaptive.predict(zero_repeat_state, obs),
            linear.predict(linear_state, obs),
            atol=1e-6,
        )
        chex.assert_trees_all_close(
            adaptive.predict(high_repeat_state, obs),
            softmax.predict(softmax_state, obs),
            atol=1e-6,
        )

    def test_factorized_simplex_initializes_near_identity(self):
        learner = UPGDLearner(
            n_heads=4,
            hidden_sizes=(8,),
            sparsity=0.0,
            perturbation_sigma=0.0,
            readout_mode="factorized_simplex",
        )
        state = learner.init(feature_dim=5, key=jr.key(28))
        adapter = state.readout_label_adapter
        preds = learner.predict(state, jnp.ones(5))

        chex.assert_shape(adapter, (4, 4))
        chex.assert_trees_all_close(
            jnp.sum(adapter, axis=1),
            jnp.ones(4),
            atol=1e-6,
        )
        assert float(jnp.min(adapter)) >= 0.0
        chex.assert_trees_all_close(
            adapter,
            jnp.eye(4, dtype=jnp.float32),
            atol=1e-5,
        )
        chex.assert_shape(preds, (4,))
        chex.assert_tree_all_finite(preds)
        chex.assert_trees_all_close(jnp.sum(preds), jnp.array(1.0), atol=1e-6)
        assert float(jnp.min(preds)) >= 0.0

    def test_adaptive_factorized_interpolates_from_linear_to_factorized(self):
        kwargs = {
            "n_heads": 4,
            "hidden_sizes": (8,),
            "sparsity": 0.0,
            "perturbation_sigma": 0.0,
        }
        adaptive = UPGDLearner(
            **kwargs,
            readout_mode="adaptive_factorized_simplex",
        )
        linear = UPGDLearner(**kwargs, readout_mode="linear_mse")
        factorized = UPGDLearner(**kwargs, readout_mode="factorized_simplex")
        key = jr.key(31)
        adaptive_state = adaptive.init(feature_dim=5, key=key)
        linear_state = linear.init(feature_dim=5, key=key)
        factorized_state = factorized.init(feature_dim=5, key=key)
        obs = jnp.linspace(-1.0, 1.0, 5)

        zero_repeat_state = adaptive_state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(0.0, dtype=jnp.float32)
        )
        high_repeat_state = adaptive_state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(1.0, dtype=jnp.float32),
        )

        chex.assert_trees_all_close(
            adaptive.predict(zero_repeat_state, obs),
            linear.predict(linear_state, obs),
            atol=1e-6,
        )
        chex.assert_trees_all_close(
            adaptive.predict(high_repeat_state, obs),
            factorized.predict(factorized_state, obs),
            atol=1e-6,
        )

    def test_two_timescale_simplex_interpolates_from_linear_to_fast_softmax(self):
        kwargs = {
            "n_heads": 4,
            "hidden_sizes": (8,),
            "sparsity": 0.0,
            "perturbation_sigma": 0.0,
        }
        learner = UPGDLearner(**kwargs, readout_mode="two_timescale_simplex")
        linear = UPGDLearner(**kwargs, readout_mode="linear_mse")
        softmax = UPGDLearner(**kwargs, readout_mode="softmax_ce")
        key = jr.key(32)
        state = learner.init(feature_dim=5, key=key)
        linear_state = linear.init(feature_dim=5, key=key)
        softmax_state = softmax.init(feature_dim=5, key=key)
        state = state.replace(  # type: ignore[attr-defined]
            readout_fast_head_params=softmax_state.head_params
        )
        obs = jnp.linspace(-1.0, 1.0, 5)
        zero_repeat_state = state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(0.0, dtype=jnp.float32)
        )
        high_repeat_state = state.replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(1.0, dtype=jnp.float32),
        )

        chex.assert_trees_all_close(
            learner.predict(zero_repeat_state, obs),
            linear.predict(linear_state, obs),
            atol=1e-6,
        )
        chex.assert_trees_all_close(
            learner.predict(high_repeat_state, obs),
            softmax.predict(softmax_state, obs),
            atol=1e-6,
        )

    def test_two_timescale_predict_requires_recent_simplex_targets(self):
        kwargs = {
            "n_heads": 4,
            "hidden_sizes": (8,),
            "sparsity": 0.0,
            "perturbation_sigma": 0.0,
        }
        learner = UPGDLearner(**kwargs, readout_mode="two_timescale_simplex")
        linear = UPGDLearner(**kwargs, readout_mode="linear_mse")
        softmax = UPGDLearner(**kwargs, readout_mode="softmax_ce")
        key = jr.key(36)
        state = learner.init(feature_dim=5, key=key)
        linear_state = linear.init(feature_dim=5, key=key)
        softmax_state = softmax.init(feature_dim=5, key=key)
        state = state.replace(  # type: ignore[attr-defined]
            readout_fast_head_params=softmax_state.head_params,
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(0.0, dtype=jnp.float32),
        )
        obs = jnp.linspace(-1.0, 1.0, 5)

        chex.assert_trees_all_close(
            learner.predict(state, obs),
            linear.predict(linear_state, obs),
            atol=1e-6,
        )


# =============================================================================
# Update / metrics
# =============================================================================


class TestUpdateMetrics:
    """Validate metrics shape and finiteness."""

    def test_update_returns_finite_metrics(self):
        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(8,), sparsity=0.0,
            step_size=0.01, perturbation_sigma=1e-3,
        )
        state = learner.init(feature_dim=5, key=jr.key(0))
        for _ in range(5):
            obs = jr.normal(jr.key(1), (5,))
            targets = jnp.array([0.5, -0.3])
            result = learner.update(state, obs, targets)
            chex.assert_shape(result.metrics, (4,))
            chex.assert_tree_all_finite(result.metrics)
            chex.assert_shape(result.predictions, (2,))
            chex.assert_shape(result.errors, (2,))
            chex.assert_tree_all_finite(result.predictions)
            state = result.state

    def test_sum_loss_normalization_scales_multihead_gradient(self):
        """Sum loss should avoid diluting gradients by active head count."""
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
        )
        mean_learner = UPGDLearner(**base_kwargs, loss_normalization="mean")
        sum_learner = UPGDLearner(**base_kwargs, loss_normalization="sum")
        state = mean_learner.init(feature_dim=4, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])
        targets = jnp.array([1.0, -1.0])

        mean_result = mean_learner.update(state, obs, targets)
        sum_result = sum_learner.update(state, obs, targets)

        mean_delta = jnp.linalg.norm(
            mean_result.state.trunk_params.weights[0]
            - state.trunk_params.weights[0]
        )
        sum_delta = jnp.linalg.norm(
            sum_result.state.trunk_params.weights[0]
            - state.trunk_params.weights[0]
        )
        assert float(sum_delta) > float(mean_delta)

    def test_target_density_loss_matches_dense_mean_and_sparse_sum(self):
        """Target-density normalization should switch by target sparsity."""
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
        )
        mean_learner = UPGDLearner(**base_kwargs, loss_normalization="mean")
        sum_learner = UPGDLearner(**base_kwargs, loss_normalization="sum")
        density_learner = UPGDLearner(
            **base_kwargs,
            loss_normalization="target_density",
        )
        state = mean_learner.init(feature_dim=4, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])

        dense_targets = jnp.array([1.0, -1.0])
        density_dense = density_learner.update(state, obs, dense_targets)
        mean_dense = mean_learner.update(state, obs, dense_targets)
        chex.assert_trees_all_close(
            density_dense.state.trunk_params,
            mean_dense.state.trunk_params,
        )
        chex.assert_trees_all_close(
            density_dense.state.head_params,
            mean_dense.state.head_params,
        )

        sparse_targets = jnp.array([1.0, 0.0])
        density_sparse = density_learner.update(state, obs, sparse_targets)
        sum_sparse = sum_learner.update(state, obs, sparse_targets)
        chex.assert_trees_all_close(
            density_sparse.state.trunk_params,
            sum_sparse.state.trunk_params,
        )
        chex.assert_trees_all_close(
            density_sparse.state.head_params,
            sum_sparse.state.head_params,
        )

    def test_target_structure_loss_uses_simplex_sum_otherwise_mean(self):
        """Target-structure normalization should not over-scale dense zeros."""
        base_kwargs = dict(
            n_heads=3,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
        )
        mean_learner = UPGDLearner(**base_kwargs, loss_normalization="mean")
        sum_learner = UPGDLearner(**base_kwargs, loss_normalization="sum")
        structure_learner = UPGDLearner(
            **base_kwargs,
            loss_normalization="target_structure",
        )
        state = mean_learner.init(feature_dim=4, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])

        simplex_targets = jnp.array([1.0, 0.0, 0.0])
        structure_simplex = structure_learner.update(state, obs, simplex_targets)
        sum_simplex = sum_learner.update(state, obs, simplex_targets)
        chex.assert_trees_all_close(
            structure_simplex.state.trunk_params,
            sum_simplex.state.trunk_params,
        )
        chex.assert_trees_all_close(
            structure_simplex.state.head_params,
            sum_simplex.state.head_params,
        )

        dense_zero_targets = jnp.array([0.5, 0.0, -0.25])
        structure_dense_zero = structure_learner.update(
            state, obs, dense_zero_targets
        )
        mean_dense_zero = mean_learner.update(state, obs, dense_zero_targets)
        chex.assert_trees_all_close(
            structure_dense_zero.state.trunk_params,
            mean_dense_zero.state.trunk_params,
        )
        chex.assert_trees_all_close(
            structure_dense_zero.state.head_params,
            mean_dense_zero.state.head_params,
        )

        multilabel_targets = jnp.array([1.0, 1.0, 0.0])
        structure_multilabel = structure_learner.update(state, obs, multilabel_targets)
        mean_multilabel = mean_learner.update(state, obs, multilabel_targets)
        chex.assert_trees_all_close(
            structure_multilabel.state.trunk_params,
            mean_multilabel.state.trunk_params,
        )
        chex.assert_trees_all_close(
            structure_multilabel.state.head_params,
            mean_multilabel.state.head_params,
        )

    def test_target_structure_matches_target_density_on_one_hot_targets(self):
        """One-hot digit evidence transfers from density to structure branches."""
        density_learner = UPGDLearner.step2_default(
            n_heads=4,
            hidden_sizes=(8,),
            loss_normalization="target_density",
        )
        structure_learner = UPGDLearner.step2_default(
            n_heads=4,
            hidden_sizes=(8,),
            loss_normalization="target_structure",
        )
        state = density_learner.init(feature_dim=5, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0, -0.7])
        target = jnp.array([0.0, 1.0, 0.0, 0.0])

        density_result = density_learner.update(state, obs, target)
        structure_result = structure_learner.update(state, obs, target)

        chex.assert_trees_all_close(
            structure_result.state.trunk_params,
            density_result.state.trunk_params,
        )
        chex.assert_trees_all_close(
            structure_result.state.head_params,
            density_result.state.head_params,
        )
        chex.assert_trees_all_close(
            structure_result.metrics[0],
            density_result.metrics[0],
        )

    def test_active_count_head_scale_increases_head_update_only(self):
        """Head active-count scaling should not change trunk update size."""
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            loss_normalization="mean",
        )
        plain = UPGDLearner(**base_kwargs)
        scaled = UPGDLearner(**base_kwargs, head_gradient_scale="active_count")
        state = plain.init(feature_dim=4, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])
        targets = jnp.array([1.0, -1.0])

        plain_result = plain.update(state, obs, targets)
        scaled_result = scaled.update(state, obs, targets)

        plain_trunk_delta = jnp.linalg.norm(
            plain_result.state.trunk_params.weights[0]
            - state.trunk_params.weights[0]
        )
        scaled_trunk_delta = jnp.linalg.norm(
            scaled_result.state.trunk_params.weights[0]
            - state.trunk_params.weights[0]
        )
        plain_head_delta = jnp.linalg.norm(
            plain_result.state.head_params.weights[0]
            - state.head_params.weights[0]
        )
        scaled_head_delta = jnp.linalg.norm(
            scaled_result.state.head_params.weights[0]
            - state.head_params.weights[0]
        )

        chex.assert_trees_all_close(scaled_trunk_delta, plain_trunk_delta)
        assert float(scaled_head_delta) > float(plain_head_delta)

    def test_negative_target_loss_scale_reduces_zero_target_head_update(self):
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            loss_normalization="sum",
        )
        plain = UPGDLearner(**base_kwargs)
        downweighted = UPGDLearner(
            **base_kwargs,
            negative_target_loss_scale=0.1,
        )
        state = plain.init(feature_dim=4, key=jr.key(3))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])
        targets = jnp.array([1.0, 0.0])

        plain_result = plain.update(state, obs, targets)
        downweighted_result = downweighted.update(state, obs, targets)

        plain_negative_delta = jnp.linalg.norm(
            plain_result.state.head_params.weights[1]
            - state.head_params.weights[1]
        )
        downweighted_negative_delta = jnp.linalg.norm(
            downweighted_result.state.head_params.weights[1]
            - state.head_params.weights[1]
        )
        assert float(downweighted_negative_delta) < float(plain_negative_delta)

    def test_simplex_bias_decay_shrinks_active_biases(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            readout_simplex_bias_decay=0.25,
        )
        state = learner.init(feature_dim=3, key=jr.key(25))
        state = state.replace(  # type: ignore[attr-defined]
            head_params=state.head_params.replace(  # type: ignore[attr-defined]
                biases=(
                    jnp.array([2.0], dtype=jnp.float32),
                    jnp.array([-1.0], dtype=jnp.float32),
                ),
            ),
        )

        result = learner.update(state, jnp.ones(3), jnp.array([1.0, 0.0]))

        chex.assert_trees_all_close(
            result.state.head_params.biases,
            (
                jnp.array([1.5], dtype=jnp.float32),
                jnp.array([-0.75], dtype=jnp.float32),
            ),
        )
        chex.assert_trees_all_close(
            result.state.head_params.weights,
            state.head_params.weights,
        )

    def test_simplex_bias_centering_leaves_inactive_biases_unchanged(self):
        learner = UPGDLearner(
            n_heads=3,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            readout_simplex_bias_centering_rate=1.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(26))
        state = state.replace(  # type: ignore[attr-defined]
            head_params=state.head_params.replace(  # type: ignore[attr-defined]
                biases=(
                    jnp.array([1.0], dtype=jnp.float32),
                    jnp.array([3.0], dtype=jnp.float32),
                    jnp.array([-5.0], dtype=jnp.float32),
                ),
            ),
        )

        result = learner.update(state, jnp.ones(3), jnp.array([1.0, 0.0, jnp.nan]))

        chex.assert_trees_all_close(
            result.state.head_params.biases,
            (
                jnp.array([-1.0], dtype=jnp.float32),
                jnp.array([1.0], dtype=jnp.float32),
                jnp.array([-5.0], dtype=jnp.float32),
            ),
        )

    def test_simplex_bias_antidrift_skips_non_simplex_targets(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            readout_simplex_bias_decay=0.25,
            readout_simplex_bias_centering_rate=1.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(27))
        state = state.replace(  # type: ignore[attr-defined]
            head_params=state.head_params.replace(  # type: ignore[attr-defined]
                biases=(
                    jnp.array([2.0], dtype=jnp.float32),
                    jnp.array([-1.0], dtype=jnp.float32),
                ),
            ),
        )

        result = learner.update(state, jnp.ones(3), jnp.array([0.75, 0.75]))

        chex.assert_trees_all_close(
            result.state.head_params.biases,
            state.head_params.biases,
        )

    def test_head_step_size_multiplier_increases_head_update_only(self):
        """Fixed head multipliers should leave trunk updates unchanged."""
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            loss_normalization="mean",
        )
        plain = UPGDLearner(**base_kwargs)
        scaled = UPGDLearner(**base_kwargs, head_step_size_multiplier=3.0)
        state = plain.init(feature_dim=4, key=jr.key(0))
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])
        targets = jnp.array([1.0, -1.0])

        plain_result = plain.update(state, obs, targets)
        scaled_result = scaled.update(state, obs, targets)

        chex.assert_trees_all_close(
            scaled_result.state.trunk_params.weights[0],
            plain_result.state.trunk_params.weights[0],
        )
        plain_head_delta = jnp.linalg.norm(
            plain_result.state.head_params.weights[0]
            - state.head_params.weights[0]
        )
        scaled_head_delta = jnp.linalg.norm(
            scaled_result.state.head_params.weights[0]
            - state.head_params.weights[0]
        )
        assert float(scaled_head_delta) > float(plain_head_delta)

    def test_head_loss_pressure_boosts_head_update_after_warmup_only(self):
        base_kwargs = dict(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            loss_normalization="mean",
            head_loss_pressure_gate_ratio=1.1,
            head_loss_pressure_multiplier=3.0,
            head_loss_pressure_warmup_steps=5,
        )
        learner = UPGDLearner(**base_kwargs)
        state = learner.init(feature_dim=4, key=jr.key(2)).replace(  # type: ignore[attr-defined]
            loss_fast_ema=jnp.array(2.0, dtype=jnp.float32),
            loss_slow_ema=jnp.array(1.0, dtype=jnp.float32),
        )
        obs = jnp.array([0.3, -0.2, 0.5, 1.0])
        targets = jnp.array([1.0, -1.0])

        cold = learner.update(state, obs, targets).state
        warm_state = state.replace(  # type: ignore[attr-defined]
            step_count=jnp.array(5, dtype=jnp.int32),
        )
        warm = learner.update(warm_state, obs, targets).state

        cold_head_delta = jnp.linalg.norm(
            cold.head_params.weights[0] - state.head_params.weights[0]
        )
        warm_head_delta = jnp.linalg.norm(
            warm.head_params.weights[0] - warm_state.head_params.weights[0]
        )
        chex.assert_trees_all_close(cold.trunk_params.weights[0], warm.trunk_params.weights[0])
        assert float(warm_head_delta) > float(cold_head_delta)

    def test_adaptive_kappa_loss_ratio_allows_larger_spike_update(self):
        base_kwargs = dict(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=1.0,
            perturbation_sigma=0.0,
            loss_normalization="sum",
            bounder=ObGDBounding(kappa=0.5),
        )
        static = UPGDLearner(**base_kwargs)
        adaptive = UPGDLearner(
            **base_kwargs,
            adaptive_kappa_mode="loss_ratio",
            adaptive_kappa_base=0.5,
            adaptive_kappa_min=0.25,
            adaptive_kappa_max=0.75,
            adaptive_kappa_exponent=1.0,
        )
        state = static.init(feature_dim=4, key=jr.key(22)).replace(  # type: ignore[attr-defined]
            loss_fast_ema=jnp.array(2.0, dtype=jnp.float32),
            loss_slow_ema=jnp.array(1.0, dtype=jnp.float32),
        )
        obs = jnp.array([2.0, -1.0, 0.5, 1.5])
        target = jnp.array([3.0])

        static_state = static.update(state, obs, target).state
        adaptive_state = adaptive.update(state, obs, target).state
        static_delta = jnp.linalg.norm(
            static_state.trunk_params.weights[0] - state.trunk_params.weights[0]
        )
        adaptive_delta = jnp.linalg.norm(
            adaptive_state.trunk_params.weights[0] - state.trunk_params.weights[0]
        )

        assert float(adaptive_delta) > float(static_delta)

    def test_gradient_alignment_can_learn_kappa_multiplier(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            adaptive_kappa_mode="gradient_alignment",
            adaptive_kappa_base=0.5,
            adaptive_kappa_min=0.25,
            adaptive_kappa_max=1.0,
            adaptive_kappa_meta_step_size=0.1,
            adaptive_kappa_meta_min_multiplier=0.5,
            adaptive_kappa_meta_max_multiplier=2.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(23))
        obs = jnp.array([1.0, -0.5, 0.25])
        target = jnp.array([1.0])

        state = learner.update(state, obs, target).state
        result = learner.update(state, obs, target)

        assert float(result.state.adaptive_kappa_log_scale) < 0.0

    def test_factorized_simplex_adapter_moves_toward_permuted_target(self):
        learner = UPGDLearner(
            n_heads=3,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            readout_mode="factorized_simplex",
            readout_label_adapter_step_size=0.5,
            readout_label_adapter_identity_regularization=0.0,
            readout_label_adapter_floor=0.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(29))
        state = state.replace(  # type: ignore[attr-defined]
            head_params=state.head_params.replace(  # type: ignore[attr-defined]
                weights=(
                    jnp.zeros((1, 3), dtype=jnp.float32),
                    jnp.zeros((1, 3), dtype=jnp.float32),
                    jnp.zeros((1, 3), dtype=jnp.float32),
                ),
                biases=(
                    jnp.array([2.0], dtype=jnp.float32),
                    jnp.array([0.0], dtype=jnp.float32),
                    jnp.array([-1.0], dtype=jnp.float32),
                ),
            ),
        )
        obs = jnp.ones(3)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        before = learner.predict(state, obs)
        result = learner.update(state, obs, target)
        after = learner.predict(result.state, obs)

        assert float(after[1]) > float(before[1])
        assert float(jnp.linalg.norm(after - target)) < float(
            jnp.linalg.norm(before - target)
        )
        assert not jnp.allclose(
            result.state.readout_label_adapter,
            state.readout_label_adapter,
        )
        chex.assert_trees_all_close(
            jnp.sum(result.state.readout_label_adapter, axis=1),
            jnp.ones(3),
            atol=1e-6,
        )

    def test_two_timescale_simplex_update_changes_slow_and_fast_heads(self):
        learner = UPGDLearner(
            n_heads=3,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.1,
            perturbation_sigma=0.0,
            readout_mode="two_timescale_simplex",
            readout_fast_head_step_size_multiplier=1.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(33))
        obs = jnp.array([1.0, -0.5, 0.25], dtype=jnp.float32)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        result = learner.update(state, obs, target)

        slow_delta = jnp.linalg.norm(
            result.state.head_params.weights[1] - state.head_params.weights[1]
        )
        fast_delta = jnp.linalg.norm(
            result.state.readout_fast_head_params.weights[1]
            - state.readout_fast_head_params.weights[1]
        )
        assert float(slow_delta) > 0.0
        assert float(fast_delta) > 0.0
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.metrics)

    def test_two_timescale_fast_trunk_gradient_changes_trunk(self):
        common = {
            "n_heads": 3,
            "hidden_sizes": (4,),
            "sparsity": 0.0,
            "step_size": 0.1,
            "perturbation_sigma": 0.0,
            "readout_mode": "two_timescale_simplex",
            "readout_fast_head_step_size_multiplier": 1.0,
        }
        passive = UPGDLearner(**common, readout_fast_trunk_gradient_multiplier=0.0)
        active = UPGDLearner(**common, readout_fast_trunk_gradient_multiplier=1.0)
        state = passive.init(feature_dim=3, key=jr.key(34)).replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32)
        )
        obs = jnp.array([1.0, -0.5, 0.25], dtype=jnp.float32)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        passive_result = passive.update(state, obs, target)
        active_result = active.update(state, obs, target)

        passive_delta = jnp.linalg.norm(
            passive_result.state.trunk_params.weights[0]
            - state.trunk_params.weights[0]
        )
        active_delta = jnp.linalg.norm(
            active_result.state.trunk_params.weights[0]
            - passive_result.state.trunk_params.weights[0]
        )
        assert float(passive_delta) > 0.0
        assert float(active_delta) > 0.0

    def test_two_timescale_fast_head_uses_shared_bounder(self):
        common = {
            "n_heads": 3,
            "hidden_sizes": (),
            "sparsity": 0.0,
            "step_size": 5.0,
            "perturbation_sigma": 0.0,
            "readout_mode": "two_timescale_simplex",
            "readout_fast_head_step_size_multiplier": 8.0,
        }
        unbounded = UPGDLearner(**common)
        bounded = UPGDLearner(**common, bounder=ObGDBounding(kappa=0.5))
        state = unbounded.init(feature_dim=3, key=jr.key(35))
        obs = jnp.array([1.0, -0.5, 0.25], dtype=jnp.float32)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        unbounded_result = unbounded.update(state, obs, target)
        bounded_result = bounded.update(state, obs, target)

        unbounded_delta = jnp.linalg.norm(
            jnp.concatenate(
                [
                    unbounded_result.state.readout_fast_head_params.weights[h].ravel()
                    - state.readout_fast_head_params.weights[h].ravel()
                    for h in range(3)
                ]
            )
        )
        bounded_delta = jnp.linalg.norm(
            jnp.concatenate(
                [
                    bounded_result.state.readout_fast_head_params.weights[h].ravel()
                    - state.readout_fast_head_params.weights[h].ravel()
                    for h in range(3)
                ]
            )
        )
        assert float(unbounded_delta) > 0.0
        assert float(bounded_delta) > 0.0
        assert float(bounded_delta) < float(unbounded_delta)

    def test_two_timescale_fast_head_supports_separate_bounder(self):
        common = {
            "n_heads": 3,
            "hidden_sizes": (),
            "sparsity": 0.0,
            "step_size": 5.0,
            "perturbation_sigma": 0.0,
            "readout_mode": "two_timescale_simplex",
            "readout_fast_head_step_size_multiplier": 8.0,
        }
        unbounded = UPGDLearner(**common)
        separate = UPGDLearner(
            **common,
            bounder=ObGDBounding(kappa=0.5),
            readout_fast_head_bounder_mode="separate",
        )
        state = unbounded.init(feature_dim=3, key=jr.key(38))
        obs = jnp.array([1.0, -0.5, 0.25], dtype=jnp.float32)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        unbounded_result = unbounded.update(state, obs, target)
        separate_result = separate.update(state, obs, target)

        unbounded_delta = jnp.linalg.norm(
            jnp.concatenate(
                [
                    unbounded_result.state.readout_fast_head_params.weights[h].ravel()
                    - state.readout_fast_head_params.weights[h].ravel()
                    for h in range(3)
                ]
            )
        )
        separate_delta = jnp.linalg.norm(
            jnp.concatenate(
                [
                    separate_result.state.readout_fast_head_params.weights[h].ravel()
                    - state.readout_fast_head_params.weights[h].ravel()
                    for h in range(3)
                ]
            )
        )
        assert float(separate_delta) > 0.0
        assert float(separate_delta) < float(unbounded_delta)

    def test_two_timescale_can_suppress_slow_simplex_gradients(self):
        common = {
            "n_heads": 3,
            "hidden_sizes": (),
            "sparsity": 0.0,
            "step_size": 0.1,
            "perturbation_sigma": 0.0,
            "readout_mode": "two_timescale_simplex",
            "readout_fast_head_step_size_multiplier": 1.0,
        }
        baseline = UPGDLearner(**common)
        suppressed = UPGDLearner(
            **common,
            readout_slow_simplex_gradient_multiplier=0.0,
        )
        state = baseline.init(feature_dim=3, key=jr.key(37)).replace(  # type: ignore[attr-defined]
            target_repeat_ema=jnp.array(1.0, dtype=jnp.float32),
            target_simplex_ema=jnp.array(1.0, dtype=jnp.float32),
        )
        obs = jnp.array([1.0, -0.5, 0.25], dtype=jnp.float32)
        target = jnp.array([0.0, 1.0, 0.0], dtype=jnp.float32)

        baseline_result = baseline.update(state, obs, target)
        suppressed_result = suppressed.update(state, obs, target)

        baseline_slow_delta = jnp.linalg.norm(
            baseline_result.state.head_params.weights[1]
            - state.head_params.weights[1]
        )
        suppressed_slow_delta = jnp.linalg.norm(
            suppressed_result.state.head_params.weights[1]
            - state.head_params.weights[1]
        )
        suppressed_fast_delta = jnp.linalg.norm(
            suppressed_result.state.readout_fast_head_params.weights[1]
            - state.readout_fast_head_params.weights[1]
        )
        assert float(baseline_slow_delta) > 0.0
        assert float(suppressed_slow_delta) == 0.0
        assert float(suppressed_fast_delta) > 0.0


# =============================================================================
# Utility tracking
# =============================================================================


class TestUtilityTracking:
    """Utility should reflect |w * grad| accumulation."""

    def test_utility_tracks_active_weights(self):
        """Synthetically zero one input column so its weights have zero gradient.

        After many steps the utility on the zero-input column should be
        smaller than on the others.
        """
        feature_dim = 6
        # No noise in noise channel so the test is deterministic.
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(16,),
            sparsity=0.0,
            step_size=0.0,            # freeze SGD so weights stay constant
            perturbation_sigma=0.0,   # no perturbation noise
            utility_decay=0.99,
        )
        state = learner.init(feature_dim=feature_dim, key=jr.key(123))

        # Constant input with one zero feature (index 0).
        obs = jnp.array([0.0, 1.0, 1.0, 1.0, 1.0, 1.0])
        target = jnp.array([1.0])

        for _ in range(1000):
            result = learner.update(state, obs, target)
            state = result.state

        # First-layer utility is shape (16, 6). Mean utility over column 0
        # should be ~0 (those weights never see input).
        u0 = state.utilities[0]
        mean_dead = float(jnp.mean(u0[:, 0]))
        mean_alive_cols = float(jnp.mean(u0[:, 1:]))
        assert mean_dead < 1e-6
        assert mean_alive_cols > mean_dead

    def test_unit_utility_tracks_row_contribution(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            utility_decay=0.0,
            unit_utility_decay=0.0,
            unit_long_utility_decay=0.0,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))
        result = learner.update(state, jnp.ones(4), jnp.array([1.0]))
        row_mean = jnp.mean(result.state.utilities[0], axis=1)
        chex.assert_trees_all_close(result.state.unit_utilities[0], row_mean)
        chex.assert_trees_all_close(result.state.unit_long_utilities[0], row_mean)
        assert float(jnp.max(result.state.unit_gradient_emas[0])) > 0.0
        chex.assert_trees_all_close(
            result.state.unit_ages[0],
            jnp.ones_like(result.state.unit_ages[0]),
        )

    def test_unit_recycling_reinitializes_lowest_mature_unit(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.25,
            unit_maturity_threshold=1,
        )
        state = learner.init(feature_dim=3, key=jr.key(11))
        state = state.replace(  # type: ignore[attr-defined]
            unit_utilities=(jnp.array([0.0, 10.0, 10.0, 10.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([5, 5, 5, 5], dtype=jnp.int32),),
        )

        result = learner.update(state, jnp.zeros(3), jnp.zeros(2))

        for head_w in result.state.head_params.weights:
            assert float(head_w[0, 0]) == 0.0
        assert int(result.state.unit_ages[0][0]) == 0
        assert float(result.state.unit_utilities[0][0]) == 0.0
        assert float(result.state.unit_replacement_counts[0]) == 1.0

    def test_stale_gradient_recycling_with_targeted_fanin_runs(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(4,),
            sparsity=0.5,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.25,
            unit_maturity_threshold=1,
            unit_replacement_criterion="stale_gradient_ratio",
            unit_replacement_fanin="gradient_columns",
            unit_replacement_loss_gate_ratio=0.0,
        )
        state = learner.init(feature_dim=6, key=jr.key(12))
        state = state.replace(  # type: ignore[attr-defined]
            unit_long_utilities=(
                jnp.array([10.0, 1.0, 1.0, 1.0], dtype=jnp.float32),
            ),
            unit_gradient_emas=(
                jnp.array([0.0, 1.0, 1.0, 1.0], dtype=jnp.float32),
            ),
            unit_ages=(jnp.array([5, 5, 5, 5], dtype=jnp.int32),),
        )

        result = learner.update(state, jnp.ones(6), jnp.array([1.0, 0.0]))

        chex.assert_tree_all_finite(result.predictions)
        assert int(result.state.unit_ages[0][0]) == 0

    def test_gated_recycling_budget_does_not_store_closed_gate_debt(self):
        base_kwargs = dict(
            n_heads=1,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.25,
            unit_maturity_threshold=0,
            unit_replacement_loss_gate_ratio=10.0,
        )
        always = UPGDLearner(**base_kwargs)
        gated = UPGDLearner(
            **base_kwargs,
            unit_replacement_budget_mode="gated",
        )
        state_always = always.init(feature_dim=3, key=jr.key(21))
        state_gated = gated.init(feature_dim=3, key=jr.key(21))

        result_always = always.update(state_always, jnp.zeros(3), jnp.zeros(1))
        result_gated = gated.update(state_gated, jnp.zeros(3), jnp.zeros(1))

        assert float(result_always.state.unit_replacement_accumulators[0]) > 0.0
        assert float(result_gated.state.unit_replacement_accumulators[0]) == 0.0

    def test_loss_pressure_recycling_budget_scales_with_loss_spike(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.125,
            unit_maturity_threshold=0,
            unit_replacement_loss_gate_ratio=1.1,
            unit_replacement_budget_mode="loss_pressure",
        )
        state = learner.init(feature_dim=3, key=jr.key(22))
        closed = learner.update(state, jnp.zeros(3), jnp.zeros(1)).state
        open_state = state.replace(  # type: ignore[attr-defined]
            loss_fast_ema=jnp.array(2.0, dtype=jnp.float32),
            loss_slow_ema=jnp.array(1.0, dtype=jnp.float32),
        )
        opened = learner.update(open_state, jnp.zeros(3), jnp.zeros(1)).state

        assert float(closed.unit_replacement_accumulators[0]) == 0.0
        assert float(opened.unit_replacement_accumulators[0]) > 0.0

    def test_recycling_can_preserve_outgoing_weights(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.25,
            unit_maturity_threshold=1,
            unit_replacement_outgoing_scale=1.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(13))
        state = state.replace(  # type: ignore[attr-defined]
            unit_utilities=(jnp.array([0.0, 10.0, 10.0, 10.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([5, 5, 5, 5], dtype=jnp.int32),),
        )
        old_head0 = state.head_params.weights[0][0, 0]

        result = learner.update(state, jnp.zeros(3), jnp.zeros(2))

        chex.assert_trees_all_close(result.state.head_params.weights[0][0, 0], old_head0)
        assert int(result.state.unit_ages[0][0]) == 0

    def test_partial_fanin_recycles_only_some_inputs(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            unit_replacement_rate=0.25,
            unit_maturity_threshold=1,
            unit_replacement_partial_fanin=1,
        )
        state = learner.init(feature_dim=4, key=jr.key(14))
        state = state.replace(  # type: ignore[attr-defined]
            unit_utilities=(jnp.array([0.0, 10.0, 10.0, 10.0], dtype=jnp.float32),),
            unit_ages=(jnp.array([5, 5, 5, 5], dtype=jnp.int32),),
        )
        old_row = state.trunk_params.weights[0][0]

        result = learner.update(state, jnp.zeros(4), jnp.zeros(1))

        changed = jnp.abs(result.state.trunk_params.weights[0][0] - old_row) > 1e-7
        assert int(jnp.sum(changed)) == 1

    def test_margin_adapter_changes_true_and_wrong_heads(self):
        learner = UPGDLearner(
            n_heads=3,
            hidden_sizes=(4,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=0.0,
            readout_margin=1.0,
            readout_margin_step_size=0.1,
        )
        state = learner.init(feature_dim=3, key=jr.key(15))
        targets = jnp.array([1.0, 0.0, 0.0])

        result = learner.update(state, jnp.ones(3), targets)

        head_deltas = [
            float(
                jnp.linalg.norm(
                    result.state.head_params.weights[i] - state.head_params.weights[i]
                )
            )
            for i in range(3)
        ]
        assert head_deltas[0] > 0.0
        assert sum(delta > 0.0 for delta in head_deltas[1:]) == 1

    def test_gradient_alignment_meta_plasticity_changes_head_scales(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            meta_plasticity_mode="gradient_alignment",
            meta_plasticity_step_size=0.1,
            meta_plasticity_min_multiplier=0.5,
            meta_plasticity_max_multiplier=2.0,
        )
        state = learner.init(feature_dim=3, key=jr.key(16))
        obs = jnp.array([1.0, -0.5, 0.25])
        target = jnp.array([1.0])

        state = learner.update(state, obs, target).state
        result = learner.update(state, obs, target)

        assert float(jnp.abs(result.state.meta_head_weight_log_scale)) > 0.0
        assert float(jnp.abs(result.state.meta_head_bias_log_scale)) > 0.0

    def test_meta_plasticity_group_switches_disable_head_scales(self):
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(),
            sparsity=0.0,
            step_size=0.01,
            perturbation_sigma=0.0,
            meta_plasticity_mode="gradient_alignment",
            meta_plasticity_step_size=0.1,
            meta_plasticity_head_weight_enabled=False,
            meta_plasticity_head_bias_enabled=False,
        )
        state = learner.init(feature_dim=3, key=jr.key(24))
        obs = jnp.array([1.0, -0.5, 0.25])
        target = jnp.array([1.0])

        state = learner.update(state, obs, target).state
        result = learner.update(state, obs, target)

        assert float(result.state.meta_head_weight_log_scale) == 0.0
        assert float(result.state.meta_head_bias_log_scale) == 0.0


# =============================================================================
# Perturbation magnitude
# =============================================================================


class TestPerturbation:
    """Perturbation should be larger on low-utility weights than high-utility ones."""

    def test_perturbation_decreases_with_utility(self):
        """Set up explicit utility differences and verify perturbation is
        smaller for high-utility weights than for low-utility weights.
        """
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=1.0,   # large noise so the difference is obvious
            perturbation_beta=2.0,
            perturbation_interval=1,
            utility_decay=0.0,        # use the instantaneous |w*grad| as utility
        )
        state = learner.init(feature_dim=4, key=jr.key(7))

        # Manually craft a known utility: high in one slot, low in the rest.
        # Bypass the learning-step utility update by overriding the trunk
        # utilities directly. We'll then call predict + a low-LR update so
        # the SGD path doesn't dominate the noise comparison.
        u_known = jnp.zeros_like(state.utilities[0])
        # Set a single weight (row 0, col 0) to large utility
        u_known = u_known.at[0, 0].set(100.0)
        # And one weight to (almost) zero (row 1, col 0): keep at 0.
        state = state.replace(utilities=(u_known,))  # type: ignore[attr-defined]

        # Disable the EMA so the in-update utility recompute matches our override
        # (decay=0 means u <- |w*grad|, but step_size=0 means weights don't move
        # so feeding zero-target zero-input keeps |w*grad|=0 too).
        # Use zero observation + zero target so the gradient is zero -- the
        # utility update computes 0*|w| = 0, but our override still gets
        # decayed by (1-decay)=1 contribution of 0 + decay*old = 0*old + 0 = 0.
        # That would erase our setup. So set decay to keep the known utility:
        # rebuild learner with decay=1.0... but we constrained < 1.0. Use a
        # very high decay (0.999) so the override survives one step.
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=1.0,
            perturbation_beta=2.0,
            perturbation_interval=1,
            utility_decay=0.999,
        )

        # Force step_count >= 1 so perturbation actually fires.
        state = state.replace(step_count=jnp.array(5, dtype=jnp.int32))  # type: ignore[attr-defined]

        # Save weights pre-perturb
        old_w = state.trunk_params.weights[0]

        # Run with zero observation + zero target so SGD step is zero.
        obs = jnp.zeros(4)
        target = jnp.array([0.0])
        result = learner.update(state, obs, target)

        # Difference == perturbation noise applied to weights.
        new_w = result.state.trunk_params.weights[0]
        delta = jnp.abs(new_w - old_w)

        # Position (0, 0) is highest utility -> smallest expected perturbation
        # Other positions have utility 0 -> largest expected perturbation.
        high_util_perturb = float(delta[0, 0])
        # Compare against a low-utility weight at, e.g., (1, 0)
        low_util_perturb = float(delta[1, 0])

        assert high_util_perturb < low_util_perturb

    def test_warmup_disables_perturbation(self):
        """Perturbation warmup should keep weights unchanged by noise."""
        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=1.0,
            perturbation_beta=2.0,
            perturbation_interval=1,
            perturbation_warmup_steps=10,
            utility_decay=0.999,
        )
        state = learner.init(feature_dim=4, key=jr.key(7))
        state = state.replace(step_count=jnp.array(5, dtype=jnp.int32))  # type: ignore[attr-defined]
        old_w = state.trunk_params.weights[0]

        result = learner.update(state, jnp.zeros(4), jnp.array([0.0]))

        chex.assert_trees_all_close(result.state.trunk_params.weights[0], old_w)
        assert float(result.metrics[3]) == 0.0

    def test_ramp_scales_perturbation_below_full_strength(self):
        """A ramped learner should perturb less than a full-strength learner."""
        base_kwargs = dict(
            n_heads=1,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.0,
            perturbation_sigma=1.0,
            perturbation_beta=2.0,
            perturbation_interval=1,
            utility_decay=0.999,
        )
        full = UPGDLearner(**base_kwargs)
        ramped = UPGDLearner(
            **base_kwargs,
            perturbation_warmup_steps=0,
            perturbation_ramp_steps=10,
        )
        state = full.init(feature_dim=4, key=jr.key(7))
        state = state.replace(step_count=jnp.array(1, dtype=jnp.int32))  # type: ignore[attr-defined]

        full_result = full.update(state, jnp.zeros(4), jnp.array([0.0]))
        ramped_result = ramped.update(state, jnp.zeros(4), jnp.array([0.0]))

        assert float(ramped_result.metrics[3]) < float(full_result.metrics[3])


# =============================================================================
# Config roundtrip
# =============================================================================


class TestConfigRoundtrip:
    """to_config/from_config should preserve all hyperparameters."""

    def test_roundtrip_basic(self):
        learner = UPGDLearner(
            n_heads=3,
            hidden_sizes=(16, 8),
            step_size=0.05,
            utility_decay=0.99,
            perturbation_sigma=2e-3,
            perturbation_beta=3.0,
            perturbation_interval=4,
            perturbation_noise="rademacher",
            perturbation_warmup_steps=100,
            perturbation_ramp_steps=50,
            sparsity=0.5,
            leaky_relu_slope=0.02,
            use_layer_norm=False,
            loss_normalization="sum",
            positive_target_loss_scale=1.5,
            negative_target_loss_scale=0.25,
            head_gradient_scale="active_count",
            head_step_size_multiplier=2.0,
            head_bias_step_size_multiplier=0.5,
            head_loss_pressure_gate_ratio=1.1,
            head_loss_pressure_multiplier=3.0,
            head_loss_pressure_warmup_steps=25,
            head_repetition_multiplier=1.5,
            head_repetition_decay=0.8,
            head_repetition_delta_threshold=0.02,
            head_repetition_pressure_threshold=0.4,
            head_repetition_warmup_steps=30,
            unit_replacement_rate=1e-4,
            unit_maturity_threshold=200,
            unit_utility_decay=0.97,
            unit_long_utility_decay=0.999,
            unit_gradient_decay=0.9,
            unit_replacement_criterion="stale_gradient_ratio",
            unit_replacement_fanin="gradient_columns",
            unit_replacement_loss_gate_ratio=1.08,
            unit_replacement_budget_mode="loss_pressure",
            unit_replacement_outgoing_scale=0.5,
            unit_replacement_partial_fanin=8,
            unit_replacement_score_threshold=0.4,
            unit_outgoing_utility_weight=0.25,
            track_unit_utilities=False,
            track_gradient_history=False,
            adaptive_kappa_mode="loss_ratio",
            adaptive_kappa_base=0.5,
            adaptive_kappa_min=0.25,
            adaptive_kappa_max=0.75,
            adaptive_kappa_exponent=0.5,
            adaptive_kappa_warmup_steps=20,
            adaptive_kappa_meta_step_size=0.01,
            adaptive_kappa_meta_min_multiplier=0.75,
            adaptive_kappa_meta_max_multiplier=1.25,
            adaptive_kappa_meta_warmup_steps=15,
            meta_plasticity_mode="gradient_alignment",
            meta_plasticity_step_size=0.02,
            meta_plasticity_min_multiplier=0.5,
            meta_plasticity_max_multiplier=2.0,
            meta_plasticity_warmup_steps=10,
            meta_plasticity_trunk_enabled=False,
            meta_plasticity_head_weight_enabled=True,
            meta_plasticity_head_bias_enabled=False,
            meta_plasticity_repetition_enabled=True,
            readout_mode="softmax_ce",
            readout_loss_mode="gce",
            readout_prediction_mode="adaptive_simplex",
            readout_robust_q=0.5,
            readout_adaptive_gate_start=0.25,
            readout_adaptive_gate_width=0.2,
            readout_input_mode="hidden_plus_input",
            readout_head_normalization="hidden_norm",
            readout_margin=0.5,
            readout_margin_step_size=0.03,
            readout_label_adapter_step_size=0.4,
            readout_label_adapter_identity_regularization=0.02,
            readout_label_adapter_entropy_regularization=0.01,
            readout_label_adapter_floor=1e-5,
            readout_fast_head_step_size_multiplier=1.25,
            readout_fast_head_bias_step_size_multiplier=0.75,
            readout_fast_trunk_gradient_multiplier=0.5,
            readout_simplex_bias_decay=0.01,
            readout_simplex_bias_centering_rate=0.5,
        )
        cfg = learner.to_config()
        assert cfg["type"] == "UPGDLearner"
        assert cfg["loss_normalization"] == "sum"
        assert cfg["positive_target_loss_scale"] == 1.5
        assert cfg["negative_target_loss_scale"] == 0.25
        assert cfg["head_gradient_scale"] == "active_count"
        assert cfg["head_step_size_multiplier"] == 2.0
        assert cfg["head_bias_step_size_multiplier"] == 0.5
        assert cfg["head_loss_pressure_gate_ratio"] == 1.1
        assert cfg["head_loss_pressure_multiplier"] == 3.0
        assert cfg["head_loss_pressure_warmup_steps"] == 25
        assert cfg["head_repetition_multiplier"] == 1.5
        assert cfg["head_repetition_decay"] == 0.8
        assert cfg["head_repetition_delta_threshold"] == 0.02
        assert cfg["head_repetition_pressure_threshold"] == 0.4
        assert cfg["head_repetition_warmup_steps"] == 30
        assert cfg["unit_replacement_criterion"] == "stale_gradient_ratio"
        assert cfg["unit_replacement_fanin"] == "gradient_columns"
        assert cfg["unit_replacement_budget_mode"] == "loss_pressure"
        assert cfg["unit_replacement_outgoing_scale"] == 0.5
        assert cfg["unit_replacement_partial_fanin"] == 8
        assert cfg["unit_replacement_score_threshold"] == 0.4
        assert cfg["unit_outgoing_utility_weight"] == 0.25
        assert cfg["perturbation_noise"] == "rademacher"
        assert cfg["track_unit_utilities"] is False
        assert cfg["track_gradient_history"] is False
        assert cfg["adaptive_kappa_mode"] == "loss_ratio"
        assert cfg["adaptive_kappa_base"] == 0.5
        assert cfg["adaptive_kappa_min"] == 0.25
        assert cfg["adaptive_kappa_max"] == 0.75
        assert cfg["adaptive_kappa_exponent"] == 0.5
        assert cfg["adaptive_kappa_warmup_steps"] == 20
        assert cfg["adaptive_kappa_meta_step_size"] == 0.01
        assert cfg["adaptive_kappa_meta_min_multiplier"] == 0.75
        assert cfg["adaptive_kappa_meta_max_multiplier"] == 1.25
        assert cfg["adaptive_kappa_meta_warmup_steps"] == 15
        assert cfg["meta_plasticity_mode"] == "gradient_alignment"
        assert cfg["meta_plasticity_step_size"] == 0.02
        assert cfg["meta_plasticity_min_multiplier"] == 0.5
        assert cfg["meta_plasticity_max_multiplier"] == 2.0
        assert cfg["meta_plasticity_warmup_steps"] == 10
        assert cfg["meta_plasticity_trunk_enabled"] is False
        assert cfg["meta_plasticity_head_weight_enabled"] is True
        assert cfg["meta_plasticity_head_bias_enabled"] is False
        assert cfg["meta_plasticity_repetition_enabled"] is True
        assert cfg["readout_mode"] == "softmax_ce"
        assert cfg["readout_loss_mode"] == "gce"
        assert cfg["readout_prediction_mode"] == "adaptive_simplex"
        assert cfg["readout_robust_q"] == 0.5
        assert cfg["readout_adaptive_gate_start"] == 0.25
        assert cfg["readout_adaptive_gate_width"] == 0.2
        assert cfg["readout_input_mode"] == "hidden_plus_input"
        assert cfg["readout_head_normalization"] == "hidden_norm"
        assert cfg["readout_margin"] == 0.5
        assert cfg["readout_margin_step_size"] == 0.03
        assert cfg["readout_label_adapter_step_size"] == 0.4
        assert cfg["readout_label_adapter_identity_regularization"] == 0.02
        assert cfg["readout_label_adapter_entropy_regularization"] == 0.01
        assert cfg["readout_label_adapter_floor"] == 1e-5
        assert cfg["readout_fast_head_step_size_multiplier"] == 1.25
        assert cfg["readout_fast_head_bias_step_size_multiplier"] == 0.75
        assert cfg["readout_fast_trunk_gradient_multiplier"] == 0.5
        assert cfg["readout_simplex_bias_decay"] == 0.01
        assert cfg["readout_simplex_bias_centering_rate"] == 0.5
        rebuilt = UPGDLearner.from_config(cfg)
        assert rebuilt.n_heads == 3
        assert rebuilt.to_config() == cfg

    def test_roundtrip_with_bounder(self):
        from alberta_framework.core.optimizers import ObGDBounding

        learner = UPGDLearner(
            n_heads=2, hidden_sizes=(8,), bounder=ObGDBounding(kappa=2.0)
        )
        cfg = learner.to_config()
        assert cfg["bounder"] is not None
        rebuilt = UPGDLearner.from_config(cfg)
        assert rebuilt.to_config() == cfg


# =============================================================================
# NaN target masking
# =============================================================================


class TestNanMaskedTarget:
    """A NaN target should produce zero gradient on its head."""

    def test_nan_masked_target_is_skipped(self):
        learner = UPGDLearner(
            n_heads=2,
            hidden_sizes=(8,),
            sparsity=0.0,
            step_size=0.1,
            perturbation_sigma=0.0,
            utility_decay=0.5,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))

        obs = jnp.array([1.0, -0.5, 0.3, 0.2])
        targets = jnp.array([1.0, jnp.nan])

        old_head1_w = state.head_params.weights[1]
        old_head1_b = state.head_params.biases[1]

        result = learner.update(state, obs, targets)

        # Head 1 (the masked one) should be unchanged because its
        # contribution to the loss is zero, so its gradient is zero.
        new_head1_w = result.state.head_params.weights[1]
        new_head1_b = result.state.head_params.biases[1]

        chex.assert_trees_all_close(new_head1_w, old_head1_w, atol=1e-7)
        chex.assert_trees_all_close(new_head1_b, old_head1_b, atol=1e-7)

        # Head 0 should be active (errors[0] is finite, errors[1] is NaN)
        assert jnp.isfinite(result.errors[0])
        assert jnp.isnan(result.errors[1])

        # Head 0 weights should have moved
        assert not jnp.allclose(
            result.state.head_params.weights[0], state.head_params.weights[0]
        )


# =============================================================================
# Function fitting
# =============================================================================


class TestCanFitSimpleFunction:
    """UPGD should be able to fit y = sin(x[0]) + cos(x[1])."""

    def test_can_fit_simple_function(self):
        num_steps = 5000
        key = jr.key(2024)
        x_key, init_key = jr.split(key)

        # Sample features uniformly in [-pi, pi]^2
        observations = jr.uniform(
            x_key, (num_steps, 2), minval=-jnp.pi, maxval=jnp.pi, dtype=jnp.float32
        )
        targets = jnp.sin(observations[:, 0]) + jnp.cos(observations[:, 1])
        targets = targets[:, None]  # (num_steps, 1)

        learner = UPGDLearner(
            n_heads=1,
            hidden_sizes=(64, 64),
            step_size=0.01,
            sparsity=0.0,
            perturbation_sigma=1e-4,  # small so it doesn't drown the signal
            perturbation_beta=2.0,
            utility_decay=0.99,
        )
        state = learner.init(feature_dim=2, key=init_key)
        result = run_upgd_arrays(learner, state, observations, targets)

        # `metrics[:, 0]` is mean_loss per step. Compare windowed averages.
        losses = result.metrics[:, 0]
        initial_loss = float(jnp.mean(losses[:200]))
        final_loss = float(jnp.mean(losses[-200:]))

        assert jnp.isfinite(final_loss)
        assert final_loss < initial_loss / 2.0, (
            f"final_loss={final_loss:.4f} did not halve initial_loss={initial_loss:.4f}"
        )


# =============================================================================
# Loops
# =============================================================================


class TestLoops:
    """Smoke tests for run_upgd_arrays and run_upgd_loop."""

    def test_run_upgd_arrays_smoke(self):
        learner = UPGDLearner(
            n_heads=1, hidden_sizes=(8,), sparsity=0.0,
            step_size=0.01, perturbation_sigma=1e-4,
        )
        state = learner.init(feature_dim=4, key=jr.key(0))
        observations = jr.normal(jr.key(1), (50, 4))
        targets = jr.normal(jr.key(2), (50, 1))
        result = run_upgd_arrays(learner, state, observations, targets)
        assert isinstance(result, UPGDLearningResult)
        chex.assert_shape(result.metrics, (50, 4))
        assert int(result.state.step_count) == 50

    def test_run_upgd_loop_smoke(self):
        from alberta_framework.streams.synthetic import RandomWalkStream

        learner = UPGDLearner(
            n_heads=1, hidden_sizes=(8,), sparsity=0.0,
            step_size=0.01, perturbation_sigma=1e-4,
        )
        stream = RandomWalkStream(feature_dim=4, drift_rate=0.0, noise_std=0.05)
        result = run_upgd_loop(learner, stream, num_steps=50, key=jr.key(0))
        chex.assert_shape(result.metrics, (50, 4))
