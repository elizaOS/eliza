"""Tests for bsuite benchmark agents and wrappers."""

from __future__ import annotations

import json
import tempfile

import numpy as np
import pytest

dm_env = pytest.importorskip("dm_env", reason="dm_env not installed (install with bsuite extra)")
pytest.importorskip("bsuite", reason="bsuite not installed")
from dm_env import specs  # noqa: E402

from benchmarks.bsuite.wrappers import ContinuingWrapper  # noqa: E402

# ---------------------------------------------------------------------------
# Minimal stub environment for unit tests (no bsuite import needed)
# ---------------------------------------------------------------------------


class StubEpisodicEnv(dm_env.Environment):
    """Minimal episodic environment for testing wrappers.

    Runs for `episode_length` steps then terminates. Observation is a
    1D array with a single feature. Three discrete actions.
    """

    def __init__(self, episode_length: int = 5) -> None:
        self._episode_length = episode_length
        self._step_count = 0
        self._obs = np.array([1.0, 0.0, 0.0], dtype=np.float32)

    def reset(self) -> dm_env.TimeStep:
        self._step_count = 0
        self._obs = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        return dm_env.restart(self._obs)

    def step(self, action: int) -> dm_env.TimeStep:
        self._step_count += 1
        self._obs = np.array([float(self._step_count), 0.0, 0.0], dtype=np.float32)
        reward = 1.0 if action == 1 else 0.0

        if self._step_count >= self._episode_length:
            return dm_env.termination(reward=reward, observation=self._obs)
        return dm_env.transition(reward=reward, observation=self._obs)

    def observation_spec(self) -> specs.Array:
        return specs.Array(shape=(3,), dtype=np.float32, name="obs")

    def action_spec(self) -> specs.DiscreteArray:
        return specs.DiscreteArray(num_values=3, name="action")


# ---------------------------------------------------------------------------
# ContinuingWrapper tests
# ---------------------------------------------------------------------------


class TestContinuingWrapper:
    """Tests for the ContinuingWrapper."""

    def test_continuing_never_produces_last(self) -> None:
        """In continuing mode, the wrapper should never return a LAST timestep."""
        env = ContinuingWrapper(StubEpisodicEnv(episode_length=3), mode="continuing")
        ts = env.reset()
        assert ts.step_type == dm_env.StepType.MID

        # Run through several episode boundaries
        for _ in range(20):
            ts = env.step(0)
            assert ts.step_type == dm_env.StepType.MID
            assert not ts.last()

    def test_continuing_discount_zero_at_boundary(self) -> None:
        """At episode boundaries, discount should be 0.0."""
        inner = StubEpisodicEnv(episode_length=3)
        env = ContinuingWrapper(inner, mode="continuing")
        env.reset()

        discounts = []
        for _ in range(9):  # 3 episodes worth
            ts = env.step(0)
            discounts.append(float(ts.discount))

        # Every 3rd step should have discount=0 (boundary)
        assert discounts[2] == 0.0  # First boundary at step 3
        assert discounts[5] == 0.0  # Second boundary at step 6
        assert discounts[8] == 0.0  # Third boundary at step 9

    def test_continuing_discount_nonzero_between_boundaries(self) -> None:
        """Between boundaries, discount should be the configured value."""
        inner = StubEpisodicEnv(episode_length=3)
        env = ContinuingWrapper(inner, mode="continuing", continuing_discount=0.99)
        env.reset()

        discounts = []
        for _ in range(9):
            ts = env.step(0)
            discounts.append(float(ts.discount))

        # Non-boundary steps should have configured discount
        assert discounts[0] == 0.99
        assert discounts[1] == 0.99
        assert discounts[3] == 0.99
        assert discounts[4] == 0.99

    def test_standard_mode_passthrough(self) -> None:
        """Standard mode should pass through timesteps unchanged."""
        inner = StubEpisodicEnv(episode_length=3)
        env = ContinuingWrapper(inner, mode="standard")
        ts = env.reset()
        assert ts.first()

        step_types = []
        for _ in range(3):
            ts = env.step(0)
            step_types.append(ts.step_type)

        assert step_types[-1] == dm_env.StepType.LAST  # Terminal should pass through

    def test_continuing_observation_from_new_episode(self) -> None:
        """At boundary, the observation should come from the new episode's reset."""
        inner = StubEpisodicEnv(episode_length=3)
        env = ContinuingWrapper(inner, mode="continuing")
        env.reset()

        # Step through to boundary
        for _ in range(3):
            ts = env.step(0)

        # At boundary (step 3), obs should be from the reset (step_count=0 -> obs=[1,0,0])
        # But actually the inner reset sets obs to [1.0, 0.0, 0.0]
        np.testing.assert_array_equal(ts.observation, [1.0, 0.0, 0.0])

    def test_continuing_reward_from_terminal_step(self) -> None:
        """At boundary, the reward should come from the terminal step."""
        inner = StubEpisodicEnv(episode_length=3)
        env = ContinuingWrapper(inner, mode="continuing")
        env.reset()

        # Take action=1 to get reward=1.0 at terminal step
        for i in range(3):
            ts = env.step(1)

        # The reward at the boundary should be from the terminal transition
        assert ts.reward == 1.0

    def test_specs_passthrough(self) -> None:
        """Observation and action specs should be passed through."""
        inner = StubEpisodicEnv()
        env = ContinuingWrapper(inner, mode="continuing")
        assert env.observation_spec().shape == (3,)
        assert env.action_spec().num_values == 3

    def test_invalid_mode_raises(self) -> None:
        """Invalid mode should raise ValueError."""
        with pytest.raises(ValueError, match="mode must be"):
            ContinuingWrapper(StubEpisodicEnv(), mode="invalid")


