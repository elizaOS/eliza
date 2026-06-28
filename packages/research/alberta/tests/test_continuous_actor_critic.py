"""Tests for the Step 4 continuous-action actor-critic preview."""

from __future__ import annotations

import chex
import jax
import jax.numpy as jnp
import jax.random as jr

from alberta_framework import ContinuousActorCriticAgent as TopLevelContinuousActorCriticAgent
from alberta_framework.core import (
    ContinuousActorCriticAgent as CoreContinuousActorCriticAgent,
)
from alberta_framework.core.actor_critic import (
    ContinuousActorCriticAgent,
    ContinuousActorCriticConfig,
    run_continuous_actor_critic_from_arrays,
)
from alberta_framework.core.optimizers import ObGDBounding


def _assert_continuous_actor_critic_state_finite(state) -> None:  # type: ignore[no-untyped-def]
    chex.assert_tree_all_finite(
        (
            state.mean_weights,
            state.mean_bias,
            state.log_sigma,
            state.critic_weights,
            state.critic_bias,
            state.mean_trace_weights,
            state.mean_trace_bias,
            state.log_sigma_trace,
            state.critic_trace_weights,
            state.critic_trace_bias,
            state.last_observation,
            state.last_action,
        )
    )


def test_continuous_actor_critic_top_level_alias() -> None:
    """Top-level and core re-exports refer to the same class."""
    assert TopLevelContinuousActorCriticAgent is ContinuousActorCriticAgent
    assert CoreContinuousActorCriticAgent is ContinuousActorCriticAgent


def test_continuous_actor_critic_init_and_select_action_shapes() -> None:
    agent = ContinuousActorCriticAgent(
        ContinuousActorCriticConfig(action_dim=2, action_low=-1.0, action_high=1.0)
    )
    state = agent.init(feature_dim=4, key=jr.key(0))
    obs = jnp.array([1.0, -1.0, 0.5, 2.0], dtype=jnp.float32)

    mean, sigma = agent.policy_params(state, obs)
    value = agent.value(state, obs)
    next_state, action, mean_start, sigma_start = agent.start(state, obs)

    chex.assert_shape(mean, (2,))
    chex.assert_shape(sigma, (2,))
    chex.assert_shape(value, ())
    chex.assert_shape(action, (2,))
    chex.assert_shape(mean_start, (2,))
    chex.assert_shape(sigma_start, (2,))
    assert jnp.all(sigma > 0.0)
    assert jnp.all(action >= -1.0)
    assert jnp.all(action <= 1.0)
    _assert_continuous_actor_critic_state_finite(next_state)


def test_continuous_actor_critic_update_produces_finite_outputs() -> None:
    config = ContinuousActorCriticConfig(
        action_dim=1,
        gamma=0.9,
        actor_step_size=0.01,
        critic_step_size=0.05,
        actor_lamda=0.5,
        critic_lamda=0.5,
    )
    agent = ContinuousActorCriticAgent(config)
    state = agent.init(feature_dim=3, key=jr.key(1))
    state, _action, _mean, _sigma = agent.start(
        state, jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    )

    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0, 0.5], dtype=jnp.float32),
        terminated=jnp.array(False),
    )

    assert int(result.state.step_count) == 1
    _assert_continuous_actor_critic_state_finite(result.state)
    chex.assert_tree_all_finite(
        (result.mean, result.sigma, result.value, result.next_value, result.td_error)
    )


def test_continuous_actor_critic_policy_gradient_sign() -> None:
    """A positive TD error with action above the mean should push the mean up.

    With a Gaussian score function ``(a - mu) / sigma^2`` and positive TD
    error, the mean parameters update along ``+ (a - mu) / sigma^2 . s``. For a
    one-dimensional input ``s = 1`` the mean weight should therefore increase.
    """
    config = ContinuousActorCriticConfig(
        action_dim=1,
        gamma=0.0,  # purely instantaneous TD = reward - value
        actor_step_size=0.5,
        critic_step_size=0.0,
        actor_lamda=0.0,
        critic_lamda=0.0,
        log_sigma_init=0.0,
    )
    agent = ContinuousActorCriticAgent(config)
    obs = jnp.array([1.0], dtype=jnp.float32)
    state = agent.init(feature_dim=1, key=jr.key(2)).replace(  # type: ignore[attr-defined]
        last_observation=obs,
        last_action=jnp.array([0.4], dtype=jnp.float32),  # action > mean (mean starts at 0)
    )
    # critic V(s) = 0 since weights are zero, so td_error = reward = +1.0 > 0.
    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0], dtype=jnp.float32),
        terminated=jnp.array(True),
    )
    assert float(result.state.mean_weights[0, 0]) > 0.0
    assert float(result.state.mean_bias[0]) > 0.0
    assert float(result.td_error) > 0.0


