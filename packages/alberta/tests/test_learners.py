"""Tests for LinearLearner."""

import time

import chex
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework import (
    IDBD,
    LMS,
    Autostep,
    BatchedLearningResult,
    EMANormalizer,
    LinearLearner,
    NormalizerHistory,
    NormalizerTrackingConfig,
    RandomWalkStream,
    StepSizeHistory,
    StepSizeTrackingConfig,
    agent_age_s,
    agent_uptime_s,
    metrics_to_dicts,
    run_learning_loop,
    run_learning_loop_batched,
)


class TestLinearLearner:
    """Tests for the LinearLearner class."""

    def test_init_creates_zero_weights(self, feature_dim):
        """Learner should initialize with zero weights and bias."""
        learner = LinearLearner()
        state = learner.init(feature_dim)

        chex.assert_shape(state.weights, (feature_dim,))
        chex.assert_trees_all_close(state.weights, jnp.zeros(feature_dim))
        chex.assert_trees_all_close(state.bias, jnp.array(0.0))

    def test_predict_returns_correct_shape(self, feature_dim, sample_observation):
        """Prediction should return scalar (as 1D array)."""
        learner = LinearLearner()
        state = learner.init(feature_dim)

        prediction = learner.predict(state, sample_observation)

        chex.assert_shape(prediction, (1,))

    def test_predict_with_zero_weights_is_bias(self, feature_dim, sample_observation):
        """With zero weights, prediction should equal bias."""
        learner = LinearLearner()
        state = learner.init(feature_dim)

        prediction = learner.predict(state, sample_observation)

        chex.assert_trees_all_close(prediction[0], state.bias)

    def test_update_reduces_error(self, feature_dim, sample_observation, sample_target):
        """Update should move prediction closer to target."""
        learner = LinearLearner(optimizer=LMS(step_size=0.1))
        state = learner.init(feature_dim)

        # Get initial error
        initial_pred = learner.predict(state, sample_observation)
        initial_error = abs(float(sample_target[0] - initial_pred[0]))

        # Do several updates
        for _ in range(10):
            result = learner.update(state, sample_observation, sample_target)
            state = result.state

        # Error should have decreased
        final_pred = learner.predict(state, sample_observation)
        final_error = abs(float(sample_target[0] - final_pred[0]))

        assert final_error < initial_error

    def test_update_returns_correct_metrics_array(
        self, feature_dim, sample_observation, sample_target
    ):
        """Update should return metrics array with squared error."""
        learner = LinearLearner()
        state = learner.init(feature_dim)

        result = learner.update(state, sample_observation, sample_target)

        # Metrics are now an array [squared_error, error, mean_step_size]
        chex.assert_shape(result.metrics, (3,))
        assert result.metrics[0] >= 0  # squared_error

    def test_works_with_idbd_optimizer(self, feature_dim, sample_observation, sample_target):
        """Learner should work correctly with IDBD optimizer."""
        learner = LinearLearner(optimizer=IDBD())
        state = learner.init(feature_dim)

        result = learner.update(state, sample_observation, sample_target)

        assert result.state is not None
        # Metrics array: [squared_error, error, mean_step_size]
        chex.assert_shape(result.metrics, (3,))


