"""Tests for Step 4b actor-critic core."""

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import ActorCriticAgent as TopLevelActorCriticAgent
from alberta_framework.core import ActorCriticAgent as CoreActorCriticAgent
from alberta_framework.core.actor_critic import (
    ActorCriticAgent,
    ActorCriticConfig,
    run_actor_critic_from_arrays,
)
from alberta_framework.core.optimizers import ObGDBounding


def _assert_actor_critic_numeric_state_finite(state) -> None:  # type: ignore[no-untyped-def]
    chex.assert_tree_all_finite(
        (
            state.actor_weights,
            state.actor_bias,
            state.critic_weights,
            state.critic_bias,
            state.actor_trace_weights,
            state.actor_trace_bias,
            state.critic_trace_weights,
            state.critic_trace_bias,
            state.last_observation,
        )
    )


def test_actor_critic_init_predict_and_start_shapes() -> None:
    agent = ActorCriticAgent(ActorCriticConfig(n_actions=3))
    state = agent.init(feature_dim=4, key=jr.key(0))
    obs = jnp.array([1.0, -1.0, 0.5, 2.0], dtype=jnp.float32)

    policy = agent.policy(state, obs)
    value = agent.value(state, obs)
    next_state, action, start_policy = agent.start(state, obs)

    chex.assert_shape(policy, (3,))
    chex.assert_shape(start_policy, (3,))
    chex.assert_shape(value, ())
    chex.assert_shape(action, ())
    chex.assert_trees_all_close(jnp.sum(policy), 1.0)
    _assert_actor_critic_numeric_state_finite(next_state)
    assert int(next_state.last_action) in range(3)


def test_actor_critic_update_changes_actor_and_critic() -> None:
    config = ActorCriticConfig(
        n_actions=2,
        gamma=0.9,
        actor_step_size=0.1,
        critic_step_size=0.2,
        actor_lamda=0.8,
        critic_lamda=0.7,
    )
    agent = ActorCriticAgent(config)
    state = agent.init(feature_dim=3, key=jr.key(1))
    state, _action, _policy = agent.start(
        state, jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0, 0.5], dtype=jnp.float32),
        terminated=jnp.array(False),
    )

    assert int(result.state.step_count) == 1
    assert float(result.td_error) == 1.0
    assert not jnp.allclose(result.state.actor_weights, state.actor_weights)
    assert not jnp.allclose(result.state.critic_weights, state.critic_weights)
    _assert_actor_critic_numeric_state_finite(result.state)
    chex.assert_tree_all_finite(
        (result.policy, result.value, result.next_value, result.td_error)
    )


def test_actor_critic_temperature_scales_actor_gradient() -> None:
    obs = jnp.array([1.0, -2.0], dtype=jnp.float32)
    next_obs = jnp.array([0.0, 0.0], dtype=jnp.float32)
    warm_agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            gamma=0.9,
            actor_step_size=0.1,
            critic_step_size=0.0,
            actor_lamda=0.0,
            critic_lamda=0.0,
            temperature=1.0,
        )
    )
    cool_agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            gamma=0.9,
            actor_step_size=0.1,
            critic_step_size=0.0,
            actor_lamda=0.0,
            critic_lamda=0.0,
            temperature=0.5,
        )
    )
    warm_state = warm_agent.init(feature_dim=2, key=jr.key(10)).replace(  # type: ignore[attr-defined]
        last_observation=obs,
        last_action=jnp.array(0, dtype=jnp.int32),
    )
    cool_state = cool_agent.init(feature_dim=2, key=jr.key(10)).replace(  # type: ignore[attr-defined]
        last_observation=obs,
        last_action=jnp.array(0, dtype=jnp.int32),
    )

    warm = warm_agent.update(
        warm_state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=next_obs,
        discount=jnp.array(0.0, dtype=jnp.float32),
    )
    cool = cool_agent.update(
        cool_state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=next_obs,
        discount=jnp.array(0.0, dtype=jnp.float32),
    )

    chex.assert_trees_all_close(
        cool.state.actor_weights,
        2.0 * warm.state.actor_weights,
        atol=1e-6,
        rtol=1e-6,
    )


def test_actor_critic_terminal_update_resets_traces() -> None:
    agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            actor_step_size=0.1,
            critic_step_size=0.1,
            actor_lamda=0.9,
            critic_lamda=0.9,
        )
    )
    state = agent.init(feature_dim=2, key=jr.key(11)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.5], dtype=jnp.float32),
        last_action=jnp.array(1, dtype=jnp.int32),
        actor_trace_weights=jnp.ones((2, 2), dtype=jnp.float32),
        actor_trace_bias=jnp.ones((2,), dtype=jnp.float32),
        critic_trace_weights=jnp.ones((2,), dtype=jnp.float32),
        critic_trace_bias=jnp.array(1.0, dtype=jnp.float32),
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(True),
    )

    chex.assert_trees_all_close(
        (
            result.state.actor_trace_weights,
            result.state.actor_trace_bias,
            result.state.critic_trace_weights,
            result.state.critic_trace_bias,
        ),
        (
            jnp.zeros_like(result.state.actor_trace_weights),
            jnp.zeros_like(result.state.actor_trace_bias),
            jnp.zeros_like(result.state.critic_trace_weights),
            jnp.array(0.0, dtype=jnp.float32),
        ),
    )
    assert not jnp.allclose(result.state.actor_weights, state.actor_weights)


