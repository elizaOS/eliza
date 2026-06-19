"""Tests for the TargetReaching locomotion environment."""

import jax
import jax.numpy as jp
import numpy as np
import pytest

from eliza_robot.sim.mujoco.target import TargetReaching, default_config


@pytest.fixture(scope="module")
def env():
    config = default_config()
    config.episode_length = 100
    return TargetReaching(config=config)


@pytest.fixture(scope="module")
def initial_state(env):
    rng = jax.random.PRNGKey(0)
    return jax.jit(env.reset)(rng)


class TestTargetReset:
    def test_obs_shape(self, env, initial_state):
        obs_size = env._config.obs_history_size * env._single_obs_size
        assert initial_state.obs.shape == (obs_size,)

    def test_target_pos_shape(self, initial_state):
        assert initial_state.info["target_pos"].shape == (2,)

    def test_target_within_range(self, env, initial_state):
        robot_xy = initial_state.data.qpos[:2]
        target = initial_state.info["target_pos"]
        dist = float(jp.linalg.norm(target - robot_xy))
        assert dist >= env._config.target_radius_min - 0.01
        assert dist <= env._config.target_radius_max + 0.01

    def test_initial_targets_reached(self, initial_state):
        assert int(initial_state.info["targets_reached"]) == 0

    def test_prev_target_dist_positive(self, initial_state):
        assert float(initial_state.info["prev_target_dist"]) > 0


class TestTargetStep:
    def test_step_returns_valid_state(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        obs_size = env._config.obs_history_size * env._single_obs_size
        assert next_state.obs.shape == (obs_size,)

    def test_zero_action_no_nan(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert not jp.any(jp.isnan(next_state.obs))
        assert not jp.isnan(next_state.reward)

    def test_multi_step_rollout(self, env, initial_state):
        state = initial_state
        step_fn = jax.jit(env.step)
        rng = jax.random.PRNGKey(1)
        for i in range(10):
            rng, act_rng = jax.random.split(rng)
            action = jax.random.uniform(act_rng, (env.action_size,), minval=-0.5, maxval=0.5)
            state = step_fn(state, action)
        assert not jp.any(jp.isnan(state.obs))

    def test_step_increments_counter(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert int(next_state.info["step"]) == 1


class TestTargetRewards:
    def test_metrics_has_targets_reached(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert "targets_reached" in next_state.metrics

    def test_metrics_has_all_reward_keys(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        expected_keys = {f"reward/{k}" for k in env._config.reward_config.scales.keys()}
        assert expected_keys.issubset(set(next_state.metrics.keys()))

    def test_penalty_scales_negative(self, env):
        scales = env._config.reward_config.scales
        for name in ["lin_vel_z", "ang_vel_xy", "orientation", "torques",
                      "action_rate", "termination", "feet_slip", "energy"]:
            assert scales[name] <= 0, f"{name} scale should be <= 0"

    def test_target_scales_positive(self, env):
        scales = env._config.reward_config.scales
        assert scales.target_distance > 0
        assert scales.target_heading > 0
        assert scales.target_reached > 0
        assert scales.target_velocity > 0


class TestTargetProperties:
    def test_action_size(self, env):
        assert env.action_size == 24

    def test_single_obs_size(self, env):
        # gyro(3) + gravity(3) + target_vec(2) + dist(1) + bearing(1) + joints(24) + last_act(24) = 58
        assert env._single_obs_size == 58


@pytest.fixture(scope="module")
def env_entity():
    """Target env with entity slots enabled."""
    config = default_config()
    config.episode_length = 100
    config.enable_entity_slots = True
    return TargetReaching(config=config)


@pytest.fixture(scope="module")
def entity_state(env_entity):
    return jax.jit(env_entity.reset)(jax.random.PRNGKey(0))


class TestTargetEntitySlots:
    def test_obs_shape_with_entities(self, env_entity, entity_state):
        proprio_size = env_entity._config.obs_history_size * env_entity._single_obs_size
        expected = proprio_size + 152  # 174 + 152 = 326
        assert entity_state.obs.shape == (expected,)

    def test_entity_portion_nonzero(self, env_entity, entity_state):
        proprio_size = env_entity._config.obs_history_size * env_entity._single_obs_size
        entity_part = entity_state.obs[proprio_size:]
        n_nonzero = jp.sum(jp.abs(entity_part) > 0.001)
        assert n_nonzero > 0, "Entity slots should be non-zero"

    def test_step_preserves_entity_shape(self, env_entity, entity_state):
        action = jp.zeros(env_entity.action_size)
        next_state = jax.jit(env_entity.step)(entity_state, action)
        assert next_state.obs.shape == entity_state.obs.shape
