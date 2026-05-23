#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Validate an ASIMOV-1 production text-conditioned checkpoint package."""

from __future__ import annotations

import argparse
import json
import math
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


REQUIRED_TASKS = {
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
}


def _load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _metric_steps(metrics: Any) -> int:
    if not isinstance(metrics, list):
        return 0
    steps = []
    for row in metrics:
        if isinstance(row, dict):
            try:
                steps.append(int(row.get("steps", 0)))
            except Exception:
                steps.append(0)
    return max(steps, default=0)


def _metric_rewards_finite(metrics: Any) -> bool:
    if not isinstance(metrics, list) or not metrics:
        return False
    rewards = []
    for row in metrics:
        if isinstance(row, dict) and "reward" in row:
            try:
                rewards.append(float(row["reward"]))
            except Exception:
                return False
    return bool(rewards) and all(math.isfinite(value) for value in rewards)


def _validate_inference(checkpoint: Path, prompts: list[str]) -> dict[str, Any]:
    from eliza_robot.rl.text_conditioned.policy import TextConditionedPolicy

    start = time.time()
    policy = TextConditionedPolicy(checkpoint)
    proprio = np.zeros(ASIMOV1_ACTOR_OBSERVATION_DIM, dtype=np.float32)
    results = []
    for prompt in prompts:
        action, task = policy.act(prompt, proprio, output_dim=ASIMOV1_FULL_ACTION_DIM)
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
        "elapsed_s": round(time.time() - start, 3),
        "results": results,
    }


def validate_asimov1_production_checkpoint(
    checkpoint: Path,
    *,
    min_steps: int,
    require_inference: bool = False,
) -> dict[str, Any]:
    checkpoint = checkpoint.resolve()
    manifest = _load_json(checkpoint / "manifest.json", {})
    metrics = _load_json(checkpoint / "metrics.json", [])
    config = _load_json(checkpoint / "config.json", {})
    inference_report = None
    policy_path = checkpoint / str(manifest.get("ckpt", "policy_brax.pkl"))
    active_tasks = set(manifest.get("active_tasks", []))
    max_steps = _metric_steps(metrics)
    checks = {
        "checkpoint_dir": checkpoint.is_dir(),
        "policy_artifact": policy_path.is_file() and policy_path.stat().st_size > 0,
        "manifest": (checkpoint / "manifest.json").is_file(),
        "metrics": (checkpoint / "metrics.json").is_file(),
        "config": (checkpoint / "config.json").is_file(),
        "profile_id": manifest.get("profile_id") == "asimov-1",
        "regime": manifest.get("regime") == "brax_ppo",
        "not_tiny_validation": manifest.get("tiny_training_validation") is not True,
        "not_marked_non_production": manifest.get("non_production") is not True,
        "proprio_dim": manifest.get("proprio_dim") == ASIMOV1_ACTOR_OBSERVATION_DIM,
        "action_dim": manifest.get("action_dim") == ASIMOV1_LEG_ACTION_DIM,
        "output_dim": manifest.get("output_dim") == ASIMOV1_FULL_ACTION_DIM,
        "obs_dim": manifest.get("obs_dim")
        == ASIMOV1_ACTOR_OBSERVATION_DIM + int(manifest.get("text_dim", manifest.get("pca_dim", -1))),
        "required_tasks": REQUIRED_TASKS.issubset(active_tasks),
        "metrics_nonempty": isinstance(metrics, list) and bool(metrics),
        "metrics_steps": max_steps >= int(min_steps),
        "metrics_rewards_finite": _metric_rewards_finite(metrics),
        "config_profile": config.get("profile_id", "asimov-1") == "asimov-1",
        "config_tasks_match_manifest": set(config.get("active_tasks", manifest.get("active_tasks", [])))
        == active_tasks,
    }
    if require_inference and checks["policy_artifact"] and checks["manifest"]:
        try:
            inference_report = _validate_inference(checkpoint, sorted(REQUIRED_TASKS))
        except Exception as exc:
            inference_report = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        checks["inference"] = bool(inference_report["ok"])
    elif require_inference:
        checks["inference"] = False

    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "checkpoint": str(checkpoint),
        "production_checkpoint": True,
        "min_steps": int(min_steps),
        "max_metric_steps": max_steps,
        "checks": checks,
        "manifest": manifest,
        "metric_count": len(metrics) if isinstance(metrics, list) else 0,
        "inference_report": inference_report,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--min-steps", type=int, default=1_000_000)
    parser.add_argument("--require-inference", action="store_true")
    args = parser.parse_args()
    report = validate_asimov1_production_checkpoint(
        args.checkpoint,
        min_steps=args.min_steps,
        require_inference=args.require_inference,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
