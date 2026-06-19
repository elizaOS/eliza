"""Build a native MuJoCo dataset in the canonical 7-D bridge action space."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import jax
import numpy as np

from eliza_robot.sim.mujoco.bridge_command import (
    command_to_bridge_action,
    state_to_bridge_observation,
    state_to_bridge_state_vector,
)
from eliza_robot.sim.mujoco.inference import load_policy_jax
from eliza_robot.schema.canonical import AINEX_SCHEMA_VERSION


def build_bridge_command_dataset(
    checkpoint_dir: str,
    output_jsonl: Path,
    episodes: int = 3,
    steps_per_episode: int = 100,
) -> int:
    policy_fn, config, env = load_policy_jax(checkpoint_dir)
    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    total = 0

    with output_jsonl.open("w", encoding="utf-8") as outfile:
        for episode in range(episodes):
            rng = jax.random.PRNGKey(episode)
            state = jax.jit(env.reset)(rng)
            for step in range(steps_per_episode):
                act_rng, rng = jax.random.split(rng)
                obs = state.obs
                if obs.shape[0] != config["obs_size"]:
                    from eliza_robot.schema.canonical import adapt_state_vector

                    obs = jax.numpy.array(
                        adapt_state_vector(np.asarray(obs).tolist(), config["obs_size"])
                    )

                action, _ = policy_fn(obs, act_rng)
                if action.shape[0] != env.action_size:
                    from eliza_robot.schema.canonical import adapt_state_vector

                    action = jax.numpy.array(
                        adapt_state_vector(np.asarray(action).tolist(), env.action_size)
                    )
                state = env.step(state, action)

                command = np.asarray(state.info["command"], dtype=np.float32)
                bridge_obs = state_to_bridge_observation(env, state)
                bridge_state = state_to_bridge_state_vector(env, state)
                bridge_action = command_to_bridge_action(command, env._config.ctrl_dt)
                record = {
                    "schema_version": AINEX_SCHEMA_VERSION,
                    "source": "mujoco_native",
                    "episode": episode,
                    "step": step,
                    "prompt": bridge_obs.language_instruction,
                    "state": bridge_state.tolist(),
                    "action": bridge_action,
                    "command": command.tolist(),
                }
                outfile.write(json.dumps(record) + "\n")
                total += 1
                if float(state.done) > 0.5:
                    break

    return total


def main() -> None:
    parser = argparse.ArgumentParser(description="Build MuJoCo-native bridge command dataset")
    parser.add_argument("--checkpoint", type=str, default="checkpoints/mujoco_locomotion")
    parser.add_argument("--output-jsonl", type=str, required=True)
    parser.add_argument("--episodes", type=int, default=3)
    parser.add_argument("--steps-per-episode", type=int, default=100)
    args = parser.parse_args()

    total = build_bridge_command_dataset(
        checkpoint_dir=args.checkpoint,
        output_jsonl=Path(args.output_jsonl),
        episodes=args.episodes,
        steps_per_episode=args.steps_per_episode,
    )
    print(f"Wrote {total} records to {args.output_jsonl}")


if __name__ == "__main__":
    main()
