"""Tests for the HordeLearner, learning loops, and equivalence with MultiHeadMLPLearner."""

import chex
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    Autostep,
    BatchedHordeResult,
    DemonType,
    EMANormalizer,
    GVFSpec,
    HordeLearner,
    HordeLearningResult,
    MultiHeadMLPLearner,
    ObGDBounding,
    create_horde_spec,
    run_horde_learning_loop,
    run_horde_learning_loop_batched,
    run_multi_head_learning_loop,
)


def _make_all_gamma0_spec(n: int) -> list[GVFSpec]:
    """Helper: create n prediction demons with gamma=0."""
    return [
        GVFSpec(
            name=f"d{i}", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=i
        )
        for i in range(n)
    ]


# =============================================================================
# Equivalence: all-gamma=0 HordeLearner == MultiHeadMLPLearner
# =============================================================================


class TestHordeEquivalence:
    """All-gamma=0 Horde should produce identical results to MultiHeadMLPLearner."""

    def test_identical_predictions(self):
        """Predictions should match exactly."""
        n_heads = 3
        feature_dim = 5
        spec = create_horde_spec(_make_all_gamma0_spec(n_heads))

        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        multi = MultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        h_state = horde.init(feature_dim, key)
        m_state = multi.init(feature_dim, key)

        obs = jnp.array([1.0, 0.5, -0.3, 0.2, 0.8])

        h_preds = horde.predict(h_state, obs)
        m_preds = multi.predict(m_state, obs)

        chex.assert_trees_all_close(h_preds, m_preds)

    def test_identical_updates(self):
        """Updates with gamma=0 should match MultiHeadMLPLearner exactly."""
        n_heads = 3
        feature_dim = 5
        spec = create_horde_spec(_make_all_gamma0_spec(n_heads))

        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        multi = MultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        h_state = horde.init(feature_dim, key)
        m_state = multi.init(feature_dim, key)

        obs = jnp.array([1.0, 0.5, -0.3, 0.2, 0.8])
        targets = jnp.array([1.0, 2.0, 3.0])
        next_obs = jnp.zeros(feature_dim)  # doesn't matter for gamma=0

        h_result = horde.update(h_state, obs, targets, next_obs)
        m_result = multi.update(m_state, obs, targets)

        chex.assert_trees_all_close(h_result.predictions, m_result.predictions)
        chex.assert_trees_all_close(h_result.td_errors, m_result.errors)
        chex.assert_trees_all_close(h_result.per_demon_metrics, m_result.per_head_metrics)
        chex.assert_trees_all_close(h_result.trunk_bounding_metric, m_result.trunk_bounding_metric)

    def test_multi_step_equivalence(self):
        """Multiple steps should stay equivalent."""
        n_heads = 2
        feature_dim = 5
        num_steps = 20
        spec = create_horde_spec(_make_all_gamma0_spec(n_heads))

        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        multi = MultiHeadMLPLearner(
            n_heads=n_heads,
            hidden_sizes=(16,),
            step_size=1.0,
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)

        h_state = horde.init(feature_dim, k1)
        m_state = multi.init(feature_dim, k1)

        observations = jr.normal(k2, (num_steps, feature_dim))
        targets = jr.normal(k3, (num_steps, n_heads))
        next_observations = jnp.zeros((num_steps, feature_dim))

        h_result = run_horde_learning_loop(horde, h_state, observations, targets, next_observations)
        m_result = run_multi_head_learning_loop(multi, m_state, observations, targets)

        chex.assert_trees_all_close(
            h_result.per_demon_metrics, m_result.per_head_metrics, rtol=1e-5
        )


# =============================================================================
# TD target computation
# =============================================================================


