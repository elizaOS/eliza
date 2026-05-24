"""Tests for Step 1 baseline optimizers."""

import chex
import jax.numpy as jnp
import pytest

from alberta_framework.core.baseline_optimizers import (
    NADALINE,
    AdaGain,
    AdaGainState,
    Adam,
    AdamParamState,
    AdamState,
    NadalineState,
    RMSprop,
    RMSpropParamState,
    RMSpropState,
)

# =============================================================================
# AdaGain
# =============================================================================


class TestAdaGain:
    """Tests for the AdaGain optimizer."""

    def test_init_shapes(self):
        """AdaGain ``init`` should produce per-feature gains and traces."""
        optimizer = AdaGain(
            initial_step_size=0.05,
            meta_step_size=0.001,
            forgetting_rate=0.1,
        )
        state = optimizer.init(feature_dim=10)

        assert isinstance(state, AdaGainState)
        chex.assert_shape(state.step_sizes, (10,))
        chex.assert_shape(state.gradient_trace, (10,))
        chex.assert_trees_all_close(state.step_sizes, jnp.full(10, 0.05))
        chex.assert_trees_all_close(state.gradient_trace, jnp.zeros(10))
        assert float(state.bias_step_size) == pytest.approx(0.05)
        assert float(state.meta_step_size) == pytest.approx(0.001)
        assert float(state.forgetting_rate) == pytest.approx(0.1)

    def test_update_returns_finite_metrics(self, sample_observation):
        """AdaGain ``update`` should produce finite outputs over 5 steps."""
        optimizer = AdaGain()
        state = optimizer.init(feature_dim=len(sample_observation))

        for i in range(5):
            error = jnp.array(1.0 + 0.1 * i)
            result = optimizer.update(state, error, sample_observation)
            chex.assert_tree_all_finite(result.weight_delta)
            chex.assert_tree_all_finite(result.bias_delta)
            chex.assert_tree_all_finite(result.new_state)
            for v in result.metrics.values():
                chex.assert_tree_all_finite(v)
            state = result.new_state

    def test_to_from_config_roundtrip(self):
        """AdaGain config roundtrip should preserve all parameters."""
        original = AdaGain(
            initial_step_size=0.1,
            meta_step_size=0.01,
            forgetting_rate=0.2,
        )
        config = original.to_config()
        kwargs = {k: v for k, v in config.items() if k != "type"}
        recreated = AdaGain(**kwargs)

        assert recreated.to_config() == config


# =============================================================================
# Adam
# =============================================================================