def test_continuous_actor_critic_terminal_resets_traces() -> None:
    config = ContinuousActorCriticConfig(
        action_dim=2,
        actor_step_size=0.01,
        critic_step_size=0.01,
        actor_lamda=0.9,
        critic_lamda=0.9,
    )
    agent = ContinuousActorCriticAgent(config)
    state = agent.init(feature_dim=2, key=jr.key(3)).replace(  # type: ignore[attr-defined]
        last_observation=jnp.array([1.0, 0.5], dtype=jnp.float32),
        last_action=jnp.array([0.1, -0.1], dtype=jnp.float32),
        mean_trace_weights=jnp.ones((2, 2), dtype=jnp.float32),
        mean_trace_bias=jnp.ones((2,), dtype=jnp.float32),
        log_sigma_trace=jnp.ones((2,), dtype=jnp.float32),
        critic_trace_weights=jnp.ones((2,), dtype=jnp.float32),
        critic_trace_bias=jnp.array(1.0, dtype=jnp.float32),
    )

    result = agent.update(
        state,
        reward=jnp.array(0.5, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0], dtype=jnp.float32),
        terminated=jnp.array(True),
    )
    chex.assert_trees_all_close(
        (
            result.state.mean_trace_weights,
            result.state.mean_trace_bias,
            result.state.log_sigma_trace,
            result.state.critic_trace_weights,
            result.state.critic_trace_bias,
        ),
        (
            jnp.zeros_like(result.state.mean_trace_weights),
            jnp.zeros_like(result.state.mean_trace_bias),
            jnp.zeros_like(result.state.log_sigma_trace),
            jnp.zeros_like(result.state.critic_trace_weights),
            jnp.array(0.0, dtype=jnp.float32),
        ),
    )


def test_continuous_actor_critic_log_sigma_clipping() -> None:
    """Log-sigma stays within configured bounds even with large updates."""
    config = ContinuousActorCriticConfig(
        action_dim=1,
        gamma=0.0,
        actor_step_size=10.0,
        critic_step_size=0.0,
        actor_lamda=0.0,
        critic_lamda=0.0,
        log_sigma_init=0.0,
        log_sigma_min=-2.0,
        log_sigma_max=1.0,
    )
    agent = ContinuousActorCriticAgent(config)
    obs = jnp.array([1.0], dtype=jnp.float32)
    state = agent.init(feature_dim=1, key=jr.key(4)).replace(  # type: ignore[attr-defined]
        last_observation=obs,
        last_action=jnp.array([5.0], dtype=jnp.float32),
    )
    result = agent.update(
        state,
        reward=jnp.array(1.0, dtype=jnp.float32),
        observation=jnp.array([0.0], dtype=jnp.float32),
        terminated=jnp.array(True),
    )
    assert float(result.state.log_sigma[0]) <= 1.0
    assert float(result.state.log_sigma[0]) >= -2.0


def test_continuous_actor_critic_action_clipping() -> None:
    """Sampled actions respect the configured action bounds."""
    config = ContinuousActorCriticConfig(
        action_dim=1,
        log_sigma_init=2.0,  # very wide policy
        action_low=-0.25,
        action_high=0.25,
    )
    agent = ContinuousActorCriticAgent(config)
    state = agent.init(feature_dim=1, key=jr.key(5))
    obs = jnp.array([1.0], dtype=jnp.float32)
    actions = []
    for _ in range(64):
        action, key, _mean, _sigma = agent.select_action(state, obs)
        state = state.replace(rng_key=key)  # type: ignore[attr-defined]
        actions.append(action)
    stacked = jnp.stack(actions)
    assert jnp.all(stacked >= -0.25)
    assert jnp.all(stacked <= 0.25)


