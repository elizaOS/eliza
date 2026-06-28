"""Load trained Brax checkpoint and run policy inference.

Bridges between Brax PPO params and the deployment pipeline.

Usage:
    python3 -m eliza_robot.sim.mujoco.inference --checkpoint checkpoints/mujoco_locomotion
"""

import argparse
import json
from pathlib import Path
from typing import Callable

import jax
import jax.numpy as jp
import numpy as np

from eliza_robot.schema.canonical import adapt_state_vector
from eliza_robot.sim.mujoco.joystick import Joystick, default_config as joystick_default_config
from eliza_robot.sim.mujoco.target import TargetReaching, default_config as target_default_config
from eliza_robot.sim.mujoco.getup import GetUp, default_config as getup_default_config

# Type alias: (observation, rng) -> action
InferenceFn = Callable[[np.ndarray], np.ndarray]


def _load_checkpoint(checkpoint_dir: str):
    """Load checkpoint params, config, and reconstruct the JAX policy function.

    Returns:
        (policy_fn, config, env) where policy_fn is (obs_jax, rng) -> (action_jax, extras).
    """
    from brax.io import model as brax_model
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.training.acme import running_statistics

    ckpt_path = Path(checkpoint_dir)

    # Support both old (final_params) and new (orbax) checkpoint formats
    final_params_path = ckpt_path / "final_params"
    config_path = ckpt_path / "config.json"

    # If this is an orbax checkpoint dir (inside brax_ckpt/NNNN/), walk up
    # to find the config.json in the parent checkpoint root.
    if not config_path.exists():
        for parent in [ckpt_path.parent, ckpt_path.parent.parent]:
            if (parent / "config.json").exists():
                config_path = parent / "config.json"
                break

    pickle_path = ckpt_path / "final_params.pkl"

    if final_params_path.exists():
        params = brax_model.load_params(str(final_params_path))
    elif pickle_path.exists():
        # Pickle fallback (saved when brax format OOMd)
        import pickle
        with open(pickle_path, "rb") as f:
            params = pickle.load(f)
    elif (ckpt_path / "_METADATA").exists() or (ckpt_path / "_CHECKPOINT_METADATA").exists():
        # Orbax checkpoint — load via brax checkpoint utility
        from brax.training import checkpoint as brax_checkpoint
        params = brax_checkpoint.load(str(ckpt_path))
    else:
        raise FileNotFoundError(
            f"No final_params, .pkl, or orbax checkpoint found in {ckpt_path}"
        )

    with open(config_path) as f:
        config = json.load(f)

    ppo_cfg = config["ppo"]
    env_name = config.get("env", "AiNexJoystick")

    enable_entity_slots = config.get("enable_entity_slots", False)

    if "GetUp" in env_name:
        env_cfg = getup_default_config()
        env = GetUp(config=env_cfg)
    elif "Target" in env_name:
        env_cfg = target_default_config()
        env_cfg.enable_entity_slots = enable_entity_slots
        env = TargetReaching(config=env_cfg)
    else:
        env_cfg = joystick_default_config()
        env_cfg.enable_entity_slots = enable_entity_slots
        env = Joystick(config=env_cfg)

    # --- Resolve obs_size and action_size from checkpoint params --------
    # Legacy checkpoints may not store these in config.json and may have been
    # trained with a different env layout (e.g., 24-DOF action vs current 12).
    # We detect both from the stored network weights so the loader is robust
    # across env changes.

    # Normalizer running-stats mean has shape == (obs_size,).
    norm_params = params[0] if isinstance(params, tuple) else None
    ckpt_obs_size = getattr(getattr(norm_params, "mean", None), "shape", (None,))[0]

    # Policy network last layer kernel has shape (hidden, 2*action_size)
    # because Brax PPO outputs Gaussian (mean, log_std) per action dim.
    ckpt_action_size = None
    if isinstance(params, tuple) and len(params) > 1:
        policy_params = params[1]
        if isinstance(policy_params, dict) and "params" in policy_params:
            layers = policy_params["params"]
            last_layer = max(
                (k for k in layers if k.startswith("hidden_")),
                key=lambda k: int(k.split("_")[1]),
                default=None,
            )
            if last_layer and "kernel" in layers[last_layer]:
                out_dim = layers[last_layer]["kernel"].shape[-1]
                ckpt_action_size = out_dim // 2  # mean + log_std

    env_obs_size = env._config.obs_history_size * env._single_obs_size
    if enable_entity_slots:
        from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS
        env_obs_size += TOTAL_ENTITY_DIMS

    if ckpt_obs_size is not None:
        obs_size = ckpt_obs_size
    elif "obs_size" in config:
        obs_size = config["obs_size"]
    else:
        obs_size = env_obs_size

    action_size = env.action_size
    if ckpt_action_size is not None and ckpt_action_size != action_size:
        action_size = ckpt_action_size

    # --- Build PPO network with matching dimensions -----------------------
    normalize = ppo_cfg.get("normalize_observations", True)
    preprocess_fn = running_statistics.normalize if normalize else lambda x, y: x

    ppo_net = ppo_networks.make_ppo_networks(
        obs_size,
        action_size,
        preprocess_observations_fn=preprocess_fn,
        policy_hidden_layer_sizes=tuple(ppo_cfg["policy_hidden_layer_sizes"]),
        value_hidden_layer_sizes=tuple(ppo_cfg["value_hidden_layer_sizes"]),
    )

    make_policy = ppo_networks.make_inference_fn(ppo_net)
    policy_fn = make_policy(params, deterministic=True)

    # Store the resolved dimensions so callers (tests, inference wrappers)
    # know the exact sizes the policy expects / produces.
    config["obs_size"] = obs_size
    config["action_size"] = action_size

    return policy_fn, config, env


