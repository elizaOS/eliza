"""Tests for the Alberta Plan Step 1 streams.

Covers :class:`AlbertaPlanStep1Stream` (drifting target with eta_t noise) and
:class:`XDistShiftStream` (fixed target with shifting input distribution).
Together these exercise the full Step 1 spec: ``y*_t = w*_t . x_t + b*_t +
eta_t`` with non-stationarity in either the target functions or the input
distribution.
"""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import pytest

from alberta_framework.core.types import TimeStep
from alberta_framework.streams.alberta_plan_step1 import (
    AlbertaPlanStep1State,
    AlbertaPlanStep1Stream,
    XDistShiftState,
    XDistShiftStream,
)

# -----------------------------------------------------------------------------
# AlbertaPlanStep1Stream
# -----------------------------------------------------------------------------


def _collect_step1_targets(
    stream: AlbertaPlanStep1Stream, key: jnp.ndarray, num_steps: int
) -> jnp.ndarray:
    """Run a stream for ``num_steps`` and return the stacked scalar targets."""
    state = stream.init(key)
    targets = []
    for i in range(num_steps):
        timestep, state = stream.step(state, jnp.array(i))
        targets.append(timestep.target[0])
    return jnp.stack(targets)


class TestAlbertaPlanStep1Stream:
    """Tests for :class:`AlbertaPlanStep1Stream`."""

    def test_default_construction_and_feature_dim(self):
        stream = AlbertaPlanStep1Stream()
        assert stream.feature_dim == 20
        assert stream.num_relevant == 5

    def test_invalid_construction_rejected(self):
        with pytest.raises(ValueError):
            AlbertaPlanStep1Stream(feature_dim=0)
        with pytest.raises(ValueError):
            AlbertaPlanStep1Stream(num_relevant=0)
        with pytest.raises(ValueError):
            AlbertaPlanStep1Stream(feature_dim=5, num_relevant=10)

    def test_init_returns_state_with_sparse_weights(self):
        stream = AlbertaPlanStep1Stream(feature_dim=20, num_relevant=5)
        state = stream.init(jr.key(0))
        assert isinstance(state, AlbertaPlanStep1State)
        assert state.true_weights.shape == (20,)
        # Irrelevant weights start at zero.
        assert jnp.all(state.true_weights[5:] == 0.0)
        # Bias starts at zero.
        chex.assert_trees_all_close(state.true_bias, jnp.array(0.0))

    def test_step_returns_well_formed_timestep(self):
        stream = AlbertaPlanStep1Stream(feature_dim=20, num_relevant=5)
        state = stream.init(jr.key(0))
        timestep, new_state = stream.step(state, jnp.array(0))

        assert isinstance(timestep, TimeStep)
        assert timestep.observation.shape == (20,)
        assert timestep.target.shape == (1,)
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

        # step_count incremented.
        assert int(new_state.step_count) == 1

    def test_irrelevant_weights_stay_zero_under_drift(self):
        """Even with ``drift_rate_w > 0`` the irrelevant entries must stay zero
        — the random walk only touches the first ``num_relevant`` slots."""
        stream = AlbertaPlanStep1Stream(
            feature_dim=20, num_relevant=5, drift_rate_w=0.5, drift_rate_b=0.5
        )
        state = stream.init(jr.key(2))
        for i in range(500):
            _, state = stream.step(state, jnp.array(i))
        assert jnp.all(state.true_weights[5:] == 0.0)

    def test_alberta_plan_stream_has_noise(self):
        """With ``noise_std=1.0`` the target std must be visibly nonzero,
        even if all drift rates are zero (the only source of variance is the
        feature draw and the eta_t noise)."""
        # Disable drift so the only randomness in the target is x and eta.
        stream = AlbertaPlanStep1Stream(
            feature_dim=20,
            num_relevant=5,
            drift_rate_w=0.0,
            drift_rate_b=0.0,
            noise_std=1.0,
            feature_std=1.0,
        )
        targets = _collect_step1_targets(stream, jr.key(0), 2000)

        std = float(jnp.std(targets))
        assert std > 0.5, std
        chex.assert_tree_all_finite(targets)

    def test_alberta_plan_stream_w_drifts(self):
        """Run 10000 steps and verify ``w*`` has moved meaningfully off its
        initial value via the random walk."""
        stream = AlbertaPlanStep1Stream(
            feature_dim=20,
            num_relevant=5,
            drift_rate_w=0.05,
            drift_rate_b=0.0,
            noise_std=0.0,
            feature_std=1.0,
        )
        key = jr.key(3)
        state = stream.init(key)
        initial_relevant_w = state.true_weights[:5].copy()
        for i in range(10_000):
            _, state = stream.step(state, jnp.array(i))
        final_relevant_w = state.true_weights[:5]

        # The std of the increment after T steps of std-d random walk is
        # d*sqrt(T) ~ 0.05*sqrt(10000) = 5.0; so per-coordinate increments
        # should comfortably exceed 1.0 in magnitude on average.
        delta = final_relevant_w - initial_relevant_w
        assert float(jnp.std(delta)) > float(jnp.std(initial_relevant_w)), (
            "expected drifted weights to deviate further than initial spread"
        )
        # And no NaNs.
        chex.assert_tree_all_finite(final_relevant_w)
        # Irrelevant entries still zero.
        assert jnp.all(state.true_weights[5:] == 0.0)

    def test_alberta_plan_stream_zero_noise_zero_drift_is_deterministic_given_x(self):
        """With ``noise_std=0`` and zero drift, the target must equal exactly
        ``w0 . x``."""
        stream = AlbertaPlanStep1Stream(
            feature_dim=10,
            num_relevant=3,
            drift_rate_w=0.0,
            drift_rate_b=0.0,
            noise_std=0.0,
        )
        state = stream.init(jr.key(7))
        w0 = state.true_weights
        b0 = state.true_bias
        timestep, _ = stream.step(state, jnp.array(0))
        expected = jnp.dot(w0, timestep.observation) + b0
        chex.assert_trees_all_close(
            timestep.target[0], expected, rtol=1e-5, atol=1e-6
        )

    def test_alberta_plan_stream_jit_compatible(self):
        """The step function must be JIT-compatible (pure, no Python control
        flow on traced values)."""
        stream = AlbertaPlanStep1Stream(feature_dim=10, num_relevant=3)
        state = stream.init(jr.key(0))
        jit_step = jax.jit(stream.step)
        for i in range(5):
            timestep, state = jit_step(state, jnp.array(i))
            chex.assert_tree_all_finite(timestep.observation)
            chex.assert_tree_all_finite(timestep.target)


