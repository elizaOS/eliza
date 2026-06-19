"""Tests for off-policy linear TD with importance sampling (Step 3 Phase E)."""

from __future__ import annotations

import chex
import jax.numpy as jnp
import numpy as np
import pytest

from alberta_framework.core.learners import LinearLearner
from alberta_framework.core.off_policy_td import (
    ETDLinearLearner,
    ETDUpdateResult,
    GradientTDLinearLearner,
    GradientTDUpdateResult,
    OffPolicyTDLinearLearner,
    OffPolicyTDUpdateResult,
    run_gradient_td_learning_loop,
)
from alberta_framework.core.optimizers import LMS

# =============================================================================
# Init / sanity
# =============================================================================


class TestInit:
    def test_init_zero(self) -> None:
        learner = OffPolicyTDLinearLearner(step_size=0.05)
        s = learner.init(7)
        chex.assert_shape(s.weights, (7,))
        chex.assert_trees_all_close(s.weights, jnp.zeros(7))
        chex.assert_trees_all_close(s.eligibility_traces, jnp.zeros(7))

    def test_invalid_args_raise(self) -> None:
        with pytest.raises(ValueError, match="step_size"):
            OffPolicyTDLinearLearner(step_size=-0.1)
        with pytest.raises(ValueError, match="trace_decay"):
            OffPolicyTDLinearLearner(trace_decay=1.5)
        with pytest.raises(ValueError, match="retrace_clip"):
            OffPolicyTDLinearLearner(retrace_clip=-1.0)
        with pytest.raises(ValueError, match="step_size"):
            ETDLinearLearner(step_size=0.0)
        with pytest.raises(ValueError, match="trace_decay"):
            ETDLinearLearner(trace_decay=-0.1)


# =============================================================================
# rho=1 reduces to on-policy TD
# =============================================================================


class TestOnPolicyEquivalence:
    def test_rho_one_lambda_zero_matches_lms_on_terminating_step(self) -> None:
        """With rho=1, gamma=0, the update reduces to LMS-style supervised:
        w += alpha * (R - V) * phi."""
        feature_dim = 4
        alpha = 0.1
        n_steps = 30

        learner = OffPolicyTDLinearLearner(
            step_size=alpha, trace_decay=0.0, retrace_clip=10.0
        )
        state = learner.init(feature_dim)

        rng = np.random.default_rng(0)
        observations = jnp.asarray(
            rng.normal(size=(n_steps, feature_dim)).astype(np.float32)
        )
        rewards = jnp.asarray(rng.normal(size=n_steps).astype(np.float32))

        for t in range(n_steps):
            res = learner.update(
                state,
                observations[t],
                rewards[t],
                jnp.zeros(feature_dim),
                jnp.float32(0.0),
                jnp.float32(1.0),
            )
            state = res.state

        # Reference: pure LMS update from zero weights with the same data
        w_ref = jnp.zeros(feature_dim)
        b_ref = jnp.float32(0.0)
        for t in range(n_steps):
            v = jnp.dot(w_ref, observations[t]) + b_ref
            err = rewards[t] - v
            w_ref = w_ref + alpha * err * observations[t]
            b_ref = b_ref + alpha * err

        chex.assert_trees_all_close(state.weights, w_ref, atol=1e-5)
        chex.assert_trees_all_close(state.bias, b_ref, atol=1e-5)


# =============================================================================
# ETD(lambda)
# =============================================================================


