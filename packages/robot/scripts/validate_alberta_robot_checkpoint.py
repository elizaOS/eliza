#!/usr/bin/env python3
"""Validate a production Alberta text-conditioned robot checkpoint."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eliza_robot.curriculum.loader import load_curriculum  # noqa: E402
from eliza_robot.profiles.schema import load_profile  # noqa: E402


def _load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except Exception:
        return False


def _controller_contract(value: Any, *, pca_dim: int) -> bool:
    if not isinstance(value, dict):
        return False
    features = value.get("features")
    if not isinstance(features, dict):
        return False
    required_scalars = (
        "gamma",
        "actor_step_size",
        "critic_step_size",
        "actor_lamda",
        "critic_lamda",
        "log_sigma_init",
        "log_sigma_min",
        "log_sigma_max",
        "action_low",
        "action_high",
        "obgd_kappa",
        "normalizer_decay",
    )
    if not all(_finite_number(value.get(key)) for key in required_scalars):
        return False
    if not isinstance(value.get("normalize"), bool):
        return False
    if not isinstance(value.get("decouple_global_bias"), bool):
        return False
    if features.get("mode") != "sparse_gated":
        return False
    try:
        return (
            int(features.get("embed_dim")) == int(pca_dim)
            and int(features.get("n_prototypes")) > 0
            and int(features.get("proprio_random_dim")) > 0
            and int(features.get("random_dim", 1)) > 0
        )
    except Exception:
        return False


def _history_contract(history: Any, tasks: list[str]) -> bool:
    if not isinstance(history, list) or len(history) != len(tasks):
        return False
    for phase, (row, task) in enumerate(zip(history, tasks, strict=True)):
        if not isinstance(row, dict):
            return False
        if int(row.get("phase", -1)) != phase or row.get("task") != task:
            return False
        if not _finite_number(row.get("train_mean_return")):
            return False
        if not _finite_number(row.get("eval_mean_return")):
            return False
    return True


def _phase_promotion_contract(
    manifest: dict[str, Any],
    tasks: list[str],
    *,
    total_steps: int,
    eval_episodes: int,
    require_phase_promotion: bool,
) -> bool:
    if manifest.get("phase_promotion_schema") is None and not require_phase_promotion:
        return True
    if manifest.get("phase_promotion_schema") != "alberta-phase-promotion-v1":
        return False
    promotion = manifest.get("phase_promotion")
    if not isinstance(promotion, dict):
        return False
    threshold = promotion.get("success_threshold")
    if not _finite_number(threshold):
        return False
    threshold = float(threshold)
    phases = promotion.get("phases")
    failed_phase = promotion.get("failed_phase")
    try:
        promoted_count = int(promotion.get("promoted_phase_count"))
        requested_count = int(promotion.get("requested_phase_count"))
        promotion_eval_episodes = int(promotion.get("eval_episodes"))
    except Exception:
        return False
    if not (
        promotion.get("status") == "completed"
        and promotion.get("gate") == "curriculum_goal_checker"
        and 0.0 < threshold <= 1.0
        and promoted_count == requested_count == len(tasks)
        and failed_phase is None
        and promotion_eval_episodes == eval_episodes
        and isinstance(phases, list)
        and len(phases) == len(tasks)
    ):
        return False
    last_cumulative = 0
    for phase_idx, (row, task) in enumerate(zip(phases, tasks, strict=True)):
        if not isinstance(row, dict):
            return False
        if int(row.get("phase", -1)) != phase_idx or row.get("task") != task:
            return False
        if row.get("promotion_passed") is not True:
            return False
        if not _finite_number(row.get("steps_trained")) or not _finite_number(
            row.get("cumulative_steps")
        ):
            return False
        if not _finite_number(row.get("eval_mean_return")) or not _finite_number(
            row.get("eval_success_rate")
        ):
            return False
        steps_trained = int(row["steps_trained"])
        cumulative_steps = int(row["cumulative_steps"])
        success_rate = float(row["eval_success_rate"])
        try:
            row_eval_episodes = int(row.get("eval_episodes"))
        except Exception:
            return False
        if not (
            steps_trained > 0
            and cumulative_steps > last_cumulative
            and row_eval_episodes == eval_episodes
            and 0.0 <= success_rate <= 1.0
            and success_rate >= threshold
        ):
            return False
        last_cumulative = cumulative_steps
    return last_cumulative == total_steps


def _validate_inference(checkpoint: Path, manifest: dict[str, Any], prompts: list[str]) -> dict[str, Any]:
    from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy

    policy = TextConditionedPolicy(checkpoint, strict_manifest=True)
    proprio = np.zeros(int(manifest["proprio_dim"]), dtype=np.float32)
    output_dim = int(manifest["output_dim"])
    results = []
    for prompt in prompts:
        action, matched_task = policy.act(prompt, proprio, output_dim=output_dim)
        results.append(
            {
                "prompt": prompt,
                "matched_task": matched_task,
                "shape": list(action.shape),
                "finite": bool(np.all(np.isfinite(action))),
            }
        )
    return {
        "ok": all(row["shape"] == [output_dim] and row["finite"] for row in results),
        "results": results,
    }


def validate_alberta_robot_checkpoint(
    checkpoint: Path,
    *,
    profile_id: str | None = None,
    required_tasks: list[str] | None = None,
    min_steps: int = 1,
    require_domain_rand: bool = False,
    require_inference: bool = False,
    require_phase_promotion: bool = False,
) -> dict[str, Any]:
    checkpoint = checkpoint.resolve()
    manifest = _load_json(checkpoint / "manifest.json", {})
    policy_path = checkpoint / str(manifest.get("ckpt", "alberta_policy.npz"))
    manifest_profile = str(manifest.get("profile_id", ""))
    expected_profile = profile_id or manifest_profile
    profile = None
    profile_error = None
    try:
        profile = load_profile(expected_profile)
    except Exception as exc:
        profile_error = f"{type(exc).__name__}: {exc}"
    curriculum = load_curriculum()
    curriculum_ids = set(curriculum.all_ids())
    tasks = list(manifest.get("active_tasks", [])) if isinstance(manifest.get("active_tasks"), list) else []
    required_tasks = list(required_tasks or [])
    pca_dim = int(manifest.get("pca_dim", -1)) if isinstance(manifest.get("pca_dim", -1), int) else -1
    obs_dim = int(manifest.get("obs_dim", -1)) if isinstance(manifest.get("obs_dim", -1), int) else -1
    action_dim = int(manifest.get("action_dim", -1)) if isinstance(manifest.get("action_dim", -1), int) else -1
    output_dim = int(manifest.get("output_dim", -1)) if isinstance(manifest.get("output_dim", -1), int) else -1
    proprio_dim = int(manifest.get("proprio_dim", -1)) if isinstance(manifest.get("proprio_dim", -1), int) else -1
    text_dim = int(manifest.get("text_dim", -1)) if isinstance(manifest.get("text_dim", -1), int) else -1
    total_steps = int(manifest.get("total_steps", 0) or 0)
    requested_total_steps = int(manifest.get("requested_total_steps", 0) or 0)
    steps_per_task = int(manifest.get("steps_per_task", 0) or 0)
    expected_total = steps_per_task * len(tasks)

    checks = {
        "checkpoint_dir": checkpoint.is_dir(),
        "manifest": (checkpoint / "manifest.json").is_file(),
        "regime": manifest.get("regime") == "alberta_streaming",
        "profile_id": bool(expected_profile) and manifest_profile == expected_profile,
        "profile_loads": profile is not None,
        "profile_version": profile is not None and manifest.get("profile_version") == profile.version,
        "curriculum_version": manifest.get("curriculum_version") == curriculum.version,
        "policy_artifact": policy_path.is_file() and policy_path.stat().st_size > 0,
        "ckpt_name": manifest.get("ckpt") == "alberta_policy.npz",
        "active_tasks": bool(tasks) and set(tasks).issubset(curriculum_ids),
        "unique_active_tasks": len(tasks) == len(set(tasks)),
        "required_tasks": not required_tasks or set(required_tasks).issubset(set(tasks)),
        "pca_text_dim": pca_dim > 0 and text_dim == pca_dim,
        "obs_layout": obs_dim == proprio_dim + text_dim and proprio_dim > 0,
        "action_dim": action_dim > 0,
        "output_dim": profile is not None and output_dim == len(profile.kinematics.joints),
        "output_covers_action": output_dim >= action_dim > 0,
        "total_steps": total_steps >= int(min_steps),
        "requested_total_steps": requested_total_steps >= int(min_steps),
        "steps_per_task": steps_per_task > 0 and expected_total == total_steps,
        "not_tiny_validation": manifest.get("tiny_training_validation") is not True,
        "not_validation_checkpoint": manifest.get("validation_checkpoint") is not True,
        "not_marked_non_production": manifest.get("non_production") is not True,
        "domain_rand": (manifest.get("domain_rand") is True) if require_domain_rand else isinstance(manifest.get("domain_rand"), bool),
        "controller": _controller_contract(manifest.get("controller"), pca_dim=pca_dim),
        "history": _history_contract(manifest.get("history"), tasks),
        "phase_promotion": _phase_promotion_contract(
            manifest,
            tasks,
            total_steps=total_steps,
            eval_episodes=int(manifest.get("eval_episodes", 0) or 0),
            require_phase_promotion=require_phase_promotion,
        ),
    }
    inference_report = None
    if require_inference and checks["policy_artifact"] and checks["manifest"] and checks["profile_loads"]:
        try:
            inference_report = _validate_inference(checkpoint, manifest, tasks)
        except Exception as exc:
            inference_report = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        checks["inference"] = bool(inference_report.get("ok"))
    elif require_inference:
        checks["inference"] = False

    return {
        "ok": all(checks.values()),
        "checkpoint": str(checkpoint),
        "profile_id": expected_profile,
        "required_tasks": required_tasks,
        "min_steps": int(min_steps),
        "total_steps": total_steps,
        "requested_total_steps": requested_total_steps,
        "checks": checks,
        "manifest": manifest,
        "profile_error": profile_error,
        "inference_report": inference_report,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--profile", default=None)
    parser.add_argument("--tasks", nargs="+", default=[])
    parser.add_argument("--min-steps", type=int, default=1)
    parser.add_argument("--require-domain-rand", action="store_true")
    parser.add_argument("--require-inference", action="store_true")
    parser.add_argument("--require-phase-promotion", action="store_true")
    args = parser.parse_args(argv)
    report = validate_alberta_robot_checkpoint(
        args.checkpoint,
        profile_id=args.profile,
        required_tasks=args.tasks,
        min_steps=args.min_steps,
        require_domain_rand=args.require_domain_rand,
        require_inference=args.require_inference,
        require_phase_promotion=args.require_phase_promotion,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
