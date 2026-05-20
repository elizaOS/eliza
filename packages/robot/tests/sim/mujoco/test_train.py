"""Tests for the training module."""

import pytest

from eliza_robot.sim.mujoco.train import make_ppo_config


class TestPPOConfig:
    def test_default_config(self):
        cfg = make_ppo_config()
        assert cfg["num_timesteps"] == 100_000_000
        assert cfg["num_envs"] == 4096
        assert cfg["learning_rate"] == 3e-4

    def test_custom_timesteps(self):
        cfg = make_ppo_config(num_timesteps=1000)
        assert cfg["num_timesteps"] == 1000

    def test_has_required_keys(self):
        cfg = make_ppo_config()
        required = [
            "num_timesteps", "num_evals", "reward_scaling",
            "normalize_observations", "action_repeat", "unroll_length",
            "num_minibatches", "num_updates_per_batch", "discounting",
            "learning_rate", "entropy_cost", "num_envs", "batch_size",
            "policy_hidden_layer_sizes", "value_hidden_layer_sizes",
        ]
        for key in required:
            assert key in cfg, f"Missing key: {key}"

    def test_network_sizes(self):
        cfg = make_ppo_config()
        assert len(cfg["policy_hidden_layer_sizes"]) == 4
        assert len(cfg["value_hidden_layer_sizes"]) == 5


class TestTrainImports:
    def test_joystick_import(self):
        from eliza_robot.sim.mujoco.joystick import Joystick, default_config
        env = Joystick(config=default_config())
        assert env.action_size == 12  # 12 leg DOFs only

    def test_target_import(self):
        from eliza_robot.sim.mujoco.target import TargetReaching, default_config
        env = TargetReaching(config=default_config())
        assert env.action_size == 24

    def test_train_function_signature(self):
        """Verify train() accepts the target parameter."""
        import inspect
        from eliza_robot.sim.mujoco.train import train
        sig = inspect.signature(train)
        assert "target" in sig.parameters