def test_actor_critic_explicit_discount_semantics() -> None:
    agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            gamma=0.9,
            actor_step_size=0.0,
            critic_step_size=0.0,
        )
    )
    state = agent.init(feature_dim=2, key=jr.key(12)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.0], dtype=jnp.float32),
        last_action=jnp.array(0, dtype=jnp.int32),
        critic_weights=jnp.array([2.0, 4.0], dtype=jnp.float32),
        critic_bias=jnp.array(0.5, dtype=jnp.float32),
    )
    next_obs = jnp.array([0.0, 1.0], dtype=jnp.float32)

    explicit = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=next_obs,
        terminated=jnp.array(True),
        discount=jnp.array(0.25, dtype=jnp.float32),
    )
    legacy = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=next_obs,
        terminated=jnp.array(True),
    )

    chex.assert_trees_all_close(explicit.td_error, jnp.array(-0.375, dtype=jnp.float32))
    chex.assert_trees_all_close(legacy.td_error, jnp.array(-1.5, dtype=jnp.float32))


def test_actor_critic_update_is_jittable() -> None:
    agent = ActorCriticAgent(ActorCriticConfig(n_actions=2))
    state = agent.init(feature_dim=2, key=jr.key(2))
    state, _action, _policy = agent.start(
        state, jnp.array([1.0, 0.0], dtype=jnp.float32)
    )

    update = jax.jit(agent.update)
    result = update(
        state,
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
        jnp.array(False),
    )

    chex.assert_shape(result.policy, (2,))
    assert int(result.state.step_count) == 1


def test_run_actor_critic_from_arrays_scan() -> None:
    agent = ActorCriticAgent(ActorCriticConfig(n_actions=2))
    state = agent.init(feature_dim=2, key=jr.key(3))
    observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=jnp.float32
    )
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [0.5, -0.5]], dtype=jnp.float32
    )
    rewards = jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    terminated = jnp.array([False, False, True])

    result = run_actor_critic_from_arrays(
        agent, state, observations, rewards, terminated, next_observations
    )

    chex.assert_shape(result.actions, (3,))
    chex.assert_shape(result.policies, (3, 2))
    chex.assert_shape(result.values, (3,))
    chex.assert_shape(result.td_errors, (3,))
    assert int(result.state.step_count) == 3
    _assert_actor_critic_numeric_state_finite(result.state)
    chex.assert_tree_all_finite((result.policies, result.values, result.td_errors))


def test_run_actor_critic_from_arrays_fixed_actions_matches_loop() -> None:
    agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            gamma=0.9,
            actor_step_size=0.05,
            critic_step_size=0.1,
            actor_lamda=0.7,
            critic_lamda=0.6,
        )
    )
    state = agent.init(feature_dim=2, key=jr.key(13))
    observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=jnp.float32
    )
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [0.5, -0.5]], dtype=jnp.float32
    )
    rewards = jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    actions = jnp.array([0, 1, 0], dtype=jnp.int32)
    discounts = jnp.array([0.9, 0.9, 0.0], dtype=jnp.float32)

    scan_result = run_actor_critic_from_arrays(
        agent,
        state,
        observations,
        rewards,
        terminated=None,
        next_observations=next_observations,
        actions=actions,
        discounts=discounts,
    )

    loop_state = state
    loop_td_errors = []
    for obs, reward, action, discount, next_obs in zip(
        observations, rewards, actions, discounts, next_observations, strict=True
    ):
        loop_state = loop_state.replace(  # type: ignore[attr-defined]
            last_observation=obs,
            last_action=action,
        )
        loop_result = agent.update(
            loop_state,
            reward=reward,
            observation=next_obs,
            discount=discount,
        )
        loop_state = loop_result.state
        loop_td_errors.append(loop_result.td_error)

    chex.assert_trees_all_close(scan_result.actions, actions)
    chex.assert_trees_all_close(scan_result.td_errors, jnp.stack(loop_td_errors))
    chex.assert_trees_all_close(scan_result.state.actor_weights, loop_state.actor_weights)
    chex.assert_trees_all_close(
        scan_result.state.critic_weights, loop_state.critic_weights
    )


def test_actor_critic_config_round_trip_with_bounder() -> None:
    agent = ActorCriticAgent(
        ActorCriticConfig(n_actions=4, gamma=0.95, actor_step_size=0.03),
        bounder=ObGDBounding(kappa=3.0),
    )

    reconstructed = ActorCriticAgent.from_config(agent.to_config())

    assert reconstructed.config == agent.config
    assert reconstructed.bounder is not None
    assert reconstructed.bounder.to_config() == {"type": "ObGDBounding", "kappa": 3.0}


def test_actor_critic_bounder_hook_runs() -> None:
    agent = ActorCriticAgent(
        ActorCriticConfig(
            n_actions=2,
            actor_step_size=100.0,
            critic_step_size=100.0,
        ),
        bounder=ObGDBounding(kappa=2.0),
    )
    state = agent.init(feature_dim=2, key=jr.key(4))
    state, _action, _policy = agent.start(
        state, jnp.array([1.0, 1.0], dtype=jnp.float32)
    )

    result = agent.update(
        state,
        reward=jnp.array(10.0, dtype=jnp.float32),
        observation=jnp.array([0.5, -1.0], dtype=jnp.float32),
        terminated=jnp.array(False),
    )

    assert float(result.bound_metric) < 1.0
    _assert_actor_critic_numeric_state_finite(result.state)
    chex.assert_tree_all_finite(
        (result.policy, result.value, result.next_value, result.td_error)
    )


def test_actor_critic_exports() -> None:
    assert TopLevelActorCriticAgent is ActorCriticAgent
    assert CoreActorCriticAgent is ActorCriticAgent