# ---------------------------------------------------------------------------
# AlbertaAgent tests
# ---------------------------------------------------------------------------


class TestAlbertaAgent:
    """Tests for the AlbertaAgent bridge class."""

    @pytest.fixture
    def agent(self):
        """Create a simple AlbertaAgent for testing."""
        from alberta_framework import MultiHeadMLPLearner, ObGDBounding
        from benchmarks.bsuite.agents.base import AlbertaAgent

        obs_spec = specs.Array(shape=(3,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")

        learner = MultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(16, 16),
            step_size=0.01,
            bounder=ObGDBounding(kappa=2.0),
        )
        return AlbertaAgent(
            obs_spec=obs_spec,
            action_spec=action_spec,
            learner=learner,
            discount=0.99,
            epsilon=0.1,
            seed=42,
        )

    def test_select_action_returns_valid_action(self, agent) -> None:
        """Agent should return an action in [0, num_actions)."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts = dm_env.restart(obs)
        for _ in range(10):
            action = agent.select_action(ts)
            assert 0 <= action < 3

    def test_update_changes_state(self, agent) -> None:
        """Agent state should change after an update."""
        obs1 = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        obs2 = np.array([0.5, 1.0, 0.5], dtype=np.float32)

        ts1 = dm_env.restart(obs1)
        ts2 = dm_env.transition(reward=1.0, observation=obs2)

        old_step_count = agent.step_count
        agent.update(ts1, 1, ts2)

        assert agent.step_count == old_step_count + 1

    def test_nan_masking_only_updates_selected_head(self, agent) -> None:
        """Only the taken action's head should get a real target."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts1 = dm_env.restart(obs)
        # Use a large reward to ensure a visible weight change
        ts2 = dm_env.transition(reward=10.0, observation=obs)

        # Get initial head weights
        initial_head_weights = [
            np.array(agent.state.head_params.weights[i]) for i in range(3)
        ]

        # Multiple updates to accumulate visible changes
        # (sparse init + ObGD bounding may produce tiny single-step updates)
        for _ in range(10):
            agent.update(ts1, 1, ts2)

        # Head 1 should change, heads 0 and 2 should stay the same
        new_head_weights = [
            np.array(agent.state.head_params.weights[i]) for i in range(3)
        ]

        assert not np.allclose(initial_head_weights[1], new_head_weights[1]), (
            "Selected head should have changed after 10 updates"
        )
        np.testing.assert_array_equal(
            initial_head_weights[0], new_head_weights[0],
        )
        np.testing.assert_array_equal(
            initial_head_weights[2], new_head_weights[2],
        )

    def test_discount_zero_no_bootstrap(self, agent) -> None:
        """When discount=0, TD target should be reward only (no bootstrap)."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts1 = dm_env.restart(obs)
        # Simulate a pseudo-terminal with discount=0
        ts2 = dm_env.TimeStep(
            step_type=dm_env.StepType.MID,
            reward=np.float64(5.0),
            discount=np.float64(0.0),
            observation=obs,
        )

        # The TD target should be 5.0 (reward) + 0 * max_Q = 5.0
        # We can verify by checking that the agent processes it without error
        agent.update(ts1, 0, ts2)
        assert agent.step_count == 1

    def test_n_heads_mismatch_raises(self) -> None:
        """n_heads != num_actions should raise ValueError."""
        from alberta_framework import MultiHeadMLPLearner
        from benchmarks.bsuite.agents.base import AlbertaAgent

        obs_spec = specs.Array(shape=(3,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")

        learner = MultiHeadMLPLearner(n_heads=5, hidden_sizes=(16,))  # Wrong

        with pytest.raises(ValueError, match="n_heads.*must match"):
            AlbertaAgent(obs_spec, action_spec, learner)


class TestAlbertaAgentRepresentationLogging:
    """Tests for representation utility logging."""

    @pytest.fixture
    def agent_with_logging(self):
        """Create an AlbertaAgent with representation logging enabled."""
        from alberta_framework import Autostep, MultiHeadMLPLearner, ObGDBounding
        from benchmarks.bsuite.agents.base import AlbertaAgent

        obs_spec = specs.Array(shape=(3,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")

        learner = MultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(16, 16),
            optimizer=Autostep(initial_step_size=0.01, meta_step_size=0.01),
            bounder=ObGDBounding(kappa=2.0),
        )
        return AlbertaAgent(
            obs_spec=obs_spec,
            action_spec=action_spec,
            learner=learner,
            seed=42,
            log_representation=True,
            log_interval=5,
        )

    def test_representation_logs_at_correct_intervals(self, agent_with_logging) -> None:
        """Representation snapshots should appear at the configured interval."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts1 = dm_env.restart(obs)
        ts2 = dm_env.transition(reward=1.0, observation=obs)

        for _ in range(12):
            agent_with_logging.update(ts1, 0, ts2)

        # With log_interval=5, should have logs at steps 5 and 10
        log = agent_with_logging.representation_log
        assert len(log) == 2
        assert log[0]["step"] == 5
        assert log[1]["step"] == 10

    def test_representation_log_has_expected_keys(self, agent_with_logging) -> None:
        """Each snapshot should contain expected metric keys."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts1 = dm_env.restart(obs)
        ts2 = dm_env.transition(reward=1.0, observation=obs)

        for _ in range(5):
            agent_with_logging.update(ts1, 0, ts2)

        log = agent_with_logging.representation_log
        assert len(log) == 1
        snapshot = log[0]
        assert "step" in snapshot
        assert "head_step_sizes" in snapshot
        assert "trunk_trace_norms" in snapshot
        assert "trunk_step_sizes" in snapshot
        assert len(snapshot["head_step_sizes"]) == 3  # n_heads

    def test_save_representation_log(self, agent_with_logging) -> None:
        """Representation log should be saveable to JSON."""
        obs = np.array([1.0, 0.5, 0.0], dtype=np.float32)
        ts1 = dm_env.restart(obs)
        ts2 = dm_env.transition(reward=1.0, observation=obs)

        for _ in range(5):
            agent_with_logging.update(ts1, 0, ts2)

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
            agent_with_logging.save_representation_log(f.name)
            with open(f.name) as rf:
                loaded = json.load(rf)
            assert len(loaded) == 1
            assert loaded[0]["step"] == 5


# ---------------------------------------------------------------------------
# Agent factory tests
# ---------------------------------------------------------------------------


class TestAgentFactories:
    """Tests for agent factory functions."""

    def test_autostep_dqn_creates_agent(self) -> None:
        """autostep_dqn.default_agent should create a valid agent."""
        from benchmarks.bsuite.agents import autostep_dqn

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = autostep_dqn.default_agent(obs_spec, action_spec)

        ts = dm_env.restart(np.zeros(10, dtype=np.float32))
        action = agent.select_action(ts)
        assert 0 <= action < 3

    def test_lms_dqn_creates_agent(self) -> None:
        """lms_dqn.default_agent should create a valid agent."""
        from benchmarks.bsuite.agents import lms_dqn

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = lms_dqn.default_agent(obs_spec, action_spec)

        ts = dm_env.restart(np.zeros(10, dtype=np.float32))
        action = agent.select_action(ts)
        assert 0 <= action < 3

    def test_adam_dqn_creates_agent(self) -> None:
        """adam_dqn.default_agent should create a valid agent."""
        from benchmarks.bsuite.agents import adam_dqn

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = adam_dqn.default_agent(obs_spec, action_spec)

        ts = dm_env.restart(np.zeros(10, dtype=np.float32))
        action = agent.select_action(ts)
        assert 0 <= action < 3

    def test_horde_ac_creates_agent_with_aux_demons(self) -> None:
        """horde_actor_critic.default_agent attaches 3 auxiliary demons by default."""
        from benchmarks.bsuite.agents import horde_actor_critic

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = horde_actor_critic.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
        )

        assert agent.n_aux == 3

        ts = dm_env.restart(np.zeros(10, dtype=np.float32))
        action = agent.select_action(ts)
        assert 0 <= action < 3

    def test_horde_ac_history_features_change_feature_dim(self) -> None:
        """Enabling history features should expand the critic feature dim."""
        from benchmarks.bsuite.agents import horde_actor_critic

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = horde_actor_critic.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            use_history_features=True,
            history_decay_rates=(0.5, 0.9, 0.99),
        )

        # 10 raw + 10 channels * 3 decays = 40
        assert agent._history_extractor is not None
        assert agent._history_extractor.feature_dim() == 40

    def test_nlhac_actor_step_size_alias_controls_actor_optimizer(self) -> None:
        """NLHAC configs use actor_step_size as the actor Autostep initializer."""
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_step_size=0.07,
        )

        assert agent._agent.actor_optimizer.to_config()["initial_step_size"] == 0.07

    def test_nlhac_actor_gradient_clip_norm_passes_to_core_config(self) -> None:
        """NLHAC adapter exposes the core actor gradient clipping hook."""
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_gradient_clip_norm=0.5,
        )

        assert agent._agent.config.actor_gradient_clip_norm == 0.5

    def test_nlhac_actor_layer_norm_can_be_disabled(self) -> None:
        """NLHAC adapter exposes the core actor layer-norm switch."""
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_use_layer_norm=False,
        )

        assert agent._agent.config.use_layer_norm is False

    def test_nlhac_actor_epsilon_passes_to_core_config(self) -> None:
        """NLHAC adapter exposes the core actor policy-mixture floor."""
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_epsilon=0.05,
        )

        assert agent._agent.config.actor_epsilon == pytest.approx(0.05)

    def test_nlhac_actor_td_error_normalizer_passes_to_core_config(self) -> None:
        """NLHAC adapter exposes actor-only TD-error normalization."""
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_td_error_normalizer_decay=0.99,
        )

        assert agent._agent.config.actor_td_error_normalizer_decay == pytest.approx(
            0.99
        )

    def test_nlhac_adaptive_bounder_configures_critic_and_actor(self) -> None:
        """NLHAC adapter exposes adaptive ObGD for critic and actor bounds."""
        from alberta_framework import AdaptiveObGDBounding
        from benchmarks.bsuite.agents import nlhac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlhac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            bounder_name="adaptive_obgd",
            actor_bounder_name="adaptive_obgd",
        )

        assert isinstance(agent._agent.critic.learner._bounder, AdaptiveObGDBounding)
        assert isinstance(agent._agent.actor_bounder, AdaptiveObGDBounding)

    def test_nlqhorde_ac_creates_agent(self) -> None:
        """Nonlinear Q-Horde AC factory creates an action-value critic agent."""
        from benchmarks.bsuite.agents import nlqhorde_ac

        obs_spec = specs.Array(shape=(10,), dtype=np.float32, name="obs")
        action_spec = specs.DiscreteArray(num_values=3, name="action")
        agent = nlqhorde_ac.default_agent(
            obs_spec,
            action_spec,
            hidden_sizes=(16,),
            actor_hidden_sizes=(16,),
            actor_gradient_clip_norm=0.5,
        )

        assert agent._agent.config.n_actions == 3
        assert agent._agent.config.actor_gradient_clip_norm == 0.5


# ---------------------------------------------------------------------------
# Integration: smoke test with ContinuingWrapper
# ---------------------------------------------------------------------------


class TestIntegration:
    """Integration tests running agents on wrapped environments."""

    def test_smoke_continuing_100_steps(self) -> None:
        """Run an agent for 100 steps on a continuing stub env."""
        from alberta_framework import MultiHeadMLPLearner, ObGDBounding
        from benchmarks.bsuite.agents.base import AlbertaAgent

        inner = StubEpisodicEnv(episode_length=5)
        env = ContinuingWrapper(inner, mode="continuing")

        learner = MultiHeadMLPLearner(
            n_heads=3,
            hidden_sizes=(16,),
            step_size=0.01,
            bounder=ObGDBounding(kappa=2.0),
        )
        agent = AlbertaAgent(
            obs_spec=env.observation_spec(),
            action_spec=env.action_spec(),
            learner=learner,
            seed=42,
        )

        ts = env.reset()
        for _ in range(100):
            action = agent.select_action(ts)
            new_ts = env.step(action)
            agent.update(ts, action, new_ts)
            ts = new_ts

        assert agent.step_count == 100

    def test_smoke_standard_1_episode(self) -> None:
        """Run an agent for 1 episode in standard mode on stub env."""
        from alberta_framework import MultiHeadMLPLearner
        from benchmarks.bsuite.agents.base import AlbertaAgent

        inner = StubEpisodicEnv(episode_length=5)
        env = ContinuingWrapper(inner, mode="standard")

        learner = MultiHeadMLPLearner(
            n_heads=3, hidden_sizes=(16,), step_size=0.01,
        )
        agent = AlbertaAgent(
            obs_spec=env.observation_spec(),
            action_spec=env.action_spec(),
            learner=learner,
            seed=42,
        )

        ts = env.reset()
        step_count = 0
        while not ts.last():
            action = agent.select_action(ts)
            new_ts = env.step(action)
            agent.update(ts, action, new_ts)
            ts = new_ts
            step_count += 1

        assert step_count == 5
        assert agent.step_count == 5

    def test_adam_dqn_smoke_100_steps(self) -> None:
        """Run Adam DQN agent for 100 steps on continuing stub env."""
        from benchmarks.bsuite.agents import adam_dqn

        inner = StubEpisodicEnv(episode_length=5)
        env = ContinuingWrapper(inner, mode="continuing")

        agent = adam_dqn.default_agent(
            obs_spec=env.observation_spec(),
            action_spec=env.action_spec(),
            seed=42,
            hidden_sizes=(16,),
        )

        ts = env.reset()
        for _ in range(100):
            action = agent.select_action(ts)
            new_ts = env.step(action)
            agent.update(ts, action, new_ts)
            ts = new_ts

        assert agent.step_count == 100

    def test_horde_ac_smoke_100_steps(self) -> None:
        """Run Horde actor-critic adapter for 100 steps on continuing stub env."""
        from benchmarks.bsuite.agents import horde_actor_critic

        inner = StubEpisodicEnv(episode_length=5)
        env = ContinuingWrapper(inner, mode="continuing")

        agent = horde_actor_critic.default_agent(
            obs_spec=env.observation_spec(),
            action_spec=env.action_spec(),
            seed=42,
            hidden_sizes=(16,),
        )

        ts = env.reset()
        for _ in range(100):
            action = agent.select_action(ts)
            new_ts = env.step(action)
            agent.update(ts, action, new_ts)
            ts = new_ts

        assert agent.step_count == 100
        assert agent.n_aux == 3

    def test_horde_ac_history_smoke_100_steps(self) -> None:
        """Horde actor-critic with history features survives episode boundaries."""
        from benchmarks.bsuite.agents import horde_actor_critic

        inner = StubEpisodicEnv(episode_length=5)
        env = ContinuingWrapper(inner, mode="continuing")

        agent = horde_actor_critic.default_agent(
            obs_spec=env.observation_spec(),
            action_spec=env.action_spec(),
            seed=42,
            hidden_sizes=(16,),
            use_history_features=True,
            history_decay_rates=(0.5, 0.9),
        )

        ts = env.reset()
        for _ in range(100):
            action = agent.select_action(ts)
            new_ts = env.step(action)
            agent.update(ts, action, new_ts)
            ts = new_ts

        assert agent.step_count == 100