def load_policy_jax(checkpoint_dir: str):
    """Load trained policy returning the raw JAX function.

    Args:
        checkpoint_dir: Path to checkpoint directory.

    Returns:
        (policy_fn, config, env) where policy_fn is (obs_jax, rng) -> (action_jax, extras).
    """
    return _load_checkpoint(checkpoint_dir)


def load_policy(checkpoint_dir: str) -> tuple[InferenceFn, dict]:
    """Load trained policy from Brax checkpoint.

    Args:
        checkpoint_dir: Path to checkpoint directory containing
            final_params and config.json.

    Returns:
        (inference_fn, config) where inference_fn maps obs (numpy) -> action (numpy).
    """
    policy_fn, config, _ = _load_checkpoint(checkpoint_dir)
    inference_rng = jax.random.PRNGKey(0)

    @jax.jit
    def _jit_policy(obs: jax.Array) -> jax.Array:
        action, _ = policy_fn(obs, inference_rng)
        return action

    def inference_fn(obs: np.ndarray) -> np.ndarray:
        """Run policy inference: obs (numpy) -> action (numpy)."""
        obs_jax = jp.array(obs)
        if obs_jax.ndim == 1:
            obs_jax = obs_jax[None, :]
        action = _jit_policy(obs_jax)
        return np.array(action).squeeze(0)

    return inference_fn, config


def run_episode(
    env,
    policy_fn: InferenceFn,
    max_steps: int = 1000,
    seed: int = 0,
    obs_size: int | None = None,
) -> dict:
    """Run one episode in MJX and return metrics.

    Args:
        env: A Joystick or TargetReaching env instance.
        policy_fn: Maps obs array -> action array.
        max_steps: Maximum episode length.
        seed: RNG seed.

    Returns:
        Dict with total_reward, episode_length, and per-step data.
    """
    rng = jax.random.PRNGKey(seed)
    state = env.reset(rng)

    rewards = []
    for step in range(max_steps):
        obs_np = np.array(state.obs)
        if obs_size is not None and obs_np.shape[0] != obs_size:
            obs_np = np.array(adapt_state_vector(obs_np.tolist(), obs_size), dtype=np.float32)
        action_np = policy_fn(obs_np)
        if action_np.shape[0] != env.action_size:
            action_np = np.array(
                adapt_state_vector(action_np.tolist(), env.action_size),
                dtype=np.float32,
            )
        action = jp.array(action_np)
        state = env.step(state, action)
        rewards.append(float(state.reward))
        if float(state.done) > 0.5:
            break

    return {
        "total_reward": sum(rewards),
        "episode_length": len(rewards),
        "mean_reward": sum(rewards) / max(len(rewards), 1),
        "rewards": rewards,
    }


def main():
    parser = argparse.ArgumentParser(description="Run inference with trained Brax policy")
    parser.add_argument("--checkpoint", type=str, default="checkpoints/mujoco_locomotion")
    parser.add_argument("--episodes", type=int, default=3)
    parser.add_argument("--max-steps", type=int, default=1000)
    args = parser.parse_args()

    print(f"Loading policy from {args.checkpoint}...")
    jax_policy, config, env = _load_checkpoint(args.checkpoint)
    inference_rng = jax.random.PRNGKey(0)

    @jax.jit
    def _jit(obs):
        action, _ = jax_policy(obs, inference_rng)
        return action

    def policy_fn(obs):
        obs_jax = jp.array(obs)
        if obs_jax.ndim == 1:
            obs_jax = obs_jax[None, :]
        return np.array(_jit(obs_jax)).squeeze(0)

    env_name = config.get("env", "AiNexJoystick")
    print(f"Environment: {env_name}")

    for ep in range(args.episodes):
        result = run_episode(
            env,
            policy_fn,
            max_steps=args.max_steps,
            seed=ep,
            obs_size=config["obs_size"],
        )
        print(f"Episode {ep+1}: reward={result['total_reward']:.2f}, "
              f"length={result['episode_length']}, "
              f"mean_reward={result['mean_reward']:.4f}")


if __name__ == "__main__":
    main()
