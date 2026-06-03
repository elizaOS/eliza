"""Tests for the compositional environment (frozen walking + trainable upper body)."""

from pathlib import Path

import jax
import jax.numpy as jp
import numpy as np
import pytest

from eliza_robot.sim.mujoco.compositional_env import (
    NUM_LEG_JOINTS,
    NUM_UPPER_JOINTS,
    WALK_TOTAL_OBS_DIM,
    CompositionalEnv,
    default_config,
)

# NOTE: the standalone WaveEnv MJX training env was removed; waving is now
# handled by the composite skill (eliza_robot/rl/skills/composite_skill.py).
# Only the CompositionalEnv (frozen legs + trainable upper body) survives here.


# Skip all tests if v13 checkpoint doesn't exist
WALKING_CHECKPOINT = "checkpoints/mujoco_locomotion_v13_flat_feet"
requires_checkpoint = pytest.mark.skipif(
    not Path(WALKING_CHECKPOINT).exists(),
    reason=f"Walking checkpoint not found at {WALKING_CHECKPOINT}",
)


class _RewardProbeEnv(CompositionalEnv):
    def __init__(self) -> None:
        self._config = default_config()
        self.action_rate_args = None

    def cost_lin_vel_z(self, data):
        return jp.float32(0.0)

    def cost_ang_vel_xy(self, data):
        return jp.float32(0.0)

    def cost_orientation(self, data):
        return jp.float32(0.0)

    def cost_torques(self, data):
        return jp.float32(0.0)

    def cost_action_rate(self, act, last_act, last_last_act):
        self.action_rate_args = (act, last_act, last_last_act)
        return jp.float32(0.0)

    def cost_termination(self, done, step):
        return jp.float32(0.0)

    def cost_feet_slip(self, data):
        return jp.float32(0.0)

    def cost_feet_orientation(self, data):
        return jp.float32(0.0)

    def cost_energy(self, data):
        return jp.float32(0.0)


def test_reward_uses_current_and_two_previous_walking_actions() -> None:
    env = _RewardProbeEnv()
    current_walk = jp.arange(NUM_LEG_JOINTS, dtype=jp.float32) + 10.0
    last_walk = jp.arange(NUM_LEG_JOINTS, dtype=jp.float32) + 20.0
    two_steps_ago = jp.arange(NUM_LEG_JOINTS, dtype=jp.float32) + 30.0
    info = {
        "walk_last_act": last_walk,
        "walk_last_last_act": two_steps_ago,
        "last_upper_act": jp.zeros(NUM_UPPER_JOINTS),
        "step": jp.array(3, dtype=jp.int32),
    }

    env._get_reward(
        data=None,
        action=jp.zeros(NUM_UPPER_JOINTS),
        walk_action=current_walk,
        info=info,
        done=jp.float32(0.0),
    )

    assert env.action_rate_args is not None
    act, last_act, last_last_act = env.action_rate_args
    np.testing.assert_allclose(act, current_walk)
    np.testing.assert_allclose(last_act, last_walk)
    np.testing.assert_allclose(last_last_act, two_steps_ago)


@pytest.fixture(scope="module")
def comp_env():
    """Create a CompositionalEnv with the frozen walking policy."""
    config = default_config()
    config.episode_length = 50
    return CompositionalEnv(
        walking_checkpoint=WALKING_CHECKPOINT,
        config=config,
    )


@pytest.fixture(scope="module")
def comp_state(comp_env):
    rng = jax.random.PRNGKey(0)
    return jax.jit(comp_env.reset)(rng)


@requires_checkpoint
class TestCompositionalReset:
    def test_obs_shape(self, comp_env, comp_state):
        obs_size = comp_env._config.obs_history_size * comp_env._single_obs_size
        assert comp_state.obs.shape == (obs_size,)

    def test_action_size_is_upper_body(self, comp_env):
        assert comp_env.action_size == NUM_UPPER_JOINTS  # 12

    def test_reward_zero(self, comp_state):
        assert float(comp_state.reward) == 0.0

    def test_done_zero(self, comp_state):
        assert float(comp_state.done) == 0.0

    def test_walk_obs_history_initialized(self, comp_state):
        assert comp_state.info["walk_obs_history"].shape == (WALK_TOTAL_OBS_DIM,)
        np.testing.assert_allclose(
            comp_state.info["walk_obs_history"], 0.0, atol=1e-6
        )

    def test_walk_command_set(self, comp_state):
        cmd = comp_state.info["walk_command"]
        assert cmd.shape == (3,)
        # Default walk command [0.3, 0, 0]
        assert float(cmd[0]) == pytest.approx(0.3, abs=0.01)


@requires_checkpoint
class TestCompositionalStep:
    def test_step_returns_valid_state(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        obs_size = comp_env._config.obs_history_size * comp_env._single_obs_size
        assert next_state.obs.shape == (obs_size,)
        assert next_state.reward.shape == ()
        assert next_state.done.shape == ()

    def test_step_increments_counter(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        assert int(next_state.info["step"]) == 1

    def test_walk_obs_history_updated(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        # Walk obs history should no longer be all zeros after one step
        assert not jp.allclose(next_state.info["walk_obs_history"], 0.0)

    def test_walk_action_produced(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        # Walking policy should produce non-zero leg actions
        walk_act = next_state.info["walk_last_act"]
        assert walk_act.shape == (NUM_LEG_JOINTS,)

    def test_motor_targets_24dim(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        assert next_state.info["motor_targets"].shape == (24,)

    def test_multiple_steps_no_crash(self, comp_env, comp_state):
        """Run 10 steps to verify JIT stability."""
        step_fn = jax.jit(comp_env.step)
        state = comp_state
        for _ in range(10):
            action = jp.zeros(comp_env.action_size)
            state = step_fn(state, action)
        assert float(state.info["step"]) == 10

    def test_robot_stays_upright(self, comp_env, comp_state):
        """Run 20 steps with zero upper body action — robot should stay upright."""
        step_fn = jax.jit(comp_env.step)
        state = comp_state
        for _ in range(20):
            action = jp.zeros(comp_env.action_size)
            state = step_fn(state, action)
        torso_z = float(state.data.xpos[comp_env._torso_body_id, 2])
        assert torso_z > 0.15, f"Robot fell: torso_z={torso_z}"


@requires_checkpoint
class TestCompositionalRewardKeys:
    def test_stability_rewards_present(self, comp_env, comp_state):
        action = jp.zeros(comp_env.action_size)
        next_state = jax.jit(comp_env.step)(comp_state, action)
        expected_keys = [
            "reward/alive", "reward/orientation", "reward/termination",
            "reward/upper_action_rate",
        ]
        for key in expected_keys:
            assert key in next_state.metrics, f"Missing metric: {key}"
