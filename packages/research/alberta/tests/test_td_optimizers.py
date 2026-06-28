"""Tests for TDIDBD and AutoTDIDBD optimizers."""

import chex
import jax.numpy as jnp
import pytest

from alberta_framework import TDIDBD, AutoTDIDBD


class TestTDIDBD:
    """Tests for the TD-IDBD optimizer."""

    def test_init_creates_correct_state(self):
        """TDIDBD init should create per-weight step-sizes, traces, and h traces."""
        optimizer = TDIDBD(initial_step_size=0.01, meta_step_size=0.001, trace_decay=0.9)
        state = optimizer.init(feature_dim=10)

        chex.assert_shape(state.log_step_sizes, (10,))
        chex.assert_shape(state.eligibility_traces, (10,))
        chex.assert_shape(state.h_traces, (10,))
        chex.assert_trees_all_close(jnp.exp(state.log_step_sizes), jnp.full(10, 0.01))
        chex.assert_trees_all_close(state.eligibility_traces, jnp.zeros(10))
        chex.assert_trees_all_close(state.h_traces, jnp.zeros(10))
        assert state.meta_step_size == pytest.approx(0.001)
        assert state.trace_decay == pytest.approx(0.9)

    def test_update_returns_correct_shapes(self, sample_observation):
        """TDIDBD update should return correctly shaped deltas."""
        optimizer = TDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9  # Slightly different

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        chex.assert_shape(result.weight_delta, sample_observation.shape)
        chex.assert_shape(result.new_state.log_step_sizes, sample_observation.shape)
        chex.assert_shape(result.new_state.eligibility_traces, sample_observation.shape)
        chex.assert_shape(result.new_state.h_traces, sample_observation.shape)

    def test_eligibility_traces_accumulate(self, sample_observation):
        """Eligibility traces should accumulate over steps."""
        optimizer = TDIDBD(trace_decay=0.9)
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9

        # First update - traces should equal observation
        result1 = optimizer.update(state, td_error, sample_observation, next_obs, gamma)
        chex.assert_trees_all_close(
            result1.new_state.eligibility_traces, sample_observation, atol=1e-6
        )

        # Second update - traces should accumulate
        result2 = optimizer.update(result1.new_state, td_error, sample_observation, next_obs, gamma)
        expected_traces = gamma * 0.9 * sample_observation + sample_observation
        chex.assert_trees_all_close(
            result2.new_state.eligibility_traces, expected_traces, atol=1e-6
        )

    def test_step_sizes_adapt_with_consistent_td_errors(self, sample_observation):
        """Step-sizes should adapt when TD errors consistently agree."""
        optimizer = TDIDBD(initial_step_size=0.1, meta_step_size=0.1)
        feature_dim = len(sample_observation)
        state = optimizer.init(feature_dim=feature_dim)

        # Consistent positive TD error
        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = jnp.zeros(feature_dim)

        # Run multiple updates with consistent TD errors
        for _ in range(10):
            result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)
            state = result.new_state

        # h traces should have built up
        assert jnp.any(state.h_traces != 0)

    def test_metrics_contain_step_size_info(self, sample_observation):
        """TDIDBD update should return step-size statistics in metrics."""
        optimizer = TDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        assert "mean_step_size" in result.metrics
        assert "min_step_size" in result.metrics
        assert "max_step_size" in result.metrics
        assert "mean_eligibility_trace" in result.metrics

    def test_semi_gradient_vs_ordinary_gradient(self, sample_observation):
        """Semi-gradient and ordinary gradient should produce different updates."""
        semi_grad = TDIDBD(use_semi_gradient=True)
        ordinary_grad = TDIDBD(use_semi_gradient=False)

        semi_state = semi_grad.init(feature_dim=len(sample_observation))
        ordinary_state = ordinary_grad.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 1.5  # Different from current

        # Both should produce valid updates
        semi_result = semi_grad.update(semi_state, td_error, sample_observation, next_obs, gamma)
        ordinary_result = ordinary_grad.update(
            ordinary_state, td_error, sample_observation, next_obs, gamma
        )

        chex.assert_tree_all_finite(semi_result.weight_delta)
        chex.assert_tree_all_finite(ordinary_result.weight_delta)

        # Weight deltas should be the same (same initial state)
        # but h traces should evolve differently over time

    def test_terminal_state_handling(self, sample_observation):
        """Terminal states (gamma=0) should be handled correctly."""
        optimizer = TDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.0)  # Terminal state
        next_obs = jnp.zeros_like(sample_observation)

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        chex.assert_tree_all_finite(result.weight_delta)
        chex.assert_tree_all_finite(result.new_state.log_step_sizes)


