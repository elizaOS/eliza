"""Tests for the MultiHeadMLPLearner and multi-head learning loops."""

import time

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    AGCBounding,
    Autostep,
    BatchedMultiHeadResult,
    EMANormalizer,
    MultiHeadLearningResult,
    MultiHeadMLPLearner,
    MultiHeadMLPState,
    MultiHeadMLPUpdateResult,
    ObGDBounding,
    WelfordNormalizer,
    multi_head_metrics_to_dicts,
    run_multi_head_learning_loop,
    run_multi_head_learning_loop_batched,
)

# =============================================================================
# Init tests
# =============================================================================


class TestMultiHeadInit:
    """Tests for MultiHeadMLPLearner.init."""

    def test_trunk_shapes_single_hidden(self):
        """Trunk with one hidden layer has correct shapes."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(32,), sparsity=0.0
        )
        state = learner.init(feature_dim=10, key=jr.key(42))

        # Trunk: 10 -> 32
        assert len(state.trunk_params.weights) == 1
        chex.assert_shape(state.trunk_params.weights[0], (32, 10))
        chex.assert_shape(state.trunk_params.biases[0], (32,))

    def test_trunk_shapes_two_hidden(self):
        """Trunk with two hidden layers has correct shapes."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(64, 32), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        assert len(state.trunk_params.weights) == 2
        chex.assert_shape(state.trunk_params.weights[0], (64, 5))
        chex.assert_shape(state.trunk_params.biases[0], (64,))
        chex.assert_shape(state.trunk_params.weights[1], (32, 64))
        chex.assert_shape(state.trunk_params.biases[1], (32,))

    def test_head_shapes(self):
        """Each head has a (1, H_last) weight and (1,) bias."""
        learner = MultiHeadMLPLearner(
            n_heads=4, hidden_sizes=(64, 32), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        assert len(state.head_params.weights) == 4
        assert len(state.head_params.biases) == 4
        for i in range(4):
            chex.assert_shape(state.head_params.weights[i], (1, 32))
            chex.assert_shape(state.head_params.biases[i], (1,))

    def test_traces_initialized_to_zero(self):
        """All trunk and head traces should be zero."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        for trace in state.trunk_traces:
            chex.assert_trees_all_close(trace, jnp.zeros_like(trace))

        for w_trace, b_trace in state.head_traces:
            chex.assert_trees_all_close(w_trace, jnp.zeros_like(w_trace))
            chex.assert_trees_all_close(b_trace, jnp.zeros_like(b_trace))

    def test_biases_initialized_to_zero(self):
        """All trunk and head biases should be zero."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        for bias in state.trunk_params.biases:
            chex.assert_trees_all_close(bias, jnp.zeros_like(bias))

        for bias in state.head_params.biases:
            chex.assert_trees_all_close(bias, jnp.zeros_like(bias))

    def test_sparsity_applied(self):
        """Trunk and head weights should be sparse when sparsity > 0."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(32,), sparsity=0.9
        )
        state = learner.init(feature_dim=10, key=jr.key(42))

        # Trunk layer: expect ~90% sparse
        zeros = jnp.sum(state.trunk_params.weights[0] == 0)
        total = state.trunk_params.weights[0].size
        sparsity = float(zeros) / total
        assert sparsity > 0.85

    def test_step_count_starts_at_zero(self):
        """step_count should be 0 after init."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))
        assert int(state.step_count) == 0

    def test_normalizer_state_init(self):
        """Normalizer state should be created when normalizer is provided."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        assert state.normalizer_state is not None
        chex.assert_shape(state.normalizer_state.mean, (5,))
        chex.assert_shape(state.normalizer_state.var, (5,))


# =============================================================================
# Predict tests
# =============================================================================


class TestMultiHeadPredict:
    """Tests for MultiHeadMLPLearner.predict."""

    def test_returns_n_heads_scalars(self):
        """predict should return array of shape (n_heads,)."""
        learner = MultiHeadMLPLearner(
            n_heads=4, hidden_sizes=(16,), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        preds = learner.predict(state, obs)

        chex.assert_shape(preds, (4,))
        chex.assert_tree_all_finite(preds)

    def test_deterministic(self):
        """Same state and observation should give same predictions."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.array([1.0, 0.5, -0.3, 0.2, 0.8])
        preds1 = learner.predict(state, obs)
        preds2 = learner.predict(state, obs)

        chex.assert_trees_all_close(preds1, preds2)


# =============================================================================
# Update tests — all heads active
# =============================================================================


class TestMultiHeadUpdateAllActive:
    """Tests for update with all heads active."""

    def test_correct_result_types(self):
        """Update should return MultiHeadMLPUpdateResult."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        result = learner.update(state, obs, targets)
        assert isinstance(result, MultiHeadMLPUpdateResult)
        assert isinstance(result.state, MultiHeadMLPState)

    def test_correct_shapes(self):
        """Metrics, predictions, errors should have correct shapes."""
        n_heads = 4
        learner = MultiHeadMLPLearner(
            n_heads=n_heads, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0, 4.0])

        result = learner.update(state, obs, targets)

        chex.assert_shape(result.predictions, (n_heads,))
        chex.assert_shape(result.errors, (n_heads,))
        chex.assert_shape(result.per_head_metrics, (n_heads, 3))
        chex.assert_shape(result.trunk_bounding_metric, ())

    def test_no_nan_when_all_active(self):
        """All metrics should be finite when all heads are active."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        result = learner.update(state, obs, targets)

        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.errors)
        chex.assert_tree_all_finite(result.per_head_metrics)

    def test_error_reduction(self):
        """Multiple updates should reduce error on a fixed target."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), step_size=0.1, sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.array([1.0, 0.5, -0.3, 0.2, 0.8])
        targets = jnp.array([2.0, -1.0])

        initial_preds = learner.predict(state, obs)
        initial_se = float(jnp.sum((initial_preds - targets) ** 2))

        for _ in range(100):
            result = learner.update(state, obs, targets)
            state = result.state

        final_preds = learner.predict(state, obs)
        final_se = float(jnp.sum((final_preds - targets) ** 2))

        assert final_se < initial_se

    def test_step_count_increments(self):
        """step_count should increment by 1 each update."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        assert int(result.state.step_count) == 1

        result = learner.update(result.state, obs, targets)
        assert int(result.state.step_count) == 2


