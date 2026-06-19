#!/usr/bin/env python3
"""Create or run a tiny ASIMOV-1 Brax/MJX training validation job.

This is not a production walking policy. It is a bounded integration proof for
the real ASIMOV `train_from_job` entrypoint: generated MJCF -> MJX env -> Brax
PPO -> `policy_brax.pkl` -> text-conditioned policy wrapper.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.asimov_1.constants import (  # noqa: E402
    ASIMOV1_ACTOR_OBSERVATION_DIM,
    ASIMOV1_FULL_ACTION_DIM,
    ASIMOV1_LEG_ACTION_DIM,
)
from eliza_robot.sim.mujoco.asimov_training import asimov_full_training_job_spec  # noqa: E402


def write_tiny_training_job(
    job_dir: Path,
    *,
    total_steps: int = 8,
    num_envs: int = 2,
    seed: int = 0,
    pca_dim: int = 4,
) -> dict[str, Any]:
    """Write a deliberately tiny ASIMOV Brax job for entrypoint validation."""
    job_dir.mkdir(parents=True, exist_ok=True)
    active_tasks = ["stand_up", "walk_forward"]
    job = asimov_full_training_job_spec(
        curriculum_version=0,
        output_dir=str(job_dir),
        total_steps=total_steps,
        num_envs=num_envs,
        num_evals=1,
        seed=seed,
        pca_dim=pca_dim,
        domain_rand=False,
    )
    job["active_tasks"] = active_tasks
    job["episode_length"] = 3
    job["domain_randomization"] = {}
    job["ppo"].update(
        {
            "unroll_length": 2,
            "num_minibatches": 1,
            "num_updates_per_batch": 1,
            "batch_size": 2,
        }
    )
    job["manifest_template"].update(
        {
            "active_tasks": active_tasks,
            "pca_dim": int(pca_dim),
            "obs_dim": ASIMOV1_ACTOR_OBSERVATION_DIM + int(pca_dim),
            "proprio_dim": ASIMOV1_ACTOR_OBSERVATION_DIM,
            "text_dim": int(pca_dim),
            "action_dim": ASIMOV1_LEG_ACTION_DIM,
            "output_dim": ASIMOV1_FULL_ACTION_DIM,
            "tiny_training_validation": True,
        }
    )
    (job_dir / "training_job.json").write_text(json.dumps(job, indent=2) + "\n")
    return job


def _validate_artifacts(job_dir: Path) -> dict[str, Any]:
    checks = {
        "training_job": (job_dir / "training_job.json").is_file(),
        "policy_brax": (job_dir / "policy_brax.pkl").is_file(),
        "manifest": (job_dir / "manifest.json").is_file(),
        "metrics": (job_dir / "metrics.json").is_file(),
        "config": (job_dir / "config.json").is_file(),
    }
    manifest = {}
    metrics = []
    if checks["manifest"]:
        manifest = json.loads((job_dir / "manifest.json").read_text(encoding="utf-8"))
        checks.update(
            {
                "profile_id": manifest.get("profile_id") == "asimov-1",
                "regime": manifest.get("regime") == "brax_ppo",
                "proprio_dim": manifest.get("proprio_dim") == ASIMOV1_ACTOR_OBSERVATION_DIM,
                "action_dim": manifest.get("action_dim") == ASIMOV1_LEG_ACTION_DIM,
                "output_dim": manifest.get("output_dim") == ASIMOV1_FULL_ACTION_DIM,
            }
        )
    if checks["metrics"]:
        metrics = json.loads((job_dir / "metrics.json").read_text(encoding="utf-8"))
        checks["metrics_nonempty"] = bool(metrics)
    return {"checks": checks, "manifest": manifest, "metrics": metrics}


def _validate_inference(job_dir: Path) -> dict[str, Any]:
    from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy

    policy = TextConditionedPolicy(job_dir)
    proprio_dim = int(policy.manifest.proprio_dim or ASIMOV1_ACTOR_OBSERVATION_DIM)
    proprio = np.zeros(proprio_dim, dtype=np.float32)
    results = []
    for prompt in policy.active_tasks:
        action, task = policy.act(prompt, proprio)
        results.append(
            {
                "prompt": prompt,
                "matched_task": task,
                "shape": list(action.shape),
                "finite": bool(np.all(np.isfinite(action))),
                "norm": float(np.linalg.norm(action)),
            }
        )
    return {
        "ok": all(
            row["shape"] == [ASIMOV1_FULL_ACTION_DIM] and row["finite"] for row in results
        ),
        "results": results,
    }


def validate_tiny_brax_training(
    job_dir: Path,
    *,
    create: bool,
    run_training: bool,
    seed: int,
) -> dict[str, Any]:
    if create or not (job_dir / "training_job.json").is_file():
        write_tiny_training_job(job_dir, seed=seed)
    start = time.time()
    train_result = None
    if run_training:
        from eliza_robot.sim.mujoco.asimov_mjx_training import train_from_job

        train_result = train_from_job(job_dir)
    artifact_report = _validate_artifacts(job_dir)
    inference_report = (
        _validate_inference(job_dir) if artifact_report["checks"].get("policy_brax") else None
    )
    checks = dict(artifact_report["checks"])
    if inference_report is not None:
        checks["inference"] = inference_report["ok"]
    elif run_training:
        checks["inference"] = False
    ok = checks["training_job"] and (not run_training or all(checks.values()))
    report = {
        "ok": ok,
        "job_dir": str(job_dir),
        "run_training": run_training,
        "non_production": True,
        "elapsed_s": round(time.time() - start, 3),
        "train_result": train_result,
        "artifact_report": artifact_report,
        "inference_report": inference_report,
        "checks": checks,
    }
    (job_dir / "tiny_brax_training_validation.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--create", action="store_true")
    parser.add_argument("--run-training", action="store_true")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    report = validate_tiny_brax_training(
        args.job_dir,
        create=args.create,
        run_training=args.run_training,
        seed=args.seed,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