class TestAdam:
    """Tests for the Adam optimizer."""

    def test_init_shapes(self):
        """Adam ``init`` should produce arrays with feature_dim shape."""
        optimizer = Adam(step_size=0.001, beta1=0.9, beta2=0.999, eps=1e-8)
        state = optimizer.init(feature_dim=10)

        assert isinstance(state, AdamState)
        chex.assert_shape(state.m, (10,))
        chex.assert_shape(state.v, (10,))
        chex.assert_shape(state.bias_m, ())
        chex.assert_shape(state.bias_v, ())
        chex.assert_shape(state.t, ())
        chex.assert_trees_all_close(state.m, jnp.zeros(10))
        chex.assert_trees_all_close(state.v, jnp.zeros(10))
        assert float(state.t) == pytest.approx(0.0)
        assert float(state.step_size) == pytest.approx(0.001)
        assert float(state.beta1) == pytest.approx(0.9)
        assert float(state.beta2) == pytest.approx(0.999)
        assert float(state.eps) == pytest.approx(1e-8)

    def test_update_returns_finite_metrics(self, sample_observation):
        """Adam ``update`` should produce finite outputs over 5 steps."""
        optimizer = Adam(step_size=0.01)
        state = optimizer.init(feature_dim=len(sample_observation))

        for i in range(5):
            error = jnp.array(1.0 + 0.1 * i)
            result = optimizer.update(state, error, sample_observation)
            chex.assert_tree_all_finite(result.weight_delta)
            chex.assert_tree_all_finite(result.bias_delta)
            chex.assert_tree_all_finite(result.new_state)
            for v in result.metrics.values():
                chex.assert_tree_all_finite(v)
            state = result.new_state

    def test_update_from_gradient_finite(self):
        """Adam ``update_from_gradient`` should produce finite outputs."""
        optimizer = Adam(step_size=0.01)
        state = optimizer.init_for_shape((8, 4))

        for i in range(5):
            gradient = jnp.ones((8, 4)) * 0.1 * (i + 1)
            error = jnp.array(0.5)
            step, state = optimizer.update_from_gradient(state, gradient, error=error)
            chex.assert_shape(step, (8, 4))
            chex.assert_tree_all_finite(step)
            chex.assert_tree_all_finite(state)

    def test_to_from_config_roundtrip(self):
        """Adam config roundtrip should preserve all parameters."""
        original = Adam(step_size=0.005, beta1=0.85, beta2=0.995, eps=1e-7)
        config = original.to_config()
        # Drop the type tag for direct reconstruction
        kwargs = {k: v for k, v in config.items() if k != "type"}
        recreated = Adam(**kwargs)

        assert recreated.to_config() == config

    def test_state_init_for_shape(self):
        """``init_for_shape((3, 4))`` should produce 2D-shaped moments."""
        optimizer = Adam(step_size=0.001)
        state = optimizer.init_for_shape((3, 4))

        assert isinstance(state, AdamParamState)
        chex.assert_shape(state.m, (3, 4))
        chex.assert_shape(state.v, (3, 4))
        chex.assert_shape(state.t, ())
        chex.assert_trees_all_close(state.m, jnp.zeros((3, 4)))
        chex.assert_trees_all_close(state.v, jnp.zeros((3, 4)))

    def test_bias_correction_at_t1(self):
        """At t=1, bias-corrected first moment should equal the gradient.

        ``m_hat = m / (1 - beta1) = ((1 - beta1) * g) / (1 - beta1) = g``
        """
        optimizer = Adam(step_size=0.001, beta1=0.9, beta2=0.999, eps=1e-8)
        state = optimizer.init_for_shape((4,))

        # Pure descent path: error=None means gradient is the loss gradient
        gradient = jnp.array([1.0, -2.0, 3.0, -4.0], dtype=jnp.float32)
        step, new_state = optimizer.update_from_gradient(state, gradient, error=None)

        # m_hat at t=1 should equal the gradient exactly
        m_hat = new_state.m / (1.0 - new_state.beta1**new_state.t)
        chex.assert_trees_all_close(m_hat, gradient, atol=1e-6)

        # v_hat at t=1 should equal gradient**2
        v_hat = new_state.v / (1.0 - new_state.beta2**new_state.t)
        chex.assert_trees_all_close(v_hat, gradient**2, atol=1e-6)

    def test_t_counter_increments(self):
        """``t`` should increment by 1 on each call."""
        optimizer = Adam(step_size=0.001)
        state = optimizer.init_for_shape((3,))
        assert float(state.t) == pytest.approx(0.0)

        for expected_t in (1.0, 2.0, 3.0):
            _, state = optimizer.update_from_gradient(
                state, jnp.ones(3), error=jnp.array(1.0)
            )
            assert float(state.t) == pytest.approx(expected_t)


# =============================================================================
# RMSprop
# =============================================================================


class TestRMSprop:
    """Tests for the RMSprop optimizer."""

    def test_init_shapes(self):
        """RMSprop ``init`` should produce arrays with feature_dim shape."""
        optimizer = RMSprop(step_size=0.001, decay=0.99, eps=1e-8)
        state = optimizer.init(feature_dim=10)

        assert isinstance(state, RMSpropState)
        chex.assert_shape(state.v, (10,))
        chex.assert_shape(state.bias_v, ())
        chex.assert_trees_all_close(state.v, jnp.zeros(10))
        assert float(state.step_size) == pytest.approx(0.001)
        assert float(state.decay) == pytest.approx(0.99)
        assert float(state.eps) == pytest.approx(1e-8)

    def test_update_returns_finite_metrics(self, sample_observation):
        """RMSprop ``update`` should produce finite outputs over 5 steps."""
        optimizer = RMSprop(step_size=0.01)
        state = optimizer.init(feature_dim=len(sample_observation))

        for i in range(5):
            error = jnp.array(1.0 + 0.1 * i)
            result = optimizer.update(state, error, sample_observation)
            chex.assert_tree_all_finite(result.weight_delta)
            chex.assert_tree_all_finite(result.bias_delta)
            chex.assert_tree_all_finite(result.new_state)
            for v in result.metrics.values():
                chex.assert_tree_all_finite(v)
            state = result.new_state

    def test_update_from_gradient_finite(self):
        """RMSprop ``update_from_gradient`` should produce finite outputs."""
        optimizer = RMSprop(step_size=0.01)
        state = optimizer.init_for_shape((8, 4))

        for i in range(5):
            gradient = jnp.ones((8, 4)) * 0.1 * (i + 1)
            error = jnp.array(0.5)
            step, state = optimizer.update_from_gradient(state, gradient, error=error)
            chex.assert_shape(step, (8, 4))
            chex.assert_tree_all_finite(step)
            chex.assert_tree_all_finite(state)

    def test_to_from_config_roundtrip(self):
        """RMSprop config roundtrip should preserve all parameters."""
        original = RMSprop(step_size=0.005, decay=0.95, eps=1e-7)
        config = original.to_config()
        kwargs = {k: v for k, v in config.items() if k != "type"}
        recreated = RMSprop(**kwargs)

        assert recreated.to_config() == config

    def test_state_init_for_shape(self):
        """``init_for_shape((3, 4))`` should produce 2D-shaped second moment."""
        optimizer = RMSprop(step_size=0.001)
        state = optimizer.init_for_shape((3, 4))

        assert isinstance(state, RMSpropParamState)
        chex.assert_shape(state.v, (3, 4))
        chex.assert_trees_all_close(state.v, jnp.zeros((3, 4)))


