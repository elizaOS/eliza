"""Tests for TDLinearLearner and run_td_learning_loop."""

import time

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework import (
    TDIDBD,
    AutoTDIDBD,
    TDLinearLearner,
    TDTimeStep,
    run_td_learning_loop,
)


# Helper class to create a simple TD stream for testing
class SimpleTDStream:
    """Simple TD stream for testing that generates deterministic transitions."""

    def __init__(self, feature_dim: int = 10, gamma: float = 0.99):
        self.feature_dim = feature_dim
        self._gamma = gamma

    def init(self, key):
        """Initialize stream state."""
        return {"key": key, "step": 0}

    def step(self, state, idx):
        """Generate a TD transition."""
        key = state["key"]
        key, obs_key, next_key, reward_key = jr.split(key, 4)

        observation = jr.normal(obs_key, (self.feature_dim,), dtype=jnp.float32)
        next_observation = jr.normal(next_key, (self.feature_dim,), dtype=jnp.float32)
        reward = jr.normal(reward_key, (), dtype=jnp.float32)
        gamma = jnp.array(self._gamma, dtype=jnp.float32)

        timestep = TDTimeStep(
            observation=observation,
            reward=reward,
            next_observation=next_observation,
            gamma=gamma,
        )

        new_state = {"key": key, "step": state["step"] + 1}
        return timestep, new_state


class EpisodicTDStream:
    """TD stream with episodes that terminate periodically."""

    def __init__(self, feature_dim: int = 10, gamma: float = 0.99, episode_length: int = 10):
        self.feature_dim = feature_dim
        self._gamma = gamma
        self._episode_length = episode_length

    def init(self, key):
        """Initialize stream state."""
        return {"key": key, "step": 0}

    def step(self, state, idx):
        """Generate a TD transition with periodic termination."""
        key = state["key"]
        key, obs_key, next_key, reward_key = jr.split(key, 4)

        observation = jr.normal(obs_key, (self.feature_dim,), dtype=jnp.float32)
        next_observation = jr.normal(next_key, (self.feature_dim,), dtype=jnp.float32)
        reward = jr.normal(reward_key, (), dtype=jnp.float32)

        # Terminal state at end of episode (gamma=0)
        is_terminal = (idx % self._episode_length) == (self._episode_length - 1)
        gamma = jnp.where(is_terminal, 0.0, self._gamma)

        timestep = TDTimeStep(
            observation=observation,
            reward=reward,
            next_observation=next_observation,
            gamma=jnp.array(gamma, dtype=jnp.float32),
        )

        new_state = {"key": key, "step": state["step"] + 1}
        return timestep, new_state


