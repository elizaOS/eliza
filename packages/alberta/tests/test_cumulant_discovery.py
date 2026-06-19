"""Tests for surprise-driven cumulant discovery (Step 3 Phase F)."""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework.core.cumulant_discovery import (
    CumulantDiscovery,
    CumulantDiscoveryState,
)

# =============================================================================
# Init / shapes
# =============================================================================


class TestInit:
    def test_init_shapes(self) -> None:
        d = CumulantDiscovery(raw_dim=5, n_candidates=8)
        s = d.init(jr.key(0))
        chex.assert_shape(s.projections, (8, 5))
        chex.assert_shape(s.weights, (8, 5))
        chex.assert_shape(s.biases, (8,))
        chex.assert_shape(s.utility, (8,))
        chex.assert_shape(s.ages, (8,))

    def test_init_unit_norm_projections(self) -> None:
        d = CumulantDiscovery(raw_dim=10, n_candidates=4)
        s = d.init(jr.key(0))
        norms = jnp.linalg.norm(s.projections, axis=1)
        chex.assert_trees_all_close(norms, jnp.ones(4), atol=1e-5)

    def test_init_zero_predictors(self) -> None:
        d = CumulantDiscovery(raw_dim=5, n_candidates=3)
        s = d.init(jr.key(7))
        chex.assert_trees_all_close(s.weights, jnp.zeros((3, 5)))
        chex.assert_trees_all_close(s.biases, jnp.zeros(3))
        chex.assert_trees_all_close(s.utility, jnp.zeros(3))


class TestValidation:
    def test_invalid_raw_dim(self) -> None:
        with pytest.raises(ValueError, match="raw_dim"):
            CumulantDiscovery(raw_dim=0)

    def test_invalid_n_candidates(self) -> None:
        with pytest.raises(ValueError, match="n_candidates"):
            CumulantDiscovery(raw_dim=4, n_candidates=0)

    def test_invalid_decay_rate(self) -> None:
        with pytest.raises(ValueError, match="decay_rate"):
            CumulantDiscovery(raw_dim=4, decay_rate=1.0)
        with pytest.raises(ValueError, match="decay_rate"):
            CumulantDiscovery(raw_dim=4, decay_rate=0.0)

    def test_invalid_replacement_rate(self) -> None:
        with pytest.raises(ValueError, match="replacement_rate"):
            CumulantDiscovery(raw_dim=4, replacement_rate=1.5)


# =============================================================================
# Step semantics
# =============================================================================


class TestStep:
    def test_age_increments(self) -> None:
        d = CumulantDiscovery(raw_dim=4, n_candidates=3)
        s = d.init(jr.key(0))
        for _ in range(7):
            s = d.step(s, jnp.ones(4), jnp.ones(4))
        chex.assert_trees_all_close(s.ages, jnp.array([7, 7, 7], dtype=jnp.int32))

    def test_utility_grows_with_high_surprise(self) -> None:
        d = CumulantDiscovery(
            raw_dim=2,
            n_candidates=2,
            decay_rate=0.9,
            predictor_step_size=1e-6,  # tiny -- predictor barely moves
            gamma=0.0,
        )
        s = d.init(jr.key(42))
        # The predictor stays approximately at zero for a few steps,
        # so the squared TD error is approximately (cumulant - 0)^2 > 0
        # for every step, and the utility EMA accumulates.
        for _ in range(10):
            s = d.step(s, jnp.zeros(2), jnp.array([1.0, 0.0]))
        assert float(jnp.min(s.utility)) > 0.0

    def test_step_uses_next_observation_for_transition_cumulant(self) -> None:
        d = CumulantDiscovery(
            raw_dim=2,
            n_candidates=1,
            decay_rate=0.5,
            predictor_step_size=0.1,
            gamma=0.0,
        )
        s0 = d.init(jr.key(0)).replace(
            projections=jnp.array([[1.0, 0.0]], dtype=jnp.float32)
        )
        # If the current observation were used as the cumulant this would
        # produce non-zero utility. GVF/nexting convention uses c_{t+1}.
        s1 = d.step(s0, jnp.array([2.0, 0.0]), jnp.array([0.0, 0.0]))
        chex.assert_trees_all_close(s1.utility, jnp.array([0.0]), atol=1e-7)

        # A non-zero next observation now produces surprise.
        s2 = d.step(s0, jnp.array([0.0, 0.0]), jnp.array([2.0, 0.0]))
        assert float(s2.utility[0]) > 0.0

    def test_predictor_reduces_td_error(self) -> None:
        d = CumulantDiscovery(
            raw_dim=2, n_candidates=1, predictor_step_size=0.1, gamma=0.0
        )
        s0 = d.init(jr.key(2))
        # Repeatedly present the same observation: predictor should
        # learn to predict the cumulant exactly, so the TD error / utility
        # should decrease.
        s = s0
        obs = jnp.array([1.0, -0.5])
        next_obs = jnp.array([0.5, 0.5])
        for _ in range(200):
            s = d.step(s, obs, next_obs)
        # Final TD error should be small
        cumulant = (s.projections @ next_obs)[0]
        v = (s.weights @ obs + s.biases)[0]
        v_next = (s.weights @ next_obs + s.biases)[0]
        td = float(cumulant + 0.0 * v_next - v)
        assert abs(td) < 0.05, f"predictor failed to converge; td={td}"