def test_continuous_actor_critic_update_is_jittable() -> None:
    agent = ContinuousActorCriticAgent(ContinuousActorCriticConfig(action_dim=2))
    state = agent.init(feature_dim=2, key=jr.key(6))
    state, _action, _mean, _sigma = agent.start(
        state, jnp.array([1.0, 0.0], dtype=jnp.float32)
    )
    update = jax.jit(agent.update)
    result = update(
        state,
        jnp.array(0.5, dtype=jnp.float32),
        jnp.array([0.0, 1.0], dtype=jnp.float32),
        jnp.array(False),
    )
    chex.assert_shape(result.mean, (2,))
    assert int(result.state.step_count) == 1


def test_continuous_actor_critic_run_from_arrays_scan() -> None:
    agent = ContinuousActorCriticAgent(ContinuousActorCriticConfig(action_dim=2))
    state = agent.init(feature_dim=2, key=jr.key(7))
    observations = jnp.array(
        [[1.0, 0.0], [0.0, 1.0], [1.0, 1.0]], dtype=jnp.float32
    )
    next_observations = jnp.array(
        [[0.0, 1.0], [1.0, 1.0], [0.5, -0.5]], dtype=jnp.float32
    )
    rewards = jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    terminated = jnp.array([False, False, True])

    result = run_continuous_actor_critic_from_arrays(
        agent, state, observations, rewards, terminated, next_observations
    )

    chex.assert_shape(result.actions, (3, 2))
    chex.assert_shape(result.means, (3, 2))
    chex.assert_shape(result.sigmas, (3, 2))
    chex.assert_shape(result.values, (3,))
    chex.assert_shape(result.td_errors, (3,))
    assert int(result.state.step_count) == 3
    _assert_continuous_actor_critic_state_finite(result.state)
    chex.assert_tree_all_finite((result.means, result.sigmas, result.values, result.td_errors))


def test_continuous_actor_critic_config_roundtrip() -> None:
    config = ContinuousActorCriticConfig(
        action_dim=3,
        gamma=0.95,
        actor_step_size=0.002,
        critic_step_size=0.04,
        actor_lamda=0.7,
        critic_lamda=0.8,
        log_sigma_init=-0.25,
        log_sigma_min=-3.0,
        log_sigma_max=1.5,
        action_low=-2.0,
        action_high=2.0,
    )
    agent = ContinuousActorCriticAgent(config, bounder=ObGDBounding(kappa=2.5))
    serialised = agent.to_config()
    restored = ContinuousActorCriticAgent.from_config(serialised)
    assert restored.config.action_dim == config.action_dim
    assert restored.config.gamma == config.gamma
    assert restored.config.actor_step_size == config.actor_step_size
    assert restored.config.critic_step_size == config.critic_step_size
    assert restored.config.actor_lamda == config.actor_lamda
    assert restored.config.critic_lamda == config.critic_lamda
    assert restored.config.log_sigma_init == config.log_sigma_init
    assert restored.config.log_sigma_min == config.log_sigma_min
    assert restored.config.log_sigma_max == config.log_sigma_max
    assert restored.config.action_low == config.action_low
    assert restored.config.action_high == config.action_high
    assert restored.bounder is not None
    assert restored.bounder.to_config() == agent.bounder.to_config()  # type: ignore[union-attr]


def test_continuous_actor_critic_with_obgd_bounder_is_finite() -> None:
    agent = ContinuousActorCriticAgent(
        ContinuousActorCriticConfig(
            action_dim=2,
            actor_step_size=0.5,
            critic_step_size=0.5,
        ),
        bounder=ObGDBounding(kappa=2.0),
    )
    state = agent.init(feature_dim=3, key=jr.key(8))
    state, _action, _mean, _sigma = agent.start(
        state, jnp.array([1.0, 0.0, -1.0], dtype=jnp.float32)
    )
    result = agent.update(
        state,
        reward=jnp.array(5.0, dtype=jnp.float32),
        observation=jnp.array([0.0, 1.0, 0.5], dtype=jnp.float32),
        terminated=jnp.array(False),
    )
    _assert_continuous_actor_critic_state_finite(result.state)
    chex.assert_tree_all_finite(result.bound_metric)
