"""Train AiNex locomotion policy using MuJoCo Playground + Brax PPO.

GPU-accelerated training using MJX for physics and JAX for RL.
Following the Playground training pattern for zero-shot sim-to-real.

Usage:
    python3 -m eliza_robot.sim.mujoco.train
    python3 -m eliza_robot.sim.mujoco.train --target
    python3 -m eliza_robot.sim.mujoco.train --getup
    python3 -m eliza_robot.sim.mujoco.train --num-timesteps 50000000
    python3 -m eliza_robot.sim.mujoco.train --no-domain-rand
    python3 -m eliza_robot.sim.mujoco.train --lr 1e-4
    python3 -m eliza_robot.sim.mujoco.train --resume-from checkpoints/mujoco_locomotion/final_params
"""

import argparse
import functools
import json
import time
from datetime import datetime
from pathlib import Path

import numpy as np

import jax

from eliza_robot.sim.mujoco.joystick import Joystick
from eliza_robot.sim.mujoco.joystick import default_config as joystick_default_config
from eliza_robot.sim.mujoco.target import TargetReaching
from eliza_robot.sim.mujoco.target import default_config as target_default_config
from eliza_robot.sim.mujoco.getup import GetUp
from eliza_robot.sim.mujoco.getup import default_config as getup_default_config
from eliza_robot.sim.mujoco.randomize import domain_randomize


VALID_TASKS = (
    "joystick",
    "target",
    "getup",
    "grasp",
    "carry",
    "place",
    "demo",
    "compositional",
)


def _build_env(task: str, enable_entity_slots: bool):
    """Construct the environment + label for ``task``.

    Heavier envs (grasp/carry/place/demo/compositional) are imported lazily
    because they pull in MJX-only collision sets that have no value for the
    common joystick/target/getup training paths.
    """
    if task == "joystick":
        cfg = joystick_default_config()
        cfg.enable_entity_slots = enable_entity_slots
        return Joystick(config=cfg), cfg, "AiNexJoystick"
    if task == "target":
        cfg = target_default_config()
        cfg.enable_entity_slots = enable_entity_slots
        return TargetReaching(config=cfg), cfg, "AiNexTargetReaching"
    if task == "getup":
        cfg = getup_default_config()
        cfg.enable_entity_slots = enable_entity_slots
        return GetUp(config=cfg), cfg, "AiNexGetUp"
    if task == "grasp":
        from eliza_robot.sim.mujoco.grasp import Grasp, default_config as grasp_default_config
        cfg = grasp_default_config()
        return Grasp(config=cfg), cfg, "AiNexGrasp"
    if task == "carry":
        from eliza_robot.sim.mujoco.carry import Carry, default_config as carry_default_config
        cfg = carry_default_config()
        return Carry(config=cfg), cfg, "AiNexCarry"
    if task == "place":
        from eliza_robot.sim.mujoco.place import Place, default_config as place_default_config
        cfg = place_default_config()
        return Place(config=cfg), cfg, "AiNexPlace"
    if task == "demo":
        from eliza_robot.sim.mujoco.demo_env import DemoEnv, default_config as demo_default_config
        cfg = demo_default_config()
        return DemoEnv(config=cfg), cfg, "AiNexDemo"
    if task == "compositional":
        from eliza_robot.sim.mujoco.compositional_env import (
            CompositionalEnv,
            default_config as compositional_default_config,
        )
        cfg = compositional_default_config()
        return CompositionalEnv(config=cfg), cfg, "AiNexCompositional"
    raise ValueError(f"Unknown task {task!r}; must be one of {VALID_TASKS}")


def make_ppo_config(
    num_timesteps: int = 100_000_000,
    num_evals: int = 10,
    learning_rate: float = 3e-4,
) -> dict:
    """PPO hyperparameters following Playground locomotion defaults."""
    return {
        "num_timesteps": num_timesteps,
        "num_evals": num_evals,
        "reward_scaling": 1.0,
        "normalize_observations": True,
        "action_repeat": 1,
        "unroll_length": 20,
        "num_minibatches": 32,
        "num_updates_per_batch": 4,
        "discounting": 0.97,
        "learning_rate": learning_rate,
        "entropy_cost": 1e-2,
        "num_envs": 4096,
        "batch_size": 256,
        "max_grad_norm": 1.0,
        "policy_hidden_layer_sizes": (512, 256, 128),   # Tapered (Playground default)
        "value_hidden_layer_sizes": (512, 256, 128),   # Tapered (Playground default)
    }