# =============================================================================
# Update tests — partial active
# =============================================================================


class TestMultiHeadUpdatePartialActive:
    """Tests for update with some heads inactive (NaN targets)."""

    def test_nan_metrics_for_inactive(self):
        """Inactive heads should have NaN in errors and metrics."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, jnp.nan, 3.0])  # Head 1 inactive

        result = learner.update(state, obs, targets)

        # Head 0 and 2 should be finite
        assert jnp.isfinite(result.errors[0])
        assert jnp.isfinite(result.errors[2])

        # Head 1 should be NaN
        assert jnp.isnan(result.errors[1])
        assert jnp.all(jnp.isnan(result.per_head_metrics[1]))

    def test_inactive_head_params_unchanged(self):
        """Inactive head params should not change."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, jnp.nan, 3.0])  # Head 1 inactive

        result = learner.update(state, obs, targets)

        # Head 1 weights/biases should be unchanged
        chex.assert_trees_all_close(
            result.state.head_params.weights[1],
            state.head_params.weights[1],
        )
        chex.assert_trees_all_close(
            result.state.head_params.biases[1],
            state.head_params.biases[1],
        )

        # Active heads should have changed
        assert not jnp.allclose(
            result.state.head_params.weights[0],
            state.head_params.weights[0],
        )

    def test_predictions_always_computed(self):
        """Predictions should be computed for all heads, even inactive ones."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([jnp.nan, jnp.nan, 1.0])

        result = learner.update(state, obs, targets)

        # All predictions should be finite
        chex.assert_tree_all_finite(result.predictions)


# =============================================================================
# Update tests — no heads active
# =============================================================================


class TestMultiHeadUpdateNoneActive:
    """Tests for update with no heads active (all NaN targets)."""

    def test_head_params_unchanged(self):
        """All head params should remain unchanged when no heads are active."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([jnp.nan, jnp.nan])

        result = learner.update(state, obs, targets)

        for i in range(2):
            chex.assert_trees_all_close(
                result.state.head_params.weights[i],
                state.head_params.weights[i],
            )
            chex.assert_trees_all_close(
                result.state.head_params.biases[i],
                state.head_params.biases[i],
            )

    def test_normalizer_still_updates(self):
        """Normalizer should update even when no heads are active."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.array([1.0, 2.0, 3.0, 4.0, 5.0])
        targets = jnp.array([jnp.nan, jnp.nan])

        result = learner.update(state, obs, targets)

        # Normalizer mean should have changed
        assert not jnp.allclose(
            result.state.normalizer_state.mean,
            state.normalizer_state.mean,
        )

    def test_step_count_still_increments(self):
        """step_count should still increment even with no active heads."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        targets = jnp.array([jnp.nan, jnp.nan])
        result = learner.update(state, jnp.ones(5), targets)
        assert int(result.state.step_count) == 1