class TestHordeTDTargets:
    """Tests for correct TD target computation."""

    def test_gamma0_target_equals_cumulant(self):
        """For gamma=0, TD target should equal the cumulant."""
        spec = create_horde_spec(_make_all_gamma0_spec(2))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, 2.0])
        next_obs = jnp.ones(5) * 99.0  # should not matter

        result = horde.update(state, obs, cumulants, next_obs)

        chex.assert_trees_all_close(result.td_targets, cumulants)

    def test_temporal_demon_td_target(self):
        """For gamma=0.9, target = cumulant + 0.9 * V(s')."""
        demons = [
            GVFSpec(
                name="temporal",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.0,
                cumulant_index=0,
            ),
        ]
        spec = create_horde_spec(demons)
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulant = jnp.array([1.0])
        next_obs = jnp.ones(5) * 0.5

        # Compute expected target manually
        v_next = horde.predict(state, next_obs)
        expected_target = cumulant + 0.9 * v_next

        result = horde.update(state, obs, cumulant, next_obs)

        chex.assert_trees_all_close(result.td_targets, expected_target, atol=1e-6)


# =============================================================================
# Mixed gamma tests
# =============================================================================


class TestHordeMixedGamma:
    """Tests with mixed gamma=0 and gamma>0 demons."""

    def test_mixed_gamma_demons(self):
        """3 gamma=0 + 2 gamma=0.9 demons should work independently."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=1
            ),
            GVFSpec(
                name="d2", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=2
            ),
            GVFSpec(
                name="d3", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.0, cumulant_index=3
            ),
            GVFSpec(
                name="d4", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.0, cumulant_index=4
            ),
        ]
        spec = create_horde_spec(demons)
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, 2.0, 3.0, 0.5, 0.8])
        next_obs = jnp.ones(5) * 0.5

        result = horde.update(state, obs, cumulants, next_obs)

        # gamma=0 demons: targets == cumulants
        chex.assert_trees_all_close(result.td_targets[:3], cumulants[:3], atol=1e-6)

        # gamma=0.9 demons: targets = cumulant + 0.9 * V(s')
        v_next = horde.predict(state, next_obs)
        expected_d3 = cumulants[3] + 0.9 * v_next[3]
        expected_d4 = cumulants[4] + 0.9 * v_next[4]
        chex.assert_trees_all_close(result.td_targets[3], expected_d3, atol=1e-6)
        chex.assert_trees_all_close(result.td_targets[4], expected_d4, atol=1e-6)

        # All results should be finite
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_demon_metrics)


# =============================================================================
# Trace decay tests
# =============================================================================


class TestHordeTraceDecay:
    """Tests for per-head trace decay with lambda > 0."""

    def test_trace_accumulates_with_lamda(self):
        """Demons with lambda>0 should accumulate traces per-head."""
        demons = [
            GVFSpec(
                name="no_trace",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.0,
                cumulant_index=0,
            ),
            GVFSpec(
                name="with_trace",
                demon_type=DemonType.PREDICTION,
                gamma=0.9,
                lamda=0.8,
                cumulant_index=1,
            ),
        ]
        spec = create_horde_spec(demons)
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
        )

        key = jr.key(42)
        state = horde.init(5, key)

        obs1 = jnp.ones(5)
        obs2 = jnp.ones(5) * 0.5
        cumulants = jnp.array([1.0, 1.0])

        # Step 1
        r1 = horde.update(state, obs1, cumulants, obs2)
        # Step 2
        r2 = horde.update(r1.state, obs2, cumulants, obs1)

        # Head 0 (gamma*lambda=0.0): traces should not accumulate
        # Head 1 (gamma*lambda=0.72): traces should accumulate
        # Both should produce finite results
        chex.assert_tree_all_finite(r2.predictions)
        chex.assert_tree_all_finite(r2.td_errors)

        # Head traces should differ because of different decay rates
        h0_w_trace = r2.state.head_traces[0][0]
        h1_w_trace = r2.state.head_traces[1][0]
        assert not jnp.allclose(h0_w_trace, h1_w_trace)


# =============================================================================
# NaN masking
# =============================================================================


class TestHordeNaNMasking:
    """Tests for inactive demon handling via NaN cumulants."""

    def test_nan_cumulant_preserves_state(self):
        """NaN cumulant should keep demon state unchanged."""
        spec = create_horde_spec(_make_all_gamma0_spec(3))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, jnp.nan, 3.0])
        next_obs = jnp.zeros(5)

        result = horde.update(state, obs, cumulants, next_obs)

        # Head 1 should be unchanged
        chex.assert_trees_all_close(
            result.state.head_params.weights[1],
            state.head_params.weights[1],
        )
        # Head 1 error should be NaN
        assert jnp.isnan(result.td_errors[1])

        # Active heads should have changed
        assert not jnp.allclose(
            result.state.head_params.weights[0],
            state.head_params.weights[0],
        )


# =============================================================================
# Config serialization
# =============================================================================


class TestHordeConfig:
    """Tests for HordeLearner config serialization."""

    def test_config_roundtrip(self):
        """to_config/from_config should preserve all settings."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.8, cumulant_index=1
            ),
        ]
        spec = create_horde_spec(demons)
        original = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(32, 16),
            step_size=0.5,
            sparsity=0.8,
            leaky_relu_slope=0.02,
            use_layer_norm=False,
            bounder=ObGDBounding(kappa=3.0),
        )

        config = original.to_config()
        assert config["type"] == "HordeLearner"
        assert len(config["horde_spec"]["demons"]) == 2

        restored = HordeLearner.from_config(config)

        # Verify reconstruction
        assert restored.n_demons == 2
        assert restored.horde_spec.demons[0].name == "d0"
        assert restored.horde_spec.demons[1].gamma == 0.9
        assert restored.horde_spec.demons[1].lamda == 0.8

        # Verify produces same predictions
        key = jr.key(42)
        obs = jnp.ones(5)

        s1 = original.init(5, key)
        s2 = restored.init(5, key)

        p1 = original.predict(s1, obs)
        p2 = restored.predict(s2, obs)

        chex.assert_trees_all_close(p1, p2)

    def test_config_roundtrip_with_head_optimizer(self):
        """Config should handle head_optimizer."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            )
        ]
        spec = create_horde_spec(demons)
        original = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            head_optimizer=Autostep(initial_step_size=0.01),
        )

        config = original.to_config()
        restored = HordeLearner.from_config(config)

        key = jr.key(42)
        s1 = original.init(5, key)
        s2 = restored.init(5, key)

        chex.assert_trees_all_close(
            original.predict(s1, jnp.ones(5)),
            restored.predict(s2, jnp.ones(5)),
        )


# =============================================================================
# Linear baseline
# =============================================================================


class TestHordeLinearBaseline:
    """Tests for HordeLearner with hidden_sizes=() (linear baseline)."""

    def test_linear_with_temporal_demons(self):
        """hidden_sizes=() should work with gamma>0 demons."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.5, cumulant_index=1
            ),
        ]
        spec = create_horde_spec(demons)
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(42))

        obs = jnp.ones(5)
        cumulants = jnp.array([1.0, 0.5])
        next_obs = jnp.ones(5) * 0.5

        result = horde.update(state, obs, cumulants, next_obs)

        chex.assert_shape(result.predictions, (2,))
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.per_demon_metrics)


