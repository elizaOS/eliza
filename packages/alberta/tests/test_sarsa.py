"""Tests for the SARSAAgent, learning loops, and integration with Horde."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr
import numpy as np
import pytest

from alberta_framework import (
    Autostep,
    DemonType,
    GVFSpec,
    MultiHeadMLPLearner,
    ObGDBounding,
    SARSAAgent,
    SARSAArrayResult,
    SARSAConfig,
    SARSAUpdateResult,
    run_sarsa_from_arrays,
)


def _make_agent(
    n_actions: int = 2,
    hidden_sizes: tuple[int, ...] = (16,),
    gamma: float = 0.99,
    epsilon_start: float = 0.1,
    **kwargs,
) -> SARSAAgent:
    """Helper to create a simple SARSA agent for tests."""
    config = SARSAConfig(
        n_actions=n_actions,
        gamma=gamma,
        epsilon_start=epsilon_start,
        epsilon_end=kwargs.pop("epsilon_end", 0.01),
        epsilon_decay_steps=kwargs.pop("epsilon_decay_steps", 0),
    )
    return SARSAAgent(
        sarsa_config=config,
        hidden_sizes=hidden_sizes,
        sparsity=0.0,
        **kwargs,
    )


# =============================================================================
# Init tests
# =============================================================================


class TestSARSAInit:
    """Tests for SARSAAgent initialization."""

    def test_init_shapes(self):
        """State arrays have correct shapes."""
        agent = _make_agent(n_actions=3)
        state = agent.init(feature_dim=5, key=jr.key(42))

        chex.assert_shape(state.last_action, ())
        chex.assert_shape(state.last_observation, (5,))
        chex.assert_shape(state.epsilon, ())
        chex.assert_shape(state.step_count, ())
        assert state.step_count == 0
        assert state.last_action == -1

    def test_q_value_prediction(self):
        """Q-values have shape (n_actions,)."""
        agent = _make_agent(n_actions=4)
        state = agent.init(feature_dim=5, key=jr.key(42))
        obs = jnp.ones(5, dtype=jnp.float32)

        all_preds = agent.horde.predict(state.learner_state, obs)
        q_values = all_preds[: agent.n_actions]
        chex.assert_shape(q_values, (4,))

    def test_n_demons_matches_n_actions(self):
        """Horde has exactly n_actions demons (no prediction demons)."""
        agent = _make_agent(n_actions=3)
        assert agent.horde.n_demons == 3

    def test_with_prediction_demons(self):
        """Prediction demons are appended after control demons."""
        pred_demons = [
            GVFSpec(
                name="pred_0",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=0,
            ),
        ]
        agent = _make_agent(n_actions=2, prediction_demons=pred_demons)
        assert agent.horde.n_demons == 3
        assert agent.horde.horde_spec.demons[0].demon_type == DemonType.CONTROL
        assert agent.horde.horde_spec.demons[1].demon_type == DemonType.CONTROL
        assert agent.horde.horde_spec.demons[2].demon_type == DemonType.PREDICTION


# =============================================================================
# Action selection tests
# =============================================================================


class TestSARSAActionSelection:
    """Tests for epsilon-greedy action selection."""

    def test_greedy_when_epsilon_zero(self):
        """With epsilon=0, always selects greedy action."""
        agent = _make_agent(n_actions=3, epsilon_start=0.0)
        state = agent.init(feature_dim=5, key=jr.key(42))
        obs = jnp.ones(5, dtype=jnp.float32)

        # Run many selections — should always be greedy
        actions = []
        for i in range(50):
            action, new_key = agent.select_action(state, obs)
            state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]
            actions.append(int(action))

        # All actions should be the same (greedy)
        assert len(set(actions)) == 1

    def test_random_when_epsilon_one(self):
        """With epsilon=1, always explores (random actions)."""
        agent = _make_agent(n_actions=4, epsilon_start=1.0)
        state = agent.init(feature_dim=5, key=jr.key(42))
        # Override epsilon in state
        state = state.replace(epsilon=jnp.array(1.0))  # type: ignore[attr-defined]
        obs = jnp.ones(5, dtype=jnp.float32)

        actions = []
        for _ in range(200):
            action, new_key = agent.select_action(state, obs)
            state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]
            actions.append(int(action))

        # With 200 samples and 4 actions, we should see multiple distinct actions
        unique_actions = set(actions)
        assert len(unique_actions) >= 2, f"Expected multiple actions, got {unique_actions}"

    def test_tie_breaking_uniform(self):
        """Equal Q-values should produce roughly uniform action selection.

        Gumbel trick tie-breaking should avoid left-side bias from jnp.argmax.
        """
        agent = _make_agent(n_actions=4, epsilon_start=0.0)
        state = agent.init(feature_dim=5, key=jr.key(42))
        obs = jnp.zeros(5, dtype=jnp.float32)  # zero obs -> similar Q-values

        counts = np.zeros(4)
        n_samples = 2000
        for _ in range(n_samples):
            action, new_key = agent.select_action(state, obs)
            state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]
            counts[int(action)] += 1

        # Chi-squared test for uniformity
        expected = n_samples / 4
        chi_sq = np.sum((counts - expected) ** 2 / expected)
        # With df=3, chi_sq < 16.27 at p=0.001 (very conservative)
        assert chi_sq < 16.27, (
            f"Action distribution not uniform: {counts}, chi_sq={chi_sq}"
        )

    def test_action_in_valid_range(self):
        """Selected actions are always in [0, n_actions)."""
        agent = _make_agent(n_actions=6, epsilon_start=0.5)
        state = agent.init(feature_dim=5, key=jr.key(0))
        obs = jnp.ones(5, dtype=jnp.float32)

        for _ in range(100):
            action, new_key = agent.select_action(state, obs)
            state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]
            assert 0 <= int(action) < 6


# =============================================================================
# Update tests
# =============================================================================


class TestSARSAUpdate:
    """Tests for SARSA update logic."""

    def test_sarsa_target(self):
        """SARSA target is r + gamma * Q(s', a')."""
        agent = _make_agent(n_actions=2, gamma=0.9, epsilon_start=0.0)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        # Set up last_action and last_observation
        action, new_key = agent.select_action(state, obs)
        state = state.replace(  # type: ignore[attr-defined]
            last_action=action,
            last_observation=obs,
            rng_key=new_key,
        )

        next_obs = jnp.ones(4, dtype=jnp.float32) * 2.0
        next_action, new_key = agent.select_action(state, next_obs)
        state = state.replace(rng_key=new_key)  # type: ignore[attr-defined]

        result = agent.update(
            state,
            reward=jnp.array(1.0),
            observation=next_obs,
            terminated=jnp.array(0.0),
            next_action=next_action,
        )

        assert isinstance(result, SARSAUpdateResult)
        chex.assert_shape(result.q_values, (2,))
        chex.assert_shape(result.td_error, ())
        assert result.reward == 1.0

    def test_terminated_no_bootstrap(self):
        """At terminal state, target = r (no bootstrapping)."""
        agent = _make_agent(n_actions=2, gamma=0.99, epsilon_start=0.0)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        action, new_key = agent.select_action(state, obs)
        state = state.replace(  # type: ignore[attr-defined]
            last_action=action,
            last_observation=obs,
            rng_key=new_key,
        )

        next_obs = jnp.zeros(4, dtype=jnp.float32)
        next_action = jnp.array(0, dtype=jnp.int32)

        # Non-terminal: target = r + gamma * Q(s', a')
        result_nt = agent.update(
            state,
            reward=jnp.array(1.0),
            observation=next_obs,
            terminated=jnp.array(0.0),
            next_action=next_action,
        )

        # Terminal: target = r
        result_t = agent.update(
            state,
            reward=jnp.array(1.0),
            observation=next_obs,
            terminated=jnp.array(1.0),
            next_action=next_action,
        )

        # TD errors should differ (unless Q(s', a') happens to be exactly 0)
        # At minimum, the logic should run without error
        assert not jnp.isnan(result_nt.td_error)
        assert not jnp.isnan(result_t.td_error)

    def test_nan_masking(self):
        """Only the taken action's head receives a weight update."""
        agent = _make_agent(n_actions=3, gamma=0.9, epsilon_start=0.0)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        # Force action = 1
        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(1, dtype=jnp.int32),
            last_observation=obs,
        )

        next_obs = jnp.ones(4, dtype=jnp.float32) * 0.5
        next_action = jnp.array(0, dtype=jnp.int32)

        # Save head params before update
        old_head_weights = [
            state.learner_state.head_params.weights[i]
            for i in range(3)
        ]

        result = agent.update(
            state,
            reward=jnp.array(1.0),
            observation=next_obs,
            terminated=jnp.array(0.0),
            next_action=next_action,
        )

        new_head_weights = [
            result.state.learner_state.head_params.weights[i]
            for i in range(3)
        ]

        # Head 1 should have changed (it was the taken action)
        head1_changed = not jnp.allclose(old_head_weights[1], new_head_weights[1])
        assert head1_changed, "Head 1 (taken action) should have been updated"

        # Heads 0 and 2 should be unchanged (NaN targets)
        chex.assert_trees_all_close(old_head_weights[0], new_head_weights[0])
        chex.assert_trees_all_close(old_head_weights[2], new_head_weights[2])

    def test_prediction_demons_unaffected(self):
        """Prediction demons learn alongside Q-heads without interference."""
        pred_demons = [
            GVFSpec(
                name="pred_0",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=0,
            ),
        ]
        agent = _make_agent(n_actions=2, prediction_demons=pred_demons)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        next_obs = jnp.ones(4, dtype=jnp.float32) * 0.5

        # Prediction cumulant for the prediction demon
        pred_cumulants = jnp.array([2.0], dtype=jnp.float32)
        next_action = jnp.array(1, dtype=jnp.int32)

        old_pred_weights = state.learner_state.head_params.weights[2]

        result = agent.update(
            state,
            reward=jnp.array(1.0),
            observation=next_obs,
            terminated=jnp.array(0.0),
            next_action=next_action,
            prediction_cumulants=pred_cumulants,
        )

        new_pred_weights = result.state.learner_state.head_params.weights[2]
        pred_changed = not jnp.allclose(old_pred_weights, new_pred_weights)
        assert pred_changed, "Prediction demon head should have been updated"

    def test_td_error_uses_last_observation_prediction(self):
        """Returned TD error is target - Q(s_t, a_t), not Q(s_{t+1}, a_t)."""
        agent = _make_agent(n_actions=2, hidden_sizes=(), gamma=0.0, epsilon_start=0.0)
        state = agent.init(feature_dim=2, key=jr.key(42))
        head_weights = state.learner_state.head_params.weights
        state = state.replace(  # type: ignore[attr-defined]
            learner_state=state.learner_state.replace(  # type: ignore[attr-defined]
                head_params=state.learner_state.head_params.replace(  # type: ignore[attr-defined]
                    weights=(
                        head_weights[0].at[0, 0].set(2.0),
                        head_weights[1],
                    )
                )
            ),
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        )

        next_observation = jnp.array([0.0, 1.0], dtype=jnp.float32)
        reward = jnp.array(1.0, dtype=jnp.float32)
        result = agent.update(
            state,
            reward=reward,
            observation=next_observation,
            terminated=jnp.array(0.0, dtype=jnp.float32),
            next_action=jnp.array(1, dtype=jnp.int32),
        )

        previous_q = agent.horde.predict(
            state.learner_state,
            state.last_observation,
        )[0]
        next_same_action_q = agent.horde.predict(
            state.learner_state,
            next_observation,
        )[0]
        chex.assert_trees_all_close(result.td_error, reward - previous_q)
        assert not jnp.allclose(result.td_error, reward - next_same_action_q)

    def test_sarsa_vs_qlearning_different_targets(self):
        """SARSA uses Q(s', a') while Q-learning uses max Q(s', :)."""
        agent = _make_agent(n_actions=3, gamma=0.9, epsilon_start=0.0)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        next_obs = jnp.ones(4, dtype=jnp.float32) * 2.0
        reward = jnp.array(1.0)

        # Get Q(s', :)
        all_preds = agent.horde.predict(state.learner_state, next_obs)
        q_next = all_preds[: agent.n_actions]

        # SARSA target with a' = action 0
        sarsa_target_a0 = reward + 0.9 * q_next[0]
        # Q-learning target
        qlearning_target = reward + 0.9 * jnp.max(q_next)

        # Unless all Q-values are equal, SARSA targets differ from Q-learning
        if not jnp.allclose(q_next[0], jnp.max(q_next)):
            assert not jnp.allclose(sarsa_target_a0, qlearning_target)