# =============================================================================
# Composition tests
# =============================================================================


class TestMultiHeadComposition:
    """Tests for composing with different optimizers/bounders/normalizers."""

    def test_with_obgd_bounding(self):
        """Should work with ObGDBounding."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_head_metrics)

    def test_with_agc_bounding(self):
        """Should work with AGCBounding."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            bounder=AGCBounding(clip_factor=0.01),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)

    def test_with_ema_normalizer(self):
        """Should work with EMANormalizer."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(decay=0.95),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)
        assert result.state.normalizer_state is not None

    def test_with_welford_normalizer(self):
        """Should work with WelfordNormalizer."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=WelfordNormalizer(),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)

    def test_with_autostep_optimizer(self):
        """Should work with Autostep optimizer."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_head_metrics)


# =============================================================================
# Gradient correctness
# =============================================================================


class TestMultiHeadGradientCorrectness:
    """Tests verifying VJP trunk gradients match N separate jax.grad calls."""

    def test_vjp_matches_separate_grads(self):
        """Accumulated VJP cotangent should match sum of per-head grads."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        slope = learner._leaky_relu_slope
        ln = learner._use_layer_norm

        # Compute via N separate jax.grad calls
        accumulated_w_grads = [
            jnp.zeros_like(w) for w in state.trunk_params.weights
        ]
        accumulated_b_grads = [
            jnp.zeros_like(b) for b in state.trunk_params.biases
        ]

        for i in range(3):
            # Full forward: trunk + head_i
            def full_forward_i(
                trunk_w: tuple, trunk_b: tuple, head_idx: int = i
            ) -> jax.Array:
                hidden = MultiHeadMLPLearner._trunk_forward(
                    trunk_w, trunk_b, obs, slope, ln
                )
                return MultiHeadMLPLearner._head_forward(
                    state.head_params.weights[head_idx],
                    state.head_params.biases[head_idx],
                    hidden,
                )

            w_grads, b_grads = jax.grad(full_forward_i, argnums=(0, 1))(
                state.trunk_params.weights, state.trunk_params.biases
            )

            error_i = targets[i] - full_forward_i(
                state.trunk_params.weights, state.trunk_params.biases
            )

            for j in range(len(accumulated_w_grads)):
                accumulated_w_grads[j] = (
                    accumulated_w_grads[j] + error_i * w_grads[j]
                )
                accumulated_b_grads[j] = (
                    accumulated_b_grads[j] + error_i * b_grads[j]
                )

        # Compute via VJP (as the learner does)
        def trunk_fn(weights, biases):
            return MultiHeadMLPLearner._trunk_forward(
                weights, biases, obs, slope, ln
            )

        hidden, trunk_vjp_fn = jax.vjp(
            trunk_fn,
            state.trunk_params.weights,
            state.trunk_params.biases,
        )

        # Build cotangent
        h_last = hidden.shape[0]
        cotangent = jnp.zeros(h_last, dtype=jnp.float32)
        for i in range(3):
            pred_i = MultiHeadMLPLearner._head_forward(
                state.head_params.weights[i],
                state.head_params.biases[i],
                hidden,
            )
            error_i = targets[i] - pred_i
            cotangent = cotangent + error_i * jnp.squeeze(
                state.head_params.weights[i]
            )

        vjp_w_grads, vjp_b_grads = trunk_vjp_fn(cotangent)

        # Compare
        for j in range(len(accumulated_w_grads)):
            chex.assert_trees_all_close(
                vjp_w_grads[j], accumulated_w_grads[j], atol=1e-5
            )
            chex.assert_trees_all_close(
                vjp_b_grads[j], accumulated_b_grads[j], atol=1e-5
            )


# =============================================================================
# Metrics utility
# =============================================================================


