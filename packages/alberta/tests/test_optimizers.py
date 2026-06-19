"""Tests for LMS, IDBD, Autostep, and ObGD optimizers."""

import chex
import jax.numpy as jnp
import pytest

from alberta_framework import (
    IDBD,
    LMS,
    AdaptiveObGDBounding,
    Autostep,
    AutostepGTDLambda,
    ObGD,
    optimizer_from_config,
)


class TestLMS:
    """Tests for the LMS optimizer."""

    def test_init_creates_correct_state(self):
        """LMS init should return state with specified step size."""
        optimizer = LMS(step_size=0.05)
        state = optimizer.init(feature_dim=10)

        assert state.step_size == pytest.approx(0.05)

    def test_update_computes_correct_delta(self, sample_observation):
        """LMS update should compute delta = alpha * error * x."""
        optimizer = LMS(step_size=0.1)
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(2.0)
        result = optimizer.update(state, error, sample_observation)

        expected_delta = 0.1 * 2.0 * sample_observation
        chex.assert_trees_all_close(result.weight_delta, expected_delta)
        assert result.bias_delta == pytest.approx(0.1 * 2.0)

    def test_state_unchanged_after_update(self):
        """LMS state should not change after update (fixed step-size)."""
        optimizer = LMS(step_size=0.01)
        state = optimizer.init(feature_dim=5)

        observation = jnp.ones(5)
        error = jnp.array(1.0)
        result = optimizer.update(state, error, observation)

        assert result.new_state.step_size == state.step_size