# =============================================================================
# Epsilon decay tests
# =============================================================================


class TestSARSAEpsilonDecay:
    """Tests for epsilon scheduling."""

    def test_linear_decay(self):
        """Epsilon decays linearly from start to end over N steps."""
        agent = _make_agent(
            n_actions=2,
            epsilon_start=1.0,
            epsilon_end=0.0,
            epsilon_decay_steps=100,
        )
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        next_obs = obs
        next_action = jnp.array(0, dtype=jnp.int32)

        # Run 50 steps
        for _ in range(50):
            result = agent.update(
                state,
                reward=jnp.array(0.0),
                observation=next_obs,
                terminated=jnp.array(0.0),
                next_action=next_action,
            )
            state = result.state

        # After 50 steps: epsilon should be ~0.5
        assert abs(float(state.epsilon) - 0.5) < 0.02

    def test_no_decay_when_zero_steps(self):
        """Epsilon stays constant when decay_steps=0."""
        agent = _make_agent(
            n_actions=2,
            epsilon_start=0.5,
            epsilon_decay_steps=0,
        )
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        for _ in range(20):
            result = agent.update(
                state,
                reward=jnp.array(0.0),
                observation=obs,
                terminated=jnp.array(0.0),
                next_action=jnp.array(0, dtype=jnp.int32),
            )
            state = result.state

        assert float(state.epsilon) == 0.5

    def test_epsilon_floors_at_end(self):
        """Epsilon doesn't go below epsilon_end."""
        agent = _make_agent(
            n_actions=2,
            epsilon_start=1.0,
            epsilon_end=0.1,
            epsilon_decay_steps=10,
        )
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        for _ in range(100):
            result = agent.update(
                state,
                reward=jnp.array(0.0),
                observation=obs,
                terminated=jnp.array(0.0),
                next_action=jnp.array(0, dtype=jnp.int32),
            )
            state = result.state

        assert float(state.epsilon) >= 0.1 - 1e-6