class TestTDLinearLearner:
    """Tests for the TDLinearLearner class."""

    def test_init_creates_zero_weights(self, feature_dim):
        """TD Learner should initialize with zero weights and bias."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        chex.assert_shape(state.weights, (feature_dim,))
        chex.assert_trees_all_close(state.weights, jnp.zeros(feature_dim))
        chex.assert_trees_all_close(state.bias, jnp.array(0.0))

    def test_init_creates_optimizer_state(self, feature_dim):
        """TD Learner should initialize optimizer state."""
        learner = TDLinearLearner(optimizer=TDIDBD())
        state = learner.init(feature_dim)

        assert state.optimizer_state is not None
        chex.assert_shape(state.optimizer_state.log_step_sizes, (feature_dim,))
        chex.assert_shape(state.optimizer_state.eligibility_traces, (feature_dim,))
        chex.assert_shape(state.optimizer_state.h_traces, (feature_dim,))

    def test_predict_returns_correct_shape(self, feature_dim, sample_observation):
        """Prediction should return scalar (as 1D array)."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        prediction = learner.predict(state, sample_observation)

        chex.assert_shape(prediction, (1,))

    def test_predict_with_zero_weights_is_bias(self, feature_dim, sample_observation):
        """With zero weights, prediction should equal bias."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        prediction = learner.predict(state, sample_observation)

        chex.assert_trees_all_close(prediction[0], state.bias)

    def test_update_returns_correct_shapes(self, feature_dim, sample_observation):
        """Update should return correctly shaped results."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        next_obs = sample_observation * 0.9
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        chex.assert_shape(result.state.weights, (feature_dim,))
        chex.assert_shape(result.prediction, (1,))
        chex.assert_shape(result.td_error, (1,))
        chex.assert_shape(result.metrics, (4,))

    def test_update_computes_correct_td_error(self, feature_dim, sample_observation):
        """TD error should be computed correctly: δ = R + γV(s') - V(s)."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        # Set non-zero weights for meaningful test
        weights = jnp.ones(feature_dim, dtype=jnp.float32) * 0.1
        state = state.replace(
            weights=weights,
            bias=jnp.array(0.5, dtype=jnp.float32),
        )

        next_obs = sample_observation * 0.5
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        # Manually compute expected TD error
        v_s = jnp.dot(weights, sample_observation) + 0.5
        v_s_prime = jnp.dot(weights, next_obs) + 0.5
        expected_td_error = reward + gamma * v_s_prime - v_s

        chex.assert_trees_all_close(result.td_error[0], expected_td_error, atol=1e-5)

    def test_update_modifies_weights(self, feature_dim, sample_observation):
        """Update should modify weights based on TD error."""
        learner = TDLinearLearner(optimizer=TDIDBD(initial_step_size=0.1))
        state = learner.init(feature_dim)

        next_obs = sample_observation * 0.9
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        # Run a few updates to build up eligibility traces
        for _ in range(5):
            result = learner.update(state, sample_observation, reward, next_obs, gamma)
            state = result.state

        # Weights should have changed from zero
        assert not jnp.allclose(state.weights, jnp.zeros(feature_dim))

    def test_update_with_zero_td_error(self, feature_dim, sample_observation):
        """Update should handle zero TD error gracefully."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        # When V(s) = V(s') = 0 and reward = 0, TD error = 0
        next_obs = sample_observation
        reward = jnp.array(0.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        chex.assert_tree_all_finite(result.state.weights)
        chex.assert_tree_all_finite(result.td_error)

    def test_terminal_state_handling(self, feature_dim, sample_observation):
        """Terminal states (gamma=0) should be handled correctly."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        next_obs = sample_observation * 0.9
        reward = jnp.array(1.0)
        gamma = jnp.array(0.0)  # Terminal state

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        # TD error should be R - V(s) when gamma=0
        expected_td_error = reward - jnp.dot(state.weights, sample_observation) - state.bias
        chex.assert_trees_all_close(result.td_error[0], expected_td_error, atol=1e-5)
        chex.assert_tree_all_finite(result.state.weights)

    def test_metrics_contain_expected_values(self, feature_dim, sample_observation):
        """Metrics should contain squared TD error, TD error, mean step-size, and mean trace."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        next_obs = sample_observation * 0.9
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        # metrics = [squared_td_error, td_error, mean_step_size, mean_eligibility_trace]
        squared_td_error = result.metrics[0]
        td_error = result.metrics[1]
        mean_step_size = result.metrics[2]

        # Verify squared TD error is square of TD error
        chex.assert_trees_all_close(squared_td_error, td_error**2, atol=1e-5)

        # Mean step-size should be positive
        assert mean_step_size > 0

        # All metrics should be finite
        chex.assert_tree_all_finite(result.metrics)

    def test_works_with_autotdidbd(self, feature_dim, sample_observation):
        """TD Learner should work with AutoTDIDBD optimizer."""
        learner = TDLinearLearner(optimizer=AutoTDIDBD())
        state = learner.init(feature_dim)

        next_obs = sample_observation * 0.9
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, sample_observation, reward, next_obs, gamma)

        assert result.state is not None
        chex.assert_shape(result.metrics, (4,))
        chex.assert_tree_all_finite(result.state.weights)

    def test_default_optimizer_is_tdidbd(self, feature_dim):
        """Default optimizer should be TDIDBD."""
        learner = TDLinearLearner()
        state = learner.init(feature_dim)

        # TDIDBD state has log_step_sizes, eligibility_traces, h_traces
        assert hasattr(state.optimizer_state, "log_step_sizes")
        assert hasattr(state.optimizer_state, "eligibility_traces")
        assert hasattr(state.optimizer_state, "h_traces")


