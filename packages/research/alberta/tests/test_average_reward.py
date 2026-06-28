"""Tests for average-reward Step 5/6 primitives."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import (
    DifferentialSARSAAgent as TopLevelDifferentialSARSAAgent,
)
from alberta_framework.core import DifferentialTDLearner as CoreDifferentialTDLearner
from alberta_framework.core.average_reward import (
    AverageRewardHordeActorCriticAgent,
    AverageRewardHordeActorCriticConfig,
    AverageRewardHordeLearner,
    DifferentialGTDConfig,
    DifferentialGTDLearner,
    DifferentialSARSAAgent,
    DifferentialSARSAConfig,
    DifferentialTDConfig,
    DifferentialTDLearner,
    run_average_reward_horde_from_arrays,
    run_differential_gtd_from_arrays,
    run_differential_sarsa_from_arrays,
    run_differential_td_from_arrays,
)


def test_differential_td_config_and_top_level_exports() -> None:
    config = DifferentialTDConfig(
        step_size=0.1,
        average_reward_step_size=0.02,
        trace_decay=0.5,
    )
    learner = DifferentialTDLearner.from_config(
        DifferentialTDLearner(config).to_config()
    )

    assert learner.config == config
    assert CoreDifferentialTDLearner is DifferentialTDLearner
    assert TopLevelDifferentialSARSAAgent is DifferentialSARSAAgent


def test_differential_td_error_matches_average_reward_target() -> None:
    learner = DifferentialTDLearner(DifferentialTDConfig(step_size=0.0))
    state = learner.init(2).replace(  # type: ignore[attr-defined]
        weights=jnp.array([1.0, -1.0], dtype=jnp.float32),
        bias=jnp.array(0.5, dtype=jnp.float32),
        average_reward=jnp.array(0.25, dtype=jnp.float32),
    )
    obs = jnp.array([2.0, 1.0], dtype=jnp.float32)
    next_obs = jnp.array([0.0, 3.0], dtype=jnp.float32)

    td_error = learner.td_error(
        state,
        obs,
        jnp.array(1.25, dtype=jnp.float32),
        next_obs,
    )

    chex.assert_trees_all_close(td_error, jnp.array(-3.0, dtype=jnp.float32))


def test_differential_td_update_moves_average_reward_and_is_jittable() -> None:
    learner = DifferentialTDLearner(
        DifferentialTDConfig(
            step_size=0.1,
            average_reward_step_size=0.2,
            trace_decay=0.0,
        )
    )
    state = learner.init(1)
    update = jax.jit(learner.update)
    result = update(
        state,
        jnp.array([1.0], dtype=jnp.float32),
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([1.0], dtype=jnp.float32),
    )

    chex.assert_trees_all_close(
        result.average_reward,
        jnp.array(0.2, dtype=jnp.float32),
    )
    assert int(result.state.step_count) == 1
    chex.assert_tree_all_finite(result)


def test_differential_td_scan_shapes_and_finite_metrics() -> None:
    learner = DifferentialTDLearner(DifferentialTDConfig(trace_decay=0.2))
    state = learner.init(2)
    observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
        dtype=jnp.float32,
    )
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [1.0, -1.0]],
        dtype=jnp.float32,
    )
    rewards = jnp.array([0.0, 1.0, 0.5], dtype=jnp.float32)

    result = run_differential_td_from_arrays(
        learner,
        state,
        observations,
        rewards,
        next_observations,
    )

    chex.assert_shape(result.predictions, (3,))
    chex.assert_shape(result.td_errors, (3,))
    chex.assert_shape(result.average_rewards, (3,))
    chex.assert_shape(result.metrics, (3, 4))
    assert int(result.state.step_count) == 3
    chex.assert_tree_all_finite(
        (result.predictions, result.td_errors, result.average_rewards, result.metrics)
    )


def test_differential_gtd_config_roundtrip_and_ratio_clipping() -> None:
    config = DifferentialGTDConfig(
        value_step_size=0.1,
        secondary_step_size=0.05,
        average_reward_step_size=0.02,
        trace_decay=0.3,
        ratio_clip=1.5,
    )
    learner = DifferentialGTDLearner.from_config(
        DifferentialGTDLearner(config).to_config()
    )
    state = learner.init(1)

    result = learner.update(
        state,
        jnp.array([1.0], dtype=jnp.float32),
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([1.0], dtype=jnp.float32),
        jnp.array(3.0, dtype=jnp.float32),
    )

    assert learner.config == config
    chex.assert_trees_all_close(result.rho_clipped, jnp.array(1.5, dtype=jnp.float32))
    assert int(result.state.step_count) == 1
    chex.assert_tree_all_finite(result)


def test_differential_gtd_scan_learns_average_reward_cycle() -> None:
    learner = DifferentialGTDLearner(
        DifferentialGTDConfig(
            value_step_size=0.05,
            secondary_step_size=0.01,
            average_reward_step_size=0.01,
            trace_decay=0.0,
            ratio_clip=2.0,
        )
    )
    rewards_by_state = jnp.array([0.0, 1.0, 2.0], dtype=jnp.float32)
    steps = 20_000
    states = jnp.arange(steps, dtype=jnp.int32) % 3
    next_states = (states + 1) % 3
    observations = jnp.eye(3, dtype=jnp.float32)[states]
    next_observations = jnp.eye(3, dtype=jnp.float32)[next_states]
    rewards = rewards_by_state[states]
    rhos = jnp.ones((steps,), dtype=jnp.float32)
    state = learner.init(3)

    result = run_differential_gtd_from_arrays(
        learner,
        state,
        observations,
        rewards,
        next_observations,
        rhos,
    )

    predictions = learner.predict(result.state, jnp.eye(3, dtype=jnp.float32))
    centered_predictions = predictions - jnp.mean(predictions)
    true_values = jnp.array([-2.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0], dtype=jnp.float32)
    chex.assert_trees_all_close(
        result.state.average_reward,
        jnp.array(1.0, dtype=jnp.float32),
        atol=2e-2,
    )
    chex.assert_trees_all_close(centered_predictions, true_values, atol=5e-2)
    assert float(jnp.mean(result.td_errors[-1000:] ** 2)) <= 2e-3
    chex.assert_tree_all_finite(result)


def test_average_reward_horde_shared_trunk_scan_learns_reward_rates() -> None:
    learner = AverageRewardHordeLearner(
        n_demons=2,
        hidden_sizes=(8,),
        step_size=0.02,
        average_reward_step_size=0.01,
        sparsity=0.0,
        use_layer_norm=False,
    )
    restored = AverageRewardHordeLearner.from_config(learner.to_config())
    assert restored.n_demons == 2

    steps = 20_000
    states = jnp.arange(steps, dtype=jnp.int32) % 3
    next_states = (states + 1) % 3
    observations = jnp.eye(3, dtype=jnp.float32)[states]
    next_observations = jnp.eye(3, dtype=jnp.float32)[next_states]
    cumulants = jnp.stack(
        [
            jnp.array([0.0, 1.0, 2.0], dtype=jnp.float32)[states],
            jnp.array([2.0, 1.0, 0.0], dtype=jnp.float32)[states],
        ],
        axis=1,
    )
    state = learner.init(3, jr.key(0))

    result = run_average_reward_horde_from_arrays(
        learner,
        state,
        observations,
        cumulants,
        next_observations,
    )

    chex.assert_trees_all_close(
        result.state.average_rewards,
        jnp.array([1.0, 1.0], dtype=jnp.float32),
        atol=3e-2,
    )
    assert float(jnp.mean(result.td_errors[-1000:] ** 2)) <= 5e-3
    chex.assert_tree_all_finite(result)


def test_average_reward_horde_actor_critic_single_update_is_finite() -> None:
    agent = AverageRewardHordeActorCriticAgent(
        AverageRewardHordeActorCriticConfig(
            n_actions=2,
            hidden_sizes=(4,),
            critic_step_size=0.02,
            average_reward_step_size=0.01,
        )
    )
    restored = AverageRewardHordeActorCriticAgent.from_config(agent.to_config())
    assert restored.config == agent.config
    assert type(restored.actor_optimizer) is type(agent.actor_optimizer)
    state = agent.init(2, jr.key(0))
    state, action = agent.start(state, jnp.array([1.0, 0.0], dtype=jnp.float32))

    result = agent.update(
        state,
        jnp.array(1.0, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
    )

    assert int(action) in (0, 1)
    assert int(result.action) in (0, 1)
    assert int(result.state.step_count) == 1
    chex.assert_tree_all_finite(
        (
            result.policy,
            result.td_error,
            result.average_reward,
            result.critic_prediction,
            result.state.actor_weights,
            result.state.actor_bias,
            result.state.critic_state.average_rewards,
        )
    )


def test_differential_sarsa_config_roundtrip_and_exact_td_error() -> None:
    config = DifferentialSARSAConfig(
        n_actions=2,
        q_step_size=0.0,
        average_reward_step_size=0.0,
        epsilon_start=0.0,
    )
    agent = DifferentialSARSAAgent.from_config(DifferentialSARSAAgent(config).to_config())
    state = agent.init(2, jr.key(0)).replace(  # type: ignore[attr-defined]
        q_weights=jnp.array([[1.0, 0.0], [0.0, 2.0]], dtype=jnp.float32),
        q_bias=jnp.array([0.5, -0.5], dtype=jnp.float32),
        average_reward=jnp.array(0.25, dtype=jnp.float32),
        last_observation=jnp.array([2.0, 1.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
    )
    next_obs = jnp.array([1.0, 3.0], dtype=jnp.float32)

    result = agent.update(
        state,
        jnp.array(2.0, dtype=jnp.float32),
        next_obs,
        next_action=jnp.array(1, dtype=jnp.int32),
    )

    assert agent.config == config
    chex.assert_trees_all_close(result.td_error, jnp.array(4.75, dtype=jnp.float32))
    chex.assert_trees_all_close(result.average_reward, state.average_reward)


def test_differential_sarsa_update_and_scan_are_finite() -> None:
    agent = DifferentialSARSAAgent(
        DifferentialSARSAConfig(
            n_actions=3,
            q_step_size=0.05,
            average_reward_step_size=0.01,
            trace_decay=0.2,
            epsilon_start=0.2,
        )
    )
    state = agent.init(2, jr.key(1))
    state, _ = agent.start(state, jnp.array([1.0, 0.0], dtype=jnp.float32))
    rewards = jnp.array([1.0, 0.0, 0.5, -0.25], dtype=jnp.float32)
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [0.5, -0.5], [1.0, 0.0]],
        dtype=jnp.float32,
    )

    result = run_differential_sarsa_from_arrays(
        agent,
        state,
        rewards,
        next_observations,
    )

    chex.assert_shape(result.q_values, (4, 3))
    chex.assert_shape(result.td_errors, (4,))
    chex.assert_shape(result.average_rewards, (4,))
    chex.assert_shape(result.actions, (4,))
    assert int(result.state.step_count) == 4
    chex.assert_tree_all_finite(
        (result.q_values, result.td_errors, result.average_rewards)
    )
    assert bool(jnp.all(result.actions >= 0))
    assert bool(jnp.all(result.actions < 3))


def test_differential_sarsa_learns_better_action_on_continuing_bandit() -> None:
    agent = DifferentialSARSAAgent(
        DifferentialSARSAConfig(
            n_actions=2,
            q_step_size=0.04,
            average_reward_step_size=0.01,
            trace_decay=0.0,
            epsilon_start=0.1,
            epsilon_end=0.02,
            epsilon_decay_steps=200,
        )
    )
    obs = jnp.array([1.0], dtype=jnp.float32)
    state = agent.init(1, jr.key(42))
    state, _ = agent.start(state, obs)

    for _ in range(800):
        reward = jnp.asarray(state.last_action == 1, dtype=jnp.float32)
        result = agent.update(state, reward, obs)
        state = result.state

    q_values = agent.q_values(state, obs)
    assert float(q_values[1]) > float(q_values[0]) + 0.25
    assert float(state.average_reward) > 0.75
