"""Tests for the inference module."""

import json
import pytest
from pathlib import Path

from eliza_robot.sim.mujoco.inference import load_policy, run_episode


CKPT_DIR = Path("checkpoints/mujoco_locomotion")


def _checkpoint_exists() -> bool:
    return (CKPT_DIR / "final_params").exists() and (CKPT_DIR / "config.json").exists()


requires_checkpoint = pytest.mark.skipif(
    not _checkpoint_exists(),
    reason=f"Checkpoint not found at {CKPT_DIR}",
)


class TestLoadPolicy:
    def test_missing_checkpoint_raises(self):
        with pytest.raises(Exception):
            load_policy("/nonexistent/path")

    @requires_checkpoint
    def test_loads_successfully(self):
        inference_fn, config = load_policy(str(CKPT_DIR))
        assert callable(inference_fn)
        assert "env" in config
        assert "ppo" in config

    @requires_checkpoint
    def test_config_has_ppo_keys(self):
        _, config = load_policy(str(CKPT_DIR))
        ppo = config["ppo"]
        assert "policy_hidden_layer_sizes" in ppo
        assert "value_hidden_layer_sizes" in ppo
        assert "num_timesteps" in ppo

    @requires_checkpoint
    def test_inference_fn_returns_correct_shape(self):
        import numpy as np
        inference_fn, config = load_policy(str(CKPT_DIR))
        # obs_size is always resolved by _load_checkpoint (from config,
        # checkpoint normalizer params, or current env).
        obs_size = config["obs_size"]
        dummy_obs = np.zeros(obs_size, dtype=np.float32)
        action = inference_fn(dummy_obs)
        assert action.ndim == 1
        assert action.shape[0] > 0

    @requires_checkpoint
    def test_inference_fn_deterministic(self):
        import numpy as np
        inference_fn, config = load_policy(str(CKPT_DIR))
        obs_size = config["obs_size"]
        dummy_obs = np.zeros(obs_size, dtype=np.float32)
        a1 = inference_fn(dummy_obs)
        a2 = inference_fn(dummy_obs)
        np.testing.assert_array_equal(a1, a2)

    @requires_checkpoint
    def test_obs_size_resolved_in_config(self):
        """obs_size is always present in config after loading."""
        _, config = load_policy(str(CKPT_DIR))
        assert "obs_size" in config
        assert isinstance(config["obs_size"], int)
        assert config["obs_size"] > 0