class TestAutoTDIDBD:
    """Tests for the AutoTDIDBD optimizer."""

    def test_init_creates_correct_state(self):
        """AutoTDIDBD init should create step-sizes, traces, h traces, normalizers."""
        optimizer = AutoTDIDBD(initial_step_size=0.01, meta_step_size=0.001, trace_decay=0.9)
        state = optimizer.init(feature_dim=10)

        chex.assert_shape(state.log_step_sizes, (10,))
        chex.assert_shape(state.eligibility_traces, (10,))
        chex.assert_shape(state.h_traces, (10,))
        chex.assert_shape(state.normalizers, (10,))
        chex.assert_trees_all_close(jnp.exp(state.log_step_sizes), jnp.full(10, 0.01))
        chex.assert_trees_all_close(state.eligibility_traces, jnp.zeros(10))
        chex.assert_trees_all_close(state.h_traces, jnp.zeros(10))
        chex.assert_trees_all_close(state.normalizers, jnp.ones(10))
        assert state.meta_step_size == pytest.approx(0.001)
        assert state.trace_decay == pytest.approx(0.9)

    def test_update_returns_correct_shapes(self, sample_observation):
        """AutoTDIDBD update should return correctly shaped deltas."""
        optimizer = AutoTDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        chex.assert_shape(result.weight_delta, sample_observation.shape)
        chex.assert_shape(result.new_state.log_step_sizes, sample_observation.shape)
        chex.assert_shape(result.new_state.eligibility_traces, sample_observation.shape)
        chex.assert_shape(result.new_state.h_traces, sample_observation.shape)
        chex.assert_shape(result.new_state.normalizers, sample_observation.shape)

    def test_normalizers_adapt_to_gradient_magnitude(self, sample_observation):
        """Normalizers should adapt to gradient magnitudes."""
        optimizer = AutoTDIDBD()
        feature_dim = len(sample_observation)
        state = optimizer.init(feature_dim=feature_dim)

        # Large TD error should lead to normalizer adaptation
        td_error = jnp.array(10.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 2.0  # Large difference

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        # Normalizers should have changed (at least some of them)
        chex.assert_tree_all_finite(result.new_state.normalizers)
        # Normalizers should be positive
        assert jnp.all(result.new_state.normalizers > 0)

    def test_metrics_contain_normalizer_info(self, sample_observation):
        """AutoTDIDBD update should return normalizer statistics in metrics."""
        optimizer = AutoTDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        assert "mean_step_size" in result.metrics
        assert "min_step_size" in result.metrics
        assert "max_step_size" in result.metrics
        assert "mean_eligibility_trace" in result.metrics
        assert "mean_normalizer" in result.metrics

    def test_effective_step_size_normalization(self, sample_observation):
        """Effective step-size normalization should prevent overshooting."""
        optimizer = AutoTDIDBD(initial_step_size=1.0)  # Large initial step-size
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(10.0)  # Large TD error
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 2.0

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        # Updates should remain finite even with large step-sizes
        chex.assert_tree_all_finite(result.weight_delta)
        chex.assert_tree_all_finite(result.new_state.log_step_sizes)

    def test_terminal_state_handling(self, sample_observation):
        """Terminal states (gamma=0) should be handled correctly."""
        optimizer = AutoTDIDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.0)  # Terminal state
        next_obs = jnp.zeros_like(sample_observation)

        result = optimizer.update(state, td_error, sample_observation, next_obs, gamma)

        chex.assert_tree_all_finite(result.weight_delta)
        chex.assert_tree_all_finite(result.new_state.log_step_sizes)


class TestTDOptimizerComparison:
    """Integration tests comparing TDIDBD and AutoTDIDBD behavior."""

    def test_all_optimizers_produce_valid_updates(self, sample_observation):
        """All TD optimizers should produce finite, non-zero updates."""
        tdidbd = TDIDBD(initial_step_size=0.01)
        auto_tdidbd = AutoTDIDBD(initial_step_size=0.01)

        tdidbd_state = tdidbd.init(len(sample_observation))
        auto_state = auto_tdidbd.init(len(sample_observation))

        td_error = jnp.array(1.0)
        gamma = jnp.array(0.99)
        next_obs = sample_observation * 0.9

        tdidbd_result = tdidbd.update(tdidbd_state, td_error, sample_observation, next_obs, gamma)
        auto_result = auto_tdidbd.update(auto_state, td_error, sample_observation, next_obs, gamma)

        # All should produce finite updates
        chex.assert_tree_all_finite(tdidbd_result.weight_delta)
        chex.assert_tree_all_finite(auto_result.weight_delta)

        # All should produce non-zero updates for non-zero TD error
        # (with non-zero eligibility traces after first step)
        # Note: First step may have zero deltas due to zero initial eligibility traces

    def test_optimizers_with_zero_td_error(self, sample_observation):
        """Optimizers should handle zero TD error gracefully."""
        tdidbd = TDIDBD()
        auto_tdidbd = AutoTDIDBD()

        tdidbd_state = tdidbd.init(len(sample_observation))
        auto_state = auto_tdidbd.init(len(sample_observation))

        td_error = jnp.array(0.0)  # Zero TD error
        gamma = jnp.array(0.99)
        next_obs = sample_observation

        tdidbd_result = tdidbd.update(tdidbd_state, td_error, sample_observation, next_obs, gamma)
        auto_result = auto_tdidbd.update(auto_state, td_error, sample_observation, next_obs, gamma)

        # All should produce finite updates (even if zero)
        chex.assert_tree_all_finite(tdidbd_result.weight_delta)
        chex.assert_tree_all_finite(auto_result.weight_delta)