# -----------------------------------------------------------------------------
# XDistShiftStream
# -----------------------------------------------------------------------------


class TestXDistShiftStream:
    """Tests for :class:`XDistShiftStream`."""

    def test_construction_and_feature_dim(self):
        stream = XDistShiftStream(feature_dim=20, num_relevant=5)
        assert stream.feature_dim == 20
        assert stream.num_relevant == 5

    def test_invalid_construction_rejected(self):
        with pytest.raises(ValueError):
            XDistShiftStream(feature_dim=0, num_relevant=1)
        with pytest.raises(ValueError):
            XDistShiftStream(feature_dim=5, num_relevant=10)
        with pytest.raises(ValueError):
            XDistShiftStream(
                feature_dim=10, num_relevant=2, scale_change_interval=0
            )
        with pytest.raises(ValueError):
            XDistShiftStream(
                feature_dim=10, num_relevant=2, scale_min=2.0, scale_max=1.0
            )

    def test_target_function_is_fixed(self):
        """The weight vector is sampled once and never changes."""
        stream = XDistShiftStream(
            feature_dim=20, num_relevant=5, scale_change_interval=10
        )
        state = stream.init(jr.key(0))
        initial_weights = state.true_weights.copy()
        for i in range(200):
            _, state = stream.step(state, jnp.array(i))
        chex.assert_trees_all_close(state.true_weights, initial_weights)
        # Sparse-relevance preserved.
        assert jnp.all(state.true_weights[5:] == 0.0)

    def test_step_returns_well_formed_timestep(self):
        stream = XDistShiftStream(feature_dim=10, num_relevant=3)
        state = stream.init(jr.key(0))
        timestep, _ = stream.step(state, jnp.array(0))

        assert isinstance(timestep, TimeStep)
        assert timestep.observation.shape == (10,)
        assert timestep.target.shape == (1,)
        chex.assert_tree_all_finite(timestep.observation)
        chex.assert_tree_all_finite(timestep.target)

    def test_xdist_shift_stream_input_scale_changes(self):
        """Per-feature input std must measurably differ between segments
        separated by a scale change."""
        feature_dim = 6
        num_relevant = 2
        scale_change_interval = 1000
        stream = XDistShiftStream(
            feature_dim=feature_dim,
            num_relevant=num_relevant,
            scale_change_interval=scale_change_interval,
            scale_min=0.5,
            scale_max=8.0,
            noise_in_target=False,
        )
        state = stream.init(jr.key(42))

        # Collect 5000 steps spanning at least four scale changes.
        n_steps = 5000
        observations = []
        for i in range(n_steps):
            timestep, state = stream.step(state, jnp.array(i))
            observations.append(timestep.observation)
        observations = jnp.stack(observations)  # (n_steps, feature_dim)

        # Compare std within the first segment vs. within the second segment.
        seg_a = observations[:scale_change_interval]
        seg_b = observations[scale_change_interval : 2 * scale_change_interval]
        std_a = jnp.std(seg_a, axis=0)
        std_b = jnp.std(seg_b, axis=0)

        # All-finite sanity.
        chex.assert_tree_all_finite(std_a)
        chex.assert_tree_all_finite(std_b)

        # At least one feature must have visibly different std between segments.
        # Use a generous absolute threshold (>0.2) to allow for rare cases where
        # consecutive uniform draws happen to be close.
        max_diff = float(jnp.max(jnp.abs(std_a - std_b)))
        assert max_diff > 0.2, (
            f"expected per-feature std to change between scale segments, "
            f"max diff was {max_diff:.4f}"
        )

        # Stronger structural check: scales are bounded by [scale_min, scale_max]
        # so per-feature std should also be within roughly that range times the
        # latent std (1.0).
        assert float(jnp.min(std_a)) >= 0.0
        assert float(jnp.max(std_a)) <= 12.0  # 8.0 * a generous slack
        assert float(jnp.min(std_b)) >= 0.0
        assert float(jnp.max(std_b)) <= 12.0

    def test_xdist_shift_stream_target_responds_to_relevant_features(self):
        """With noise off, the target equals exactly ``w* . x`` where x is the
        scaled observation."""
        stream = XDistShiftStream(
            feature_dim=10,
            num_relevant=3,
            noise_in_target=False,
            scale_change_interval=2,
        )
        state = stream.init(jr.key(11))
        timestep, _ = stream.step(state, jnp.array(0))
        expected = jnp.dot(state.true_weights, timestep.observation)
        chex.assert_trees_all_close(
            timestep.target[0], expected, rtol=1e-5, atol=1e-6
        )

    def test_xdist_shift_stream_jit_compatible(self):
        """The step function must be JIT-compatible."""
        stream = XDistShiftStream(feature_dim=10, num_relevant=3)
        state = stream.init(jr.key(0))
        jit_step = jax.jit(stream.step)
        for i in range(5):
            timestep, state = jit_step(state, jnp.array(i))
            chex.assert_tree_all_finite(timestep.observation)
            chex.assert_tree_all_finite(timestep.target)

    def test_xdist_shift_state_typed(self):
        """Returned state is the typed dataclass."""
        stream = XDistShiftStream(feature_dim=8, num_relevant=2)
        state = stream.init(jr.key(0))
        assert isinstance(state, XDistShiftState)