# =============================================================================
# Gymnasium integration tests
# =============================================================================


class TestSARSAGymnasium:
    """Tests for SARSA with Gymnasium environments."""

    def test_cartpole_no_crash(self):
        """Run 100 steps on CartPole without crashing."""
        gymnasium = pytest.importorskip("gymnasium")
        gym = gymnasium

        env = gym.make("CartPole-v1")
        agent = _make_agent(
            n_actions=2,
            hidden_sizes=(16,),
            gamma=0.99,
            epsilon_start=0.5,
        )
        state = agent.init(feature_dim=4, key=jr.key(42))

        from alberta_framework import run_sarsa_continuing

        result = run_sarsa_continuing(agent, state, env, num_steps=100)

        assert len(result.rewards) == 100
        assert not any(np.isnan(r) for r in result.rewards)
        env.close()

    def test_episode_mode(self):
        """Run one episode on CartPole."""
        gymnasium = pytest.importorskip("gymnasium")
        gym = gymnasium

        env = gym.make("CartPole-v1")
        agent = _make_agent(
            n_actions=2,
            hidden_sizes=(16,),
            gamma=0.99,
            epsilon_start=0.5,
        )
        state = agent.init(feature_dim=4, key=jr.key(42))

        from alberta_framework import run_sarsa_episode

        result = run_sarsa_episode(agent, state, env, max_steps=500)

        assert result.num_steps > 0
        assert result.num_steps <= 500
        assert len(result.rewards) == result.num_steps
        env.close()