class TestETDLambda:
    def test_lambda_zero_on_policy_terminating_matches_lms(self) -> None:
        """With rho=1, lambda=0, and gamma=0, ETD reduces to LMS/TD(0)."""
        feature_dim = 4
        alpha = 0.08
        n_steps = 40

        rng = np.random.default_rng(123)
        observations = jnp.asarray(
            rng.normal(size=(n_steps, feature_dim)).astype(np.float32)
        )
        rewards = jnp.asarray(rng.normal(size=n_steps).astype(np.float32))

        etd = ETDLinearLearner(step_size=alpha, trace_decay=0.0)
        etd_state = etd.init(feature_dim)
        for t in range(n_steps):
            res = etd.update(
                etd_state,
                observations[t],
                rewards[t],
                jnp.zeros(feature_dim),
                jnp.float32(0.0),
                jnp.float32(1.0),
            )
            etd_state = res.state

        lms = LinearLearner(optimizer=LMS(step_size=alpha))
        lms_state = lms.init(feature_dim)
        for t in range(n_steps):
            res = lms.update(lms_state, observations[t], jnp.atleast_1d(rewards[t]))
            lms_state = res.state

        chex.assert_trees_all_close(etd_state.weights, lms_state.weights, atol=1e-5)
        chex.assert_trees_all_close(etd_state.bias, lms_state.bias, atol=1e-5)

    def test_follow_on_and_emphasis_evolve_under_off_policy_rho(self) -> None:
        learner = ETDLinearLearner(step_size=0.05, trace_decay=0.4)
        state = learner.init(2)

        first = learner.update(
            state,
            jnp.array([1.0, 0.0], dtype=jnp.float32),
            jnp.float32(0.0),
            jnp.zeros(2, dtype=jnp.float32),
            jnp.float32(0.9),
            jnp.float32(2.0),
        )
        second = learner.update(
            first.state,
            jnp.array([0.0, 1.0], dtype=jnp.float32),
            jnp.float32(0.0),
            jnp.zeros(2, dtype=jnp.float32),
            jnp.float32(0.8),
            jnp.float32(0.5),
        )

        # F_1 = 2 * 0.9 * 0 + 1 = 1
        # F_2 = 0.5 * 0.8 * 1 + 1 = 1.4
        # M_2 = lambda * i + (1 - lambda) * F_2 = 0.4 + 0.6 * 1.4 = 1.24
        chex.assert_trees_all_close(first.state.follow_on_trace, jnp.float32(1.0))
        chex.assert_trees_all_close(second.state.follow_on_trace, jnp.float32(1.4))
        chex.assert_trees_all_close(second.state.emphasis, jnp.float32(1.24))
        chex.assert_trees_all_close(
            second.state.eligibility_traces,
            jnp.array([0.32, 0.62], dtype=jnp.float32),
            atol=1e-6,
        )

    def test_update_is_jit_compatible(self) -> None:
        learner = ETDLinearLearner(step_size=0.05, trace_decay=0.5)
        state = learner.init(4)
        result = learner.update(
            state,
            jnp.ones(4),
            jnp.float32(1.0),
            jnp.ones(4),
            jnp.float32(0.9),
            jnp.float32(1.5),
        )
        assert isinstance(result, ETDUpdateResult)
        chex.assert_shape(result.metrics, (7,))

    def test_config_roundtrip(self) -> None:
        original = ETDLinearLearner(step_size=0.03, trace_decay=0.7)
        config = original.to_config()
        assert config["type"] == "ETDLinearLearner"
        restored = ETDLinearLearner.from_config(config)
        assert restored.to_config() == config

    def test_bounded_finite_updates(self) -> None:
        learner = ETDLinearLearner(step_size=0.001, trace_decay=0.6)
        state = learner.init(5)

        rng = np.random.default_rng(9)
        for _ in range(1000):
            phi = jnp.asarray(0.2 * rng.normal(size=5).astype(np.float32))
            phi_next = jnp.asarray(0.2 * rng.normal(size=5).astype(np.float32))
            reward = jnp.float32(0.1 * rng.normal())
            rho = jnp.float32(rng.uniform(0.0, 1.8))
            result = learner.update(
                state,
                phi,
                reward,
                phi_next,
                jnp.float32(0.7),
                rho,
            )
            state = result.state

        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(state.eligibility_traces)
        chex.assert_tree_all_finite(state.follow_on_trace)
        chex.assert_tree_all_finite(state.emphasis)
        assert float(jnp.max(jnp.abs(state.weights))) < 5.0


