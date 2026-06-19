"""Tests verifying the single-step API for daemon-style usage.

Validates that predict() and update() work correctly with unbatched
observations (one at a time), which is the usage pattern for rlsecd
and other daemon deployments.
"""

import time

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    Autostep,
    EMANormalizer,
    MLPLearner,
    MultiHeadMLPLearner,
    ObGDBounding,
)


class TestMultiHeadSingleStep:
    """Verify MultiHeadMLPLearner works with single unbatched observations."""

    def test_predict_unbatched(self):
        """predict() should work with a 1D observation."""
        learner = MultiHeadMLPLearner(
            n_heads=5, hidden_sizes=(64, 64), sparsity=0.0,
        )
        state = learner.init(feature_dim=20, key=jr.key(42))

        obs = jnp.ones(20)  # Single observation, not batched
        preds = learner.predict(state, obs)

        chex.assert_shape(preds, (5,))
        chex.assert_tree_all_finite(preds)

    def test_update_unbatched(self):
        """update() should work with a single 1D observation."""
        learner = MultiHeadMLPLearner(
            n_heads=5, hidden_sizes=(64, 64), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=20, key=jr.key(42))

        obs = jnp.ones(20)
        targets = jnp.array([1.0, 2.0, 3.0, 4.0, 5.0])

        result = learner.update(state, obs, targets)

        chex.assert_shape(result.predictions, (5,))
        chex.assert_shape(result.errors, (5,))
        chex.assert_shape(result.per_head_metrics, (5, 3))
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_head_metrics)

    def test_step_count_increments_over_single_steps(self):
        """step_count should increment correctly over multiple single steps."""
        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), sparsity=0.0,
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 2.0, 3.0])

        for i in range(10):
            result = learner.update(state, obs, targets)
            state = result.state
            assert int(state.step_count) == i + 1

    def test_normalizer_updates_per_step(self):
        """Normalizer state should update with each single observation."""
        learner = MultiHeadMLPLearner(
            n_heads=2, hidden_sizes=(16,), sparsity=0.0,
            normalizer=EMANormalizer(decay=0.99),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        # Feed different observations
        for i in range(5):
            obs = jnp.full(5, float(i + 1))
            targets = jnp.array([1.0, 2.0])
            result = learner.update(state, obs, targets)
            state = result.state

        # Normalizer mean should reflect the observations
        assert state.normalizer_state is not None
        assert float(state.normalizer_state.sample_count) == 5.0
        # Mean should be closer to 3.0 (average of 1,2,3,4,5)
        assert float(jnp.mean(state.normalizer_state.mean)) > 0.0

    def test_nan_masking_single_step(self):
        """NaN targets should correctly mask individual heads per step."""
        learner = MultiHeadMLPLearner(
            n_heads=5, hidden_sizes=(16,), sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        # Only heads 0 and 3 active
        targets = jnp.array([1.0, jnp.nan, jnp.nan, 2.0, jnp.nan])

        result = learner.update(state, obs, targets)

        # Active heads should have finite errors
        assert jnp.isfinite(result.errors[0])
        assert jnp.isfinite(result.errors[3])

        # Inactive heads should have NaN errors
        assert jnp.isnan(result.errors[1])
        assert jnp.isnan(result.errors[2])
        assert jnp.isnan(result.errors[4])

        # Inactive head params unchanged
        for i in [1, 2, 4]:
            chex.assert_trees_all_close(
                result.state.head_params.weights[i],
                state.head_params.weights[i],
            )

    def test_jit_warmup_pattern(self):
        """Demonstrate the JIT warmup pattern; second call should be faster."""
        learner = MultiHeadMLPLearner(
            n_heads=5, hidden_sizes=(64, 64), sparsity=0.9,
            optimizer=Autostep(initial_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
            normalizer=EMANormalizer(decay=0.99),
        )
        state = learner.init(feature_dim=20, key=jr.key(42))

        # Warmup calls (trigger JIT trace)
        dummy_obs = jnp.zeros(20)
        dummy_targets = jnp.full(5, jnp.nan)
        _ = learner.predict(state, dummy_obs)
        result = learner.update(state, dummy_obs, dummy_targets)

        # Time 100 subsequent calls — should be fast (already compiled)
        obs = jnp.ones(20)
        targets = jnp.array([1.0, 0.5, jnp.nan, 3.0, jnp.nan])

        current_state = state
        t0 = time.time()
        for _ in range(100):
            result = learner.update(current_state, obs, targets)
            current_state = result.state
        elapsed = time.time() - t0

        # Verify it ran successfully
        assert int(current_state.step_count) == 100
        chex.assert_tree_all_finite(result.predictions)
        # 100 single-step updates should complete in reasonable time
        # (Just verifying it works, not a strict performance assertion)
        assert elapsed < 30.0  # generous upper bound


class TestMLPSingleStep:
    """Verify MLPLearner works with single unbatched observations."""

    def test_predict_unbatched(self):
        """predict() should work with a 1D observation."""
        learner = MLPLearner(
            hidden_sizes=(32, 32), step_size=1.0, sparsity=0.0,
        )
        state = learner.init(feature_dim=10, key=jr.key(42))

        obs = jnp.ones(10)
        pred = learner.predict(state, obs)

        # MLPLearner output layer is Dense(1), so prediction has shape (1,)
        chex.assert_shape(pred, (1,))
        chex.assert_tree_all_finite(pred)

    def test_update_unbatched(self):
        """update() should work with a single 1D observation."""
        learner = MLPLearner(
            hidden_sizes=(32, 32), step_size=1.0, sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=10, key=jr.key(42))

        obs = jnp.ones(10)
        target = jnp.array([2.0])

        result = learner.update(state, obs, target)

        chex.assert_shape(result.prediction, (1,))
        chex.assert_tree_all_finite(result.prediction)
        assert int(result.state.step_count) == 1

    def test_step_count_increments(self):
        """step_count should increment correctly over single steps."""
        learner = MLPLearner(
            hidden_sizes=(16,), step_size=1.0, sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        obs = jnp.ones(5)
        target = jnp.array([1.0])

        for i in range(10):
            result = learner.update(state, obs, target)
            state = result.state
            assert int(state.step_count) == i + 1

    def test_normalizer_updates_per_step(self):
        """Normalizer state should update with each single observation."""
        learner = MLPLearner(
            hidden_sizes=(16,), step_size=1.0, sparsity=0.0,
            normalizer=EMANormalizer(decay=0.99),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(feature_dim=5, key=jr.key(42))

        for i in range(5):
            obs = jnp.full(5, float(i + 1))
            target = jnp.array([1.0])
            result = learner.update(state, obs, target)
            state = result.state

        assert state.normalizer_state is not None
        assert float(state.normalizer_state.sample_count) == 5.0
