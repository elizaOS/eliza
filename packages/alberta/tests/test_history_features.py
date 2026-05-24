"""Tests for the history-feature extractor (Step 3 Phase D)."""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework.core.history_features import (
    HistoryFeatureExtractor,
    HistoryFeatureState,
)


class TestInit:
    def test_init_traces_zero(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=4, decay_rates=(0.5, 0.9))
        s = ex.init()
        chex.assert_shape(s.traces, (2, 4))
        chex.assert_trees_all_close(s.traces, jnp.zeros((2, 4)))

    def test_feature_dim_with_raw(self) -> None:
        ex = HistoryFeatureExtractor(
            raw_dim=4, decay_rates=(0.5, 0.9, 0.99), include_raw=True
        )
        assert ex.feature_dim() == 4 + 4 * 3

    def test_feature_dim_without_raw(self) -> None:
        ex = HistoryFeatureExtractor(
            raw_dim=4, decay_rates=(0.5, 0.9), include_raw=False
        )
        assert ex.feature_dim() == 4 * 2

    def test_feature_dim_subset_channels(self) -> None:
        ex = HistoryFeatureExtractor(
            raw_dim=10, decay_rates=(0.9,), channels=(0, 3, 5)
        )
        assert ex.feature_dim() == 10 + 3 * 1


class TestValidation:
    def test_invalid_decay_rate_negative(self) -> None:
        with pytest.raises(ValueError, match="decay_rates"):
            HistoryFeatureExtractor(raw_dim=4, decay_rates=(-0.1, 0.9))

    def test_invalid_decay_rate_one(self) -> None:
        with pytest.raises(ValueError, match="decay_rates"):
            HistoryFeatureExtractor(raw_dim=4, decay_rates=(0.5, 1.0))

    def test_invalid_channel_index(self) -> None:
        with pytest.raises(ValueError, match="channels"):
            HistoryFeatureExtractor(raw_dim=4, channels=(0, 5))


class TestStep:
    def test_first_step_traces(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=3, decay_rates=(0.9,))
        s = ex.init()
        obs = jnp.array([1.0, 2.0, 3.0])
        aug, s2 = ex.step(s, obs)
        # First step: trace = 0.9 * 0 + 0.1 * obs = 0.1 * obs
        chex.assert_trees_all_close(s2.traces[0], 0.1 * obs, atol=1e-7)
        # Augmented: raw + traces (raw_dim=3, decay rates=1, so 6 dims)
        chex.assert_shape(aug, (6,))
        chex.assert_trees_all_close(aug[:3], obs)
        chex.assert_trees_all_close(aug[3:], 0.1 * obs, atol=1e-7)

    def test_decay_dynamics(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=1, decay_rates=(0.5,))
        s = ex.init()
        obs1 = jnp.array([1.0])
        obs2 = jnp.array([0.0])

        # Step 1: trace = 0.5*0 + 0.5*1 = 0.5
        _, s1 = ex.step(s, obs1)
        chex.assert_trees_all_close(s1.traces[0], jnp.array([0.5]), atol=1e-7)

        # Step 2 with obs=0: trace = 0.5*0.5 + 0.5*0 = 0.25
        _, s2 = ex.step(s1, obs2)
        chex.assert_trees_all_close(s2.traces[0], jnp.array([0.25]), atol=1e-7)

    def test_multiple_decay_rates_independent(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=1, decay_rates=(0.0, 0.5, 0.9))
        s = ex.init()
        obs = jnp.array([1.0])
        _, s1 = ex.step(s, obs)
        # decay=0.0: trace = 0.0*0 + 1.0*1 = 1.0
        # decay=0.5: trace = 0.5
        # decay=0.9: trace = 0.1
        chex.assert_trees_all_close(
            s1.traces[:, 0], jnp.array([1.0, 0.5, 0.1]), atol=1e-7
        )

    def test_subset_channels_only(self) -> None:
        ex = HistoryFeatureExtractor(
            raw_dim=4, decay_rates=(0.5,), channels=(1, 3), include_raw=False
        )
        s = ex.init()
        obs = jnp.array([10.0, 20.0, 30.0, 40.0])
        aug, s1 = ex.step(s, obs)
        # Only channels 1, 3 are tracked
        # trace = 0.5*0 + 0.5*[20, 40] = [10, 20]
        chex.assert_shape(aug, (2,))
        chex.assert_trees_all_close(aug, jnp.array([10.0, 20.0]), atol=1e-7)


class TestJitAndScan:
    def test_step_jit_compiles(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=4, decay_rates=(0.5, 0.9))
        s = ex.init()
        # Decorator already JITs; just verify two calls produce same results
        obs = jnp.ones(4)
        out1, s1 = ex.step(s, obs)
        out2, s2 = ex.step(s, obs)
        chex.assert_trees_all_close(out1, out2)
        chex.assert_trees_all_close(s1.traces, s2.traces)

    def test_scan_compatibility(self) -> None:
        ex = HistoryFeatureExtractor(raw_dim=3, decay_rates=(0.9,))
        s0 = ex.init()
        observations = jr.normal(jr.key(0), (50, 3))

        def step_fn(state: HistoryFeatureState, obs: jax.Array):
            aug, new_state = ex.step(state, obs)
            return new_state, aug

        final_state, augmented = jax.lax.scan(step_fn, s0, observations)
        chex.assert_shape(augmented, (50, 6))
        chex.assert_tree_all_finite(augmented)
        chex.assert_tree_all_finite(final_state.traces)


class TestConfig:
    def test_roundtrip(self) -> None:
        original = HistoryFeatureExtractor(
            raw_dim=5,
            decay_rates=(0.1, 0.5, 0.9),
            channels=(0, 2, 4),
            include_raw=False,
        )
        config = original.to_config()
        restored = HistoryFeatureExtractor.from_config(config)

        assert restored.raw_dim == 5
        assert restored.decay_rates == (0.1, 0.5, 0.9)
        assert restored.channels == (0, 2, 4)
        assert restored.include_raw is False
        assert restored.feature_dim() == original.feature_dim()


# =============================================================================
# Smoke test: history features integrate with a learner
# =============================================================================


class TestIntegration:
    """Basic smoke test: a learner can consume the augmented observations
    and produce finite predictions / updates."""

    def test_extractor_plus_learner_runs(self) -> None:
        from alberta_framework import LMS, LinearLearner

        ex = HistoryFeatureExtractor(raw_dim=2, decay_rates=(0.5, 0.9))
        learner = LinearLearner(optimizer=LMS(step_size=0.05))
        l_state = learner.init(ex.feature_dim())
        h_state = ex.init()

        rng = np.random.default_rng(0)
        for _ in range(50):
            obs = jnp.asarray(rng.normal(size=2).astype(np.float32))
            target = jnp.atleast_1d(jnp.float32(rng.normal()))
            aug, h_state = ex.step(h_state, obs)
            res = learner.update(l_state, aug, target)
            l_state = res.state

        chex.assert_tree_all_finite(l_state.weights)
        chex.assert_tree_all_finite(h_state.traces)