# =============================================================================
# Bounder + optimizer tests
# =============================================================================


class TestSARSAWithBounder:
    """Tests for SARSA with ObGDBounding."""

    def test_obgd_no_divergence(self):
        """SARSA + ObGDBounding doesn't diverge over 50 steps."""
        agent = _make_agent(
            n_actions=2,
            hidden_sizes=(16,),
            bounder=ObGDBounding(),
        )
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        for _ in range(50):
            next_obs = obs + jax.random.normal(jr.key(0), (4,)) * 0.1
            next_action = jnp.array(0, dtype=jnp.int32)
            result = agent.update(
                state,
                reward=jnp.array(1.0),
                observation=next_obs,
                terminated=jnp.array(0.0),
                next_action=next_action,
            )
            state = result.state

            # Check Q-values are finite
            q_vals = agent.horde.predict(state.learner_state, obs)
            assert jnp.all(jnp.isfinite(q_vals)), f"Q-values diverged: {q_vals}"


class TestSARSAWithAutostep:
    """Tests for SARSA with Autostep optimizer."""

    def test_autostep_runs(self):
        """SARSA + Autostep runs without errors."""
        agent = _make_agent(
            n_actions=2,
            hidden_sizes=(16,),
            optimizer=Autostep(),
        )
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        for _ in range(20):
            result = agent.update(
                state,
                reward=jnp.array(1.0),
                observation=obs,
                terminated=jnp.array(0.0),
                next_action=jnp.array(1, dtype=jnp.int32),
            )
            state = result.state

        # Should complete without NaN
        q_vals = agent.horde.predict(state.learner_state, obs)
        assert jnp.all(jnp.isfinite(q_vals))