class TestRunLearningLoop:
    """Tests for the run_learning_loop helper function."""

    def test_returns_correct_number_of_metrics(self, rng_key):
        """Should return metrics for each step."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        num_steps = 100
        _, metrics = run_learning_loop(learner, stream, num_steps, rng_key)

        # Metrics is now an array of shape (num_steps, 3)
        chex.assert_shape(metrics, (num_steps, 3))

    def test_returns_valid_final_state(self, rng_key):
        """Final state should have correct structure."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        state, _ = run_learning_loop(learner, stream, num_steps=50, key=rng_key)

        chex.assert_shape(state.weights, (5,))
        chex.assert_tree_all_finite(state.weights)

    def test_can_resume_from_existing_state(self, rng_key):
        """Should be able to continue from a previous state."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        # First run
        key1, key2 = jr.split(rng_key)
        state1, _ = run_learning_loop(learner, stream, num_steps=50, key=key1)

        # Continue from state1 with new key for stream
        state2, _ = run_learning_loop(learner, stream, num_steps=50, key=key2, learner_state=state1)

        # Weights should have changed
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(state1.weights, state2.weights)

    def test_error_decreases_on_stationary_target(self, rng_key):
        """On a stationary target, error should decrease over time."""
        # Use zero drift for stationary target
        stream = RandomWalkStream(feature_dim=5, drift_rate=0.0)
        learner = LinearLearner(optimizer=LMS(step_size=0.01))

        _, metrics = run_learning_loop(learner, stream, num_steps=1000, key=rng_key)

        # Convert to dicts for easier access
        metrics_list = metrics_to_dicts(metrics)

        # Compare first 100 vs last 100 average error
        early_error = sum(m["squared_error"] for m in metrics_list[:100]) / 100
        late_error = sum(m["squared_error"] for m in metrics_list[-100:]) / 100

        assert late_error < early_error

    def test_deterministic_with_same_key(self, rng_key):
        """Same key should produce same results."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        state1, metrics1 = run_learning_loop(learner, stream, num_steps=50, key=rng_key)
        state2, metrics2 = run_learning_loop(learner, stream, num_steps=50, key=rng_key)

        chex.assert_trees_all_close(state1.weights, state2.weights)
        chex.assert_trees_all_close(metrics1, metrics2)


