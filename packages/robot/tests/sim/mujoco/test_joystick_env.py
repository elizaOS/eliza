"""Tests for the Joystick locomotion environment."""

import jax
import jax.numpy as jp
import numpy as np
import pytest

from eliza_robot.sim.mujoco.joystick import Joystick, default_config


@pytest.fixture(scope="module")
def env():
    """Create a Joystick env once (MJX model loading is expensive)."""
    config = default_config()
    config.episode_length = 100
    return Joystick(config=config)


@pytest.fixture(scope="module")
def initial_state(env):
    rng = jax.random.PRNGKey(0)
    return jax.jit(env.reset)(rng)


class TestJoystickReset:
    def test_obs_shape(self, env, initial_state):
        obs_size = env._config.obs_history_size * env._single_obs_size
        assert initial_state.obs.shape == (obs_size,)

    def test_reward_is_zero(self, initial_state):
        assert float(initial_state.reward) == 0.0

    def test_done_is_zero(self, initial_state):
        assert float(initial_state.done) == 0.0

    def test_command_shape(self, initial_state):
        assert initial_state.info["command"].shape == (3,)

    def test_initial_step_counter(self, initial_state):
        assert initial_state.info["step"] == 0

    def test_qpos_matches_stand_keyframe(self, env, initial_state):
        expected = env._init_q
        actual = initial_state.data.qpos
        np.testing.assert_allclose(actual, expected, atol=1e-5)