def train(
    task: str,
    num_timesteps: int = 100_000_000,
    num_envs: int = 4096,
    checkpoint_dir: str = "checkpoints/mujoco_locomotion",
    seed: int = 0,
    domain_rand: bool = True,
    enable_entity_slots: bool = False,
    num_evals: int = 10,
    learning_rate: float = 3e-4,
    resume_from: str | None = None,
):
    """Run GPU-accelerated PPO training for an AiNex task."""
    from brax.training.agents.ppo.train import train as ppo_train
    from brax.training.agents.ppo import networks as ppo_networks
    from brax.io import model as brax_model
    from mujoco_playground._src.wrapper import wrap_for_brax_training

    print("=" * 60)
    print("AiNex MuJoCo Playground Training")
    print("=" * 60)
    print(f"JAX backend: {jax.default_backend()}")
    print(f"JAX devices: {jax.devices()}")
    print()

    # Create environment
    env, env_config, env_name = _build_env(task, enable_entity_slots)
    getup = task == "getup"
    print(f"Environment: {env_name}")
    print(f"  Action size: {env.action_size}")
    print(f"  MuJoCo model: nq={env.mj_model.nq}, nv={env.mj_model.nv}, nu={env.mj_model.nu}")
    print(f"  Sim dt: {env_config.sim_dt}, Ctrl dt: {env_config.ctrl_dt}")
    print(f"  Episode length: {env_config.episode_length}")
    if enable_entity_slots:
        print(f"  Entity slots: ENABLED (152 extra obs dims, {len(env._entity_body_ids)} entities)")
    print()

    # PPO config
    ppo_cfg = make_ppo_config(num_timesteps, num_evals=num_evals, learning_rate=learning_rate)
    ppo_cfg["num_envs"] = num_envs
    if getup:
        # Shorter episodes (150 steps) need shorter unroll
        ppo_cfg["unroll_length"] = 5
    print(f"PPO Config:")
    for k, v in ppo_cfg.items():
        print(f"  {k}: {v}")
    print()

    # Domain randomization
    rand_fn = None
    if domain_rand:
        print("Domain randomization: ENABLED")
        rand_fn = domain_randomize
        print(f"  Randomizing: friction, mass, armature, damping, gains, qpos0")
    else:
        print("Domain randomization: DISABLED")
    print()

    # Checkpoint directory
    ckpt_dir = Path(checkpoint_dir)
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    # Compute and store obs_size for checkpoint compatibility
    obs_size = env._config.obs_history_size * env._single_obs_size
    if enable_entity_slots:
        from eliza_robot.perception.entity_slots.slot_config import TOTAL_ENTITY_DIMS
        obs_size += TOTAL_ENTITY_DIMS

    # Save config
    with open(ckpt_dir / "config.json", "w") as f:
        json.dump({
            "env": env_name,
            "ppo": ppo_cfg,
            "env_config": {k: str(v) for k, v in dict(env_config).items()},
            "domain_rand": domain_rand,
            "enable_entity_slots": enable_entity_slots,
            "obs_size": obs_size,
            "action_size": env.action_size,
            "seed": seed,
            "timestamp": datetime.now().isoformat(),
        }, f, indent=2, default=str)

    # Load params from a previous checkpoint for warm-starting
    restore_params = None
    if resume_from:
        print(f"Resuming from: {resume_from}")
        try:
            restore_params = brax_model.load_params(resume_from)
            print(f"  Loaded params successfully")
        except Exception:
            import pickle
            pkl_path = resume_from if resume_from.endswith(".pkl") else resume_from + ".pkl"
            print(f"  brax load failed, trying pickle: {pkl_path}")
            with open(pkl_path, "rb") as f:
                restore_params = pickle.load(f)
            print(f"  Loaded params from pickle")
        print()

    # Training metrics tracking
    train_metrics = []
    best_reward = float("-inf")
    best_params = None
    start_time = time.time()

    def _save_params_safe(params, path):
        """Save params leaf-by-leaf to avoid GPU OOM on jax.device_get."""
        try:
            cpu_params = jax.tree.map(lambda x: np.asarray(x), params)
            brax_model.save_params(str(path), cpu_params)
            return True
        except Exception as e:
            print(f"  WARNING: brax save failed ({e}), trying pickle...", flush=True)
            try:
                import pickle
                pkl_path = str(path) + ".pkl"
                with open(pkl_path, "wb") as f:
                    pickle.dump(jax.tree.map(lambda x: np.asarray(x), params), f)
                print(f"  Saved pickle: {pkl_path}", flush=True)
                return True
            except Exception as e2:
                print(f"  WARNING: pickle save also failed ({e2})", flush=True)
                return False

    def progress_callback(num_steps, metrics):
        nonlocal best_reward, best_params
        elapsed = time.time() - start_time
        reward = float(metrics.get("eval/episode_reward", 0))
        train_metrics.append({
            "steps": int(num_steps),
            "reward": reward,
            "elapsed": elapsed,
        })

        print(f"Step {num_steps:>10,} | "
              f"Reward: {reward:>8.2f} | "
              f"Time: {elapsed:>6.1f}s | "
              f"FPS: {num_steps/max(elapsed,1):.0f}",
              flush=True)

        if reward > best_reward:
            best_reward = reward
            print(f"  New best reward: {reward:.2f}", flush=True)

        # Save metrics incrementally
        with open(ckpt_dir / "metrics.json", "w") as f:
            json.dump(train_metrics, f, indent=2)

    def policy_params_callback(num_steps, make_policy, params):
        """Save intermediate checkpoints at each eval."""
        if num_steps == 0:
            return
        step_path = ckpt_dir / f"params_step{num_steps}"
        print(f"  Saving checkpoint at step {num_steps}...", flush=True)
        _save_params_safe(params, step_path)

    # Run PPO training
    print("Starting training...")
    print()

    # Let Brax PPO handle wrapping — it creates separate train/eval envs
    # with correct batch sizes for domain randomization
    make_inference_fn, params, _ = ppo_train(
        environment=env,
        num_timesteps=ppo_cfg["num_timesteps"],
        episode_length=env_config.episode_length,
        num_evals=ppo_cfg["num_evals"],
        reward_scaling=ppo_cfg["reward_scaling"],
        normalize_observations=ppo_cfg["normalize_observations"],
        action_repeat=ppo_cfg["action_repeat"],
        unroll_length=ppo_cfg["unroll_length"],
        num_minibatches=ppo_cfg["num_minibatches"],
        num_updates_per_batch=ppo_cfg["num_updates_per_batch"],
        discounting=ppo_cfg["discounting"],
        learning_rate=ppo_cfg["learning_rate"],
        entropy_cost=ppo_cfg["entropy_cost"],
        num_envs=ppo_cfg["num_envs"],
        batch_size=ppo_cfg["batch_size"],
        max_grad_norm=ppo_cfg["max_grad_norm"],
        wrap_env=True,
        wrap_env_fn=functools.partial(
            wrap_for_brax_training,
        ),
        randomization_fn=rand_fn,
        network_factory=lambda obs_size, action_size, preprocess_observations_fn: ppo_networks.make_ppo_networks(
            obs_size,
            action_size,
            preprocess_observations_fn=preprocess_observations_fn,
            policy_hidden_layer_sizes=ppo_cfg["policy_hidden_layer_sizes"],
            value_hidden_layer_sizes=ppo_cfg["value_hidden_layer_sizes"],
        ),
        seed=seed,
        progress_fn=progress_callback,
        policy_params_fn=policy_params_callback,
        restore_params=restore_params,
    )

    elapsed = time.time() - start_time
    print()
    print(f"Training complete in {elapsed:.1f}s")
    print(f"Best reward: {best_reward:.2f}")

    # Save final checkpoint leaf-by-leaf (avoids GPU OOM from jax.device_get)
    final_path = ckpt_dir / "final_params"
    if _save_params_safe(params, final_path):
        print(f"Saved params: {final_path}")
    else:
        print("WARNING: Could not save final params!")

    # Save training metrics
    with open(ckpt_dir / "metrics.json", "w") as f:
        json.dump(train_metrics, f, indent=2)

    # Save inference function for deployment
    inference_fn = make_inference_fn(params, deterministic=True)
    print(f"\nCheckpoints saved to {ckpt_dir}/")

    return inference_fn, params