class TestMultiHeadMetricsToDicts:
    """Tests for multi_head_metrics_to_dicts."""

    def test_all_active(self):
        """All active heads should produce dicts."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        result = learner.update(state, obs, targets)
        dicts = multi_head_metrics_to_dicts(result)

        assert len(dicts) == 3
        for d in dicts:
            assert d is not None
            assert "squared_error" in d
            assert "error" in d
            assert "mean_step_size" in d

    def test_partial_active(self):
        """Inactive heads should produce None."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, jnp.nan, 3.0])

        result = learner.update(state, obs, targets)
        dicts = multi_head_metrics_to_dicts(result)

        assert dicts[0] is not None
        assert dicts[1] is None
        assert dicts[2] is not None

    def test_none_active(self):
        """All NaN targets should produce all None."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([jnp.nan, jnp.nan])

        result = learner.update(state, obs, targets)
        dicts = multi_head_metrics_to_dicts(result)

        assert dicts[0] is None
        assert dicts[1] is None


# =============================================================================
# Scan loop tests
# =============================================================================


class TestRunMultiHeadLearningLoop:
    """Tests for run_multi_head_learning_loop."""

    def test_correct_shapes(self):
        """Scan loop should return correct metric shapes."""
        n_heads = 3
        num_steps = 50
        feature_dim = 5

        learner = MultiHeadMLPLearner(
            n_heads=n_heads, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=feature_dim, key=jr.key(0))

        # Generate synthetic data
        key = jr.key(42)
        k1, k2 = jr.split(key)
        observations = jr.normal(k1, (num_steps, feature_dim))
        targets = jr.normal(k2, (num_steps, n_heads))

        result = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        assert isinstance(result, MultiHeadLearningResult)
        chex.assert_shape(
            result.per_head_metrics, (num_steps, n_heads, 3)
        )

    def test_deterministic(self):
        """Same inputs should give identical results."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        observations = jr.normal(k1, (30, 5))
        targets = jr.normal(k2, (30, 2))

        result1 = run_multi_head_learning_loop(
            learner, state, observations, targets
        )
        result2 = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        chex.assert_trees_all_close(
            result1.per_head_metrics, result2.per_head_metrics
        )

    def test_nan_target_handling(self):
        """Should handle NaN targets correctly in scan loop."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(0))

        observations = jr.normal(jr.key(42), (20, 5))
        # Head 0 always active, head 1 active only first 10 steps
        targets = jr.normal(jr.key(99), (20, 2))
        targets = targets.at[10:, 1].set(jnp.nan)

        result = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        # Head 0 metrics should all be finite
        assert jnp.all(jnp.isfinite(result.per_head_metrics[:, 0, :]))

        # Head 1 metrics: first 10 steps finite, last 10 NaN
        assert jnp.all(jnp.isfinite(result.per_head_metrics[:10, 1, :]))
        assert jnp.all(jnp.isnan(result.per_head_metrics[10:, 1, 0]))

    def test_with_normalizer(self):
        """Should work with normalizer in scan loop."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(0))

        observations = jr.normal(jr.key(42), (30, 5))
        targets = jr.normal(jr.key(99), (30, 2))

        result = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        chex.assert_shape(result.per_head_metrics, (30, 2, 3))
        # Normalizer should have updated
        assert result.state.normalizer_state is not None


# =============================================================================
# Batched loop tests
# =============================================================================