# =============================================================================
# NADALINE
# =============================================================================


class TestNADALINE:
    """Tests for the NADALINE optimizer."""

    def test_init_shapes(self):
        """NADALINE ``init`` should produce per-feature second-moment array."""
        optimizer = NADALINE(step_size=0.01, decay=0.99, eps=1e-8)
        state = optimizer.init(feature_dim=10)

        assert isinstance(state, NadalineState)
        chex.assert_shape(state.feature_second_moment, (10,))
        chex.assert_trees_all_close(state.feature_second_moment, jnp.zeros(10))
        assert float(state.step_size) == pytest.approx(0.01)
        assert float(state.decay) == pytest.approx(0.99)
        assert float(state.eps) == pytest.approx(1e-8)

    def test_update_returns_finite_metrics(self, sample_observation):
        """NADALINE ``update`` should produce finite outputs over 5 steps."""
        optimizer = NADALINE(step_size=0.01)
        state = optimizer.init(feature_dim=len(sample_observation))

        for i in range(5):
            error = jnp.array(1.0 + 0.1 * i)
            result = optimizer.update(state, error, sample_observation)
            chex.assert_tree_all_finite(result.weight_delta)
            chex.assert_tree_all_finite(result.bias_delta)
            chex.assert_tree_all_finite(result.new_state)
            for v in result.metrics.values():
                chex.assert_tree_all_finite(v)
            state = result.new_state

    def test_to_from_config_roundtrip(self):
        """NADALINE config roundtrip should preserve all parameters."""
        original = NADALINE(step_size=0.05, decay=0.95, eps=1e-7)
        config = original.to_config()
        kwargs = {k: v for k, v in config.items() if k != "type"}
        recreated = NADALINE(**kwargs)

        assert recreated.to_config() == config

    def test_normalization_reduces_step_for_large_features(self):
        """Per-feature normalization should make step magnitude scale-invariant.

        Feeding ``x = 100 * ones`` should produce a weight-step magnitude
        roughly equal to feeding ``x = ones``, because each weight is
        scaled by ``1 / max(eps, EMA(x_i^2))``.
        """
        optimizer = NADALINE(step_size=0.01, decay=0.5, eps=1e-8)
        feature_dim = 5
        error = jnp.array(1.0)

        # Run several steps with x = 1 to let EMA converge
        state_small = optimizer.init(feature_dim)
        small_obs = jnp.ones(feature_dim)
        for _ in range(20):
            r = optimizer.update(state_small, error, small_obs)
            state_small = r.new_state
        result_small = optimizer.update(state_small, error, small_obs)
        small_step_norm = float(jnp.linalg.norm(result_small.weight_delta))

        # Run several steps with x = 100 to let EMA converge to a much
        # larger value (10000), which the denominator will normalize by
        state_large = optimizer.init(feature_dim)
        large_obs = jnp.ones(feature_dim) * 100.0
        for _ in range(20):
            r = optimizer.update(state_large, error, large_obs)
            state_large = r.new_state
        result_large = optimizer.update(state_large, error, large_obs)
        large_step_norm = float(jnp.linalg.norm(result_large.weight_delta))

        # Without normalization, large_step_norm would be ~100x larger.
        # With normalization, alpha * x / E[x^2] ~ alpha * x / x^2 = alpha / x,
        # so the ratio of large to small should be roughly 1/100, not 100.
        ratio = large_step_norm / small_step_norm
        assert ratio < 0.1, (
            f"Expected normalization to keep step magnitude similar; "
            f"got ratio {ratio:.4f} (small={small_step_norm:.6f}, "
            f"large={large_step_norm:.6f})"
        )

    def test_bias_uses_plain_lms(self):
        """NADALINE bias delta should equal ``alpha * error`` with no normalization."""
        optimizer = NADALINE(step_size=0.05)
        state = optimizer.init(feature_dim=4)

        observation = jnp.array([0.5, 1.0, 2.0, 3.0])
        error = jnp.array(0.7)

        result = optimizer.update(state, error, observation)
        # bias_delta = alpha * error
        assert float(result.bias_delta) == pytest.approx(0.05 * 0.7, abs=1e-6)