class TestStepSizeTracking:
    """Tests for step-size tracking in run_learning_loop."""

    def test_returns_3_tuple_when_tracking_enabled(self, rng_key):
        """Should return 3-tuple (state, metrics, history) when tracking enabled."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=10)

        result = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        assert len(result) == 3
        state, metrics, history = result
        assert state is not None
        assert metrics is not None
        assert isinstance(history, StepSizeHistory)

    def test_returns_2_tuple_when_tracking_disabled(self, rng_key):
        """Should return 2-tuple (state, metrics) when tracking disabled (backward compat)."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())

        result = run_learning_loop(learner, stream, num_steps=100, key=rng_key)

        assert len(result) == 2
        state, metrics = result
        assert state is not None
        assert metrics is not None

    def test_history_shape_based_on_interval(self, rng_key):
        """History should have correct shape based on interval."""
        feature_dim = 10
        num_steps = 1000
        interval = 100
        expected_recordings = num_steps // interval  # 10

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=interval)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=num_steps, key=rng_key, step_size_tracking=config
        )

        chex.assert_shape(history.step_sizes, (expected_recordings, feature_dim))
        chex.assert_shape(history.bias_step_sizes, (expected_recordings,))
        chex.assert_shape(history.recording_indices, (expected_recordings,))

    def test_lms_returns_constant_step_sizes(self, rng_key):
        """LMS should return constant step-sizes throughout training."""
        step_size = 0.05
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=LMS(step_size=step_size))
        config = StepSizeTrackingConfig(interval=10)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        # All step-sizes should be equal to the fixed step_size
        expected_ss = jnp.full_like(history.step_sizes, step_size)
        expected_bias_ss = jnp.full_like(history.bias_step_sizes, step_size)
        chex.assert_trees_all_close(history.step_sizes, expected_ss)
        chex.assert_trees_all_close(history.bias_step_sizes, expected_bias_ss)

    def test_idbd_step_sizes_evolve(self, rng_key):
        """IDBD step-sizes should change over training."""
        stream = RandomWalkStream(feature_dim=5, drift_rate=0.01)
        learner = LinearLearner(optimizer=IDBD(initial_step_size=0.01, meta_step_size=0.1))
        config = StepSizeTrackingConfig(interval=100)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=10000, key=rng_key, step_size_tracking=config
        )

        # First and last recordings should differ
        first_mean = jnp.mean(history.step_sizes[0])
        last_mean = jnp.mean(history.step_sizes[-1])
        assert not jnp.isclose(first_mean, last_mean, rtol=0.1)

    def test_autostep_step_sizes_evolve(self, rng_key):
        """Autostep step-sizes should change over training."""
        stream = RandomWalkStream(feature_dim=5, drift_rate=0.01)
        learner = LinearLearner(optimizer=Autostep(initial_step_size=0.01, meta_step_size=0.1))
        config = StepSizeTrackingConfig(interval=100)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=10000, key=rng_key, step_size_tracking=config
        )

        # First and last recordings should differ
        first_mean = jnp.mean(history.step_sizes[0])
        last_mean = jnp.mean(history.step_sizes[-1])
        assert not jnp.isclose(first_mean, last_mean, rtol=0.1)

    def test_interval_1_records_every_step(self, rng_key):
        """Interval of 1 should record at every step."""
        num_steps = 50
        feature_dim = 3
        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=1)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=num_steps, key=rng_key, step_size_tracking=config
        )

        chex.assert_shape(history.step_sizes, (num_steps, feature_dim))
        # Recording indices should be 0, 1, 2, ..., num_steps-1
        expected_indices = jnp.arange(num_steps)
        chex.assert_trees_all_close(history.recording_indices, expected_indices)

    def test_interval_equals_num_steps_records_once(self, rng_key):
        """Interval equal to num_steps should record once at step 0."""
        num_steps = 100
        feature_dim = 5
        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=num_steps)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=num_steps, key=rng_key, step_size_tracking=config
        )

        chex.assert_shape(history.step_sizes, (1, feature_dim))
        assert history.recording_indices[0] == 0

    def test_invalid_interval_zero_raises_error(self, rng_key):
        """Interval of 0 should raise ValueError."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()
        config = StepSizeTrackingConfig(interval=0)

        with pytest.raises(ValueError, match="interval must be >= 1"):
            run_learning_loop(
                learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
            )

    def test_invalid_interval_greater_than_num_steps_raises_error(self, rng_key):
        """Interval greater than num_steps should raise ValueError."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()
        config = StepSizeTrackingConfig(interval=200)

        with pytest.raises(ValueError, match="must be <= num_steps"):
            run_learning_loop(
                learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
            )

    def test_include_bias_false_returns_none(self, rng_key):
        """When include_bias=False, bias_step_sizes should be None."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=10, include_bias=False)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        assert history.bias_step_sizes is None
        assert history.step_sizes is not None

    def test_recording_indices_correct(self, rng_key):
        """Recording indices should match expected values based on interval."""
        num_steps = 100
        interval = 25
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=interval)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=num_steps, key=rng_key, step_size_tracking=config
        )

        # Should record at steps 0, 25, 50, 75
        expected_indices = jnp.array([0, 25, 50, 75])
        chex.assert_trees_all_close(history.recording_indices, expected_indices)

    def test_autostep_normalizers_tracked(self, rng_key):
        """Autostep should track normalizers (v_i) in history."""
        feature_dim = 5
        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=Autostep())
        config = StepSizeTrackingConfig(interval=10)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        # Autostep should have normalizers tracked
        assert history.normalizers is not None
        chex.assert_equal_shape([history.normalizers, history.step_sizes])

    def test_idbd_normalizers_none(self, rng_key):
        """IDBD should not track normalizers (only Autostep has v_i)."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        config = StepSizeTrackingConfig(interval=10)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        # IDBD doesn't have normalizers
        assert history.normalizers is None

    def test_lms_normalizers_none(self, rng_key):
        """LMS should not track normalizers."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=LMS())
        config = StepSizeTrackingConfig(interval=10)

        _, _, history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=config
        )

        # LMS doesn't have normalizers
        assert history.normalizers is None


class TestNormalizedLearningLoopTracking:
    """Tests for tracking in run_learning_loop with a normalized learner."""

    def test_no_tracking_returns_2_tuple(self, rng_key):
        """Without tracking, should return (state, metrics)."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())

        result = run_learning_loop(learner, stream, num_steps=100, key=rng_key)

        assert len(result) == 2
        state, metrics = result
        assert state is not None
        chex.assert_shape(metrics, (100, 4))  # 4 columns for normalized learner

    def test_step_size_tracking_returns_3_tuple(self, rng_key):
        """With step_size_tracking, should return (state, metrics, ss_history)."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        ss_config = StepSizeTrackingConfig(interval=10)

        result = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=ss_config
        )

        assert len(result) == 3
        state, metrics, ss_history = result
        assert state is not None
        chex.assert_shape(metrics, (100, 4))
        assert isinstance(ss_history, StepSizeHistory)
        chex.assert_shape(ss_history.step_sizes, (10, 5))

    def test_normalizer_tracking_returns_3_tuple(self, rng_key):
        """With normalizer_tracking, should return (state, metrics, norm_history)."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        norm_config = NormalizerTrackingConfig(interval=10)

        result = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, normalizer_tracking=norm_config
        )

        assert len(result) == 3
        state, metrics, norm_history = result
        assert state is not None
        chex.assert_shape(metrics, (100, 4))
        assert isinstance(norm_history, NormalizerHistory)
        chex.assert_shape(norm_history.means, (10, 5))
        chex.assert_shape(norm_history.variances, (10, 5))

    def test_both_tracking_returns_4_tuple(self, rng_key):
        """With both tracking options, should return 4-tuple."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        ss_config = StepSizeTrackingConfig(interval=10)
        norm_config = NormalizerTrackingConfig(interval=20)

        result = run_learning_loop(
            learner,
            stream,
            num_steps=100,
            key=rng_key,
            step_size_tracking=ss_config,
            normalizer_tracking=norm_config,
        )

        assert len(result) == 4
        state, metrics, ss_history, norm_history = result
        assert state is not None
        chex.assert_shape(metrics, (100, 4))
        assert isinstance(ss_history, StepSizeHistory)
        assert isinstance(norm_history, NormalizerHistory)
        # Different intervals
        chex.assert_shape(ss_history.step_sizes, (10, 5))  # 100 // 10
        chex.assert_shape(norm_history.means, (5, 5))  # 100 // 20

    def test_autostep_normalizers_tracked_in_normalized_loop(self, rng_key):
        """Autostep's v_i should be tracked in normalized learning loop."""
        feature_dim = 5
        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=Autostep(), normalizer=EMANormalizer())
        ss_config = StepSizeTrackingConfig(interval=10)

        _, _, ss_history = run_learning_loop(
            learner, stream, num_steps=100, key=rng_key, step_size_tracking=ss_config
        )

        # Autostep should have normalizers tracked
        assert ss_history.normalizers is not None
        chex.assert_equal_shape([ss_history.normalizers, ss_history.step_sizes])

    def test_normalizer_history_tracks_adaptation(self, rng_key):
        """Normalizer history should capture mean/var adaptation over time."""
        stream = RandomWalkStream(feature_dim=5, drift_rate=0.01)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        norm_config = NormalizerTrackingConfig(interval=100)

        _, _, norm_history = run_learning_loop(
            learner, stream, num_steps=10000, key=rng_key, normalizer_tracking=norm_config
        )

        # Means should drift over time (due to stream drift)
        first_means = norm_history.means[0]
        last_means = norm_history.means[-1]
        # At least some features should have different means
        with pytest.raises(AssertionError):
            chex.assert_trees_all_close(first_means, last_means, atol=0.1)

    def test_normalizer_tracking_invalid_interval_raises(self, rng_key):
        """Invalid normalizer tracking interval should raise ValueError."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        norm_config = NormalizerTrackingConfig(interval=0)

        with pytest.raises(ValueError, match="normalizer_tracking.interval must be >= 1"):
            run_learning_loop(
                learner, stream, num_steps=100, key=rng_key, normalizer_tracking=norm_config
            )

    def test_normalizer_tracking_interval_too_large_raises(self, rng_key):
        """Normalizer tracking interval > num_steps should raise ValueError."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        norm_config = NormalizerTrackingConfig(interval=200)

        with pytest.raises(ValueError, match="must be <= num_steps"):
            run_learning_loop(
                learner, stream, num_steps=100, key=rng_key, normalizer_tracking=norm_config
            )

    def test_recording_indices_correct_for_normalizer(self, rng_key):
        """Normalizer recording indices should be correct."""
        num_steps = 100
        interval = 25
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        norm_config = NormalizerTrackingConfig(interval=interval)

        _, _, norm_history = run_learning_loop(
            learner, stream, num_steps=num_steps, key=rng_key, normalizer_tracking=norm_config
        )

        # Should record at steps 0, 25, 50, 75
        expected_indices = jnp.array([0, 25, 50, 75])
        chex.assert_trees_all_close(norm_history.recording_indices, expected_indices)