def main():
    parser = argparse.ArgumentParser(description="Train AiNex policies with MuJoCo Playground")
    parser.add_argument("--task", type=str, required=True, choices=VALID_TASKS,
                        help="Task / environment to train. Required.")
    parser.add_argument("--num-timesteps", type=int, default=100_000_000,
                        help="Total training timesteps")
    parser.add_argument("--num-envs", type=int, default=4096,
                        help="Number of parallel environments")
    parser.add_argument("--checkpoint-dir", type=str, default=None,
                        help="Checkpoint output directory (defaults to checkpoints/mujoco_<task>)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--num-evals", type=int, default=10,
                        help="Number of eval checkpoints during training")
    parser.add_argument("--no-domain-rand", action="store_true",
                        help="Disable domain randomization")
    parser.add_argument("--enable-entity-slots", action="store_true",
                        help="Include entity perception slots in observations (152 extra dims)")
    parser.add_argument("--lr", type=float, default=3e-4,
                        help="Learning rate (default: 3e-4)")
    parser.add_argument("--resume-from", type=str, default=None,
                        help="Path to checkpoint params file for warm-starting training")
    args = parser.parse_args()

    ckpt_dir = args.checkpoint_dir or f"checkpoints/mujoco_{args.task}"

    train(
        task=args.task,
        num_timesteps=args.num_timesteps,
        num_envs=args.num_envs,
        checkpoint_dir=ckpt_dir,
        seed=args.seed,
        domain_rand=not args.no_domain_rand,
        enable_entity_slots=args.enable_entity_slots,
        num_evals=args.num_evals,
        learning_rate=args.lr,
        resume_from=args.resume_from,
    )


if __name__ == "__main__":
    main()
