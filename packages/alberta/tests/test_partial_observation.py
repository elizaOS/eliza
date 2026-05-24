"""Tests for the partial-observation stream wrapper (Step 3 Phase D)."""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework.streams.partial_observation import (
    MaskMode,
    PartialObservationState,
    PartialObservationWrapper,
)
from alberta_framework.streams.synthetic import RandomWalkStream


class TestFixed:
    def test_fixed_mask_hides_correct_channels(self) -> None:
        inner = RandomWalkStream(feature_dim=5, drift_rate=0.0, noise_std=0.0)
        mask = jnp.array([True, False, True, False, True])
        w = PartialObservationWrapper(inner, mode=MaskMode.FIXED, fixed_mask=mask)
        state = w.init(jr.key(0))
        ts, _ = w.step(state, jnp.array(0))
        # Hidden channels (indices 1, 3) should be 0
        assert float(ts.observation[1]) == 0.0
        assert float(ts.observation[3]) == 0.0

    def test_target_unchanged(self) -> None:
        inner = RandomWalkStream(feature_dim=4, drift_rate=0.0)
        mask = jnp.array([False] * 4)  # hide everything
        w = PartialObservationWrapper(inner, mode=MaskMode.FIXED, fixed_mask=mask)
        state = w.init(jr.key(7))
        ts, _ = w.step(state, jnp.array(0))
        # Even with all observations hidden, target is whatever the inner produced
        chex.assert_tree_all_finite(ts.target)

    def test_no_fixed_mask_raises(self) -> None:
        inner = RandomWalkStream(feature_dim=3, drift_rate=0.0)
        with pytest.raises(ValueError, match="fixed_mask"):
            PartialObservationWrapper(inner, mode=MaskMode.FIXED, fixed_mask=None)

    def test_wrong_mask_shape_raises(self) -> None:
        inner = RandomWalkStream(feature_dim=4, drift_rate=0.0)
        bad_mask = jnp.array([True, False, True])
        with pytest.raises(ValueError, match="fixed_mask shape"):
            PartialObservationWrapper(inner, mode=MaskMode.FIXED, fixed_mask=bad_mask)


class TestRandom:
    def test_random_keep_fraction(self) -> None:
        inner = RandomWalkStream(feature_dim=10, drift_rate=0.0, noise_std=0.0)
        # Make features non-zero so we can detect masking
        w = PartialObservationWrapper(
            inner, mode=MaskMode.RANDOM, mask_prob=0.5
        )
        state = w.init(jr.key(0))
        # Sample many steps
        kept = []
        for i in range(500):
            ts, state = w.step(state, jnp.array(i))
            # Count non-zero channels (approximation of "kept")
            kept.append(float(jnp.sum(ts.observation != 0.0)))
        mean_kept = float(np.mean(kept))
        # Should be roughly 5 out of 10 (mask_prob = 0.5)
        assert 3.5 < mean_kept < 6.5, f"mean_kept={mean_kept}, expected ~5"

    def test_random_invalid_mask_prob(self) -> None:
        inner = RandomWalkStream(feature_dim=4, drift_rate=0.0)
        with pytest.raises(ValueError, match="mask_prob"):
            PartialObservationWrapper(
                inner, mode=MaskMode.RANDOM, mask_prob=1.5
            )


class TestPeriodic:
    def test_periodic_cycles(self) -> None:
        inner = RandomWalkStream(feature_dim=3, drift_rate=0.0, noise_std=0.0)
        schedule = (
            jnp.array([True, False, False]),
            jnp.array([False, True, False]),
            jnp.array([False, False, True]),
        )
        w = PartialObservationWrapper(
            inner, mode=MaskMode.PERIODIC, schedule=schedule
        )
        state = w.init(jr.key(42))

        # Step 0: only channel 0 visible
        ts0, state = w.step(state, jnp.array(0))
        assert float(ts0.observation[1]) == 0.0
        assert float(ts0.observation[2]) == 0.0

        # Step 1: only channel 1 visible
        ts1, state = w.step(state, jnp.array(1))
        assert float(ts1.observation[0]) == 0.0
        assert float(ts1.observation[2]) == 0.0

        # Step 2: only channel 2 visible
        ts2, state = w.step(state, jnp.array(2))
        assert float(ts2.observation[0]) == 0.0
        assert float(ts2.observation[1]) == 0.0

        # Step 3: cycle returns to channel 0
        ts3, state = w.step(state, jnp.array(3))
        assert float(ts3.observation[1]) == 0.0
        assert float(ts3.observation[2]) == 0.0

    def test_periodic_no_schedule_raises(self) -> None:
        inner = RandomWalkStream(feature_dim=3, drift_rate=0.0)
        with pytest.raises(ValueError, match="schedule"):
            PartialObservationWrapper(inner, mode=MaskMode.PERIODIC, schedule=None)

    def test_periodic_empty_schedule_raises(self) -> None:
        inner = RandomWalkStream(feature_dim=3, drift_rate=0.0)
        with pytest.raises(ValueError, match="schedule"):
            PartialObservationWrapper(inner, mode=MaskMode.PERIODIC, schedule=())


class TestScanCompatibility:
    def test_scan_with_fixed_mask(self) -> None:
        inner = RandomWalkStream(feature_dim=4, drift_rate=0.0)
        mask = jnp.array([True, False, True, False])
        w = PartialObservationWrapper(inner, mode=MaskMode.FIXED, fixed_mask=mask)
        state = w.init(jr.key(99))

        def step_fn(s: PartialObservationState, idx: jax.Array):
            ts, ns = w.step(s, idx)
            return ns, ts.observation

        final_state, observations = jax.lax.scan(step_fn, state, jnp.arange(20))
        chex.assert_shape(observations, (20, 4))
        # Hidden columns should all be zero
        chex.assert_trees_all_close(observations[:, 1], jnp.zeros(20))
        chex.assert_trees_all_close(observations[:, 3], jnp.zeros(20))

    def test_scan_with_random_mask_advances_key(self) -> None:
        inner = RandomWalkStream(feature_dim=3, drift_rate=0.0)
        w = PartialObservationWrapper(
            inner, mode=MaskMode.RANDOM, mask_prob=0.5
        )
        state = w.init(jr.key(0))

        def step_fn(s: PartialObservationState, idx: jax.Array):
            ts, ns = w.step(s, idx)
            return ns, ts.observation

        final_state, observations = jax.lax.scan(step_fn, state, jnp.arange(50))
        # Key should have advanced
        assert not jnp.all(final_state.key == jr.key(0))


class TestDeterminism:
    def test_random_mode_deterministic_with_fixed_seed(self) -> None:
        inner = RandomWalkStream(feature_dim=4, drift_rate=0.0)
        w = PartialObservationWrapper(
            inner, mode=MaskMode.RANDOM, mask_prob=0.5
        )

        def run() -> jax.Array:
            state = w.init(jr.key(123))
            obs_collected = []
            for i in range(20):
                ts, state = w.step(state, jnp.array(i))
                obs_collected.append(ts.observation)
            return jnp.stack(obs_collected)

        out1 = run()
        out2 = run()
        chex.assert_trees_all_close(out1, out2)
