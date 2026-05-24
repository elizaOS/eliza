#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Validate an ASIMOV-1 production text-conditioned checkpoint package."""

from __future__ import annotations

import argparse
import hashlib
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
    ASIMOV1_GENERATED_MANIFEST,
    ASIMOV1_GENERATED_MJCF,
    ASIMOV1_LEG_ACTION_DIM,
    ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS,
    ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
)
from scripts.validate_alberta_robot_checkpoint import (  # noqa: E402
    validate_alberta_robot_checkpoint,
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

REQUIRED_OBSERVATION_DELAY_STEPS = {"left_leg": 1, "right_leg": 2}


def _observation_delay_contract(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    try:
        if any(isinstance(v, bool) for v in value.values()):
            return False
        return {str(k): int(v) for k, v in value.items()} == REQUIRED_OBSERVATION_DELAY_STEPS
    except Exception:
        return False


def _observation_delay_groups_contract(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    expected = {
        group: list(indices) for group, indices in ASIMOV1_LEG_OBSERVATION_DELAY_GROUPS.items()
    }
    return value == expected


def _load_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _metric_steps(metrics: Any) -> int:
    if not isinstance(metrics, list):
        return 0
    steps = []
    for row in metrics:
        if isinstance(row, dict):
            try:
                raw_steps = row.get("steps", 0)
                steps.append(0 if isinstance(raw_steps, bool) else int(raw_steps))
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
                if isinstance(row["reward"], bool):
                    return False
                rewards.append(float(row["reward"]))
            except Exception:
                return False
    return bool(rewards) and all(math.isfinite(value) for value in rewards)


def _validate_inference_check_report(
    report: Any,
    *,
    checkpoint: Path,
    manifest: dict[str, Any],
    policy_path: Path,
) -> bool:
    if not isinstance(report, dict) or report.get("ok") is not True:
        return False
    report_checkpoint = report.get("checkpoint")
    if report_checkpoint is not None and Path(str(report_checkpoint)).resolve() != checkpoint:
        return False
    if Path(str(report.get("policy_artifact", ""))).resolve() != policy_path:
        return False
    if report.get("policy_artifact_sha256") != _sha256_file(policy_path):
        return False
    report_manifest = report.get("manifest")
    if not isinstance(report_manifest, dict):
        return False
    manifest_fields = {
        "profile_id",
        "regime",
        "obs_dim",
        "proprio_dim",
        "text_dim",
        "mjcf_xml",
        "mjcf_xml_sha256",
        "asset_manifest",
        "asset_manifest_sha256",
        "critic_obs_dim",
        "action_dim",
        "output_dim",
        "policy_obs_key",
        "value_obs_key",
    }
    for field in manifest_fields:
        if report_manifest.get(field) != manifest.get(field):
            return False
    if set(report_manifest.get("active_tasks", [])) != set(manifest.get("active_tasks", [])):
        return False
    checks = report.get("checks")
    if not isinstance(checks, dict) or not checks:
        return False
    required = {
        "profile",
        "proprio_dim",
        "action_dim",
        "output_dim",
        "critic_obs_dim",
        "policy_obs_key",
        "policy_artifact",
        "mjcf_xml",
        "asset_manifest",
        "value_obs_key",
    }
    if not required.issubset(checks):
        return False
    if not all(checks.get(name) is True for name in required):
        return False
    results = report.get("results")
    return isinstance(results, list) and bool(results)


def _asset_provenance_matches(
    manifest: dict[str, Any],
    training_job: dict[str, Any],
    config: dict[str, Any],
    *,
    path_key: str,
    hash_key: str,
    expected_path: Path,
) -> bool:
    manifest_path = Path(str(manifest.get(path_key, "")))
    job_path = Path(str(training_job.get(path_key, "")))
    config_path = Path(str(config.get(path_key, "")))
    if not manifest_path.is_file() or not job_path.is_file() or not config_path.is_file():
        return False
    if manifest_path.resolve() != expected_path.resolve():
        return False
    if job_path.resolve() != manifest_path.resolve() or config_path.resolve() != manifest_path.resolve():
        return False
    actual_hash = _sha256_file(manifest_path)
    return (
        actual_hash is not None
        and manifest.get(hash_key) == actual_hash
        and training_job.get(hash_key) == actual_hash
        and config.get(hash_key) == actual_hash
    )


def _manifest_asset_provenance_matches(
    manifest: dict[str, Any],
    *,
    path_key: str,
    hash_key: str,
    expected_path: Path,
) -> bool:
    manifest_path = Path(str(manifest.get(path_key, "")))
    try:
        manifest_is_file = manifest_path.is_file()
        manifest_resolved = manifest_path.resolve()
        expected_resolved = expected_path.resolve()
    except OSError:
        return False
    if not manifest_is_file or manifest_resolved != expected_resolved:
        return False
    actual_hash = _sha256_file(manifest_path)
    return actual_hash is not None and manifest.get(hash_key) == actual_hash


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


def _validate_asimov1_alberta_checkpoint(
    checkpoint: Path,
    *,
    manifest: dict[str, Any],
    min_steps: int,
    require_inference: bool,
    require_inference_check: bool,
) -> dict[str, Any]:
    report = validate_alberta_robot_checkpoint(
        checkpoint,
        profile_id="asimov-1",
        required_tasks=sorted(REQUIRED_TASKS),
        min_steps=min_steps,
        require_domain_rand=True,
        require_inference=require_inference or require_inference_check,
    )
    checks = dict(report["checks"])
    checks.update(
        {
            "profile_id": manifest.get("profile_id") == "asimov-1",
            "regime": manifest.get("regime") == "alberta_streaming",
            "not_tiny_validation": manifest.get("tiny_training_validation") is not True,
            "not_validation_checkpoint": manifest.get("validation_checkpoint") is not True,
            "not_marked_non_production": manifest.get("non_production") is not True,
            "required_tasks": REQUIRED_TASKS.issubset(set(manifest.get("active_tasks", []))),
            "domain_rand": manifest.get("domain_rand") is True,
            "ckpt_name": manifest.get("ckpt") == "alberta_policy.npz",
            "manifest_mjcf_asset_provenance": _manifest_asset_provenance_matches(
                manifest,
                path_key="mjcf_xml",
                hash_key="mjcf_xml_sha256",
                expected_path=ASIMOV1_GENERATED_MJCF,
            ),
            "manifest_asset_manifest_provenance": _manifest_asset_provenance_matches(
                manifest,
                path_key="asset_manifest",
                hash_key="asset_manifest_sha256",
                expected_path=ASIMOV1_GENERATED_MANIFEST,
            ),
        }
    )
    if require_inference_check:
        checks["inference_check"] = bool(
            report.get("inference_report")
            and report["inference_report"].get("ok") is True
        )
    return {
        "ok": all(checks.values()),
        "profile_id": "asimov-1",
        "checkpoint": str(checkpoint),
        "production_checkpoint": True,
        "production_regime": "alberta_streaming",
        "min_steps": int(min_steps),
        "max_metric_steps": int(report.get("total_steps", 0)),
        "checks": checks,
        "manifest": manifest,
        "metric_count": len(manifest.get("history", []))
        if isinstance(manifest.get("history"), list)
        else 0,
        "inference_check": report.get("inference_report") if require_inference_check else None,
        "inference_report": report.get("inference_report"),
        "alberta_report": report,
    }


def validate_asimov1_production_checkpoint(
    checkpoint: Path,
    *,
    min_steps: int,
    require_inference: bool = False,
    require_inference_check: bool = False,
) -> dict[str, Any]:
    checkpoint = checkpoint.resolve()
    manifest = _load_json(checkpoint / "manifest.json", {})
    training_job = _load_json(checkpoint / "training_job.json", {})
    metrics = _load_json(checkpoint / "metrics.json", [])
    config = _load_json(checkpoint / "config.json", {})
    inference_check = _load_json(checkpoint / "inference_check.json", {})
    inference_report = None
    policy_path = checkpoint / str(manifest.get("ckpt", "policy_brax.pkl"))
    if manifest.get("regime") == "alberta_streaming":
        return _validate_asimov1_alberta_checkpoint(
            checkpoint,
            manifest=manifest,
            min_steps=min_steps,
            require_inference=require_inference,
            require_inference_check=require_inference_check,
        )
    mjcf_path = Path(str(training_job.get("mjcf_xml", "")))
    asset_manifest_path = Path(str(training_job.get("asset_manifest", "")))
    active_tasks = set(manifest.get("active_tasks", []))
    max_steps = _metric_steps(metrics)
    checks = {
        "checkpoint_dir": checkpoint.is_dir(),
        "policy_artifact": policy_path.is_file() and policy_path.stat().st_size > 0,
        "training_job": (checkpoint / "training_job.json").is_file(),
        "mjcf_current_asset": mjcf_path.resolve() == ASIMOV1_GENERATED_MJCF.resolve(),
        "mjcf_asset_hash": mjcf_path.is_file()
        and training_job.get("mjcf_xml_sha256") == _sha256_file(mjcf_path),
        "asset_manifest_current": asset_manifest_path.resolve()
        == ASIMOV1_GENERATED_MANIFEST.resolve(),
        "asset_manifest_hash": asset_manifest_path.is_file()
        and training_job.get("asset_manifest_sha256") == _sha256_file(asset_manifest_path),
        "manifest_mjcf_asset_provenance": _asset_provenance_matches(
            manifest,
            training_job,
            config,
            path_key="mjcf_xml",
            hash_key="mjcf_xml_sha256",
            expected_path=ASIMOV1_GENERATED_MJCF,
        ),
        "manifest_asset_manifest_provenance": _asset_provenance_matches(
            manifest,
            training_job,
            config,
            path_key="asset_manifest",
            hash_key="asset_manifest_sha256",
            expected_path=ASIMOV1_GENERATED_MANIFEST,
        ),
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
        "critic_obs_dim": manifest.get("critic_obs_dim")
        == ASIMOV1_ACTOR_OBSERVATION_DIM
        + int(manifest.get("text_dim", manifest.get("pca_dim", -1)))
        + ASIMOV1_PRIVILEGED_OBSERVATION_EXTRA_DIM,
        "asymmetric_actor_critic": manifest.get("policy_obs_key") == "state"
        and manifest.get("value_obs_key") == "privileged_state",
        "required_tasks": REQUIRED_TASKS.issubset(active_tasks),
        "observation_delay_steps": _observation_delay_contract(
            manifest.get("observation_delay_steps")
        ),
        "observation_delay_groups": _observation_delay_groups_contract(
            manifest.get("observation_delay_groups")
        ),
        "metrics_nonempty": isinstance(metrics, list) and bool(metrics),
        "metrics_steps": max_steps >= int(min_steps),
        "metrics_rewards_finite": _metric_rewards_finite(metrics),
        "config_profile": config.get("profile_id", "asimov-1") == "asimov-1",
        "config_tasks_match_manifest": set(config.get("active_tasks", manifest.get("active_tasks", [])))
        == active_tasks,
        "config_observation_delay_steps": _observation_delay_contract(
            config.get("observation_delay_steps")
        ),
        "config_asymmetric_actor_critic": config.get("ppo", {}).get("policy_obs_key") == "state"
        and config.get("ppo", {}).get("value_obs_key") == "privileged_state",
    }
    if require_inference_check:
        checks["inference_check"] = _validate_inference_check_report(
            inference_check,
            checkpoint=checkpoint,
            manifest=manifest,
            policy_path=policy_path,
        )
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
        "inference_check": inference_check if require_inference_check else None,
        "inference_report": inference_report,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=Path)
    parser.add_argument("--min-steps", type=int, default=1_000_000)
    parser.add_argument("--require-inference", action="store_true")
    parser.add_argument("--require-inference-check", action="store_true")
    args = parser.parse_args()
    report = validate_asimov1_production_checkpoint(
        args.checkpoint,
        min_steps=args.min_steps,
        require_inference=args.require_inference,
        require_inference_check=args.require_inference_check,
    )
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