class TestBatchedLearningLoop:
    """Tests for run_learning_loop_batched."""

    def test_batched_returns_correct_shapes(self, rng_key):
        """Batched loop should return metrics with shape (num_seeds, num_steps, 3)."""
        num_seeds = 5
        num_steps = 100
        feature_dim = 10

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD())
        keys = jr.split(rng_key, num_seeds)

        result = run_learning_loop_batched(learner, stream, num_steps, keys)

        assert isinstance(result, BatchedLearningResult)
        chex.assert_shape(result.metrics, (num_seeds, num_steps, 3))
        chex.assert_shape(result.states.weights, (num_seeds, feature_dim))
        chex.assert_shape(result.states.bias, (num_seeds,))
        assert result.step_size_history is None

    def test_batched_matches_sequential(self, rng_key):
        """Batched results should match sequential execution."""
        num_seeds = 3
        num_steps = 50
        feature_dim = 5

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD())
        keys = jr.split(rng_key, num_seeds)

        # Run batched
        batched_result = run_learning_loop_batched(learner, stream, num_steps, keys)

        # Run sequential
        sequential_metrics = []
        for i in range(num_seeds):
            _, metrics = run_learning_loop(learner, stream, num_steps, keys[i])
            sequential_metrics.append(metrics)
        sequential_metrics = jnp.stack(sequential_metrics)

        # Should match (use rtol=1e-5 to account for vmap vs sequential floating-point differences)
        chex.assert_trees_all_close(batched_result.metrics, sequential_metrics, rtol=1e-5)

    def test_batched_with_step_size_tracking(self, rng_key):
        """Batched loop should support step-size tracking."""
        num_seeds = 4
        num_steps = 100
        feature_dim = 8
        interval = 10
        expected_recordings = num_steps // interval

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=Autostep())
        keys = jr.split(rng_key, num_seeds)
        config = StepSizeTrackingConfig(interval=interval)

        result = run_learning_loop_batched(
            learner, stream, num_steps, keys, step_size_tracking=config
        )

        assert result.step_size_history is not None
        assert result.step_size_history.step_sizes.shape == (
            num_seeds,
            expected_recordings,
            feature_dim,
        )
        assert result.step_size_history.bias_step_sizes.shape == (num_seeds, expected_recordings)
        assert result.step_size_history.recording_indices.shape == (num_seeds, expected_recordings)
        # Autostep should have normalizers tracked
        assert result.step_size_history.normalizers is not None
        assert result.step_size_history.normalizers.shape == (
            num_seeds,
            expected_recordings,
            feature_dim,
        )

    def test_batched_without_tracking_has_none_history(self, rng_key):
        """When tracking disabled, step_size_history should be None."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        keys = jr.split(rng_key, 3)

        result = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys)

        assert result.step_size_history is None

    def test_batched_deterministic_with_same_keys(self, rng_key):
        """Same keys should produce same results."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())
        keys = jr.split(rng_key, 4)

        result1 = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys)
        result2 = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys)

        assert jnp.allclose(result1.metrics, result2.metrics)
        assert jnp.allclose(result1.states.weights, result2.states.weights)

    def test_batched_different_keys_different_results(self, rng_key):
        """Different keys should produce different results."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD())

        keys1 = jr.split(jr.key(42), 3)
        keys2 = jr.split(jr.key(123), 3)

        result1 = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys1)
        result2 = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys2)

        assert not jnp.allclose(result1.metrics, result2.metrics)

    def test_batched_with_lms_optimizer(self, rng_key):
        """Batched loop should work with LMS optimizer."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=LMS(step_size=0.01))
        keys = jr.split(rng_key, 3)

        result = run_learning_loop_batched(learner, stream, num_steps=50, keys=keys)

        assert result.metrics.shape == (3, 50, 3)
        # LMS doesn't report mean_step_size in metrics (defaults to 0.0)
        assert jnp.allclose(result.metrics[:, :, 2], 0.0)


