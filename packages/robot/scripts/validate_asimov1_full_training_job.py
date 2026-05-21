#!/usr/bin/env python3
"""Validate an ASIMOV-1 full PPO/MJX training job package."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.rl.text_conditioned.train import _write_full_training_job  # noqa: E402


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def validate_full_training_job(job_dir: Path, *, create: bool = False) -> dict:
    if create:
        _write_full_training_job(
            job_dir,
            "asimov-1",
            total_steps=150_000_000,
            num_envs=8192,
            num_evals=10,
            seed=0,
            learning_rate=3e-4,
            domain_rand=True,
        )
    job = _load(job_dir / "training_job.json")
    manifest = _load(job_dir / "manifest.template.json")
    import mujoco

    model = mujoco.MjModel.from_xml_path(str(job.get("mjcf_xml"))) if job.get("mjcf_xml") else None
    commands = job.get("validation_commands", [])
    run_script_text = (
        (job_dir / "run_full_training.sh").read_text(encoding="utf-8")
        if (job_dir / "run_full_training.sh").is_file()
        else ""
    )
    expected = set(job.get("expected_artifacts", []))
    layout_dim = sum(int(item["dim"]) for item in job.get("actor_observation_layout", []))
    checks = {
        "training_job": (job_dir / "training_job.json").is_file(),
        "manifest_template": (job_dir / "manifest.template.json").is_file(),
        "run_script": (job_dir / "run_full_training.sh").is_file(),
        "run_script_executable": (job_dir / "run_full_training.sh").is_file()
        and bool((job_dir / "run_full_training.sh").stat().st_mode & 0o111),
        "run_script_train_mode": "--train" in run_script_text
        and "verify_brax_text_policy.py" in run_script_text
        and "eval_text_policy.py --profile asimov-1 --backend mjx" in run_script_text
        and "sim_validation_gate.py --profile asimov-1" in run_script_text,
        "readme": (job_dir / "README.full_training.md").is_file(),
        "profile_id": job.get("profile_id") == "asimov-1",
        "job_name": job.get("job") == "asimov-1-text-conditioned-mjx-brax",
        "mjcf_compiles": model is not None and int(model.nu) == 25,
        "control_hz": float(job.get("control_hz", 0.0)) == 50.0,
        "physics_hz": float(job.get("physics_hz", 0.0)) == 200.0,
        "actor_observation_layout": layout_dim == 45 == int(job.get("actor_observation_dim", -1)),
        "leg_action_dim": int(job.get("leg_action_dim", -1)) == 12,
        "output_dim": int(job.get("output_dim", -1)) == 25,
        "joint_order": len(job.get("joint_order", [])) == 25,
        "active_tasks": len(job.get("active_tasks", [])) >= 7,
        "ppo_algorithm": job.get("ppo", {}).get("algorithm") == "brax_ppo",
        "ppo_steps": int(job.get("ppo", {}).get("num_timesteps", 0)) > 0,
        "ppo_envs": int(job.get("ppo", {}).get("num_envs", 0)) > 0,
        "trainer_entrypoint": job.get("trainer_entrypoint") == "eliza_robot.sim.mujoco.asimov_mjx_training:train_from_job",
        "runner": job.get("runner") == "scripts/run_asimov1_full_training.py",
        "domain_randomization": "encoder_zero_offset_rad" in job.get("domain_randomization", {}),
        "manifest_profile": manifest.get("profile_id") == "asimov-1",
        "manifest_dims": int(manifest.get("proprio_dim", -1)) == 45
        and int(manifest.get("action_dim", -1)) == 12
        and int(manifest.get("output_dim", -1)) == 25,
        "expected_artifacts": {"policy_brax.pkl", "manifest.json", "metrics.json", "config.json"}.issubset(expected),
        "validation_commands": any("run_asimov1_full_training.py" in c for c in commands)
        and any("verify_brax_text_policy.py" in c and "--profile asimov-1" in c for c in commands)
        and any(
            "eval_text_policy.py" in c
            and "--profile asimov-1" in c
            and "--backend mjx" in c
            for c in commands
        )
        and any("sim_validation_gate.py --profile asimov-1" in c for c in commands),
    }
    return {
        "ok": all(checks.values()),
        "job_dir": str(job_dir),
        "checks": checks,
        "model": {} if model is None else {"nq": int(model.nq), "nv": int(model.nv), "nu": int(model.nu)},
        "expected_artifacts": sorted(expected),
        "validation_commands": commands,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, default=None)
    parser.add_argument("--create", action="store_true")
    args = parser.parse_args()
    if args.job_dir is None:
        with tempfile.TemporaryDirectory(prefix="asimov-full-training-") as tmp:
            report = validate_full_training_job(Path(tmp), create=True)
    else:
        report = validate_full_training_job(args.job_dir, create=args.create)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