# =============================================================================
# Gradient-TD / TDC
# =============================================================================


class TestGradientTD:
    def test_invalid_args_raise(self) -> None:
        with pytest.raises(ValueError, match="step_size"):
            GradientTDLinearLearner(step_size=0.0)
        with pytest.raises(ValueError, match="secondary_step_size"):
            GradientTDLinearLearner(secondary_step_size=-0.1)
        with pytest.raises(ValueError, match="trace_decay"):
            GradientTDLinearLearner(trace_decay=1.2)
        with pytest.raises(ValueError, match="ratio_clip"):
            GradientTDLinearLearner(ratio_clip=0.0)

    def test_config_roundtrip_and_exports(self) -> None:
        original = GradientTDLinearLearner(
            step_size=0.02,
            secondary_step_size=0.03,
            trace_decay=0.4,
            ratio_clip=2.0,
        )
        config = original.to_config()
        restored = GradientTDLinearLearner.from_config(config)
        assert restored.to_config() == config

    def test_update_shapes_and_secondary_weights_change(self) -> None:
        learner = GradientTDLinearLearner(
            step_size=0.01,
            secondary_step_size=0.05,
            trace_decay=0.2,
            ratio_clip=2.0,
        )
        state = learner.init(3)
        result = learner.update(
            state,
            jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32),
            jnp.array(1.0, dtype=jnp.float32),
            jnp.array([0.0, 1.0, 0.5], dtype=jnp.float32),
            jnp.array(0.9, dtype=jnp.float32),
            jnp.array(3.0, dtype=jnp.float32),
        )

        assert isinstance(result, GradientTDUpdateResult)
        chex.assert_shape(result.state.weights, (4,))
        chex.assert_shape(result.state.secondary_weights, (4,))
        chex.assert_shape(result.metrics, (6,))
        assert float(result.rho_clipped) == pytest.approx(2.0)
        assert float(jnp.linalg.norm(result.state.secondary_weights)) > 0.0
        chex.assert_tree_all_finite(result.state)

    def test_scan_off_policy_positive_control(self) -> None:
        rng = np.random.default_rng(0)
        steps = 600
        actions = rng.integers(0, 2, size=steps)
        observations = jnp.ones((steps, 1), dtype=jnp.float32)
        next_observations = jnp.ones((steps, 1), dtype=jnp.float32)
        rewards = jnp.asarray((actions == 1).astype(np.float32))
        rhos = jnp.asarray(np.where(actions == 1, 2.0, 0.0).astype(np.float32))
        gammas = jnp.zeros((steps,), dtype=jnp.float32)

        learner = GradientTDLinearLearner(
            step_size=0.02,
            secondary_step_size=0.05,
            ratio_clip=10.0,
        )
        result = run_gradient_td_learning_loop(
            learner,
            learner.init(1),
            observations,
            rewards,
            next_observations,
            gammas,
            rhos,
        )
        pred = float(learner.predict(result.state, jnp.ones(1))[0])

        assert pred > 0.95
        chex.assert_shape(result.metrics, (steps, 6))
        chex.assert_tree_all_finite(result.state)


# =============================================================================
# rho clipping
# =============================================================================


