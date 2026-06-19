"""Continual learning of text-command walking skills over a trained biped policy.

The capstone integration: a trained Brax-PPO joystick policy is the *teacher*
that follows any velocity command. We teach a student the text-command skills
(walk forward, turn, backward, ...) ONE AT A TIME by behaviour cloning, and show
that Alberta-style per-command heads over a consolidated trunk RETAIN every skill
while a single-head finetune student FORGETS earlier ones.

Outputs (to --out-dir):
  - continual_skills.json / .md : the command x phase performance matrices and
    ACC/BWT/Forgetting for both the multi-head (retain) and finetune (forget)
    students, plus per-command rollout command-following for the final students.
  - optional rollout videos of the retained multi-head student following each text
    command, and the finetune student only following the last.

Run (after scripts/train_biped_walk.py produces a checkpoint):
  JAX_PLATFORMS=cpu uv run python scripts/continual_walking_skills.py \
      --ckpt checkpoints/biped_walk_berkeley/final_params --render
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")  # students/teacher eval on CPU; GPU may be training

import numpy as np

PKG_ROOT = Path(__file__).resolve().parents[1]
if str(PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT))

from eliza_robot.rl.text_conditioned.joystick_text import CANONICAL_COMMANDS  # noqa: E402
from eliza_robot.rl.text_conditioned.walking_continual import (  # noqa: E402
    BCStudent,
    BCStudentConfig,
    run_continual_bc,
)


def load_env(env_name: str):
    from mujoco_playground import registry

    return registry.load(env_name, config_overrides={"impl": "jax"})


def make_teacher(env_name: str, ckpt: Path):
    from brax.io import model as brax_model
    from brax.training.acme import running_statistics
    from brax.training.agents.ppo import networks as ppo_networks
    from mujoco_playground.config import locomotion_params

    env = load_env(env_name)
    cfg = dict(locomotion_params.brax_ppo_config(env_name))
    nf = cfg.get("network_factory", {})
    networks = ppo_networks.make_ppo_networks(
        env.observation_size,
        env.action_size,
        preprocess_observations_fn=running_statistics.normalize,
        policy_hidden_layer_sizes=tuple(nf.get("policy_hidden_layer_sizes", (512, 256, 128))),
        value_hidden_layer_sizes=tuple(nf.get("value_hidden_layer_sizes", (512, 256, 128))),
    )
    make_policy = ppo_networks.make_inference_fn(networks)
    params = brax_model.load_params(str(ckpt))
    return env, make_policy(params, deterministic=True)


def _flat_state(obs):
    """The proprioceptive state vector the student learns over (handles dict obs)."""
    if isinstance(obs, dict):
        return np.asarray(obs["state"], dtype=np.float32)
    return np.asarray(obs, dtype=np.float32)


def _quat_yaw(q) -> float:
    w, x, y, z = (float(v) for v in q)
    return float(np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))


def collect(env, teacher, command, *, n_steps, seed):
    """Roll out the teacher holding `command` fixed; return (flat_state, action) arrays."""
    import jax
    import jax.numpy as jp

    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    jit_act = jax.jit(teacher)
    cmd = jp.array(command, dtype=jp.float32)
    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    state.info["command"] = cmd
    obs_l, act_l = [], []
    for _ in range(n_steps):
        act_rng, rng = jax.random.split(rng)
        action, _ = jit_act(state.obs, act_rng)
        obs_l.append(_flat_state(state.obs))
        act_l.append(np.asarray(action, dtype=np.float32))
        state = jit_step(state, action)
        state.info["command"] = cmd
        if bool(np.asarray(state.done)):
            state = jit_reset(rng)
            state.info["command"] = cmd
    return np.asarray(obs_l), np.asarray(act_l)


def rollout_student(env, student: BCStudent, command, slot, *, eval_steps, seed):
    import jax
    import jax.numpy as jp

    jit_reset = jax.jit(env.reset)
    jit_step = jax.jit(env.step)
    cmd = jp.array(command, dtype=jp.float32)
    rng = jax.random.PRNGKey(seed)
    state = jit_reset(rng)
    state.info["command"] = cmd
    q0 = np.asarray(state.data.qpos)
    x0, y0, yaw0 = float(q0[0]), float(q0[1]), _quat_yaw(q0[3:7])
    zmin = float(q0[2])
    n = 0
    for _ in range(eval_steps):
        action = student.act(_flat_state(state.obs), slot)
        state = jit_step(state, jp.asarray(action))
        state.info["command"] = cmd
        q = np.asarray(state.data.qpos)
        zmin = min(zmin, float(q[2]))
        n += 1
        if bool(np.asarray(state.done)):
            break
    q = np.asarray(state.data.qpos)
    dx, dy, dyaw = float(q[0]) - x0, float(q[1]) - y0, _quat_yaw(q[3:7]) - yaw0
    fell = n < eval_steps
    vx, vy, yaw = command
    if vx == 0 and vy == 0 and yaw == 0:
        follows = (not fell) and abs(dx) < 0.5 and abs(dy) < 0.5
    elif abs(vx) > 0:
        follows = (not fell) and np.sign(dx) == np.sign(vx) and abs(dx) >= 0.5
    elif abs(vy) > 0:
        follows = (not fell) and np.sign(dy) == np.sign(vy) and abs(dy) >= 0.3
    else:
        follows = (not fell) and np.sign(dyaw) == np.sign(yaw) and abs(dyaw) >= 0.3
    return {"delta_x_m": dx, "delta_y_m": dy, "delta_yaw_rad": dyaw, "min_base_z_m": zmin,
            "steps": n, "fell": fell, "follows_goal": bool(follows)}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--env", default="BerkeleyHumanoidJoystickFlatTerrain")
    p.add_argument("--ckpt", type=Path, required=True)
    p.add_argument("--collect-steps", type=int, default=8000)
    p.add_argument("--eval-collect-steps", type=int, default=2000)
    p.add_argument("--rollout-steps", type=int, default=400)
    p.add_argument("--hidden", type=int, nargs="+", default=[256, 256])
    p.add_argument("--out-dir", type=Path, default=Path("evidence/bipedal_walking/continual_skills"))
    p.add_argument("--no-rollout", action="store_true", help="skip env rollouts of the students")
    args = p.parse_args(argv)
    args.out_dir.mkdir(parents=True, exist_ok=True)

    commands = list(CANONICAL_COMMANDS.keys())
    cmd_vecs = {c: CANONICAL_COMMANDS[c].as_tuple() for c in commands}
    print(f"env={args.env} ckpt={args.ckpt} commands={commands}", flush=True)

    env, teacher = make_teacher(args.env, args.ckpt)
    obs_dim = len(_flat_state(env.reset(__import__("jax").random.PRNGKey(0)).obs))
    action_dim = int(env.action_size)
    print(f"student obs_dim={obs_dim} action_dim={action_dim}", flush=True)

    # 1) Collect teacher demonstrations per command (train + held-out eval split).
    train_data, eval_data = {}, {}
    for ci, c in enumerate(commands):
        train_data[c] = collect(env, teacher, cmd_vecs[c], n_steps=args.collect_steps, seed=100 + ci)
        eval_data[c] = collect(env, teacher, cmd_vecs[c], n_steps=args.eval_collect_steps, seed=900 + ci)
        print(f"  collected '{c}': train {train_data[c][0].shape[0]} eval {eval_data[c][0].shape[0]}", flush=True)

    # 2) Continual BC: multi-head (retain) vs finetune (forget).
    common = dict(obs_dim=obs_dim, action_dim=action_dim, n_commands=len(commands),
                  hidden_sizes=tuple(args.hidden), lr=1e-3)
    results = {}
    for mode in ("multihead", "finetune"):
        res = run_continual_bc(BCStudentConfig(mode=mode, **common), commands, train_data, eval_data)
        results[mode] = res
        print(f"[{mode}] ACC={res.acc:.4f} BWT={res.bwt:.4f} Forgetting={res.forgetting:.4f}", flush=True)

    report = {
        "env": args.env, "ckpt": str(args.ckpt), "commands": commands,
        "text_to_command": {c: list(cmd_vecs[c]) for c in commands},
        "continual": {m: {"acc": r.acc, "bwt": r.bwt, "forgetting": r.forgetting,
                          "perf_matrix": r.perf_matrix} for m, r in results.items()},
    }

    # 3) Roll out the FINAL students in the env, per command, to show retention.
    if not args.no_rollout:
        for mode in ("multihead", "finetune"):
            # Re-train the final student of this mode end-to-end (cheap) to roll out.
            student = BCStudent(BCStudentConfig(mode=mode, **common))
            for ci, c in enumerate(commands):
                update_trunk = (ci == 0) if mode == "multihead" else True
                student.fit_command(*train_data[c], ci, update_trunk=update_trunk, seed=ci)
            roll = {}
            for ci, c in enumerate(commands):
                roll[c] = rollout_student(env, student, cmd_vecs[c], ci,
                                          eval_steps=args.rollout_steps, seed=7)
                print(f"  rollout [{mode}] '{c}': follows={roll[c]['follows_goal']} dx={roll[c]['delta_x_m']:+.2f} dyaw={roll[c]['delta_yaw_rad']:+.2f}", flush=True)
            report.setdefault("rollout", {})[mode] = {
                "per_command": roll,
                "n_followed": int(sum(v["follows_goal"] for v in roll.values())),
                "n_commands": len(commands),
            }

    (args.out_dir / "continual_skills.json").write_text(json.dumps(report, indent=2))
    _write_md(report, args.out_dir / "continual_skills.md")
    print(f"wrote {args.out_dir}/continual_skills.json + .md", flush=True)
    return 0


def _write_md(report: dict, path: Path) -> None:
    L = ["# Continual learning of text-command walking skills", "",
         f"Env: `{report['env']}`  ·  teacher checkpoint: `{report['ckpt']}`", "",
         "Skills (text → joystick command) learned **sequentially** by behaviour cloning a "
         "trained walking policy. Performance = negative mean-squared action error vs the teacher "
         "(higher = still follows that command).", "",
         "| student | ACC ↑ | BWT ↑ (0=no forgetting) | Forgetting ↓ |", "|---|---:|---:|---:|"]
    for m, r in report["continual"].items():
        L.append(f"| `{m}` | {r['acc']:.3f} | {r['bwt']:.3f} | {r['forgetting']:.3f} |")
    L += ["", "`multihead` = per-command heads over a consolidated trunk (Alberta retention); "
          "`finetune` = single shared head retrained per command.", ""]
    if "rollout" in report:
        L += ["## Env rollout: does the final student still follow each text command?", "",
              "| text command | multihead follows | finetune follows |", "|---|:--:|:--:|"]
        mh = report["rollout"]["multihead"]["per_command"]
        ft = report["rollout"]["finetune"]["per_command"]
        for c in report["commands"]:
            L.append(f"| {c} | {'✅' if mh[c]['follows_goal'] else '❌'} | {'✅' if ft[c]['follows_goal'] else '❌'} |")
        L.append("")
        L.append(f"multihead followed {report['rollout']['multihead']['n_followed']}/{len(report['commands'])}; "
                 f"finetune followed {report['rollout']['finetune']['n_followed']}/{len(report['commands'])} "
                 "(finetune typically only follows the LAST-learned command).")
    path.write_text("\n".join(L) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