class TestJoystickStep:
    def test_step_returns_valid_state(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        obs_size = env._config.obs_history_size * env._single_obs_size
        assert next_state.obs.shape == (obs_size,)
        assert next_state.reward.shape == ()
        assert next_state.done.shape == ()

    def test_step_increments_counter(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert int(next_state.info["step"]) == 1

    def test_zero_action_reward_nonnegative(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert float(next_state.reward) >= 0.0

    def test_random_action_no_nan(self, env, initial_state):
        rng = jax.random.PRNGKey(42)
        action = jax.random.uniform(rng, (env.action_size,), minval=-1.0, maxval=1.0)
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
        assert int(state.info["step"]) == 10
        assert not jp.any(jp.isnan(state.obs))


class TestJoystickReward:
    def test_metrics_keys(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        expected_keys = {f"reward/{k}" for k in env._config.reward_config.scales.keys()}
        assert expected_keys.issubset(set(next_state.metrics.keys()))

    def test_penalty_scales_negative(self, env):
        scales = env._config.reward_config.scales
        for name in ["lin_vel_z", "ang_vel_xy", "orientation", "torques",
                      "action_rate", "termination", "feet_slip", "energy"]:
            assert scales[name] <= 0, f"{name} scale should be <= 0, got {scales[name]}"

    def test_positive_scales_positive(self, env):
        scales = env._config.reward_config.scales
        assert scales.tracking_lin_vel > 0
        assert scales.tracking_ang_vel > 0


class TestJoystickTermination:
    def test_standing_not_terminated(self, env, initial_state):
        action = jp.zeros(env.action_size)
        next_state = jax.jit(env.step)(initial_state, action)
        assert float(next_state.done) == 0.0


class TestJoystickCommand:
    def test_sample_command_shape(self, env):
        rng = jax.random.PRNGKey(99)
        cmd = env.sample_command(rng)
        assert cmd.shape == (3,)

    def test_sample_command_range(self, env):
        rng = jax.random.PRNGKey(99)
        cmds = jax.vmap(env.sample_command)(jax.random.split(rng, 100))
        nonzero = jp.any(cmds != 0, axis=1)
        if jp.any(nonzero):
            nonzero_cmds = cmds[nonzero]
            assert jp.all(nonzero_cmds[:, 0] >= env._config.lin_vel_x[0])
            assert jp.all(nonzero_cmds[:, 0] <= env._config.lin_vel_x[1])


class TestJoystickProperties:
    def test_action_size(self, env):
        assert env.action_size == 12  # 12 leg DOFs only

    def test_single_obs_size(self, env):
        assert env._single_obs_size == 45  # gyro(3)+gravity(3)+cmd(3)+leg_pos(12)+leg_vel(12)+last_act(12)


@pytest.fixture(scope="module")
def env_entity():
    """Joystick env with entity slots enabled."""
    config = default_config()
    config.episode_length = 100
    config.enable_entity_slots = True
    return Joystick(config=config)


@pytest.fixture(scope="module")
def entity_state(env_entity):
    return jax.jit(env_entity.reset)(jax.random.PRNGKey(0))


class TestJoystickEntitySlots:
    def test_obs_shape_with_entities(self, env_entity, entity_state):
        proprio_size = env_entity._config.obs_history_size * env_entity._single_obs_size
        expected = proprio_size + 152  # 135 + 152 = 287
        assert entity_state.obs.shape == (expected,)

    def test_entity_portion_nonzero(self, env_entity, entity_state):
        """Entity slots should contain real data from MJCF entity bodies."""
        proprio_size = env_entity._config.obs_history_size * env_entity._single_obs_size
        entity_part = entity_state.obs[proprio_size:]
        assert entity_part.shape == (152,)
        n_nonzero = jp.sum(jp.abs(entity_part) > 0.001)
        assert n_nonzero > 0, "Entity slots should be non-zero with entities in scene"

    def test_step_preserves_entity_shape(self, env_entity, entity_state):
        action = jp.zeros(env_entity.action_size)
        next_state = jax.jit(env_entity.step)(entity_state, action)
        assert next_state.obs.shape == entity_state.obs.shape

    def test_obs_history_slicing_correct(self, env_entity, entity_state):
        """After stepping, the proprio history should roll correctly."""
        step_fn = jax.jit(env_entity.step)
        action = jp.zeros(env_entity.action_size)
        state1 = step_fn(entity_state, action)
        state2 = step_fn(state1, action)
        # Verify no NaN in obs after multiple steps
        assert not jp.any(jp.isnan(state2.obs))
        # Entity portion should still be non-zero
        proprio_size = env_entity._config.obs_history_size * env_entity._single_obs_size
        entity_part = state2.obs[proprio_size:]
        n_nonzero = jp.sum(jp.abs(entity_part) > 0.001)
        assert n_nonzero > 0

    def test_multi_step_rollout_with_entities(self, env_entity, entity_state):
        """10-step rollout should work without NaN or shape errors."""
        state = entity_state
        step_fn = jax.jit(env_entity.step)
        rng = jax.random.PRNGKey(1)
        for i in range(10):
            rng, act_rng = jax.random.split(rng)
            action = jax.random.uniform(act_rng, (env_entity.action_size,), minval=-0.5, maxval=0.5)
            state = step_fn(state, action)
        assert not jp.any(jp.isnan(state.obs))
        assert state.obs.shape[0] == 287

    def test_entity_positions_randomized_per_episode(self, env_entity):
        """Different RNG seeds should produce different entity layouts."""
        reset_fn = jax.jit(env_entity.reset)
        s1 = reset_fn(jax.random.PRNGKey(0))
        s2 = reset_fn(jax.random.PRNGKey(42))
        # Entity positions stored in info should differ
        pos1 = s1.info["entity_positions"]
        pos2 = s2.info["entity_positions"]
        assert not jp.allclose(pos1, pos2, atol=1e-3), \
            "Entity positions should be randomized per episode"

    def test_entity_count_varies(self, env_entity):
        """Different seeds may produce different numbers of active entities."""
        reset_fn = jax.jit(env_entity.reset)
        counts = set()
        for seed in range(20):
            state = reset_fn(jax.random.PRNGKey(seed + 100))
            n_active = int(jp.sum(state.info["entity_mask"]))
            counts.add(n_active)
        # Should have at least 2 different entity counts across 20 seeds
        assert len(counts) >= 2, f"Entity count should vary, got {counts}"

    def test_entity_types_randomized(self, env_entity):
        """Entity types should not always be the same."""
        reset_fn = jax.jit(env_entity.reset)
        all_types = []
        for seed in range(10):
            state = reset_fn(jax.random.PRNGKey(seed + 200))
            mask = state.info["entity_mask"]
            types = state.info["entity_types"][mask]
            all_types.append(tuple(int(t) for t in types))
        # Should have variation in type configurations
        assert len(set(all_types)) >= 2, "Entity types should be randomized"