class TestBatchedNormalizedLearningLoop:
    """Tests for run_learning_loop_batched with a normalized learner."""

    def test_normalized_batched_returns_correct_shapes(self, rng_key):
        """Batched normalized loop should return metrics with shape (num_seeds, num_steps, 4)."""
        num_seeds = 5
        num_steps = 100
        feature_dim = 10

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        keys = jr.split(rng_key, num_seeds)

        result = run_learning_loop_batched(learner, stream, num_steps, keys)

        assert isinstance(result, BatchedLearningResult)
        assert result.metrics.shape == (num_seeds, num_steps, 4)
        assert result.states.weights.shape == (num_seeds, feature_dim)
        assert result.states.normalizer_state.mean.shape == (num_seeds, feature_dim)
        assert result.step_size_history is None
        assert result.normalizer_history is None

    def test_normalized_batched_matches_sequential(self, rng_key):
        """Batched normalized results should match sequential execution."""
        num_seeds = 3
        num_steps = 50
        feature_dim = 5

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        keys = jr.split(rng_key, num_seeds)

        # Run batched
        batched_result = run_learning_loop_batched(learner, stream, num_steps, keys)

        # Run sequential
        sequential_metrics = []
        for i in range(num_seeds):
            _, metrics = run_learning_loop(learner, stream, num_steps, keys[i])
            sequential_metrics.append(metrics)
        sequential_metrics = jnp.stack(sequential_metrics)

        # Should match (use rtol=1e-4 to account for vmap vs sequential floating-point differences)
        chex.assert_trees_all_close(batched_result.metrics, sequential_metrics, rtol=1e-4)

    def test_normalized_batched_with_both_tracking(self, rng_key):
        """Batched normalized loop should support both tracking options."""
        num_seeds = 4
        num_steps = 100
        feature_dim = 8
        ss_interval = 10
        norm_interval = 20
        ss_recordings = num_steps // ss_interval
        norm_recordings = num_steps // norm_interval

        stream = RandomWalkStream(feature_dim=feature_dim)
        learner = LinearLearner(optimizer=Autostep(), normalizer=EMANormalizer())
        keys = jr.split(rng_key, num_seeds)
        ss_config = StepSizeTrackingConfig(interval=ss_interval)
        norm_config = NormalizerTrackingConfig(interval=norm_interval)

        result = run_learning_loop_batched(
            learner,
            stream,
            num_steps,
            keys,
            step_size_tracking=ss_config,
            normalizer_tracking=norm_config,
        )

        # Step-size history
        assert result.step_size_history is not None
        chex.assert_shape(
            result.step_size_history.step_sizes,
            (num_seeds, ss_recordings, feature_dim),
        )
        # Autostep normalizers
        assert result.step_size_history.normalizers is not None

        # Normalizer history
        assert result.normalizer_history is not None
        chex.assert_shape(
            result.normalizer_history.means,
            (num_seeds, norm_recordings, feature_dim),
        )
        chex.assert_shape(
            result.normalizer_history.variances,
            (num_seeds, norm_recordings, feature_dim),
        )

    def test_normalized_batched_step_size_only(self, rng_key):
        """Batched normalized loop with only step-size tracking."""
        num_seeds = 3
        num_steps = 50

        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        keys = jr.split(rng_key, num_seeds)
        ss_config = StepSizeTrackingConfig(interval=10)

        result = run_learning_loop_batched(
            learner, stream, num_steps, keys, step_size_tracking=ss_config
        )

        assert result.step_size_history is not None
        assert result.normalizer_history is None

    def test_normalized_batched_normalizer_only(self, rng_key):
        """Batched normalized loop with only normalizer tracking."""
        num_seeds = 3
        num_steps = 50

        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner(optimizer=IDBD(), normalizer=EMANormalizer())
        keys = jr.split(rng_key, num_seeds)
        norm_config = NormalizerTrackingConfig(interval=10)

        result = run_learning_loop_batched(
            learner, stream, num_steps, keys, normalizer_tracking=norm_config
        )

        assert result.step_size_history is None
        assert result.normalizer_history is not None