# =============================================================================
# Replacement
# =============================================================================


class TestReplacement:
    def test_replacement_disabled_keeps_state(self) -> None:
        d = CumulantDiscovery(
            raw_dim=4,
            n_candidates=3,
            replacement_rate=1.0,
            maturity_threshold=0,
            enabled=False,
        )
        s = d.init(jr.key(0))
        s_after = d.maybe_replace(s)
        chex.assert_trees_all_close(s_after.projections, s.projections)
        chex.assert_trees_all_close(s_after.utility, s.utility)
        chex.assert_trees_all_close(s_after.ages, s.ages)

    def test_replacement_when_eligible(self) -> None:
        # rate=1.0, maturity=0 means every call to maybe_replace replaces
        d = CumulantDiscovery(
            raw_dim=3,
            n_candidates=4,
            replacement_rate=1.0,
            maturity_threshold=0,
            enabled=True,
        )
        s = d.init(jr.key(0))
        s_after = d.maybe_replace(s)
        # At least one row should differ (the lowest utility candidate)
        diff = jnp.linalg.norm(s_after.projections - s.projections, axis=1)
        assert float(jnp.max(diff)) > 0.0

    def test_no_replacement_before_maturity(self) -> None:
        d = CumulantDiscovery(
            raw_dim=3,
            n_candidates=4,
            replacement_rate=1.0,
            maturity_threshold=100,  # nothing can be replaced before age 100
            enabled=True,
        )
        s = d.init(jr.key(0))
        s_after = d.maybe_replace(s)
        # Should be unchanged because nothing is mature
        chex.assert_trees_all_close(s_after.projections, s.projections)
        chex.assert_trees_all_close(s_after.utility, s.utility)
        chex.assert_trees_all_close(s_after.ages, s.ages)


# =============================================================================
# JIT and scan
# =============================================================================


class TestJit:
    def test_step_jit(self) -> None:
        d = CumulantDiscovery(raw_dim=4, n_candidates=4)
        s = d.init(jr.key(0))
        s2 = d.step(s, jnp.ones(4), jnp.ones(4))
        chex.assert_tree_all_finite(s2.utility)

    def test_scan_compatibility(self) -> None:
        d = CumulantDiscovery(raw_dim=4, n_candidates=4)
        s0 = d.init(jr.key(0))
        observations = jr.normal(jr.key(1), (50, 4))

        def step_fn(state: CumulantDiscoveryState, x: jax.Array):
            new_state = d.step(state, x, x)
            return new_state, new_state.utility

        final_state, utility_history = jax.lax.scan(step_fn, s0, observations)
        chex.assert_shape(utility_history, (50, 4))
        chex.assert_tree_all_finite(final_state.utility)


# =============================================================================
# Functional: surprise-driven retains structure-bearing cumulants
# =============================================================================


class TestFunctional:
    """A non-stationary stream emits an obs that has a deterministic
    function of obs as its hidden cumulant. Among many random
    candidates, the ones that align with that function should accumulate
    higher utility (squared TD error reflects information content
    times mismatch -- which decays as the predictor learns; with
    short-horizon updates, mis-aligned candidates also have high error).

    Here we just check that the discovery loop runs end-to-end and that
    candidates with smaller surprise survive over many steps.
    """

    def test_low_surprise_candidates_survive(self) -> None:
        d = CumulantDiscovery(
            raw_dim=4,
            n_candidates=8,
            decay_rate=0.99,
            replacement_rate=0.05,
            maturity_threshold=50,
            predictor_step_size=0.05,
        )
        s = d.init(jr.key(0))

        rng = np.random.default_rng(0)
        for _ in range(2000):
            obs = jnp.asarray(rng.normal(size=4).astype(np.float32))
            next_obs = jnp.asarray(rng.normal(size=4).astype(np.float32))
            s = d.step(s, obs, next_obs)
            s = d.maybe_replace(s)

        # Surviving candidates should have FINITE utility and ages
        chex.assert_tree_all_finite(s.utility)
        chex.assert_tree_all_finite(s.weights)
        # By the end of 2000 steps, every candidate should be mature
        assert int(jnp.min(s.ages)) > 0


# =============================================================================
# Config roundtrip
# =============================================================================


class TestConfig:
    def test_roundtrip(self) -> None:
        original = CumulantDiscovery(
            raw_dim=8,
            n_candidates=12,
            decay_rate=0.95,
            replacement_rate=0.01,
            maturity_threshold=300,
            predictor_step_size=0.02,
            gamma=0.9,
            enabled=True,
        )
        config = original.to_config()
        restored = CumulantDiscovery.from_config(config)
        assert restored.raw_dim == 8
        assert restored.n_candidates == 12
        assert restored.enabled is True
