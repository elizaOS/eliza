"""Text-conditioned trainer for robot curricula.

Three regimes:
  - default    : Alberta streaming continual learning on the profile-driven
                 MuJoCo env. This is the production default for continual
                 task sequences and writes `regime="alberta_streaming"`.
  - `--smoke`  : CPU-friendly stable-baselines3 PPO on the profile-driven
                 MuJoCo text-conditioned env (uses python-mujoco, not MJX).
                 Default 30k env steps, runs in ~3-5 minutes on a laptop.
                 Saves checkpoint to `checkpoints/text_conditioned_smoke/`.

  - `--full`   : legacy ASIMOV-1 MJX-Brax PPO baseline job package. Use this
                 for comparison evidence only; Alberta is the default
                 production continual-learning path.

The checkpoint format is unified at the manifest/policy wrapper boundary:
Alberta runs write `alberta_policy.npz`, smoke SB3 runs write `policy.zip`,
ASIMOV full MJX/Brax runs write `policy_brax.pkl`, and all write `manifest.json` for
`eliza_robot.rl.text_conditioned.policy`.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from eliza_robot.curriculum.loader import load_curriculum
from eliza_robot.profiles.schema import load_profile
from eliza_robot.rl.text_conditioned.profile_env import (
    ProfileEnvConfig,
    make_text_conditioned_env,
)
from eliza_robot.sim.mujoco.asimov_training import (
    asimov_full_training_job_spec,
)

PKG_ROOT = Path(__file__).resolve().parents[2].parent
DEFAULT_ALBERTA_OUT = PKG_ROOT / "checkpoints" / "alberta_text_conditioned"
DEFAULT_SMOKE_OUT = PKG_ROOT / "checkpoints" / "text_conditioned_smoke"
DEFAULT_DRY_RUN_OUT = PKG_ROOT / "checkpoints" / "text_conditioned_dry_run"
DEFAULT_FULL_OUT = PKG_ROOT / "checkpoints" / "asimov_1_brax_mjx_baseline"


def _train_smoke(
    out_dir: Path,
    profile_id: str,
    total_steps: int,
    *,
    seed: int = 0,
    tasks: list[str],
    pca_dim: int,
    domain_rand: bool,
) -> dict:
    """Stable-baselines3 PPO smoke run on the profile-driven MuJoCo env."""
    from stable_baselines3 import PPO
    from stable_baselines3.common.monitor import Monitor
    from stable_baselines3.common.vec_env import DummyVecEnv

    out_dir.mkdir(parents=True, exist_ok=True)
    profile = load_profile(profile_id)
    curriculum = load_curriculum()

    # Stick to a small task subset for the smoke so the policy can
    # actually start producing meaningful joint targets in minutes.
    active_tasks = tuple(tasks or ["stand_up", "walk_forward", "turn_left", "turn_right"])
    cfg = ProfileEnvConfig(
        tier_subset=(1,),
        include_tasks=active_tasks,
        exclude_tasks=(),
        pca_dim=pca_dim,
        episode_steps=200,
        domain_rand=domain_rand,
    )

    def _make():
        env = make_text_conditioned_env(profile_id, config=cfg)
        return Monitor(env)

    vec_env = DummyVecEnv([_make])

    model = PPO(
        "MlpPolicy",
        vec_env,
        n_steps=256,
        batch_size=64,
        n_epochs=4,
        learning_rate=3e-4,
        gamma=0.97,
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=0.005,
        vf_coef=0.5,
        policy_kwargs=dict(net_arch=dict(pi=[128, 128], vf=[128, 128])),
        seed=seed,
        device="cpu",
        verbose=1,
    )
    print(
        f"[smoke] {profile_id} PPO over {len(cfg.include_tasks)} tasks "
        f"(obs={vec_env.observation_space.shape}, act={vec_env.action_space.shape}), "
        f"target={total_steps} env steps"
    )
    t0 = time.time()
    model.learn(total_timesteps=total_steps, progress_bar=False)
    wall_s = time.time() - t0
    actual_steps = int(model.num_timesteps)
    ckpt_path = out_dir / "policy.zip"
    model.save(str(ckpt_path))
    manifest = {
        "regime": "smoke_sb3_ppo",
        "profile_id": profile_id,
        "profile_version": profile.version,
        "curriculum_version": curriculum.version,
        "pca_dim": cfg.pca_dim,
        "active_tasks": list(cfg.include_tasks),
        "obs_dim": int(vec_env.observation_space.shape[0]),
        "action_dim": int(vec_env.action_space.shape[0]),
        "output_dim": len(profile.kinematics.joints),
        "proprio_dim": int(vec_env.observation_space.shape[0]) - cfg.pca_dim,
        "text_dim": cfg.pca_dim,
        "requested_total_steps": int(total_steps),
        "total_steps": actual_steps,
        "domain_rand": bool(domain_rand),
        "wall_clock_s": round(wall_s, 1),
        "seed": seed,
        "ckpt": str(ckpt_path.name),
        "encoder_model": "sentence-transformers/all-MiniLM-L6-v2",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(
        f"[smoke] saved {ckpt_path.name} + manifest.json — "
        f"{actual_steps} steps in {wall_s:.1f}s"
    )
    return manifest


def _write_manifest_dry_run(out_dir: Path, profile_id: str, seed: int = 0) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    curriculum = load_curriculum()
    env = make_text_conditioned_env(
        profile_id,
        config=ProfileEnvConfig(
            include_tasks=("walk_forward",),
            exclude_tasks=(),
            pca_dim=32,
            episode_steps=4,
        ),
    )
    obs, _ = env.reset(seed=seed)
    step = env.step(np.zeros(env.action_space.shape, dtype=np.float32))
    manifest = {
        "regime": "dry_run",
        "profile_id": profile_id,
        "profile_version": env.profile.version,
        "curriculum_version": curriculum.version,
        "pca_dim": 32,
        "active_tasks": [task.id for task in env.active_tasks],
        "obs_dim": int(env.observation_space.shape[0]),
        "proprio_dim": int(env.observation_space.shape[0]) - 32,
        "text_dim": 32,
        "action_dim": int(env.action_space.shape[0]),
        "output_dim": len(env.profile.kinematics.joints),
        "default_backend": "alberta",
        "reset_obs_shape": list(obs.shape),
        "step_reward": float(step[1]),
        "step_terminated": bool(step[2]),
        "dry_run": True,
        "seed": int(seed),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def _train_alberta(
    out_dir: Path,
    profile_id: str,
    *,
    total_steps: int,
    seed: int,
    tasks: list[str],
    pca_dim: int,
    episode_steps: int,
    eval_episodes: int,
    domain_rand: bool,
) -> dict:
    from eliza_robot.rl.alberta.train_robot import (
        steps_per_task_from_total,
        train_robot,
    )

    steps_per_task = steps_per_task_from_total(total_steps, len(tasks))

    return train_robot(
        profile_id,
        tasks,
        steps_per_task,
        out_dir,
        pca_dim=pca_dim,
        episode_steps=episode_steps,
        eval_episodes=eval_episodes,
        seed=seed,
        requested_total_steps=total_steps,
        domain_rand=domain_rand,
    )


def _write_full_training_job(
    out_dir: Path,
    profile_id: str,
    *,
    total_steps: int,
    num_envs: int,
    num_evals: int,
    seed: int,
    learning_rate: float,
    domain_rand: bool,
) -> dict:
    if profile_id != "asimov-1":
        raise ValueError("full training job export currently supports asimov-1")
    out_dir.mkdir(parents=True, exist_ok=True)
    curriculum = load_curriculum()
    job = asimov_full_training_job_spec(
        curriculum_version=curriculum.version,
        output_dir=str(out_dir),
        total_steps=total_steps,
        num_envs=num_envs,
        num_evals=num_evals,
        seed=seed,
        learning_rate=learning_rate,
        domain_rand=domain_rand,
    )
    (out_dir / "training_job.json").write_text(json.dumps(job, indent=2) + "\n")
    (out_dir / "manifest.template.json").write_text(json.dumps(job["manifest_template"], indent=2) + "\n")
    run_script = out_dir / "run_full_training.sh"
    package_root = Path(__file__).resolve().parents[3]
    critic_obs_dim = int(job["manifest_template"]["critic_obs_dim"])
    run_script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "MODE=\"${1:---check}\"\n"
        "JOB_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
        f"BRAX_MJX_STEPS=\"${{BRAX_MJX_STEPS:-{total_steps}}}\"\n"
        "BRAX_MJX_NUM_ENVS=\"${BRAX_MJX_NUM_ENVS:-}\"\n"
        "BRAX_MJX_NUM_EVALS=\"${BRAX_MJX_NUM_EVALS:-}\"\n"
        "BRAX_MJX_EVAL_EPISODES=\"${BRAX_MJX_EVAL_EPISODES:-5}\"\n"
        "BRAX_MJX_EVAL_MAX_STEPS=\"${BRAX_MJX_EVAL_MAX_STEPS:-200}\"\n"
        "BRAX_MJX_SKIP_ROLLOUT_EVAL=\"${BRAX_MJX_SKIP_ROLLOUT_EVAL:-0}\"\n"
        f"PACKAGE_ROOT=\"${{ELIZA_ROBOT_PACKAGE_ROOT:-{package_root}}}\"\n"
        "cd \"$PACKAGE_ROOT\"\n"
        "uv run python scripts/validate_asimov1_full_training_job.py --job-dir \"$JOB_DIR\"\n"
        "if [[ \"$MODE\" == \"--check\" || \"$MODE\" == \"check\" ]]; then\n"
        "  uv run python scripts/run_asimov1_full_training.py --job-dir \"$JOB_DIR\" --check-only --require-ready\n"
        "  echo 'ASIMOV-1 full-training package is valid and ready.'\n"
        "elif [[ \"$MODE\" == \"--train\" || \"$MODE\" == \"train\" ]]; then\n"
        f"  if [[ \"$BRAX_MJX_STEPS\" != \"{total_steps}\" ]]; then\n"
        "    cp -n \"$JOB_DIR/training_job.json\" \"$JOB_DIR/training_job.full_contract.json\"\n"
        "    uv run python - \"$JOB_DIR/training_job.json\" \"$BRAX_MJX_STEPS\" \"$BRAX_MJX_NUM_ENVS\" \"$BRAX_MJX_NUM_EVALS\" <<'PY'\n"
        "import json\n"
        "import sys\n"
        "from pathlib import Path\n"
        "path = Path(sys.argv[1])\n"
        "steps = int(sys.argv[2])\n"
        "num_envs = int(sys.argv[3]) if sys.argv[3] else None\n"
        "num_evals = int(sys.argv[4]) if sys.argv[4] else None\n"
        "job = json.loads(path.read_text(encoding='utf-8'))\n"
        "old_steps = int(job.get('ppo', {}).get('num_timesteps', 0) or 0)\n"
        "ppo = job.setdefault('ppo', {})\n"
        "ppo['num_timesteps'] = steps\n"
        "if num_envs is not None:\n"
        "    ppo['num_envs'] = num_envs\n"
        "if num_evals is not None:\n"
        "    ppo['num_evals'] = num_evals\n"
        "job.setdefault('manifest_template', {})['total_steps'] = steps\n"
        "commands = job.get('validation_commands')\n"
        "if isinstance(commands, list):\n"
        "    job['validation_commands'] = [\n"
        "        str(command).replace(f'--min-steps {old_steps}', f'--min-steps {steps}')\n"
        "        for command in commands\n"
        "    ]\n"
        "path.write_text(json.dumps(job, indent=2) + '\\n', encoding='utf-8')\n"
        "PY\n"
        "  fi\n"
        "  if [[ \"${BRAX_MJX_REUSE_EXISTING:-0}\" == \"1\" && -s \"$JOB_DIR/policy_brax.pkl\" ]]; then\n"
        "    uv run python - \"$JOB_DIR\" <<'PY'\n"
        "import json\n"
        "import sys\n"
        "from pathlib import Path\n"
        "from scripts.run_asimov1_full_training import (\n"
        "    build_training_run_report,\n"
        "    run_post_training_validation,\n"
        ")\n"
        "job_dir = Path(sys.argv[1])\n"
        "post = run_post_training_validation(job_dir)\n"
        "report = build_training_run_report(\n"
        "    job_dir,\n"
        "    training={\"ok\": True, \"job_dir\": str(job_dir), \"policy\": str(job_dir / \"policy_brax.pkl\"), \"reused_existing\": True},\n"
        "    post_training_validation=post,\n"
        ")\n"
        "(job_dir / \"full_training_run.json\").write_text(json.dumps(report, indent=2) + \"\\n\", encoding=\"utf-8\")\n"
        "print(json.dumps(report, indent=2))\n"
        "raise SystemExit(0 if report[\"ok\"] else 2)\n"
        "PY\n"
        "  else\n"
        "    uv run python scripts/run_asimov1_full_training.py --job-dir \"$JOB_DIR\" --out \"$JOB_DIR/full_training_run.json\"\n"
        "  fi\n"
        "  export JAX_PLATFORMS=cpu\n"
        "  export JAX_PLATFORM_NAME=cpu\n"
        "  unset CUDA_VISIBLE_DEVICES\n"
        "  uv run python scripts/validate_asimov1_full_training_run.py \"$JOB_DIR/full_training_run.json\" --job-dir \"$JOB_DIR\"\n"
        f"  uv run python scripts/verify_brax_text_policy.py --ckpt \"$JOB_DIR\" --profile asimov-1 --require-proprio-dim 45 --require-action-dim 12 --require-output-dim 25 --require-critic-obs-dim {critic_obs_dim} --require-policy-obs-key state --require-value-obs-key privileged_state\n"
        f"  # Production contract default: --min-steps {total_steps}\n"
        "  uv run python scripts/validate_asimov1_production_checkpoint.py \"$JOB_DIR\" --min-steps \"$BRAX_MJX_STEPS\" --require-inference-check\n"
        "  if [[ \"$BRAX_MJX_SKIP_ROLLOUT_EVAL\" != \"1\" ]]; then\n"
        "    uv run python scripts/eval_text_policy.py --profile asimov-1 --backend mjx --ckpt \"$JOB_DIR\" --tasks stand_up walk_forward walk_backward sidestep_left sidestep_right turn_left turn_right --episodes \"$BRAX_MJX_EVAL_EPISODES\" --max-steps \"$BRAX_MJX_EVAL_MAX_STEPS\"\n"
        "    uv run python scripts/sim_validation_gate.py --profile asimov-1 --checkpoint \"$JOB_DIR\" --require-asimov-model-provenance\n"
        "  fi\n"
        "else\n"
        "  echo \"usage: $0 [--check|--train]\" >&2\n"
        "  exit 64\n"
        "fi\n"
    )
    run_script.chmod(0o755)
    (out_dir / "README.full_training.md").write_text(
        "# ASIMOV-1 Full Training Job\n\n"
        "Reproducible ASIMOV-1 text-conditioned PPO/MJX baseline package.\n\n"
        "Run `./run_full_training.sh --check` on a development machine to validate "
        "the package and installed training dependencies. Run "
        "`./run_full_training.sh --train` on a GPU training host to start Brax/MJX "
        "PPO baseline training and then execute the policy verifier, production "
        "checkpoint validator, ASIMOV MJX evaluator, and simulation validation "
        "gate. For the default continual-learning path, use this module without "
        "`--full` or run `scripts/train_text_conditioned.py --backend alberta`.\n"
    )
    return job


def _resolve_out_dir(
    out: Path | None,
    *,
    dry_run: bool,
    smoke: bool,
    full: bool,
) -> Path:
    if out is not None:
        return out
    if dry_run:
        return DEFAULT_DRY_RUN_OUT
    if smoke:
        return DEFAULT_SMOKE_OUT
    if full:
        return DEFAULT_FULL_OUT
    return DEFAULT_ALBERTA_OUT


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=(
            "output directory for the checkpoint + manifest. Defaults by mode: "
            "Alberta -> checkpoints/alberta_text_conditioned, "
            "smoke -> checkpoints/text_conditioned_smoke, "
            "full -> checkpoints/asimov_1_brax_mjx_baseline, "
            "dry-run -> checkpoints/text_conditioned_dry_run."
        ),
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=30_000,
        help=(
            "total env-step budget for training; the default Alberta path "
            "splits it evenly across tasks"
        ),
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--profile", default="hiwonder-ainex")
    parser.add_argument("--tasks", nargs="+", default=["stand_up", "walk_forward"])
    parser.add_argument("--pca-dim", type=int, default=32)
    parser.add_argument("--episode-steps", type=int, default=200)
    parser.add_argument("--eval-episodes", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--num-envs", type=int, default=8192)
    parser.add_argument("--num-evals", type=int, default=10)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--no-domain-rand", action="store_true")
    parser.add_argument(
        "--smoke",
        action="store_true",
        default=False,
        help="run the CPU SB3 smoke trainer instead of the default Alberta trainer.",
    )
    args = parser.parse_args(argv)
    out_dir = _resolve_out_dir(
        args.out,
        dry_run=args.dry_run,
        smoke=args.smoke,
        full=args.full,
    )
    if args.dry_run:
        _write_manifest_dry_run(out_dir, args.profile, args.seed)
        return 0
    if args.full:
        _write_full_training_job(
            out_dir,
            args.profile,
            total_steps=args.steps,
            num_envs=args.num_envs,
            num_evals=args.num_evals,
            seed=args.seed,
            learning_rate=args.learning_rate,
            domain_rand=not args.no_domain_rand,
        )
        return 0
    if args.smoke:
        _train_smoke(
            out_dir,
            args.profile,
            args.steps,
            seed=args.seed,
            tasks=args.tasks,
            pca_dim=args.pca_dim,
            domain_rand=not args.no_domain_rand,
        )
        return 0
    _train_alberta(
        out_dir,
        args.profile,
        total_steps=args.steps,
        seed=args.seed,
        tasks=args.tasks,
        pca_dim=args.pca_dim,
        episode_steps=args.episode_steps,
        eval_episodes=args.eval_episodes,
        domain_rand=not args.no_domain_rand,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