# =============================================================================
# Scan loop tests
# =============================================================================


class TestRunHordeLearningLoop:
    """Tests for run_horde_learning_loop."""

    def test_correct_shapes(self):
        """Scan loop should return correct shapes."""
        n_demons = 3
        num_steps = 50
        feature_dim = 5

        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(feature_dim, jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        observations = jr.normal(k1, (num_steps, feature_dim))
        cumulants = jr.normal(k2, (num_steps, n_demons))
        next_observations = jnp.zeros((num_steps, feature_dim))

        result = run_horde_learning_loop(horde, state, observations, cumulants, next_observations)

        assert isinstance(result, HordeLearningResult)
        chex.assert_shape(result.per_demon_metrics, (num_steps, n_demons, 3))
        chex.assert_shape(result.td_errors, (num_steps, n_demons))

    def test_deterministic(self):
        """Same inputs should give identical results."""
        spec = create_horde_spec(_make_all_gamma0_spec(2))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        obs = jr.normal(k1, (30, 5))
        cums = jr.normal(k2, (30, 2))
        next_obs = jnp.zeros((30, 5))

        r1 = run_horde_learning_loop(horde, state, obs, cums, next_obs)
        r2 = run_horde_learning_loop(horde, state, obs, cums, next_obs)

        chex.assert_trees_all_close(r1.per_demon_metrics, r2.per_demon_metrics)
        chex.assert_trees_all_close(r1.td_errors, r2.td_errors)

    def test_with_normalizer(self):
        """Should work with EMANormalizer."""
        spec = create_horde_spec(_make_all_gamma0_spec(2))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            normalizer=EMANormalizer(),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        obs = jr.normal(k1, (30, 5))
        cums = jr.normal(k2, (30, 2))
        next_obs = jnp.zeros((30, 5))

        result = run_horde_learning_loop(horde, state, obs, cums, next_obs)
        chex.assert_shape(result.per_demon_metrics, (30, 2, 3))

    def test_temporal_scan_loop(self):
        """Scan loop with gamma>0 demons should work."""
        demons = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.0, cumulant_index=1
            ),
        ]
        spec = create_horde_spec(demons)
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )
        state = horde.init(5, jr.key(0))

        key = jr.key(42)
        k1, k2 = jr.split(key)
        obs = jr.normal(k1, (30, 5))
        cums = jr.normal(k2, (30, 2))
        # next_obs = obs shifted by 1 (realistic TD setting)
        next_obs = jnp.concatenate([obs[1:], obs[:1]], axis=0)

        result = run_horde_learning_loop(horde, state, obs, cums, next_obs)

        chex.assert_shape(result.per_demon_metrics, (30, 2, 3))
        chex.assert_shape(result.td_errors, (30, 2))
        # TD targets for d1 should differ from cumulants
        # (because gamma=0.9 adds V(s') bootstrap)


