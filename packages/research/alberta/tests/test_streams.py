"""Tests for experience streams."""

import chex
import jax.numpy as jnp
import pytest

from alberta_framework import (
    AbruptChangeStream,
    CyclicStream,
    DynamicScaleShiftStream,
    PeriodicChangeStream,
    RandomWalkStream,
    ScaleDriftStream,
    ScaledStreamWrapper,
    SuttonExperiment1Stream,
    TimeStep,
    make_scale_range,
)


class TestRandomWalkStream:
    """Tests for the RandomWalkStream class."""

    def test_init_creates_valid_state(self, rng_key):
        """Stream init should create valid state with correct shapes."""
        stream = RandomWalkStream(feature_dim=10, drift_rate=0.001)
        state = stream.init(rng_key)

        assert state.key is not None
        chex.assert_shape(state.true_weights, (10,))

    def test_step_produces_valid_timestep(self, rng_key):
        """Step should produce valid observation and target."""
        stream = RandomWalkStream(feature_dim=10)
        state = stream.init(rng_key)

        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (10,))
        chex.assert_shape(timestep.target, (1,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_feature_dim_property(self):
        """Feature dim property should return correct dimension."""
        stream = RandomWalkStream(feature_dim=20)
        assert stream.feature_dim == 20

    def test_weights_drift_over_time(self, rng_key):
        """True weights should change from step to step."""
        stream = RandomWalkStream(feature_dim=10, drift_rate=0.1)  # High drift
        state = stream.init(rng_key)

        initial_weights = state.true_weights

        for i in range(10):
            _, state = stream.step(state, jnp.array(i))

        # Weights should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_weights, state.true_weights)

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same sequence."""
        stream = RandomWalkStream(feature_dim=10)

        state1 = stream.init(rng_key)
        timestep1, _ = stream.step(state1, jnp.array(0))

        state2 = stream.init(rng_key)
        timestep2, _ = stream.step(state2, jnp.array(0))

        chex.assert_trees_all_close(timestep1.observation, timestep2.observation)
        chex.assert_trees_all_close(timestep1.target, timestep2.target)

    def test_targets_are_non_constant(self, rng_key):
        """Targets should vary due to random features and noise."""
        stream = RandomWalkStream(feature_dim=10)
        state = stream.init(rng_key)

        targets = []
        for i in range(100):
            timestep, state = stream.step(state, jnp.array(i))
            targets.append(float(timestep.target[0]))

        # Targets should not all be the same
        assert len(set(targets)) > 1


class TestAbruptChangeStream:
    """Tests for the AbruptChangeStream class."""

    def test_weights_change_at_interval(self, rng_key):
        """Weights should change at specified interval."""
        stream = AbruptChangeStream(feature_dim=10, change_interval=10)
        state = stream.init(rng_key)

        # Step count starts at 0, changes happen when step_count % interval == 0
        # So first change at step 0 (initial), then step 10, 20, etc.
        weights_at_0 = state.true_weights.copy()

        # Run 9 steps (step_count goes 0->9)
        for i in range(9):
            _, state = stream.step(state, jnp.array(i))

        # Run one more step (step_count becomes 10)
        _, state = stream.step(state, jnp.array(9))

        # Weights should have changed at step 10
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(weights_at_0, state.true_weights)

    def test_generates_valid_timesteps(self, rng_key):
        """Should generate valid TimeStep instances."""
        stream = AbruptChangeStream(feature_dim=5)
        state = stream.init(rng_key)

        for i in range(50):
            timestep, state = stream.step(state, jnp.array(i))
            assert isinstance(timestep, TimeStep)
            chex.assert_tree_all_finite(timestep.observation)


class TestSuttonExperiment1Stream:
    """Tests for the SuttonExperiment1Stream class."""

    def test_correct_feature_dim(self):
        """Feature dim should be num_relevant + num_irrelevant."""
        stream = SuttonExperiment1Stream(num_relevant=5, num_irrelevant=15)
        assert stream.feature_dim == 20

    def test_initial_signs_are_positive(self, rng_key):
        """All initial signs should be +1."""
        stream = SuttonExperiment1Stream()
        state = stream.init(rng_key)

        assert jnp.all(state.signs == 1.0)

    def test_sign_flips_at_interval(self, rng_key):
        """One sign should flip every change_interval steps."""
        stream = SuttonExperiment1Stream(change_interval=20)
        state = stream.init(rng_key)

        initial_signs = state.signs.copy()

        # Step past the change interval
        for i in range(21):
            _, state = stream.step(state, jnp.array(i))

        # At least one sign should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_signs, state.signs)

        # Exactly one sign should be different
        num_changes = jnp.sum(initial_signs != state.signs)
        assert num_changes == 1

    def test_target_only_depends_on_relevant_inputs(self, rng_key):
        """Target should only depend on first num_relevant inputs."""
        stream = SuttonExperiment1Stream(num_relevant=5, num_irrelevant=15)
        state = stream.init(rng_key)

        timestep, new_state = stream.step(state, jnp.array(0))

        # At step 0, no flip happens (step_count > 0 check), so signs remain all 1
        # Target = sum of first 5 inputs (weighted by signs which are all 1)
        expected = jnp.sum(timestep.observation[:5])

        assert jnp.isclose(timestep.target[0], expected, rtol=1e-5)


class TestCyclicStream:
    """Tests for the CyclicStream class."""

    def test_cycles_through_configurations(self, rng_key):
        """Should cycle through configurations."""
        stream = CyclicStream(
            feature_dim=10,
            cycle_length=5,
            num_configurations=4,
        )
        state = stream.init(rng_key)

        # Track which configuration index is used
        config_indices = []
        for i in range(25):  # Go through all 4 configs plus more
            config_idx = (state.step_count // 5) % 4
            config_indices.append(int(config_idx))
            _, state = stream.step(state, jnp.array(i))

        # Should see all 4 configurations
        assert 0 in config_indices
        assert 1 in config_indices
        assert 2 in config_indices
        assert 3 in config_indices

    def test_same_config_produces_consistent_weights(self, rng_key):
        """Same configuration should use same weights."""
        stream = CyclicStream(
            feature_dim=10,
            cycle_length=10,
            num_configurations=2,
            noise_std=0.0,  # No noise for easier testing
        )
        state = stream.init(rng_key)

        # Get the stored configurations
        config0_weights = state.configurations[0]

        # After one full cycle, we should be back to config 0
        for i in range(20):  # Go through both configs
            _, state = stream.step(state, jnp.array(i))

        # Config 0 weights should be unchanged (stored in configurations)
        chex.assert_trees_all_close(config0_weights, state.configurations[0])

    def test_generates_valid_timesteps(self, rng_key):
        """Should generate valid TimeStep instances."""
        stream = CyclicStream(feature_dim=5)
        state = stream.init(rng_key)

        for i in range(50):
            timestep, state = stream.step(state, jnp.array(i))
            assert isinstance(timestep, TimeStep)
            chex.assert_tree_all_finite(timestep.observation)


class TestPeriodicChangeStream:
    """Tests for the PeriodicChangeStream class."""

    def test_init_creates_valid_state(self, rng_key):
        """Stream init should create valid state with correct shapes."""
        stream = PeriodicChangeStream(feature_dim=10, period=100)
        state = stream.init(rng_key)

        assert state.key is not None
        chex.assert_shape(state.base_weights, (10,))
        chex.assert_shape(state.phases, (10,))
        assert state.step_count == 0

    def test_step_produces_valid_timestep(self, rng_key):
        """Step should produce valid observation and target."""
        stream = PeriodicChangeStream(feature_dim=10)
        state = stream.init(rng_key)

        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (10,))
        chex.assert_shape(timestep.target, (1,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_feature_dim_property(self):
        """Feature dim property should return correct dimension."""
        stream = PeriodicChangeStream(feature_dim=20)
        assert stream.feature_dim == 20

    def test_weights_oscillate_periodically(self, rng_key):
        """Weights should return to similar values after one period."""
        period = 100
        stream = PeriodicChangeStream(feature_dim=5, period=period, amplitude=1.0)
        state = stream.init(rng_key)

        # Get weights at step 0 (after init, step_count=0)
        t = 0
        oscillation_0 = 1.0 * jnp.sin(2.0 * jnp.pi * t / period + state.phases)
        weights_at_0 = state.base_weights + oscillation_0

        # Run one full period
        for i in range(period):
            _, state = stream.step(state, jnp.array(i))

        # Get weights after one period
        t = period
        oscillation_period = 1.0 * jnp.sin(2.0 * jnp.pi * t / period + state.phases)
        weights_at_period = state.base_weights + oscillation_period

        # Should be back to same weights (sin(2π + φ) = sin(φ))
        chex.assert_trees_all_close(weights_at_0, weights_at_period, atol=1e-5)

    def test_weights_differ_at_half_period(self, rng_key):
        """Weights at half period should differ from initial (unless phase happens to align)."""
        period = 100
        stream = PeriodicChangeStream(feature_dim=10, period=period, amplitude=2.0)
        state = stream.init(rng_key)

        # Run to half period
        for i in range(period // 2):
            _, state = stream.step(state, jnp.array(i))

        # At t=period/2, oscillation should be different from t=0
        # sin(π + φ) = -sin(φ), so weights should differ
        t_half = period // 2
        oscillation_half = 2.0 * jnp.sin(2.0 * jnp.pi * t_half / period + state.phases)
        weights_half = state.base_weights + oscillation_half

        t_0 = 0
        oscillation_0 = 2.0 * jnp.sin(2.0 * jnp.pi * t_0 / period + state.phases)
        weights_0 = state.base_weights + oscillation_0

        # Weights should differ (they're inverted around base)
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(weights_0, weights_half)

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same sequence."""
        stream = PeriodicChangeStream(feature_dim=10)

        state1 = stream.init(rng_key)
        timestep1, _ = stream.step(state1, jnp.array(0))

        state2 = stream.init(rng_key)
        timestep2, _ = stream.step(state2, jnp.array(0))

        chex.assert_trees_all_close(timestep1.observation, timestep2.observation)
        chex.assert_trees_all_close(timestep1.target, timestep2.target)


class TestScaledStreamWrapper:
    """Tests for the ScaledStreamWrapper class."""

    def test_scales_observations(self, rng_key):
        """Wrapper should scale observations by feature_scales."""
        inner = RandomWalkStream(feature_dim=5, feature_std=1.0)
        scales = jnp.array([0.1, 1.0, 10.0, 100.0, 1000.0])
        wrapped = ScaledStreamWrapper(inner, feature_scales=scales)

        # Get inner stream output
        inner_state = inner.init(rng_key)
        inner_timestep, _ = inner.step(inner_state, jnp.array(0))

        # Get wrapped stream output (same key)
        wrapped_state = wrapped.init(rng_key)
        wrapped_timestep, _ = wrapped.step(wrapped_state, jnp.array(0))

        # Wrapped observation should be inner * scales
        expected = inner_timestep.observation * scales
        chex.assert_trees_all_close(wrapped_timestep.observation, expected)

    def test_preserves_target(self, rng_key):
        """Wrapper should not modify targets."""
        inner = RandomWalkStream(feature_dim=5)
        scales = jnp.array([0.1, 1.0, 10.0, 100.0, 1000.0])
        wrapped = ScaledStreamWrapper(inner, feature_scales=scales)

        inner_state = inner.init(rng_key)
        inner_timestep, _ = inner.step(inner_state, jnp.array(0))

        wrapped_state = wrapped.init(rng_key)
        wrapped_timestep, _ = wrapped.step(wrapped_state, jnp.array(0))

        # Target should be unchanged
        chex.assert_trees_all_close(wrapped_timestep.target, inner_timestep.target)

    def test_feature_dim_property(self):
        """Feature dim should match inner stream."""
        inner = RandomWalkStream(feature_dim=20)
        wrapped = ScaledStreamWrapper(inner, feature_scales=jnp.ones(20))
        assert wrapped.feature_dim == 20

    def test_rejects_mismatched_scales(self):
        """Should raise error if scales don't match feature_dim."""
        inner = RandomWalkStream(feature_dim=10)
        scales = jnp.ones(5)  # Wrong size

        with pytest.raises(ValueError, match="must match"):
            ScaledStreamWrapper(inner, feature_scales=scales)

    def test_works_with_different_streams(self, rng_key):
        """Should work with any stream implementing the protocol."""
        scales = jnp.array([0.01, 0.1, 1.0, 10.0, 100.0])

        # Test with AbruptChangeStream
        stream1 = ScaledStreamWrapper(AbruptChangeStream(feature_dim=5), feature_scales=scales)
        state1 = stream1.init(rng_key)
        ts1, _ = stream1.step(state1, jnp.array(0))
        chex.assert_shape(ts1.observation, (5,))

        # Test with CyclicStream
        stream2 = ScaledStreamWrapper(CyclicStream(feature_dim=5), feature_scales=scales)
        state2 = stream2.init(rng_key)
        ts2, _ = stream2.step(state2, jnp.array(0))
        chex.assert_shape(ts2.observation, (5,))


class TestMakeScaleRange:
    """Tests for the make_scale_range utility function."""

    def test_log_spaced_range(self):
        """Log-spaced scales should span min to max logarithmically."""
        scales = make_scale_range(5, min_scale=0.01, max_scale=100.0, log_spaced=True)

        chex.assert_shape(scales, (5,))
        chex.assert_trees_all_close(scales[0], jnp.array(0.01), rtol=1e-5)
        chex.assert_trees_all_close(scales[-1], jnp.array(100.0), rtol=1e-5)
        # Middle value should be geometric mean ≈ 1.0
        chex.assert_trees_all_close(scales[2], jnp.array(1.0), rtol=0.1)

    def test_linear_spaced_range(self):
        """Linear-spaced scales should span min to max linearly."""
        scales = make_scale_range(5, min_scale=0.0, max_scale=100.0, log_spaced=False)

        chex.assert_shape(scales, (5,))
        chex.assert_trees_all_close(scales[0], jnp.array(0.0), atol=1e-5)
        chex.assert_trees_all_close(scales[-1], jnp.array(100.0), rtol=1e-5)
        # Middle value should be arithmetic mean = 50.0
        chex.assert_trees_all_close(scales[2], jnp.array(50.0), rtol=1e-5)

    def test_default_range(self):
        """Default range should be 0.001 to 1000."""
        scales = make_scale_range(7)

        chex.assert_shape(scales, (7,))
        chex.assert_trees_all_close(scales[0], jnp.array(0.001), rtol=1e-5)
        chex.assert_trees_all_close(scales[-1], jnp.array(1000.0), rtol=1e-5)


class TestDynamicScaleShiftStream:
    """Tests for the DynamicScaleShiftStream class."""

    def test_init_creates_valid_state(self, rng_key):
        """Stream init should create valid state with correct shapes."""
        stream = DynamicScaleShiftStream(feature_dim=10)
        state = stream.init(rng_key)

        assert state.key is not None
        chex.assert_shape(state.true_weights, (10,))
        chex.assert_shape(state.current_scales, (10,))
        assert state.step_count == 0

    def test_step_produces_valid_timestep(self, rng_key):
        """Step should produce valid observation and target."""
        stream = DynamicScaleShiftStream(feature_dim=10)
        state = stream.init(rng_key)

        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (10,))
        chex.assert_shape(timestep.target, (1,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_feature_dim_property(self):
        """Feature dim property should return correct dimension."""
        stream = DynamicScaleShiftStream(feature_dim=20)
        assert stream.feature_dim == 20

    def test_scales_change_at_interval(self, rng_key):
        """Scales should change at specified interval."""
        stream = DynamicScaleShiftStream(
            feature_dim=10,
            scale_change_interval=10,
            weight_change_interval=1000,  # Don't change weights
        )
        state = stream.init(rng_key)

        initial_scales = state.current_scales.copy()

        # Run 9 steps (step_count goes 0->9)
        for i in range(9):
            _, state = stream.step(state, jnp.array(i))

        # Run one more step (step_count becomes 10)
        _, state = stream.step(state, jnp.array(9))

        # Scales should have changed at step 10
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_scales, state.current_scales)

    def test_weights_change_at_interval(self, rng_key):
        """Weights should change at specified interval."""
        stream = DynamicScaleShiftStream(
            feature_dim=10,
            scale_change_interval=1000,  # Don't change scales
            weight_change_interval=10,
        )
        state = stream.init(rng_key)

        initial_weights = state.true_weights.copy()

        # Run 10 steps
        for i in range(10):
            _, state = stream.step(state, jnp.array(i))

        # Weights should have changed at step 10
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_weights, state.true_weights)

    def test_scales_within_bounds(self, rng_key):
        """Scales should be within min_scale and max_scale."""
        min_scale, max_scale = 0.01, 100.0
        stream = DynamicScaleShiftStream(
            feature_dim=10,
            scale_change_interval=5,
            min_scale=min_scale,
            max_scale=max_scale,
        )
        state = stream.init(rng_key)

        # Run many steps with scale changes
        for i in range(50):
            _, state = stream.step(state, jnp.array(i))

        # All scales should be within bounds
        assert jnp.all(state.current_scales >= min_scale)
        assert jnp.all(state.current_scales <= max_scale)

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same sequence."""
        stream = DynamicScaleShiftStream(feature_dim=10)

        state1 = stream.init(rng_key)
        timestep1, _ = stream.step(state1, jnp.array(0))

        state2 = stream.init(rng_key)
        timestep2, _ = stream.step(state2, jnp.array(0))

        chex.assert_trees_all_close(timestep1.observation, timestep2.observation)
        chex.assert_trees_all_close(timestep1.target, timestep2.target)


class TestScaleDriftStream:
    """Tests for the ScaleDriftStream class."""

    def test_init_creates_valid_state(self, rng_key):
        """Stream init should create valid state with correct shapes."""
        stream = ScaleDriftStream(feature_dim=10)
        state = stream.init(rng_key)

        assert state.key is not None
        chex.assert_shape(state.true_weights, (10,))
        chex.assert_shape(state.log_scales, (10,))
        assert state.step_count == 0
        # Initial log_scales should be 0 (scale = 1)
        chex.assert_trees_all_close(state.log_scales, jnp.zeros(10))

    def test_step_produces_valid_timestep(self, rng_key):
        """Step should produce valid observation and target."""
        stream = ScaleDriftStream(feature_dim=10)
        state = stream.init(rng_key)

        timestep, new_state = stream.step(state, jnp.array(0))

        chex.assert_shape(timestep.observation, (10,))
        chex.assert_shape(timestep.target, (1,))
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_feature_dim_property(self):
        """Feature dim property should return correct dimension."""
        stream = ScaleDriftStream(feature_dim=20)
        assert stream.feature_dim == 20

    def test_scales_drift_over_time(self, rng_key):
        """Log-scales should change from step to step."""
        stream = ScaleDriftStream(feature_dim=10, scale_drift_rate=0.1)  # High drift
        state = stream.init(rng_key)

        initial_log_scales = state.log_scales.copy()

        for i in range(100):
            _, state = stream.step(state, jnp.array(i))

        # Log-scales should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_log_scales, state.log_scales)

    def test_weights_drift_over_time(self, rng_key):
        """Weights should change from step to step."""
        stream = ScaleDriftStream(feature_dim=10, weight_drift_rate=0.1)  # High drift
        state = stream.init(rng_key)

        initial_weights = state.true_weights.copy()

        for i in range(100):
            _, state = stream.step(state, jnp.array(i))

        # Weights should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(initial_weights, state.true_weights)

    def test_log_scales_bounded(self, rng_key):
        """Log-scales should stay within bounds."""
        min_log, max_log = -2.0, 2.0
        stream = ScaleDriftStream(
            feature_dim=10,
            scale_drift_rate=0.5,  # High drift to test bounds
            min_log_scale=min_log,
            max_log_scale=max_log,
        )
        state = stream.init(rng_key)

        # Run many steps
        for i in range(500):
            _, state = stream.step(state, jnp.array(i))

        # Log-scales should be within bounds
        assert jnp.all(state.log_scales >= min_log)
        assert jnp.all(state.log_scales <= max_log)

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same sequence."""
        stream = ScaleDriftStream(feature_dim=10)

        state1 = stream.init(rng_key)
        timestep1, _ = stream.step(state1, jnp.array(0))

        state2 = stream.init(rng_key)
        timestep2, _ = stream.step(state2, jnp.array(0))

        chex.assert_trees_all_close(timestep1.observation, timestep2.observation)
        chex.assert_trees_all_close(timestep1.target, timestep2.target)

    def test_generates_valid_timesteps(self, rng_key):
        """Should generate valid TimeStep instances over many steps."""
        stream = ScaleDriftStream(feature_dim=5)
        state = stream.init(rng_key)

        for i in range(100):
            timestep, state = stream.step(state, jnp.array(i))
            assert isinstance(timestep, TimeStep)
            chex.assert_tree_all_finite(timestep.observation)
            chex.assert_tree_all_finite(timestep.target)