class TestRunTDLearningLoop:
    """Tests for the run_td_learning_loop function."""

    def test_returns_correct_metric_shape(self, rng_key):
        """Should return metrics with shape (num_steps, 4)."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        num_steps = 100
        _, metrics = run_td_learning_loop(learner, stream, num_steps, rng_key)

        chex.assert_shape(metrics, (num_steps, 4))

    def test_returns_valid_final_state(self, rng_key):
        """Final state should have correct structure and finite values."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        state, _ = run_td_learning_loop(learner, stream, num_steps=50, key=rng_key)

        chex.assert_shape(state.weights, (5,))
        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(state.bias)

    def test_can_resume_from_existing_state(self, rng_key):
        """Should be able to continue from a previous state."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        # First run
        key1, key2 = jr.split(rng_key)
        state1, _ = run_td_learning_loop(learner, stream, num_steps=50, key=key1)

        # Continue from state1 with new key for stream
        state2, _ = run_td_learning_loop(
            learner, stream, num_steps=50, key=key2, learner_state=state1
        )

        # Weights should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(state1.weights, state2.weights)

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same results."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        state1, metrics1 = run_td_learning_loop(learner, stream, num_steps=50, key=rng_key)
        state2, metrics2 = run_td_learning_loop(learner, stream, num_steps=50, key=rng_key)

        chex.assert_trees_all_close(state1.weights, state2.weights)
        chex.assert_trees_all_close(metrics1, metrics2)

    def test_eligibility_traces_accumulate(self, rng_key):
        """Eligibility traces should accumulate over the learning loop."""
        stream = SimpleTDStream(feature_dim=5, gamma=0.99)
        learner = TDLinearLearner(optimizer=TDIDBD(trace_decay=0.9))

        state, _ = run_td_learning_loop(learner, stream, num_steps=100, key=rng_key)

        # Eligibility traces should be non-zero after many steps
        assert jnp.any(state.optimizer_state.eligibility_traces != 0)

    def test_handles_episodic_stream(self, rng_key):
        """Should handle episodic streams with terminal states (gamma=0)."""
        stream = EpisodicTDStream(feature_dim=5, gamma=0.99, episode_length=10)
        learner = TDLinearLearner()

        state, metrics = run_td_learning_loop(learner, stream, num_steps=100, key=rng_key)

        # Should complete without errors and produce finite values
        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(metrics)

    def test_weights_evolve_during_learning(self, rng_key):
        """Weights should change during the learning loop."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner(optimizer=TDIDBD(initial_step_size=0.1))

        initial_state = learner.init(stream.feature_dim)
        final_state, _ = run_td_learning_loop(
            learner, stream, num_steps=100, key=rng_key, learner_state=initial_state
        )

        # Weights should have changed from initial zeros
        assert not jnp.allclose(final_state.weights, initial_state.weights)

    def test_metrics_all_finite(self, rng_key):
        """All metrics should be finite throughout learning."""
        stream = SimpleTDStream(feature_dim=10)
        learner = TDLinearLearner()

        _, metrics = run_td_learning_loop(learner, stream, num_steps=500, key=rng_key)

        chex.assert_tree_all_finite(metrics)

    def test_works_with_autotdidbd(self, rng_key):
        """Learning loop should work with AutoTDIDBD optimizer."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner(optimizer=AutoTDIDBD())

        state, metrics = run_td_learning_loop(learner, stream, num_steps=100, key=rng_key)

        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(metrics)
        # AutoTDIDBD state should have normalizers
        assert hasattr(state.optimizer_state, "normalizers")

    def test_long_training_remains_stable(self, rng_key):
        """Long training should remain numerically stable."""
        stream = SimpleTDStream(feature_dim=10, gamma=0.99)
        learner = TDLinearLearner(optimizer=TDIDBD(initial_step_size=0.01))

        state, metrics = run_td_learning_loop(learner, stream, num_steps=5000, key=rng_key)

        # Should remain finite even after many steps
        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(state.optimizer_state.log_step_sizes)
        chex.assert_tree_all_finite(state.optimizer_state.eligibility_traces)
        chex.assert_tree_all_finite(state.optimizer_state.h_traces)
        chex.assert_tree_all_finite(metrics)


class TestTDLearnerWithDifferentOptimizers:
    """Integration tests comparing TDIDBD and AutoTDIDBD in learning loops."""

    def test_both_optimizers_produce_valid_learning(self, rng_key):
        """Both TD optimizers should produce valid learning trajectories."""
        stream = SimpleTDStream(feature_dim=5)

        tdidbd_learner = TDLinearLearner(optimizer=TDIDBD())
        auto_learner = TDLinearLearner(optimizer=AutoTDIDBD())

        tdidbd_state, tdidbd_metrics = run_td_learning_loop(
            tdidbd_learner, stream, num_steps=100, key=rng_key
        )
        auto_state, auto_metrics = run_td_learning_loop(
            auto_learner, stream, num_steps=100, key=rng_key
        )

        # Both should produce finite results
        chex.assert_tree_all_finite(tdidbd_state.weights)
        chex.assert_tree_all_finite(auto_state.weights)
        chex.assert_tree_all_finite(tdidbd_metrics)
        chex.assert_tree_all_finite(auto_metrics)

    def test_semi_gradient_vs_ordinary_gradient(self, rng_key):
        """Semi-gradient and ordinary gradient should both learn."""
        stream = SimpleTDStream(feature_dim=5)

        semi_learner = TDLinearLearner(optimizer=TDIDBD(use_semi_gradient=True))
        ordinary_learner = TDLinearLearner(optimizer=TDIDBD(use_semi_gradient=False))

        semi_state, _ = run_td_learning_loop(semi_learner, stream, num_steps=100, key=rng_key)
        ordinary_state, _ = run_td_learning_loop(
            ordinary_learner, stream, num_steps=100, key=rng_key
        )

        # Both should produce finite weights
        chex.assert_tree_all_finite(semi_state.weights)
        chex.assert_tree_all_finite(ordinary_state.weights)

        # h_traces should differ between the two methods
        # (they evolve differently based on semi vs ordinary gradient)


class TestTDLifecycleTracking:
    """Tests for TD learner lifecycle tracking."""

    def test_step_count_starts_at_zero(self):
        """step_count should be 0 after init."""
        learner = TDLinearLearner()
        state = learner.init(5)
        assert int(state.step_count) == 0

    def test_step_count_increments(self):
        """step_count should increment on update."""
        learner = TDLinearLearner()
        state = learner.init(5)

        obs = jnp.ones(5)
        next_obs = jnp.zeros(5)
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, obs, reward, next_obs, gamma)
        assert int(result.state.step_count) == 1

    def test_birth_timestamp_set(self):
        """birth_timestamp should be set at init."""
        before = time.time()
        learner = TDLinearLearner()
        state = learner.init(5)
        after = time.time()
        assert before <= state.birth_timestamp <= after

    def test_birth_timestamp_survives_update(self):
        """birth_timestamp should not change across updates."""
        learner = TDLinearLearner()
        state = learner.init(5)
        original_ts = state.birth_timestamp

        obs = jnp.ones(5)
        next_obs = jnp.zeros(5)
        reward = jnp.array(1.0)
        gamma = jnp.array(0.99)

        result = learner.update(state, obs, reward, next_obs, gamma)
        assert result.state.birth_timestamp == original_ts

    def test_uptime_increases_after_loop(self, rng_key):
        """uptime_s should be > 0 after run_td_learning_loop."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        state, _ = run_td_learning_loop(learner, stream, num_steps=100, key=rng_key)
        assert state.uptime_s > 0.0

    def test_step_count_after_loop(self, rng_key):
        """step_count should equal num_steps after learning loop."""
        stream = SimpleTDStream(feature_dim=5)
        learner = TDLinearLearner()

        state, _ = run_td_learning_loop(learner, stream, num_steps=200, key=rng_key)
        assert int(state.step_count) == 200