class TestRetraceClip:
    def test_clip_at_one(self) -> None:
        learner = OffPolicyTDLinearLearner(retrace_clip=1.0)
        state = learner.init(3)
        # rho >> 1 should be clipped to 1
        result = learner.update(
            state,
            jnp.array([1.0, 0.0, 0.0]),
            jnp.float32(1.0),
            jnp.zeros(3),
            jnp.float32(0.0),
            jnp.float32(5.0),
        )
        assert float(result.rho_clipped) == 1.0

    def test_no_clip_when_below_threshold(self) -> None:
        learner = OffPolicyTDLinearLearner(retrace_clip=1.0)
        state = learner.init(3)
        result = learner.update(
            state,
            jnp.array([1.0, 0.0, 0.0]),
            jnp.float32(1.0),
            jnp.zeros(3),
            jnp.float32(0.0),
            jnp.float32(0.5),
        )
        assert float(result.rho_clipped) == pytest.approx(0.5)

    def test_inf_clip_disables(self) -> None:
        learner = OffPolicyTDLinearLearner(retrace_clip=float("inf"))
        state = learner.init(3)
        # Large rho stays unclipped
        result = learner.update(
            state,
            jnp.array([1.0, 0.0, 0.0]),
            jnp.float32(1.0),
            jnp.zeros(3),
            jnp.float32(0.0),
            jnp.float32(7.0),
        )
        assert float(result.rho_clipped) == pytest.approx(7.0)


# =============================================================================
# Off-policy convergence on a small chain
# =============================================================================