class TestLifecycleTracking:
    """Tests for agent lifecycle tracking (step_count, birth_timestamp, uptime_s)."""

    def test_step_count_starts_at_zero(self):
        """step_count should be 0 after init."""
        learner = LinearLearner()
        state = learner.init(5)
        assert int(state.step_count) == 0

    def test_step_count_increments(self, feature_dim, sample_observation, sample_target):
        """step_count should increment by 1 on each update."""
        learner = LinearLearner()
        state = learner.init(feature_dim)
        assert int(state.step_count) == 0

        result = learner.update(state, sample_observation, sample_target)
        assert int(result.state.step_count) == 1

        result2 = learner.update(result.state, sample_observation, sample_target)
        assert int(result2.state.step_count) == 2

    def test_birth_timestamp_set(self):
        """birth_timestamp should be set to approximately time.time() at init."""
        before = time.time()
        learner = LinearLearner()
        state = learner.init(5)
        after = time.time()

        assert before <= state.birth_timestamp <= after

    def test_birth_timestamp_survives_update(self, feature_dim, sample_observation, sample_target):
        """birth_timestamp should not change across updates."""
        learner = LinearLearner()
        state = learner.init(feature_dim)
        original_ts = state.birth_timestamp

        result = learner.update(state, sample_observation, sample_target)
        assert result.state.birth_timestamp == original_ts

    def test_uptime_starts_at_zero(self):
        """uptime_s should be 0.0 after init."""
        learner = LinearLearner()
        state = learner.init(5)
        assert state.uptime_s == 0.0

    def test_uptime_increases_after_loop(self, rng_key):
        """uptime_s should be > 0 after run_learning_loop."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        state, _ = run_learning_loop(learner, stream, num_steps=100, key=rng_key)
        assert state.uptime_s > 0.0

    def test_uptime_accumulates(self, rng_key):
        """uptime_s should accumulate across sequential learning loops."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        key1, key2 = jr.split(rng_key)
        state1, _ = run_learning_loop(learner, stream, num_steps=100, key=key1)
        uptime_after_first = state1.uptime_s
        assert uptime_after_first > 0.0

        state2, _ = run_learning_loop(
            learner, stream, num_steps=100, key=key2, learner_state=state1
        )
        assert state2.uptime_s > uptime_after_first

    def test_step_count_after_loop(self, rng_key):
        """step_count should equal num_steps after run_learning_loop."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        state, _ = run_learning_loop(learner, stream, num_steps=200, key=rng_key)
        assert int(state.step_count) == 200


class TestLifecycleUtilities:
    """Tests for agent_age_s and agent_uptime_s utility functions."""

    def test_agent_age_s(self):
        """agent_age_s should return positive age."""
        learner = LinearLearner()
        state = learner.init(5)
        time.sleep(0.01)
        age = agent_age_s(state)
        assert age > 0.0

    def test_agent_uptime_s_zero_at_init(self):
        """agent_uptime_s should return 0.0 at init."""
        learner = LinearLearner()
        state = learner.init(5)
        assert agent_uptime_s(state) == 0.0

    def test_agent_uptime_s_after_loop(self, rng_key):
        """agent_uptime_s should return > 0 after a learning loop."""
        stream = RandomWalkStream(feature_dim=5)
        learner = LinearLearner()

        state, _ = run_learning_loop(learner, stream, num_steps=100, key=rng_key)
        assert agent_uptime_s(state) > 0.0
