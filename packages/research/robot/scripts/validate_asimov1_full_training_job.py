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

from eliza_robot.asimov_1.cad import sha256_file  # noqa: E402
from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
)
from eliza_robot.rl.text_conditioned.train import _write_full_training_job  # noqa: E402

CURRICULUM_EVAL_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _has_curriculum_eval_contract(text: str) -> bool:
    tasks = "--tasks " + " ".join(CURRICULUM_EVAL_TASKS)
    return (
        "eval_text_policy.py" in text
        and "--profile asimov-1" in text
        and "--backend mjx" in text
        and tasks in text
        and "--out evidence/curriculum_eval/eval_text_policy.json" in text
        and "--curriculum-report-out evidence/curriculum_eval/report.json" in text
        and "--fail-under-success-rate 1.0" in text
    )


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

    mjcf_path = Path(str(job.get("mjcf_xml", "")))
    manifest_path = Path(str(job.get("asset_manifest", "")))
    model = mujoco.MjModel.from_xml_path(str(mjcf_path)) if job.get("mjcf_xml") else None
    commands = job.get("validation_commands", [])
    run_script_text = (
        (job_dir / "run_full_training.sh").read_text(encoding="utf-8")
        if (job_dir / "run_full_training.sh").is_file()
        else ""
    )
    expected = set(job.get("expected_artifacts", []))
    job_dir_options = {str(job_dir), str(job_dir.resolve())}
    job_dir_name = job_dir.resolve().name

    def _targets_job_dir(command: str) -> bool:
        if any(f"--job-dir {candidate}" in command for candidate in job_dir_options):
            return True
        marker = "--job-dir "
        if marker not in command:
            return False
        target = command.split(marker, 1)[1].split()[0].rstrip("/")
        return Path(target).name == job_dir_name

    layout_dim = sum(int(item["dim"]) for item in job.get("actor_observation_layout", []))
    critic_layout_dim = sum(int(item["dim"]) for item in job.get("critic_observation_layout", []))
    expected_critic_dim = int(
        job.get("critic_observation_dim", manifest.get("critic_obs_dim", -1))
    )
    checks = {
        "training_job": (job_dir / "training_job.json").is_file(),
        "manifest_template": (job_dir / "manifest.template.json").is_file(),
        "run_script": (job_dir / "run_full_training.sh").is_file(),
        "run_script_executable": (job_dir / "run_full_training.sh").is_file()
        and bool((job_dir / "run_full_training.sh").stat().st_mode & 0o111),
        "run_script_train_mode": "--train" in run_script_text
        and "verify_brax_text_policy.py" in run_script_text
        and "--require-policy-obs-key state" in run_script_text
        and "--require-value-obs-key privileged_state" in run_script_text
        and f"--require-critic-obs-dim {expected_critic_dim}" in run_script_text
        and "validate_asimov1_production_checkpoint.py" in run_script_text
        and _has_curriculum_eval_contract(run_script_text)
        and "sim_validation_gate.py --profile asimov-1" in run_script_text
        and "--require-asimov-model-provenance" in run_script_text,
        "readme": (job_dir / "README.full_training.md").is_file(),
        "profile_id": job.get("profile_id") == "asimov-1",
        "job_name": job.get("job") == "asimov-1-text-conditioned-mjx-brax",
        "mjcf_current_asset": mjcf_path.resolve() == ASIMOV1_GENERATED_MJCF.resolve(),
        "mjcf_asset_hash": mjcf_path.is_file()
        and job.get("mjcf_xml_sha256") == sha256_file(mjcf_path),
        "asset_manifest_current": manifest_path.resolve() == ASIMOV1_GENERATED_MANIFEST.resolve(),
        "asset_manifest_hash": manifest_path.is_file()
        and job.get("asset_manifest_sha256") == sha256_file(manifest_path),
        "mjcf_compiles": model is not None and int(model.nu) == 25,
        "control_hz": float(job.get("control_hz", 0.0)) == 50.0,
        "physics_hz": float(job.get("physics_hz", 0.0)) == 200.0,
        "actor_observation_layout": layout_dim == 45 == int(job.get("actor_observation_dim", -1)),
        "critic_observation_layout": critic_layout_dim
        == int(job.get("critic_observation_dim", -1))
        == int(manifest.get("critic_obs_dim", -1)),
        "leg_action_dim": int(job.get("leg_action_dim", -1)) == 12,
        "output_dim": int(job.get("output_dim", -1)) == 25,
        "joint_order": len(job.get("joint_order", [])) == 25,
        "active_tasks": len(job.get("active_tasks", [])) >= 7,
        "observation_delay_steps": job.get("observation_delay_steps")
        == {"left_leg": 1, "right_leg": 2},
        "observation_delay_groups": job.get("observation_delay_groups")
        == {"left_leg": list(range(0, 6)), "right_leg": list(range(6, 12))},
        "ppo_algorithm": job.get("ppo", {}).get("algorithm") == "brax_ppo",
        "ppo_asymmetric_actor_critic": job.get("ppo", {}).get("policy_obs_key") == "state"
        and job.get("ppo", {}).get("value_obs_key") == "privileged_state",
        "ppo_steps": int(job.get("ppo", {}).get("num_timesteps", 0)) > 0,
        "ppo_envs": int(job.get("ppo", {}).get("num_envs", 0)) > 0,
        "trainer_entrypoint": job.get("trainer_entrypoint") == "eliza_robot.sim.mujoco.asimov_mjx_training:train_from_job",
        "runner": job.get("runner") == "scripts/run_asimov1_full_training.py",
        "domain_randomization": "encoder_zero_offset_rad" in job.get("domain_randomization", {}),
        "manifest_profile": manifest.get("profile_id") == "asimov-1",
        "manifest_dims": int(manifest.get("proprio_dim", -1)) == 45
        and int(manifest.get("action_dim", -1)) == 12
        and int(manifest.get("output_dim", -1)) == 25,
        "manifest_asymmetric_actor_critic": manifest.get("policy_obs_key") == "state"
        and manifest.get("value_obs_key") == "privileged_state",
        "manifest_observation_delay_steps": manifest.get("observation_delay_steps")
        == {"left_leg": 1, "right_leg": 2},
        "expected_artifacts": {
            "policy_brax.pkl",
            "manifest.json",
            "metrics.json",
            "config.json",
            "inference_check.json",
            "full_training_run.json",
        }.issubset(expected),
        "validation_commands": any("run_asimov1_full_training.py" in c for c in commands)
        and any(
            "verify_brax_text_policy.py" in c
            and "--profile asimov-1" in c
            and "--require-policy-obs-key state" in c
            and "--require-value-obs-key privileged_state" in c
            and f"--require-critic-obs-dim {expected_critic_dim}" in c
            for c in commands
        )
        and any(
            "validate_asimov1_production_checkpoint.py" in c
            and (
                f"--min-steps {int(job.get('ppo', {}).get('num_timesteps', 0))}" in c
                or '--min-steps "$BRAX_MJX_STEPS"' in c
            )
            and "--require-inference-check" in c
            for c in commands
        )
        and any(
            "validate_asimov1_full_training_run.py" in c
            and "full_training_run.json" in c
            and _targets_job_dir(c)
            for c in commands
        )
        and any(
            _has_curriculum_eval_contract(c)
            for c in commands
        )
        and any(
            "sim_validation_gate.py --profile asimov-1" in c
            and "--require-asimov-model-provenance" in c
            for c in commands
        ),
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