# =============================================================================
# Batched loop tests
# =============================================================================


class TestRunHordeLearningLoopBatched:
    """Tests for run_horde_learning_loop_batched."""

    def test_correct_shapes(self):
        """Batched loop should return correctly shaped results."""
        n_demons = 3
        num_steps = 30
        feature_dim = 5
        n_seeds = 4

        spec = create_horde_spec(_make_all_gamma0_spec(n_demons))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        obs = jr.normal(k1, (num_steps, feature_dim))
        cums = jr.normal(k2, (num_steps, n_demons))
        next_obs = jnp.zeros((num_steps, feature_dim))
        keys = jr.split(k3, n_seeds)

        result = run_horde_learning_loop_batched(horde, obs, cums, next_obs, keys)

        assert isinstance(result, BatchedHordeResult)
        chex.assert_shape(result.per_demon_metrics, (n_seeds, num_steps, n_demons, 3))
        chex.assert_shape(result.td_errors, (n_seeds, num_steps, n_demons))

    def test_different_seeds_different_results(self):
        """Different seeds should produce different metrics."""
        spec = create_horde_spec(_make_all_gamma0_spec(2))
        horde = HordeLearner(
            horde_spec=spec,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        obs = jr.normal(k1, (30, 5))
        cums = jr.normal(k2, (30, 2))
        next_obs = jnp.zeros((30, 5))
        keys = jr.split(k3, 3)

        result = run_horde_learning_loop_batched(horde, obs, cums, next_obs, keys)

        assert not jnp.allclose(result.per_demon_metrics[0], result.per_demon_metrics[1])


# =============================================================================
# Non-stationary config change (chaos test)
# =============================================================================


class TestHordeConfigReload:
    """Test that changing demon gamma/lambda mid-stream via config is safe."""

    def test_gamma_change_mid_stream(self):
        """Changing gamma via new HordeLearner should not cause NaNs."""
        feature_dim = 5

        # Phase 1: all gamma=0
        demons_v1 = _make_all_gamma0_spec(3)
        spec_v1 = create_horde_spec(demons_v1)
        horde_v1 = HordeLearner(
            horde_spec=spec_v1,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        key = jr.key(42)
        k1, k2 = jr.split(key)
        state = horde_v1.init(feature_dim, k1)

        obs = jr.normal(k2, (5,))
        cums = jnp.array([1.0, 2.0, 3.0])
        next_obs = jnp.zeros(feature_dim)

        # Run a few steps
        for _ in range(5):
            result = horde_v1.update(state, obs, cums, next_obs)
            state = result.state

        chex.assert_tree_all_finite(result.predictions)

        # Phase 2: change demon 1 to gamma=0.9
        demons_v2 = [
            GVFSpec(
                name="d0", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=0
            ),
            GVFSpec(
                name="d1", demon_type=DemonType.PREDICTION, gamma=0.9, lamda=0.5, cumulant_index=1
            ),
            GVFSpec(
                name="d2", demon_type=DemonType.PREDICTION, gamma=0.0, lamda=0.0, cumulant_index=2
            ),
        ]
        spec_v2 = create_horde_spec(demons_v2)
        horde_v2 = HordeLearner(
            horde_spec=spec_v2,
            hidden_sizes=(16,),
            sparsity=0.0,
            bounder=ObGDBounding(kappa=2.0),
        )

        # Continue from existing state with new horde
        for _ in range(5):
            result = horde_v2.update(state, obs, cums, next_obs)
            state = result.state

        # Should not produce NaNs
        chex.assert_tree_all_finite(result.predictions)
        chex.assert_tree_all_finite(result.td_errors)
        chex.assert_tree_all_finite(result.per_demon_metrics)


# =============================================================================
# Per-head gamma_lamda on MultiHeadMLPLearner
# =============================================================================


class TestPerHeadGammaLamda:
    """Tests for per_head_gamma_lamda parameter on MultiHeadMLPLearner."""

    def test_none_preserves_existing_behavior(self):
        """per_head_gamma_lamda=None should match default behavior."""
        key = jr.key(42)
        k1, k2, k3 = jr.split(key, 3)
        observations = jr.normal(k2, (20, 5))
        targets = jr.normal(k3, (20, 2))

        learner_default = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(),
            sparsity=0.0,
            gamma=0.5,
            lamda=0.3,
            bounder=ObGDBounding(kappa=2.0),
        )
        learner_explicit = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(),
            sparsity=0.0,
            gamma=0.5,
            lamda=0.3,
            bounder=ObGDBounding(kappa=2.0),
            per_head_gamma_lamda=None,
        )

        s1 = learner_default.init(5, k1)
        s2 = learner_explicit.init(5, k1)

        r1 = run_multi_head_learning_loop(learner_default, s1, observations, targets)
        r2 = run_multi_head_learning_loop(learner_explicit, s2, observations, targets)

        chex.assert_trees_all_close(r1.per_head_metrics, r2.per_head_metrics)

    def test_per_head_decay_differs(self):
        """Different per-head gamma_lamda should produce different traces."""
        learner = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(16,),
            sparsity=0.0,
            per_head_gamma_lamda=(0.0, 0.72),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = learner.init(5, jr.key(42))

        obs = jnp.ones(5)
        targets = jnp.array([1.0, 1.0])

        # Two steps to let traces accumulate
        r1 = learner.update(state, obs, targets)
        r2 = learner.update(r1.state, obs, targets)

        # Head 0 (gl=0.0): trace should not accumulate
        # Head 1 (gl=0.72): trace should accumulate
        h0_trace = r2.state.head_traces[0][0]
        h1_trace = r2.state.head_traces[1][0]
        assert not jnp.allclose(h0_trace, h1_trace)

    def test_config_roundtrip(self):
        """per_head_gamma_lamda should survive config roundtrip."""
        learner = MultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(16,),
            sparsity=0.0,
            per_head_gamma_lamda=(0.0, 0.5, 0.9),
        )
        config = learner.to_config()
        assert config["per_head_gamma_lamda"] == [0.0, 0.5, 0.9]

        restored = MultiHeadMLPLearner.from_config(config)
        restored_config = restored.to_config()
        assert restored_config["per_head_gamma_lamda"] == [0.0, 0.5, 0.9]
