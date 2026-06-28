"""Tests for feature relevance diagnostics."""

import json

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    Autostep,
    EMANormalizer,
    MultiHeadMLPLearner,
    ObGDBounding,
    compute_feature_relevance,
    compute_feature_sensitivity,
    relevance_to_dict,
)

# =============================================================================
# Fixtures
# =============================================================================

FEATURE_DIM = 12
N_HEADS = 5
HIDDEN = (64, 64)


def _make_learner(optimizer=None, normalizer=None, hidden_sizes=HIDDEN, **kwargs):
    """Create a MultiHeadMLPLearner with sensible defaults."""
    return MultiHeadMLPLearner(
        n_heads=N_HEADS,
        hidden_sizes=hidden_sizes,
        optimizer=optimizer,
        normalizer=normalizer,
        sparsity=0.9,
        **kwargs,
    )


def _make_state(learner, key=None):
    if key is None:
        key = jr.key(42)
    return learner.init(feature_dim=FEATURE_DIM, key=key)


# =============================================================================
# compute_feature_relevance — shape tests
# =============================================================================


class TestFeatureRelevanceShapes:
    """Verify all output shapes are correct."""

    def test_shapes_with_autostep(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        chex.assert_shape(rel.weight_relevance, (N_HEADS, FEATURE_DIM))
        chex.assert_shape(rel.step_size_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.trace_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.head_reliance, (N_HEADS, HIDDEN[-1]))
        assert rel.normalizer_mean is None
        assert rel.normalizer_std is None
        # Autostep has per-weight step-sizes on heads
        chex.assert_shape(rel.head_mean_step_size, (N_HEADS,))

    def test_shapes_with_lms(self):
        learner = _make_learner(step_size=0.01)
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        chex.assert_shape(rel.weight_relevance, (N_HEADS, FEATURE_DIM))
        chex.assert_shape(rel.step_size_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.trace_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.head_reliance, (N_HEADS, HIDDEN[-1]))
        # LMS has no per-weight step-sizes on heads
        assert rel.head_mean_step_size is None

    def test_shapes_with_normalizer(self):
        learner = _make_learner(optimizer=Autostep(), normalizer=EMANormalizer(decay=0.99))
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        chex.assert_shape(rel.normalizer_mean, (FEATURE_DIM,))
        chex.assert_shape(rel.normalizer_std, (FEATURE_DIM,))

    def test_shapes_without_normalizer(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        assert rel.normalizer_mean is None
        assert rel.normalizer_std is None


# =============================================================================
# compute_feature_relevance — value tests
# =============================================================================


class TestFeatureRelevanceValues:
    """Verify metrics have sensible values."""

    def test_lms_step_size_uniform(self):
        """LMS should give uniform step-size activity across features."""
        learner = _make_learner(step_size=0.05)
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        # All features should have the same step-size activity
        expected = jnp.full(FEATURE_DIM, 0.05)
        chex.assert_trees_all_close(rel.step_size_activity, expected, atol=1e-6)

    def test_traces_zero_at_init(self):
        """Traces should be zero at init."""
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        chex.assert_trees_all_close(rel.trace_activity, jnp.zeros(FEATURE_DIM), atol=1e-8)

    def test_weight_relevance_nonnegative(self):
        """Path-norm weight relevance should be non-negative."""
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        assert jnp.all(rel.weight_relevance >= 0)

    def test_relevance_changes_after_updates(self):
        """Relevance metrics should change after a few update steps."""
        learner = _make_learner(
            optimizer=Autostep(),
            normalizer=EMANormalizer(decay=0.99),
            bounder=ObGDBounding(kappa=2.0),
        )
        state = _make_state(learner)

        compute_feature_relevance(state)

        # Run a few updates
        key = jr.key(99)
        for _ in range(20):
            key, k1, k2 = jr.split(key, 3)
            obs = jr.normal(k1, (FEATURE_DIM,))
            targets = jr.normal(k2, (N_HEADS,))
            result = learner.update(state, obs, targets)
            state = result.state

        rel_after = compute_feature_relevance(state)

        # At least trace_activity should have changed from zero
        assert jnp.any(rel_after.trace_activity > 0)
        # Normalizer mean should have shifted from zero
        assert jnp.any(jnp.abs(rel_after.normalizer_mean) > 1e-6)

    def test_no_trunk_layers(self):
        """Works when hidden_sizes=() — multi-head linear model."""
        learner = _make_learner(optimizer=Autostep(), hidden_sizes=())
        state = learner.init(feature_dim=FEATURE_DIM, key=jr.key(42))
        rel = compute_feature_relevance(state)

        chex.assert_shape(rel.weight_relevance, (N_HEADS, FEATURE_DIM))
        chex.assert_shape(rel.step_size_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.trace_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.head_reliance, (N_HEADS, FEATURE_DIM))

    def test_linear_multihead_uses_head_traces_and_step_sizes(self):
        """Linear Horde-style states report head-level feature activity."""
        learner = _make_learner(optimizer=Autostep(), hidden_sizes=())
        state = learner.init(feature_dim=FEATURE_DIM, key=jr.key(42))
        result = learner.update(
            state,
            jnp.ones(FEATURE_DIM, dtype=jnp.float32),
            jnp.ones(N_HEADS, dtype=jnp.float32),
        )

        rel = compute_feature_relevance(result.state)

        chex.assert_shape(rel.step_size_activity, (FEATURE_DIM,))
        chex.assert_shape(rel.trace_activity, (FEATURE_DIM,))
        assert jnp.any(rel.step_size_activity > 0.0)
        assert jnp.any(rel.trace_activity > 0.0)


# =============================================================================
# compute_feature_sensitivity
# =============================================================================


class TestFeatureSensitivity:
    """Tests for Jacobian-based feature sensitivity."""

    def test_shape(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        obs = jr.normal(jr.key(1), (FEATURE_DIM,))

        sensitivity = compute_feature_sensitivity(learner, state, obs)
        chex.assert_shape(sensitivity, (N_HEADS, FEATURE_DIM))

    def test_shape_with_normalizer(self):
        learner = _make_learner(optimizer=Autostep(), normalizer=EMANormalizer(decay=0.99))
        state = _make_state(learner)
        obs = jr.normal(jr.key(1), (FEATURE_DIM,))

        sensitivity = compute_feature_sensitivity(learner, state, obs)
        chex.assert_shape(sensitivity, (N_HEADS, FEATURE_DIM))

    def test_finite_values(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        obs = jr.normal(jr.key(1), (FEATURE_DIM,))

        sensitivity = compute_feature_sensitivity(learner, state, obs)
        chex.assert_tree_all_finite(sensitivity)


# =============================================================================
# relevance_to_dict
# =============================================================================


class TestRelevanceToDict:
    """Tests for dict conversion and JSON serialization."""

    def test_json_serializable(self):
        learner = _make_learner(optimizer=Autostep(), normalizer=EMANormalizer(decay=0.99))
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)
        # Should not raise
        json.dumps(d)

    def test_custom_names(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        feature_names = [f"feat_{i}" for i in range(FEATURE_DIM)]
        head_names = ["is_malicious", "bot_detect", "attack_stage", "session_val", "anomaly"]

        d = relevance_to_dict(rel, feature_names=feature_names, head_names=head_names)

        assert "feat_0" in d["trunk"]["step_size_activity"]
        assert "is_malicious" in d["per_head"]
        assert "feat_0" in d["per_head"]["is_malicious"]["weight_relevance"]

    def test_default_names(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)

        assert "feature_0" in d["trunk"]["step_size_activity"]
        assert "head_0" in d["per_head"]

    def test_normalized_weight_relevance_present_with_normalizer(self):
        learner = _make_learner(optimizer=Autostep(), normalizer=EMANormalizer(decay=0.99))
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)
        assert "normalized_weight_relevance" in d["per_head"]["head_0"]

    def test_normalized_weight_relevance_absent_without_normalizer(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)
        assert "normalized_weight_relevance" not in d["per_head"]["head_0"]

    def test_head_mean_step_size_in_dict(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)
        assert "mean_step_size" in d["per_head"]["head_0"]

    def test_no_mean_step_size_for_lms(self):
        learner = _make_learner(step_size=0.01)
        state = _make_state(learner)
        rel = compute_feature_relevance(state)

        d = relevance_to_dict(rel)
        assert "mean_step_size" not in d["per_head"]["head_0"]


# =============================================================================
# JIT compilation
# =============================================================================


class TestJITCompilation:
    """Verify diagnostics work under JIT."""

    def test_jit_compute_feature_relevance(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)

        jit_fn = jax.jit(compute_feature_relevance)
        rel = jit_fn(state)

        chex.assert_shape(rel.weight_relevance, (N_HEADS, FEATURE_DIM))
        chex.assert_tree_all_finite(rel.weight_relevance)

    def test_jit_compute_feature_sensitivity(self):
        learner = _make_learner(optimizer=Autostep())
        state = _make_state(learner)
        obs = jr.normal(jr.key(1), (FEATURE_DIM,))

        jit_fn = jax.jit(lambda s, o: compute_feature_sensitivity(learner, s, o))
        sensitivity = jit_fn(state, obs)

        chex.assert_shape(sensitivity, (N_HEADS, FEATURE_DIM))
        chex.assert_tree_all_finite(sensitivity)