class TestIDBD:
    """Tests for the IDBD optimizer."""

    def test_init_creates_correct_state(self):
        """IDBD init should create per-weight step-sizes and traces."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.001)
        state = optimizer.init(feature_dim=10)

        chex.assert_shape(state.log_step_sizes, (10,))
        chex.assert_shape(state.traces, (10,))
        chex.assert_trees_all_close(jnp.exp(state.log_step_sizes), jnp.full(10, 0.01))
        chex.assert_trees_all_close(state.traces, jnp.zeros(10))
        assert state.meta_step_size == pytest.approx(0.001)

    def test_update_returns_correct_shapes(self, sample_observation):
        """IDBD update should return correctly shaped deltas."""
        optimizer = IDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        chex.assert_shape(result.weight_delta, sample_observation.shape)
        chex.assert_shape(result.new_state.log_step_sizes, sample_observation.shape)
        chex.assert_shape(result.new_state.traces, sample_observation.shape)

    def test_step_sizes_adapt_with_consistent_gradients(self):
        """Step-sizes should increase when gradients consistently agree."""
        optimizer = IDBD(initial_step_size=0.1, meta_step_size=0.1)
        feature_dim = 5
        state = optimizer.init(feature_dim=feature_dim)

        # Consistent positive error and positive observation
        observation = jnp.ones(feature_dim)
        error = jnp.array(1.0)

        initial_step_sizes = jnp.exp(state.log_step_sizes)

        # Run multiple updates with consistent gradients
        for _ in range(10):
            result = optimizer.update(state, error, observation)
            state = result.new_state

        final_step_sizes = jnp.exp(state.log_step_sizes)

        # Step-sizes should have increased due to consistent gradient direction
        # (traces build up positive correlation)
        assert jnp.mean(final_step_sizes) >= jnp.mean(initial_step_sizes)

    def test_metrics_contain_step_size_info(self, sample_observation):
        """IDBD update should return step-size statistics in metrics."""
        optimizer = IDBD()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        assert "mean_step_size" in result.metrics
        assert "min_step_size" in result.metrics
        assert "max_step_size" in result.metrics


class TestAutostep:
    """Tests for the Autostep optimizer."""

    def test_init_creates_correct_state(self):
        """Autostep init should create per-weight step-sizes, traces, and normalizers."""
        optimizer = Autostep(initial_step_size=0.01, meta_step_size=0.001)
        state = optimizer.init(feature_dim=10)

        chex.assert_shape(state.step_sizes, (10,))
        chex.assert_shape(state.traces, (10,))
        chex.assert_shape(state.normalizers, (10,))
        chex.assert_trees_all_close(state.step_sizes, jnp.full(10, 0.01))
        chex.assert_trees_all_close(state.traces, jnp.zeros(10))
        # Normalizers init to 0 per Mahmood et al. 2012
        chex.assert_trees_all_close(state.normalizers, jnp.zeros(10))
        assert state.meta_step_size == pytest.approx(0.001)
        assert state.tau == pytest.approx(10000.0)

    def test_update_returns_correct_shapes(self, sample_observation):
        """Autostep update should return correctly shaped deltas."""
        optimizer = Autostep()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        chex.assert_shape(result.weight_delta, sample_observation.shape)
        chex.assert_shape(result.new_state.step_sizes, sample_observation.shape)
        chex.assert_shape(result.new_state.traces, sample_observation.shape)
        chex.assert_shape(result.new_state.normalizers, sample_observation.shape)

    def test_normalizers_adapt_to_meta_gradient_magnitude(self):
        """Normalizers should track |δ*x*h| — needs 2+ steps since h starts at 0."""
        optimizer = Autostep(initial_step_size=0.1, meta_step_size=0.1)
        feature_dim = 5
        state = optimizer.init(feature_dim=feature_dim)

        large_observation = jnp.ones(feature_dim) * 10.0
        error = jnp.array(1.0)

        # First step: h=0 so meta_gradient = δ*x*h = 0, v stays 0
        result1 = optimizer.update(state, error, large_observation)
        chex.assert_trees_all_close(result1.new_state.normalizers, jnp.zeros(feature_dim))

        # Second step: h is nonzero from first step, so meta_gradient > 0
        result2 = optimizer.update(result1.new_state, error, large_observation)

        # Normalizers should now be positive (tracking |δ*x*h|)
        chex.assert_trees_all_equal_comparator(
            lambda x, y: jnp.all(x > y),
            lambda x, y: f"Expected {x} > {y}",
            result2.new_state.normalizers,
            jnp.zeros(feature_dim),
        )

    def test_step_sizes_adapt_with_consistent_gradients(self):
        """Step-sizes should increase when gradients consistently agree."""
        optimizer = Autostep(initial_step_size=0.1, meta_step_size=0.1)
        feature_dim = 5
        state = optimizer.init(feature_dim=feature_dim)

        observation = jnp.ones(feature_dim)
        error = jnp.array(1.0)

        initial_step_sizes = state.step_sizes

        # Run multiple updates with consistent gradients
        for _ in range(10):
            result = optimizer.update(state, error, observation)
            state = result.new_state

        final_step_sizes = state.step_sizes

        # Step-sizes should have increased on average
        assert jnp.mean(final_step_sizes) >= jnp.mean(initial_step_sizes)

    def test_metrics_contain_normalizer_info(self, sample_observation):
        """Autostep update should return normalizer statistics in metrics."""
        optimizer = Autostep()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        assert "mean_step_size" in result.metrics
        assert "min_step_size" in result.metrics
        assert "max_step_size" in result.metrics
        assert "mean_normalizer" in result.metrics

    def test_overshoot_prevention_bounds_effective_step_size(self):
        """M normalization should prevent sum(alpha_i * x_i^2) from exceeding 1."""
        # Use large step-sizes and large observations to trigger M > 1
        optimizer = Autostep(initial_step_size=1.0, meta_step_size=0.1)
        feature_dim = 10
        state = optimizer.init(feature_dim=feature_dim)

        large_observation = jnp.ones(feature_dim) * 5.0
        error = jnp.array(1.0)

        result = optimizer.update(state, error, large_observation)

        # After M normalization: sum(alpha_i * x_i^2) + alpha_bias <= 1.0
        effective = jnp.sum(
            result.new_state.step_sizes * large_observation**2
        ) + result.new_state.bias_step_size
        assert float(effective) <= 1.0 + 1e-6

    def test_normalizer_tracks_meta_gradient_not_primary(self):
        """v_i should track |δ*x*h| (meta-gradient), not |δ*x| (primary gradient)."""
        optimizer = Autostep(initial_step_size=0.1, meta_step_size=0.1)
        feature_dim = 3
        state = optimizer.init(feature_dim=feature_dim)

        observation = jnp.array([1.0, 2.0, 3.0])
        error = jnp.array(5.0)

        # Run 3 steps to build up traces
        for _ in range(3):
            result = optimizer.update(state, error, observation)
            state = result.new_state

        # v_i should be proportional to |δ*x_i*h_i|, not |δ*x_i|
        # With consistent gradients, h_i grows roughly like α_i*δ*x_i
        # so v_i ~ |δ*x_i * α_i*δ*x_i| = α_i*δ²*x_i²
        # Features with larger x should have disproportionately larger v
        # (v ~ x² rather than v ~ x if it were tracking primary gradient)
        v = state.normalizers
        # v[2]/v[0] should be closer to (3/1)^2 = 9 than to (3/1) = 3
        ratio = float(v[2]) / float(jnp.maximum(v[0], 1e-10))
        assert ratio > 4.0  # Well above linear (3), closer to quadratic (9)


class TestAutostepGTDLambda:
    """Tests for the Autostep-for-GTD(lambda) optimizer.

    Reference: Kearney, Veeriah, Travnik, Pilarski, Sutton 2019,
    "Learning Feature Relevance Through Step Size Adaptation in
    Temporal-Difference Learning". The Step 1 supervised limit (gamma=0,
    lamda=0, rho=1) reduces to standard Autostep, so this class
    primarily pins shape/finite/JIT/config behaviour and the supervised
    numerical-equivalence guarantee.
    """

    def test_init_creates_correct_state(self):
        """init should produce per-weight step-sizes, traces, normalizers, and z."""
        optimizer = AutostepGTDLambda(initial_step_size=0.02, meta_step_size=0.005)
        state = optimizer.init(feature_dim=7)

        chex.assert_shape(state.step_sizes, (7,))
        chex.assert_shape(state.traces, (7,))
        chex.assert_shape(state.normalizers, (7,))
        chex.assert_shape(state.eligibility_traces, (7,))
        chex.assert_trees_all_close(state.step_sizes, jnp.full(7, 0.02))
        chex.assert_trees_all_close(state.traces, jnp.zeros(7))
        chex.assert_trees_all_close(state.normalizers, jnp.zeros(7))
        chex.assert_trees_all_close(state.eligibility_traces, jnp.zeros(7))
        assert state.meta_step_size == pytest.approx(0.005)
        assert state.tau == pytest.approx(10000.0)
        assert state.trace_decay == pytest.approx(0.0)

    def test_update_returns_correct_shapes_and_finite(self, sample_observation):
        """update should return correctly shaped, finite deltas across multiple steps."""
        optimizer = AutostepGTDLambda()
        state = optimizer.init(feature_dim=len(sample_observation))

        for _ in range(5):
            result = optimizer.update(state, jnp.array(1.0), sample_observation)
            chex.assert_shape(result.weight_delta, sample_observation.shape)
            chex.assert_shape(result.new_state.step_sizes, sample_observation.shape)
            chex.assert_shape(
                result.new_state.eligibility_traces, sample_observation.shape
            )
            chex.assert_tree_all_finite(result.weight_delta)
            chex.assert_tree_all_finite(result.bias_delta)
            chex.assert_tree_all_finite(result.new_state)
            state = result.new_state

    def test_jit_compiles(self):
        """update should compile under jax.jit."""
        import jax

        optimizer = AutostepGTDLambda(initial_step_size=0.01, meta_step_size=0.01)
        state = optimizer.init(feature_dim=4)
        update_jit = jax.jit(optimizer.update)
        observation = jnp.array([0.1, -0.5, 1.0, 2.0], dtype=jnp.float32)

        result = update_jit(state, jnp.array(1.0, dtype=jnp.float32), observation)

        chex.assert_tree_all_finite(result.weight_delta)
        chex.assert_tree_all_finite(result.new_state)

    def test_supervised_matches_autostep_numerically(self):
        """gamma=lambda=0 supervised case matches Autostep within 1e-5 over 10 steps.

        Pins the Step 1 footnote-11 closure: Autostep-for-GTD(lambda) in the
        supervised limit (the Step 1 baseline) is the same algorithm as
        Autostep on the weight, bias, trace, normalizer, and step-size paths.
        """
        autostep = Autostep(initial_step_size=0.03, meta_step_size=0.02, tau=2000.0)
        gtd = AutostepGTDLambda(
            initial_step_size=0.03, meta_step_size=0.02, tau=2000.0, trace_decay=0.0
        )

        feature_dim = 6
        state_a = autostep.init(feature_dim=feature_dim)
        state_g = gtd.init(feature_dim=feature_dim)

        observations = jnp.array(
            [
                [1.0, 0.5, -0.25, 0.75, -1.0, 0.0],
                [0.2, -0.4, 0.6, -0.8, 1.2, -0.3],
                [-1.5, 0.9, 0.1, -0.7, 0.4, 1.1],
                [0.6, 1.3, -0.5, 0.0, 0.2, -0.9],
                [1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
                [-0.3, 0.7, 1.4, -1.1, 0.05, 0.8],
                [0.45, -0.55, 0.65, -0.75, 0.85, -0.95],
                [1.1, -0.4, 0.3, 0.6, -0.2, 0.5],
                [0.0, 0.5, -0.5, 1.0, -1.0, 0.25],
                [0.8, -0.6, 0.4, -0.2, 0.1, -0.9],
            ],
            dtype=jnp.float32,
        )
        errors = jnp.array(
            [1.5, -0.7, 0.4, 1.0, -1.2, 0.6, -0.3, 0.8, -0.5, 0.9],
            dtype=jnp.float32,
        )

        for x, e in zip(observations, errors, strict=True):
            res_a = autostep.update(state_a, e, x)
            res_g = gtd.update(state_g, e, x)
            chex.assert_trees_all_close(
                res_g.weight_delta, res_a.weight_delta, atol=1e-5, rtol=1e-5
            )
            chex.assert_trees_all_close(
                res_g.bias_delta, res_a.bias_delta, atol=1e-5
            )
            chex.assert_trees_all_close(
                res_g.new_state.step_sizes,
                res_a.new_state.step_sizes,
                atol=1e-5,
                rtol=1e-5,
            )
            chex.assert_trees_all_close(
                res_g.new_state.traces,
                res_a.new_state.traces,
                atol=1e-5,
                rtol=1e-5,
            )
            chex.assert_trees_all_close(
                res_g.new_state.normalizers,
                res_a.new_state.normalizers,
                atol=1e-5,
                rtol=1e-5,
            )
            state_a = res_a.new_state
            state_g = res_g.new_state

    def test_config_round_trip(self):
        """to_config / optimizer_from_config should roundtrip."""
        opt = AutostepGTDLambda(
            initial_step_size=0.02, meta_step_size=0.05, tau=4000.0, trace_decay=0.7
        )
        config = opt.to_config()
        assert config["type"] == "AutostepGTDLambda"
        restored = optimizer_from_config(config)
        assert isinstance(restored, AutostepGTDLambda)
        assert restored._initial_step_size == 0.02
        assert restored._meta_step_size == 0.05
        assert restored._tau == 4000.0
        assert restored._trace_decay == 0.7

    def test_eligibility_trace_accumulates_with_lambda(self):
        """With trace_decay > 0 the eligibility trace should accumulate."""
        optimizer = AutostepGTDLambda(
            initial_step_size=0.01, meta_step_size=0.01, trace_decay=0.5
        )
        state = optimizer.init(feature_dim=3)
        observation = jnp.array([1.0, 0.5, -0.25], dtype=jnp.float32)

        result1 = optimizer.update(state, jnp.array(1.0), observation)
        chex.assert_trees_all_close(
            result1.new_state.eligibility_traces, observation, atol=1e-6
        )

        result2 = optimizer.update(result1.new_state, jnp.array(1.0), observation)
        expected = 0.5 * observation + observation
        chex.assert_trees_all_close(
            result2.new_state.eligibility_traces, expected, atol=1e-6
        )


class TestObGD:
    """Tests for the ObGD optimizer."""

    def test_init_creates_correct_state(self):
        """ObGD init should create state with traces and parameters."""
        optimizer = ObGD(step_size=1.0, kappa=2.0)
        state = optimizer.init(feature_dim=10)

        chex.assert_shape(state.traces, (10,))
        chex.assert_trees_all_close(state.traces, jnp.zeros(10))
        assert state.step_size == pytest.approx(1.0)
        assert state.kappa == pytest.approx(2.0)
        assert state.gamma == pytest.approx(0.0)
        assert state.lamda == pytest.approx(0.0)

    def test_update_returns_correct_shapes(self, sample_observation):
        """ObGD update should return correctly shaped deltas."""
        optimizer = ObGD()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        chex.assert_shape(result.weight_delta, sample_observation.shape)
        chex.assert_shape(result.new_state.traces, sample_observation.shape)

    def test_no_trace_mode_matches_lms_when_unbounded(self):
        """With gamma=0, small error, and kappa=0, ObGD should match LMS."""
        feature_dim = 5
        step_size = 0.1
        # kappa=0 means bounding never activates (dot_product = 0 < 1)
        obgd = ObGD(step_size=step_size, kappa=0.0)
        lms = LMS(step_size=step_size)

        obgd_state = obgd.init(feature_dim)
        lms_state = lms.init(feature_dim)

        observation = jnp.ones(feature_dim) * 0.5
        error = jnp.array(0.5)

        obgd_result = obgd.update(obgd_state, error, observation)
        lms_result = lms.update(lms_state, error, observation)

        chex.assert_trees_all_close(obgd_result.weight_delta, lms_result.weight_delta, atol=1e-6)

    def test_bounding_activates_with_large_errors(self):
        """Bounding should reduce effective step-size with large errors."""
        optimizer = ObGD(step_size=1.0, kappa=2.0)
        feature_dim = 5
        state = optimizer.init(feature_dim)

        observation = jnp.ones(feature_dim)

        # Small error - may not trigger bounding
        small_error = jnp.array(0.01)
        small_result = optimizer.update(state, small_error, observation)
        small_eff = small_result.metrics["effective_step_size"]

        # Large error - should trigger bounding
        large_error = jnp.array(100.0)
        large_result = optimizer.update(state, large_error, observation)
        large_eff = large_result.metrics["effective_step_size"]

        # Effective step-size should be smaller for large errors
        assert float(large_eff) < float(small_eff)

    def test_traces_accumulate_with_nonzero_gamma_lamda(self):
        """Traces should accumulate over steps with nonzero gamma and lamda."""
        optimizer = ObGD(step_size=1.0, kappa=2.0, gamma=0.9, lamda=0.8)
        feature_dim = 3
        state = optimizer.init(feature_dim)

        observation = jnp.array([1.0, 2.0, 3.0])
        error = jnp.array(1.0)

        # First update: traces = 0*0.72 + obs = obs
        result1 = optimizer.update(state, error, observation)
        chex.assert_trees_all_close(result1.new_state.traces, observation)

        # Second update: traces = 0.72*obs + obs = 1.72*obs
        result2 = optimizer.update(result1.new_state, error, observation)
        expected = 0.9 * 0.8 * observation + observation
        chex.assert_trees_all_close(result2.new_state.traces, expected, atol=1e-6)

    def test_effective_step_size_never_exceeds_base(self):
        """Effective step-size should never exceed the base step-size."""
        optimizer = ObGD(step_size=0.5, kappa=2.0)
        feature_dim = 10
        state = optimizer.init(feature_dim)

        observation = jnp.ones(feature_dim) * 0.1
        error = jnp.array(5.0)

        result = optimizer.update(state, error, observation)
        eff = result.metrics["effective_step_size"]
        assert float(eff) <= 0.5 + 1e-7

    def test_produces_finite_updates(self, sample_observation):
        """ObGD should produce finite updates."""
        optimizer = ObGD()
        state = optimizer.init(feature_dim=len(sample_observation))

        error = jnp.array(1.0)
        result = optimizer.update(state, error, sample_observation)

        chex.assert_tree_all_finite(result.weight_delta)
        chex.assert_tree_all_finite(result.bias_delta)


class TestAdaptiveObGDBounding:
    """Tests for the adaptive ObGD bounder."""

    def test_matches_obgd_scale_when_rms_below_one(self):
        """Small bounded steps should only receive the global ObGD scale."""
        bounder = AdaptiveObGDBounding(kappa=2.0)
        steps = (
            jnp.array([0.1, -0.2], dtype=jnp.float32),
            jnp.array([0.05], dtype=jnp.float32),
        )

        bounded, scale = bounder.bound(
            steps,
            jnp.array(1.0, dtype=jnp.float32),
            tuple(jnp.zeros_like(step) for step in steps),
        )

        total_step = sum(jnp.sum(jnp.abs(step)) for step in steps)
        expected_scale = 1.0 / jnp.maximum(2.0 * total_step, 1.0)
        assert scale == pytest.approx(float(expected_scale))
        for actual, step in zip(bounded, steps, strict=True):
            chex.assert_trees_all_close(actual, expected_scale * step)

    def test_rms_stage_reduces_large_bounded_steps(self):
        """RMS normalization should further shrink large post-ObGD steps."""
        bounder = AdaptiveObGDBounding(kappa=0.0, eps=0.0)
        steps = (
            jnp.array([3.0, 4.0], dtype=jnp.float32),
            jnp.array([0.0], dtype=jnp.float32),
        )

        bounded, scale = bounder.bound(
            steps,
            jnp.array(1.0, dtype=jnp.float32),
            tuple(jnp.zeros_like(step) for step in steps),
        )

        rms = jnp.sqrt((3.0**2 + 4.0**2) / 3.0)
        assert scale == pytest.approx(1.0)
        chex.assert_trees_all_close(bounded[0], steps[0] / rms)
        chex.assert_trees_all_close(bounded[1], steps[1] / rms)

    def test_produces_finite_zero_steps(self):
        """Zero steps should remain finite and unchanged."""
        bounder = AdaptiveObGDBounding()
        steps = (jnp.zeros((3,), dtype=jnp.float32),)

        bounded, scale = bounder.bound(
            steps,
            jnp.array(0.0, dtype=jnp.float32),
            tuple(jnp.zeros_like(step) for step in steps),
        )

        assert scale == pytest.approx(1.0)
        chex.assert_tree_all_finite(bounded)
        chex.assert_trees_all_close(bounded[0], steps[0])


class TestIDBDParamState:
    """Tests for the IDBD per-parameter state (MLP path, Meyer adaptation)."""

    def test_init_for_shape_2d(self):
        """init_for_shape should create correct shapes for 2D weight matrix."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.001)
        state = optimizer.init_for_shape((32, 10))

        chex.assert_shape(state.log_step_sizes, (32, 10))
        chex.assert_shape(state.traces, (32, 10))
        chex.assert_trees_all_close(
            jnp.exp(state.log_step_sizes), jnp.full((32, 10), 0.01)
        )
        chex.assert_trees_all_close(state.traces, jnp.zeros((32, 10)))
        assert state.meta_step_size == pytest.approx(0.001)

    def test_init_for_shape_1d(self):
        """init_for_shape should create correct shapes for 1D bias vector."""
        optimizer = IDBD(initial_step_size=0.05)
        state = optimizer.init_for_shape((16,))

        chex.assert_shape(state.log_step_sizes, (16,))
        chex.assert_shape(state.traces, (16,))
        chex.assert_trees_all_close(
            jnp.exp(state.log_step_sizes), jnp.full(16, 0.05)
        )

    def test_update_from_gradient_shapes(self):
        """update_from_gradient should return correct shapes and finite values."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.01)
        state = optimizer.init_for_shape((32, 10))

        gradient = jnp.ones((32, 10)) * 0.1
        error = jnp.array(1.0)

        step, new_state = optimizer.update_from_gradient(state, gradient, error=error)

        chex.assert_shape(step, (32, 10))
        chex.assert_shape(new_state.log_step_sizes, (32, 10))
        chex.assert_shape(new_state.traces, (32, 10))
        chex.assert_tree_all_finite(step)
        chex.assert_tree_all_finite(new_state.log_step_sizes)
        chex.assert_tree_all_finite(new_state.traces)

    def test_update_from_gradient_without_error(self):
        """update_from_gradient should work without error (trunk path)."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.01)
        state = optimizer.init_for_shape((16, 8))

        gradient = jnp.ones((16, 8)) * 0.1

        step, new_state = optimizer.update_from_gradient(state, gradient, error=None)

        chex.assert_shape(step, (16, 8))
        chex.assert_tree_all_finite(step)
        chex.assert_tree_all_finite(new_state.log_step_sizes)

    def test_h_trace_uses_loss_gradient_direction(self):
        """h-trace should accumulate in loss gradient direction (-error * z)."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.01)
        state = optimizer.init_for_shape((5,))

        z = jnp.ones(5)
        error = jnp.array(2.0)

        _, new_state = optimizer.update_from_gradient(state, z, error=error)

        # h should be alpha * (-error * z) = -0.01 * 2.0 * 1.0 = -0.02
        expected_h = -0.01 * 2.0 * jnp.ones(5)
        chex.assert_trees_all_close(new_state.traces, expected_h, atol=1e-6)

    def test_meta_update_uses_prediction_grads_only(self):
        """Meta-update should use z * h (no error), matching Meyer."""
        optimizer = IDBD(initial_step_size=0.1, meta_step_size=0.1)
        state = optimizer.init_for_shape((3,))

        z = jnp.ones(3)
        error = jnp.array(1.0)

        # Step 1: h starts at 0, so no meta-update
        _, state = optimizer.update_from_gradient(state, z, error=error)
        log_alpha_after_1 = state.log_step_sizes

        # Step 2: h = -alpha * error * z < 0, meta = z * h < 0
        # With negative h, meta-gradient z * h < 0 -> step-size decreases
        _, state = optimizer.update_from_gradient(state, z, error=error)
        log_alpha_after_2 = state.log_step_sizes

        # Step-sizes should decrease (meta-gradient is negative)
        assert jnp.all(log_alpha_after_2 < log_alpha_after_1)

    def test_loss_grads_mode(self):
        """loss_grads h_decay_mode should produce finite results."""
        optimizer = IDBD(
            initial_step_size=0.01, meta_step_size=0.01, h_decay_mode="loss_grads"
        )
        state = optimizer.init_for_shape((8, 4))

        gradient = jnp.ones((8, 4)) * 0.1
        error = jnp.array(2.0)

        step, new_state = optimizer.update_from_gradient(state, gradient, error=error)

        chex.assert_tree_all_finite(step)
        chex.assert_tree_all_finite(new_state.log_step_sizes)

    def test_invalid_h_decay_mode_raises(self):
        """Invalid h_decay_mode should raise ValueError."""
        with pytest.raises(ValueError, match="Invalid h_decay_mode"):
            IDBD(h_decay_mode="invalid")

    def test_vmap_compatible(self):
        """update_from_gradient should work with jax.vmap."""
        import jax

        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.01)

        state = optimizer.init_for_shape((8, 4))
        batched_state = jax.tree.map(lambda x: jnp.stack([x, x, x]), state)

        gradient = jnp.ones((3, 8, 4)) * 0.1
        error = jnp.ones(3)

        def single_update(s, g, e):
            return optimizer.update_from_gradient(s, g, error=e)

        batched_step, batched_new_state = jax.vmap(single_update)(
            batched_state, gradient, error
        )

        chex.assert_shape(batched_step, (3, 8, 4))
        chex.assert_tree_all_finite(batched_step)

    def test_to_config_default_mode(self):
        """to_config should omit h_decay_mode when default."""
        optimizer = IDBD(initial_step_size=0.01, meta_step_size=0.01)
        config = optimizer.to_config()
        assert "h_decay_mode" not in config

    def test_to_config_non_default_mode(self):
        """to_config should include h_decay_mode when non-default."""
        optimizer = IDBD(h_decay_mode="loss_grads")
        config = optimizer.to_config()
        assert config["h_decay_mode"] == "loss_grads"


class TestOptimizerComparison:
    """Integration tests comparing LMS, IDBD, and Autostep behavior."""

    def test_all_optimizers_produce_valid_updates(self, sample_observation):
        """All optimizers should produce finite, non-zero updates."""
        lms = LMS(step_size=0.01)
        idbd = IDBD(initial_step_size=0.01)
        autostep = Autostep(initial_step_size=0.01)
        obgd = ObGD(step_size=0.01)

        lms_state = lms.init(len(sample_observation))
        idbd_state = idbd.init(len(sample_observation))
        autostep_state = autostep.init(len(sample_observation))
        obgd_state = obgd.init(len(sample_observation))

        error = jnp.array(1.0)

        lms_result = lms.update(lms_state, error, sample_observation)
        idbd_result = idbd.update(idbd_state, error, sample_observation)
        autostep_result = autostep.update(autostep_state, error, sample_observation)
        obgd_result = obgd.update(obgd_state, error, sample_observation)

        # All should produce finite updates
        chex.assert_tree_all_finite(lms_result.weight_delta)
        chex.assert_tree_all_finite(idbd_result.weight_delta)
        chex.assert_tree_all_finite(autostep_result.weight_delta)
        chex.assert_tree_all_finite(obgd_result.weight_delta)

        # All should produce non-zero updates for non-zero error
        assert jnp.any(lms_result.weight_delta != 0)
        assert jnp.any(idbd_result.weight_delta != 0)
        assert jnp.any(autostep_result.weight_delta != 0)
        assert jnp.any(obgd_result.weight_delta != 0)