class TestOffPolicyConvergence:
    """Small bandit-with-state: 2 actions, 4 states.
    Behavior policy uniform; target policy always picks action 0.
    Reward depends on state and action.
    """

    @staticmethod
    def _generate_episode(
        rng: np.random.Generator,
        n_states: int = 4,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """Random walk where each step picks left or right uniformly.
        Reward 1 when reaching the right end; 0 otherwise.
        """
        eye = np.eye(n_states, dtype=np.float32)
        state = n_states // 2
        obs_list, next_obs_list, rew_list, gam_list, action_list = (
            [],
            [],
            [],
            [],
            [],
        )
        while True:
            obs = eye[state]
            action = int(rng.integers(0, 2))
            new_state = state - 1 if action == 0 else state + 1
            if new_state < 0:
                rew = 0.0
                term = True
            elif new_state >= n_states:
                rew = 1.0
                term = True
            else:
                rew = 0.0
                term = False

            obs_list.append(obs)
            action_list.append(action)
            rew_list.append(rew)
            if term:
                next_obs_list.append(np.zeros(n_states, dtype=np.float32))
                gam_list.append(0.0)
                break
            else:
                next_obs_list.append(eye[new_state])
                gam_list.append(1.0)
                state = new_state

        return (
            np.asarray(obs_list),
            np.asarray(rew_list),
            np.asarray(next_obs_list),
            np.asarray(gam_list),
            np.asarray(action_list),
        )

    def test_off_policy_converges_to_target_v(self) -> None:
        """Behavior: uniform random. Target: always go right.
        Under target policy, V(s_i) = 1.0 for every state (always reach
        right end). Off-policy TD with IS should converge there.
        """
        n_states = 4

        # rho_t = pi(a_t|s) / b(a_t|s)
        # target policy: always go right (action 1) => pi(1|s)=1, pi(0|s)=0
        # behavior:      uniform =>                     b(0|s)=b(1|s)=0.5
        # rho(action=1) = 1 / 0.5 = 2
        # rho(action=0) = 0 / 0.5 = 0  (the trajectory contributes nothing)

        learner = OffPolicyTDLinearLearner(
            step_size=0.05, trace_decay=0.0, retrace_clip=2.0
        )
        state = learner.init(n_states)

        rng = np.random.default_rng(42)
        for _ in range(2000):
            obs, rew, nxt, gam, actions = self._generate_episode(rng, n_states)
            for t in range(len(rew)):
                # Importance ratio per the policy definitions above
                rho = 2.0 if actions[t] == 1 else 0.0
                res = learner.update(
                    state,
                    jnp.asarray(obs[t]),
                    jnp.asarray(rew[t]),
                    jnp.asarray(nxt[t]),
                    jnp.asarray(gam[t]),
                    jnp.float32(rho),
                )
                state = res.state

        # Under target policy (always right), V(s_i) = 1 for all states
        eye = np.eye(n_states, dtype=np.float32)
        v_estimated = np.array(
            [
                float(jnp.dot(state.weights, jnp.asarray(eye[s])) + state.bias)
                for s in range(n_states)
            ]
        )
        # Target V per state
        v_true = np.ones(n_states, dtype=np.float32)
        rmse = float(np.sqrt(np.mean((v_estimated - v_true) ** 2)))
        assert rmse < 0.20, (
            f"Off-policy TD did not converge: V_est={v_estimated}, RMSE={rmse}"
        )

    def test_naive_is_finite_with_clipping(self) -> None:
        """Even with a high IS-ratio target/behavior mismatch, clipping at
        c=1 should keep weights finite over many steps."""
        learner = OffPolicyTDLinearLearner(
            step_size=0.01, trace_decay=0.7, retrace_clip=1.0
        )
        state = learner.init(5)

        rng = np.random.default_rng(7)
        for _ in range(2000):
            phi = jnp.asarray(rng.normal(size=5).astype(np.float32))
            phi_next = jnp.asarray(rng.normal(size=5).astype(np.float32))
            r = jnp.float32(rng.normal())
            # Wildly varying rho
            rho = jnp.float32(rng.uniform(0.0, 50.0))
            res = learner.update(
                state, phi, r, phi_next, jnp.float32(0.95), rho
            )
            state = res.state

        chex.assert_tree_all_finite(state.weights)
        chex.assert_tree_all_finite(state.eligibility_traces)


# =============================================================================
# JIT / scan
# =============================================================================


class TestJit:
    def test_predict_and_update_jit(self) -> None:
        learner = OffPolicyTDLinearLearner(step_size=0.05, trace_decay=0.5)
        state = learner.init(4)
        # Two calls should not retrace
        v1 = learner.predict(state, jnp.ones(4))
        v2 = learner.predict(state, jnp.ones(4))
        chex.assert_trees_all_close(v1, v2)

        result = learner.update(
            state,
            jnp.ones(4),
            jnp.float32(1.0),
            jnp.ones(4),
            jnp.float32(0.9),
            jnp.float32(1.5),
        )
        assert isinstance(result, OffPolicyTDUpdateResult)


# =============================================================================
# Config roundtrip
# =============================================================================


class TestConfig:
    def test_roundtrip(self) -> None:
        original = OffPolicyTDLinearLearner(
            step_size=0.07, trace_decay=0.6, retrace_clip=2.5
        )
        config = original.to_config()
        assert config["type"] == "OffPolicyTDLinearLearner"
        restored = OffPolicyTDLinearLearner.from_config(config)
        assert restored.step_size == 0.07
        assert restored.trace_decay == 0.6
        assert restored.retrace_clip == 2.5


# =============================================================================
# Baird-style: don't diverge with bounded clipping
# =============================================================================


class TestBairdStyle:
    """With Retrace clipping (c=1) on a moderate off-policy problem,
    the algorithm stays finite and bounded. This is NOT a guarantee of
    convergence on Baird's exact counterexample (which requires gradient-
    TD or emphatic methods); it's a sanity check that clipping prevents
    the most pathological IS-variance blowups.
    """

    def test_no_divergence_with_clip(self) -> None:
        learner = OffPolicyTDLinearLearner(
            step_size=0.01, trace_decay=0.5, retrace_clip=1.0
        )
        state = learner.init(4)

        rng = np.random.default_rng(11)
        for _ in range(3000):
            phi = jnp.asarray(rng.normal(size=4).astype(np.float32))
            phi_next = jnp.asarray(rng.normal(size=4).astype(np.float32))
            r = jnp.float32(rng.normal())
            # Heavy-tailed rho but mostly modest values
            rho = jnp.float32(rng.exponential(1.0))
            res = learner.update(
                state, phi, r, phi_next, jnp.float32(0.9), rho
            )
            state = res.state

        chex.assert_tree_all_finite(state.weights)
        # Without clipping this is unbounded; with c=1 it's bounded.
        assert float(jnp.max(jnp.abs(state.weights))) < 50.0