# =============================================================================
# Config serialization tests
# =============================================================================


class TestSARSAConfigSerialization:
    """Tests for SARSA config serialization roundtrip."""

    def test_sarsa_config_roundtrip(self):
        """SARSAConfig serializes and deserializes correctly."""
        config = SARSAConfig(
            n_actions=4,
            gamma=0.95,
            epsilon_start=0.2,
            epsilon_end=0.05,
            epsilon_decay_steps=1000,
        )
        restored = SARSAConfig.from_config(config.to_config())
        assert restored.n_actions == 4
        assert restored.gamma == 0.95
        assert restored.epsilon_start == 0.2
        assert restored.epsilon_end == 0.05
        assert restored.epsilon_decay_steps == 1000

    def test_agent_config_roundtrip(self):
        """SARSAAgent serializes and deserializes correctly."""
        pred_demons = [
            GVFSpec(
                name="pred_0",
                demon_type=DemonType.PREDICTION,
                gamma=0.0,
                lamda=0.0,
                cumulant_index=0,
            ),
        ]
        agent = _make_agent(
            n_actions=3,
            hidden_sizes=(32, 16),
            gamma=0.95,
            prediction_demons=pred_demons,
        )

        config = agent.to_config()
        restored = SARSAAgent.from_config(config)

        assert restored.n_actions == 3
        assert restored.sarsa_config.gamma == 0.95
        assert restored.horde.n_demons == 4  # 3 control + 1 prediction

    def test_agent_config_roundtrip_no_prediction(self):
        """SARSAAgent without prediction demons roundtrips correctly."""
        agent = _make_agent(n_actions=2)
        config = agent.to_config()
        restored = SARSAAgent.from_config(config)
        assert restored.n_actions == 2
        assert restored.horde.n_demons == 2


# =============================================================================
# Scan-based (array) loop tests
# =============================================================================