class TestRunMultiHeadLearningLoopBatched:
    """Tests for run_multi_head_learning_loop_batched."""

    def test_correct_shapes(self):
        """Batched loop should return correctly shaped results."""
        n_heads = 3
        num_steps = 30
        feature_dim = 5
        n_seeds = 4

        learner = MultiHeadMLPLearner(
            n_heads=n_heads, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k1, (num_steps, feature_dim))
        targets = jr.normal(k2, (num_steps, n_heads))
        keys = jr.split(k3, n_seeds)

        result = run_multi_head_learning_loop_batched(
            learner, observations, targets, keys
        )

        assert isinstance(result, BatchedMultiHeadResult)
        chex.assert_shape(
            result.per_head_metrics, (n_seeds, num_steps, n_heads, 3)
        )

    def test_matches_sequential(self):
        """Batched results should match sequential for each seed."""
        n_heads = 2
        num_steps = 20
        feature_dim = 5
        n_seeds = 3

        learner = MultiHeadMLPLearner(
            n_heads=n_heads, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k1, (num_steps, feature_dim))
        targets = jr.normal(k2, (num_steps, n_heads))
        keys = jr.split(k3, n_seeds)

        # Batched
        batched_result = run_multi_head_learning_loop_batched(
            learner, observations, targets, keys
        )

        # Sequential
        for i in range(n_seeds):
            state_i = learner.init(feature_dim, keys[i])
            seq_result = run_multi_head_learning_loop(
                learner, state_i, observations, targets
            )
            chex.assert_trees_all_close(
                batched_result.per_head_metrics[i],
                seq_result.per_head_metrics,
                rtol=1e-4,
            )

    def test_different_seeds_different_results(self):
        """Different seeds should produce different metrics."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k1, (30, 5))
        targets = jr.normal(k2, (30, 2))
        keys = jr.split(k3, 3)

        result = run_multi_head_learning_loop_batched(
            learner, observations, targets, keys
        )

        # Different seeds should give different final metrics
        assert not jnp.allclose(
            result.per_head_metrics[0], result.per_head_metrics[1]
        )


class TestMultiHeadLifecycleTracking:
    """Tests for multi-head MLP lifecycle tracking (birth_timestamp, uptime_s)."""

    def test_birth_timestamp_set(self):
        """birth_timestamp should be set at init."""
        before = time.time()
        learner = MultiHeadMLPLearner(n_heads=2, hidden_sizes=(16,), sparsity=0.0)
        state = learner.init(feature_dim=5, key=jr.key(42))
        after = time.time()
        assert before <= state.birth_timestamp <= after

    def test_birth_timestamp_survives_update(self):
        """birth_timestamp should not change across updates."""
        learner = MultiHeadMLPLearner(n_heads=2, hidden_sizes=(16,), sparsity=0.0)
        state = learner.init(feature_dim=5, key=jr.key(42))
        original_ts = state.birth_timestamp

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])
        result = learner.update(state, obs, targets)
        assert result.state.birth_timestamp == original_ts

    def test_uptime_starts_at_zero(self):
        """uptime_s should be 0.0 after init."""
        learner = MultiHeadMLPLearner(n_heads=2, hidden_sizes=(16,), sparsity=0.0)
        state = learner.init(feature_dim=5, key=jr.key(42))
        assert state.uptime_s == 0.0

    def test_uptime_increases_after_loop(self):
        """uptime_s should be > 0 after run_multi_head_learning_loop."""
        learner = MultiHeadMLPLearner(n_heads=2, hidden_sizes=(16,), sparsity=0.0)
        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)

        state = learner.init(feature_dim=5, key=k1)
        observations = jr.normal(k2, (50, 5))
        targets = jr.normal(k3, (50, 2))

        result = run_multi_head_learning_loop(learner, state, observations, targets)
        assert result.state.uptime_s > 0.0

    def test_uptime_accumulates(self):
        """uptime_s should accumulate across sequential loops."""
        learner = MultiHeadMLPLearner(n_heads=2, hidden_sizes=(16,), sparsity=0.0)
        key = jr.key(42)
        k1, k2, k3, k4, k5 = jr.split(key, 5)

        state = learner.init(feature_dim=5, key=k1)
        obs1 = jr.normal(k2, (50, 5))
        tgt1 = jr.normal(k3, (50, 2))

        result1 = run_multi_head_learning_loop(learner, state, obs1, tgt1)
        uptime_after_first = result1.state.uptime_s
        assert uptime_after_first > 0.0

        obs2 = jr.normal(k4, (50, 5))
        tgt2 = jr.normal(k5, (50, 2))
        result2 = run_multi_head_learning_loop(
            learner, result1.state, obs2, tgt2
        )
        assert result2.state.uptime_s > uptime_after_first


# =============================================================================
# Hybrid optimizer tests
# =============================================================================


class TestMultiHeadHybridOptimizer:
    """Tests for MultiHeadMLPLearner with head_optimizer."""

    def test_hybrid_init_creates_different_states(self):
        """Head optimizer states should differ from trunk when using hybrid."""
        from alberta_framework.core.types import AutostepParamState, LMSState

        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            step_size=1.0,
            head_optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        # Trunk optimizer states should be LMS
        for trunk_opt in state.trunk_optimizer_states:
            assert isinstance(trunk_opt, LMSState)

        # Head optimizer states should be Autostep
        for w_opt, b_opt in state.head_optimizer_states:
            assert isinstance(w_opt, AutostepParamState)
            assert isinstance(b_opt, AutostepParamState)

    def test_hybrid_update_runs(self):
        """Update with hybrid optimizer should work."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            step_size=1.0,
            head_optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        assert isinstance(result, MultiHeadMLPUpdateResult)
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_head_metrics)

    def test_hybrid_scan_loop(self):
        """Full scan loop with hybrid optimizer should work."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            step_size=1.0,
            head_optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        state = learner.init(feature_dim=5, key=k1)
        observations = jr.normal(k2, (50, 5))
        targets = jr.normal(k3, (50, 2))

        result = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        assert isinstance(result, MultiHeadLearningResult)
        chex.assert_shape(result.per_head_metrics, (50, 2, 3))

    def test_hybrid_default_none_matches_uniform(self):
        """head_optimizer=None should produce same results as explicit single optimizer."""
        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k2, (30, 5))
        targets = jr.normal(k3, (30, 2))

        learner_default = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            step_size=1.0, bounder=ObGDBounding(kappa=2.0),
        )
        learner_explicit = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            step_size=1.0, head_optimizer=None,
            bounder=ObGDBounding(kappa=2.0),
        )

        state_default = learner_default.init(feature_dim=5, key=k1)
        state_explicit = learner_explicit.init(feature_dim=5, key=k1)

        result_default = run_multi_head_learning_loop(
            learner_default, state_default, observations, targets
        )
        result_explicit = run_multi_head_learning_loop(
            learner_explicit, state_explicit, observations, targets
        )

        chex.assert_trees_all_close(
            result_default.per_head_metrics,
            result_explicit.per_head_metrics,
        )


# =============================================================================
# Linear baseline tests (hidden_sizes=())
# =============================================================================


class TestMultiHeadLinearBaseline:
    """Tests for MultiHeadMLPLearner with hidden_sizes=() (linear model)."""

    def test_init_succeeds(self):
        """hidden_sizes=() should init without error."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        # No trunk layers
        assert len(state.trunk_params.weights) == 0
        assert len(state.trunk_params.biases) == 0
        assert len(state.trunk_traces) == 0
        assert len(state.trunk_optimizer_states) == 0

    def test_head_shapes_match_input(self):
        """Heads should project from feature_dim directly."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        assert len(state.head_params.weights) == 3
        for i in range(3):
            chex.assert_shape(state.head_params.weights[i], (1, 5))
            chex.assert_shape(state.head_params.biases[i], (1,))

    def test_predict_correct_shape(self):
        """predict should return (n_heads,) array."""
        learner = MultiHeadMLPLearner(
            n_heads=4, hidden_sizes=(), sparsity=0.0
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        preds = learner.predict(state, obs)

        chex.assert_shape(preds, (4,))
        chex.assert_tree_all_finite(preds)

    def test_update_correct_shape(self):
        """update should return correct shapes."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        result = learner.update(state, obs, targets)

        chex.assert_shape(result.predictions, (3,))
        chex.assert_shape(result.errors, (3,))
        chex.assert_shape(result.per_head_metrics, (3, 3))
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_head_metrics)

    def test_state_updates(self):
        """Head params should change after update."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), step_size=0.1, sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)

        # Head weights should have changed
        assert not jnp.allclose(
            result.state.head_params.weights[0],
            state.head_params.weights[0],
        )
        assert int(result.state.step_count) == 1

    def test_error_reduction(self):
        """Multiple updates on fixed target should reduce error."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), step_size=0.1, sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.array([1.0, 0.5, -0.3, 0.2, 0.8])
        targets = jnp.array([2.0, -1.0])

        initial_preds = learner.predict(state, obs)
        initial_se = float(jnp.sum((initial_preds - targets) ** 2))

        for _ in range(100):
            result = learner.update(state, obs, targets)
            state = result.state

        final_preds = learner.predict(state, obs)
        final_se = float(jnp.sum((final_preds - targets) ** 2))

        assert final_se < initial_se

    def test_nan_masking(self):
        """NaN targets should leave inactive heads unchanged."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, jnp.nan, 3.0])

        result = learner.update(state, obs, targets)

        # Head 1 should be unchanged
        chex.assert_trees_all_close(
            result.state.head_params.weights[1],
            state.head_params.weights[1],
        )
        assert jnp.isnan(result.errors[1])

    def test_scan_loop(self):
        """Should work in scan-based learning loop."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        observations = jr.normal(k1, (30, 5))
        targets = jr.normal(k2, (30, 2))

        result = run_multi_head_learning_loop(
            learner, state, observations, targets
        )

        assert isinstance(result, MultiHeadLearningResult)
        chex.assert_shape(result.per_head_metrics, (30, 2, 3))

    def test_with_normalizer(self):
        """Should work with EMANormalizer."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(), sparsity=0.0,
            normalizer=EMANormalizer(),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0])

        result = learner.update(state, obs, targets)
        chex.assert_tree_all_finite(result.predictions)
        assert result.state.normalizer_state is not None