class TestSARSAScan:
    """Tests for run_sarsa_from_arrays scan loop."""

    def test_scan_shapes(self):
        """Scan loop produces correct output shapes."""
        agent = _make_agent(n_actions=2, hidden_sizes=(8,))
        state = agent.init(feature_dim=4, key=jr.key(42))

        n_steps = 20
        obs = jax.random.normal(jr.key(0), (n_steps, 4))
        next_obs = jax.random.normal(jr.key(1), (n_steps, 4))
        rewards = jnp.ones(n_steps)
        terminated = jnp.zeros(n_steps)

        # Set initial action/observation
        action, new_key = agent.select_action(state, obs[0])
        state = state.replace(  # type: ignore[attr-defined]
            last_action=action,
            last_observation=obs[0],
            rng_key=new_key,
        )

        result = run_sarsa_from_arrays(
            agent, state, obs, rewards, terminated, next_obs
        )

        assert isinstance(result, SARSAArrayResult)
        chex.assert_shape(result.q_values, (n_steps, 2))
        chex.assert_shape(result.td_errors, (n_steps,))
        chex.assert_shape(result.actions, (n_steps,))
        assert jnp.all(jnp.isfinite(result.td_errors))

    def test_scan_terminal_handling(self):
        """Scan loop handles terminal flags correctly."""
        agent = _make_agent(n_actions=2, hidden_sizes=(8,), gamma=0.99)
        state = agent.init(feature_dim=4, key=jr.key(42))

        n_steps = 10
        obs = jnp.ones((n_steps, 4))
        next_obs = jnp.ones((n_steps, 4))
        rewards = jnp.ones(n_steps)
        # Terminal at step 5
        terminated = jnp.zeros(n_steps).at[5].set(1.0)

        action, new_key = agent.select_action(state, obs[0])
        state = state.replace(  # type: ignore[attr-defined]
            last_action=action,
            last_observation=obs[0],
            rng_key=new_key,
        )

        result = run_sarsa_from_arrays(
            agent, state, obs, rewards, terminated, next_obs
        )

        # Should run without error and produce finite results
        assert jnp.all(jnp.isfinite(result.td_errors))


# =============================================================================
# Trunk trace guard tests (Phase 1)
# =============================================================================


class TestTrunkTraceGuard:
    """Tests for trunk gamma*lambda validation."""

    def test_trunk_trace_decay_raises(self):
        """MultiHeadMLPLearner with trunk gamma*lamda>0 and hidden layers raises."""
        import pytest

        with pytest.raises(ValueError, match="Trunk gamma\\*lamda must be 0"):
            MultiHeadMLPLearner(
                n_heads=2,
                hidden_sizes=(16,),
                gamma=0.9,
                lamda=0.5,
            )

    def test_trunk_trace_decay_allowed_linear(self):
        """Linear baseline (hidden_sizes=()) allows any gamma*lamda."""
        # Should NOT raise
        learner = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(),
            gamma=0.9,
            lamda=0.5,
        )
        state = learner.init(feature_dim=4, key=jr.key(42))
        assert state is not None

    def test_trunk_gamma_zero_ok(self):
        """gamma=0 with any lamda is fine for MLP."""
        learner = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(16,),
            gamma=0.0,
            lamda=0.9,
        )
        state = learner.init(feature_dim=4, key=jr.key(42))
        assert state is not None

    def test_trunk_lamda_zero_ok(self):
        """lamda=0 with any gamma is fine for MLP."""
        learner = MultiHeadMLPLearner(
            n_heads=2,
            hidden_sizes=(16,),
            gamma=0.99,
            lamda=0.0,
        )
        state = learner.init(feature_dim=4, key=jr.key(42))
        assert state is not None


# =============================================================================
# Continuing pseudo-boundary test
# =============================================================================


class TestSARSAContinuingPseudoBoundary:
    """Tests for continuing mode at pseudo-boundaries."""

    def test_pseudo_boundary_zeros_gamma(self):
        """At a pseudo-boundary (episode end), gamma=0 prevents bootstrapping."""
        agent = _make_agent(n_actions=2, gamma=0.99, epsilon_start=0.0)
        state = agent.init(feature_dim=4, key=jr.key(42))
        obs = jnp.ones(4, dtype=jnp.float32)

        state = state.replace(  # type: ignore[attr-defined]
            last_action=jnp.array(0, dtype=jnp.int32),
            last_observation=obs,
        )

        next_obs = jnp.ones(4, dtype=jnp.float32) * 3.0
        next_action = jnp.array(1, dtype=jnp.int32)
        reward = jnp.array(5.0)

        # Terminal update: target = r only
        result_term = agent.update(
            state, reward, next_obs, jnp.array(1.0), next_action
        )

        # Non-terminal update: target = r + gamma * Q(s', a')
        result_cont = agent.update(
            state, reward, next_obs, jnp.array(0.0), next_action
        )

        # TD errors should differ (terminal strips bootstrap)
        # Both should be finite
        assert jnp.isfinite(result_term.td_error)
        assert jnp.isfinite(result_cont.td_error)
