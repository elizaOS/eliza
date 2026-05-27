#!/usr/bin/env python3
# ruff: noqa: E402,I001
"""Sync and validate a Nebius end-to-end robot training run.

The active H200 payload uploads raw stage outputs. This script is the stricter
post-run gate: pull the object prefix locally, run every production validator
over the synced artifacts, review produced videos frame-by-frame, and write one
summary report that can be used for the Alberta completion audit.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.review_robot_video_evidence import review_videos  # noqa: E402
from scripts.validate_alberta_benchmark_artifacts import (  # noqa: E402
    validate_alberta_benchmark_artifacts,
)
from scripts.validate_alberta_robot_checkpoint import (  # noqa: E402
    validate_alberta_robot_checkpoint,
)
from scripts.validate_asimov1_full_training_run import (  # noqa: E402
    validate_asimov1_full_training_run,
)
from scripts.validate_asimov1_production_checkpoint import (  # noqa: E402
    validate_asimov1_production_checkpoint,
)
from scripts.validate_backend_comparison_artifacts import (  # noqa: E402
    validate_backend_comparison_artifacts,
)
from scripts.validate_multi_robot_training_readiness import (  # noqa: E402
    DEFAULT_COMMANDS as DEFAULT_MULTI_ROBOT_COMMANDS,
    DEFAULT_PROFILES as DEFAULT_MULTI_ROBOT_PROFILES,
    validate as validate_multi_robot_training_readiness,
)


STAGES = (
    "00_local_preflight",
    "10_nebius_train_alberta",
    "20_nebius_compare_backends",
    "30_nebius_continual_benchmarks",
    "40_nebius_brax_baseline",
    "50_post_train_validation",
)
LOCAL_SYNC_PRESERVE_PATTERNS = (
    "runtime_watch.json",
    "runtime_watch.md",
    "runtime_watch_history.jsonl",
    "instance_launch_hygiene.json",
)
DEFAULT_TASKS = (
    "stand_up",
    "walk_forward",
    "walk_backward",
    "sidestep_left",
    "sidestep_right",
    "turn_left",
    "turn_right",
)
TEXT_POLICY_EVAL_SCHEMA = "robot-text-policy-eval-v1"
CURRICULUM_EVAL_SCHEMA = "robot-policy-curriculum-eval-v1"
CURRICULUM_EVAL_REPORT_REL = Path("evidence/curriculum_eval/report.json")
CURRICULUM_EVAL_NATIVE_REL = Path("evidence/curriculum_eval/eval_text_policy.json")
PRODUCTION_MIN_ALBERTA_STEPS = 150_000_000
PRODUCTION_MIN_BACKEND_COMPARE_STEPS = 30_000
PRODUCTION_MIN_BENCHMARK_STEPS_PER_TASK = 16_000
PRODUCTION_MIN_BENCHMARK_SEEDS = 3


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else ""


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_markdown(path: Path, report: dict[str, Any]) -> None:
    checks = report.get("checks", {})
    stage_checks = report.get("reports", {}).get("stages", {}).get("checks", {})
    failed_gates = [name for name, value in checks.items() if not value]
    production_videos = (
        report.get("reports", {}).get("production_policy_videos")
        if isinstance(report.get("reports"), dict)
        else {}
    )
    if not isinstance(production_videos, dict):
        production_videos = {}
    production_video_checks = (
        production_videos.get("checks")
        if isinstance(production_videos.get("checks"), dict)
        else {}
    )
    lines = [
        "# Nebius Full Robot Training Validation",
        "",
        f"Run: `{report.get('run_id') or 'unknown'}`",
        f"Profile: `{report.get('profile_id')}`",
        f"Overall result: `{'ok' if report.get('ok') else 'not-ready'}`",
        "",
        "## Production Gates",
        "",
        "| gate | result |",
        "|---|---:|",
    ]
    for name, value in checks.items():
        lines.append(f"| `{name}` | `{bool(value)}` |")
    lines += [
        "",
        "## Failed Gates",
        "",
    ]
    if failed_gates:
        lines.extend(f"- `{name}`" for name in failed_gates)
    else:
        lines.append("- none")
    lines += [
        "",
        "## Stage Logs",
        "",
        "| stage | ended ok |",
        "|---|---:|",
    ]
    for name in STAGES:
        lines.append(f"| `{name}` | `{bool(stage_checks.get(name))}` |")
    lines += [
        "",
        "## Production Policy Videos",
        "",
        f"Gate ok: `{production_videos.get('ok')}`",
        f"Checkpoint: `{production_videos.get('checkpoint') or 'missing'}`",
        "Checkpoint artifacts exist: "
        f"`{production_video_checks.get('checkpoint_exists')}`",
        "Manifest checkpoint bound: "
        f"`{production_video_checks.get('manifest_policy_checkpoint')}`",
        "Profile checkpoint bound: "
        f"`{production_video_checks.get('profile_policy_checkpoint')}`",
        "Expected videos present: "
        f"`{production_video_checks.get('expected_videos')}`",
        "Expected telemetry present: "
        f"`{production_video_checks.get('expected_telemetry')}`",
        "",
        "| kind | files |",
        "|---|---|",
        "| present | "
        f"`{', '.join(map(str, production_videos.get('present') or [])) or 'none'}` |",
        "| missing | "
        f"`{', '.join(map(str, production_videos.get('missing') or [])) or 'none'}` |",
    ]
    lines += [
        "",
        "## Thresholds",
        "",
        "```json",
        json.dumps(report.get("thresholds", {}), indent=2),
        "```",
        "",
        "This report is generated from the synced Nebius object-storage prefix. "
        "A completion claim requires every production gate above to be `true`.",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def sync_from_s3(
    *,
    run_id: str,
    bucket: str,
    endpoint: str,
    dest: Path,
    aws_bin: str = "aws",
) -> dict[str, Any]:
    """Sync a Nebius Object Storage run prefix to ``dest`` without logging secrets."""
    dest.mkdir(parents=True, exist_ok=True)
    prefix = f"s3://{bucket}/{run_id}/"
    cmd = [
        aws_bin,
        "--endpoint-url",
        endpoint,
        "s3",
        "sync",
        "--delete",
    ]
    for pattern in LOCAL_SYNC_PRESERVE_PATTERNS:
        cmd.extend(["--exclude", pattern])
    cmd.extend([prefix, str(dest)])
    env = os.environ.copy()
    env.setdefault("AWS_DEFAULT_REGION", "eu-north1")
    result = subprocess.run(
        cmd,
        cwd=str(ROOT),
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    return {
        "ok": result.returncode == 0,
        "run_id": run_id,
        "bucket": bucket,
        "endpoint": endpoint,
        "dest": str(dest),
        "delete_extra": True,
        "preserved_local_patterns": list(LOCAL_SYNC_PRESERVE_PATTERNS),
        "returncode": result.returncode,
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def _stage_checks(run_root: Path) -> dict[str, Any]:
    logs_dir = run_root / "logs"
    checks: dict[str, Any] = {}
    details: dict[str, Any] = {}
    for stage in STAGES:
        log = logs_dir / f"{stage}.log"
        text = _read_text(log)
        checks[stage] = log.is_file() and f"END {stage} rc=0" in text
        details[stage] = {
            "log": str(log),
            "exists": log.is_file(),
            "ended_ok": f"END {stage} rc=0" in text,
            "tail": text[-1000:] if text else "",
        }
    return {"ok": all(checks.values()), "checks": checks, "details": details}


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def _stage_status_checks(run_root: Path) -> dict[str, Any]:
    status_dir = run_root / "status"
    runner_path = status_dir / "runner_status.json"
    runner = _read_json_object(runner_path)
    runner_stages = runner.get("stages") if isinstance(runner.get("stages"), list) else []
    runner_stage_names = [
        item.get("stage") for item in runner_stages if isinstance(item, dict)
    ]
    runner_checks = {
        "present": runner_path.is_file(),
        "valid_json_object": bool(runner),
        "state_complete": runner.get("state") == "complete",
        "ok_true": runner.get("ok") is True,
        "all_stages_listed": set(STAGES).issubset(set(runner_stage_names)),
        "stage_count_exact": len(runner_stage_names) == len(STAGES),
        "stage_order": runner_stage_names == list(STAGES),
        "last_stage": runner.get("last_stage") == STAGES[-1],
        "started_at": isinstance(runner.get("started_at"), str)
        and bool(runner.get("started_at")),
        "ended_at": isinstance(runner.get("ended_at"), str)
        and bool(runner.get("ended_at")),
        "heartbeat_at": isinstance(runner.get("heartbeat_at"), str)
        and bool(runner.get("heartbeat_at")),
    }
    stage_checks: dict[str, bool] = {}
    stage_details: dict[str, Any] = {}
    for stage in STAGES:
        path = status_dir / f"{stage}.json"
        payload = _read_json_object(path)
        checks = {
            "present": path.is_file(),
            "valid_json_object": bool(payload),
            "stage_matches": payload.get("stage") == stage,
            "state_complete": payload.get("state") == "complete",
            "returncode_zero": payload.get("returncode") == 0,
            "started_at": isinstance(payload.get("started_at"), str)
            and bool(payload.get("started_at")),
            "ended_at": isinstance(payload.get("ended_at"), str)
            and bool(payload.get("ended_at")),
            "heartbeat_at": isinstance(payload.get("heartbeat_at"), str)
            and bool(payload.get("heartbeat_at")),
        }
        stage_checks[stage] = all(checks.values())
        stage_details[stage] = {
            "status": str(path),
            "checks": checks,
            "state": payload.get("state"),
            "returncode": payload.get("returncode"),
            "started_at": payload.get("started_at"),
            "ended_at": payload.get("ended_at"),
            "heartbeat_at": payload.get("heartbeat_at"),
        }
    checks = {
        "runner_status": all(runner_checks.values()),
        "all_stage_statuses": all(stage_checks.values()),
    }
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "runner": {
            "status": str(runner_path),
            "checks": runner_checks,
            "state": runner.get("state"),
            "ok": runner.get("ok"),
            "last_stage": runner.get("last_stage"),
            "stage_count": len(runner_stages),
        },
        "stages": stage_checks,
        "details": stage_details,
    }


def _has_alberta_checkpoint(path: Path) -> bool:
    return (
        path.is_dir()
        and (path / "manifest.json").is_file()
        and (path / "alberta_policy.npz").is_file()
    )


def _has_brax_checkpoint(path: Path) -> bool:
    return all(
        (path / name).is_file()
        for name in (
            "manifest.json",
            "metrics.json",
            "config.json",
            "inference_check.json",
            "full_training_run.json",
            "policy_brax.pkl",
        )
    )


def _validate_production_policy_videos(
    evidence_dir: Path,
    *,
    checkpoint: Path,
    profile_id: str,
    commands: tuple[str, ...],
    min_video_bytes: int = 1024,
) -> dict[str, Any]:
    manifest_path = evidence_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    profiles = manifest.get("profiles") if isinstance(manifest.get("profiles"), list) else []
    entries = [entry for entry in profiles if isinstance(entry, dict) and entry.get("profile") == profile_id]
    checkpoint_path = str(checkpoint.resolve())
    manifest_checkpoint = manifest.get("policy_checkpoint")
    profile_checkpoints = [entry.get("policy_checkpoint") for entry in entries]
    checkpoint_name = checkpoint.name
    def _checkpoint_matches(value: Any) -> bool:
        if value == checkpoint_path:
            return True
        if isinstance(value, str):
            return Path(value).name == checkpoint_name
        return False
    profile_dir = evidence_dir / profile_id
    expected = [
        f"{profile_id}_{command.replace(' ', '_').replace('/', '_')[:48]}.mp4"
        for command in commands
    ] + [f"{profile_id}_combined_actions.mp4"]
    expected_telemetry = [Path(name).with_suffix(".telemetry.json").name for name in expected]
    present = [name for name in expected if (profile_dir / name).is_file()]
    missing = [name for name in expected if name not in present]
    present_telemetry = [name for name in expected_telemetry if (profile_dir / name).is_file()]
    missing_telemetry = [name for name in expected_telemetry if name not in present_telemetry]
    sizes = {
        name: (profile_dir / name).stat().st_size
        for name in present
        if (profile_dir / name).is_file()
    }
    telemetry_sizes = {
        name: (profile_dir / name).stat().st_size
        for name in present_telemetry
        if (profile_dir / name).is_file()
    }
    undersized = [name for name, size in sizes.items() if size < min_video_bytes]
    undersized_telemetry = [name for name, size in telemetry_sizes.items() if size <= 0]
    telemetry_reports = {
        name: _validate_policy_video_telemetry(
            profile_dir / name,
            expected_profile=profile_id,
            expected_task=_task_id_for_command(command),
            checkpoint_name=checkpoint_name,
            combined=False,
        )
        for command, name in zip(commands, expected_telemetry[:-1], strict=True)
    }
    combined_name = expected_telemetry[-1]
    telemetry_reports[combined_name] = _validate_policy_video_telemetry(
        profile_dir / combined_name,
        expected_profile=profile_id,
        expected_task=None,
        checkpoint_name=checkpoint_name,
        combined=True,
        expected_tasks=[_task_id_for_command(command) for command in commands],
    )
    telemetry_semantics_ok = all(
        report.get("ok") is True for report in telemetry_reports.values()
    )
    checks = {
        "manifest": manifest_path.is_file(),
        "manifest_ok": manifest.get("ok") is True,
        "checkpoint_exists": _has_alberta_checkpoint(checkpoint),
        "manifest_policy_checkpoint": _checkpoint_matches(manifest_checkpoint),
        "profile_entry": bool(entries),
        "profile_policy_checkpoint": any(
            _checkpoint_matches(value) for value in profile_checkpoints
        ),
        "expected_videos": not missing,
        "expected_telemetry": not missing_telemetry,
        "video_sizes": not undersized and len(sizes) == len(expected),
        "telemetry_sizes": not undersized_telemetry
        and len(telemetry_sizes) == len(expected_telemetry),
        "telemetry_semantics": telemetry_semantics_ok,
        "combined_video": (profile_dir / f"{profile_id}_combined_actions.mp4").is_file(),
    }
    return {
        "ok": all(checks.values()),
        "manifest": str(manifest_path),
        "checkpoint": checkpoint_path,
        "profile_id": profile_id,
        "checks": checks,
        "manifest_policy_checkpoint": manifest_checkpoint,
        "profile_policy_checkpoints": profile_checkpoints,
        "expected": expected,
        "expected_telemetry": expected_telemetry,
        "present": present,
        "present_telemetry": present_telemetry,
        "sizes": sizes,
        "telemetry_sizes": telemetry_sizes,
        "telemetry_reports": telemetry_reports,
        "min_video_bytes": int(min_video_bytes),
        "undersized": undersized,
        "undersized_telemetry": undersized_telemetry,
        "missing": missing,
        "missing_telemetry": missing_telemetry,
    }


def _task_id_for_command(command: str) -> str:
    mapping = {
        "stand up": "stand_up",
        "walk forward": "walk_forward",
        "walk backward": "walk_backward",
        "sidestep left": "sidestep_left",
        "sidestep right": "sidestep_right",
        "turn left": "turn_left",
        "turn right": "turn_right",
        "turn around": "turn_around",
    }
    return mapping.get(command.strip().lower(), command.strip().lower().replace(" ", "_"))


def _load_json_dict(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _policy_source_is_checkpoint(value: Any, checkpoint_name: str) -> bool:
    if not isinstance(value, str):
        return False
    if not value.startswith("checkpoint:"):
        return False
    raw_path = value.removeprefix("checkpoint:")
    return Path(raw_path).name == checkpoint_name or value.endswith(checkpoint_name)


def _series_has_finite_value(series: Any, key: str = "final") -> bool:
    if not isinstance(series, dict):
        return False
    value = series.get(key)
    if isinstance(value, bool):
        return False
    try:
        number = float(value)
    except (TypeError, ValueError):
        return False
    return math.isfinite(number)


def _series_finite_number(series: Any, key: str = "final") -> float | None:
    if not isinstance(series, dict):
        return None
    value = series.get(key)
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _policy_video_motion_checks(payload: dict[str, Any], expected_task: str | None) -> dict[str, bool]:
    checks: dict[str, bool] = {}
    if expected_task == "walk_forward":
        final = _series_finite_number(payload.get("delta_x_m"))
        checks["delta_x_forward"] = final is not None and final >= 0.30
    elif expected_task == "walk_backward":
        final = _series_finite_number(payload.get("delta_x_m"))
        checks["delta_x_backward"] = final is not None and final <= -0.20
    elif expected_task == "sidestep_left":
        final_y = _series_finite_number(payload.get("delta_y_m"))
        final_x = _series_finite_number(payload.get("delta_x_m"))
        checks["delta_y_left"] = final_y is not None and final_y >= 0.20
        checks["forward_drift_bound"] = final_x is not None and abs(final_x) <= 0.20
    elif expected_task == "sidestep_right":
        final_y = _series_finite_number(payload.get("delta_y_m"))
        final_x = _series_finite_number(payload.get("delta_x_m"))
        checks["delta_y_right"] = final_y is not None and final_y <= -0.20
        checks["forward_drift_bound"] = final_x is not None and abs(final_x) <= 0.20
    elif expected_task == "turn_left":
        final_yaw = _series_finite_number(payload.get("delta_yaw_rad"))
        checks["delta_yaw_left"] = final_yaw is not None and final_yaw >= 0.70
    elif expected_task == "turn_right":
        final_yaw = _series_finite_number(payload.get("delta_yaw_rad"))
        checks["delta_yaw_right"] = final_yaw is not None and final_yaw <= -0.70
    elif expected_task == "turn_around":
        final_yaw = _series_finite_number(payload.get("delta_yaw_rad"))
        checks["delta_yaw_turn_around"] = (
            final_yaw is not None and abs(final_yaw) >= 2.60
        )
    return checks


def _validate_policy_video_telemetry(
    path: Path,
    *,
    expected_profile: str,
    expected_task: str | None,
    checkpoint_name: str,
    combined: bool,
    expected_tasks: list[str] | None = None,
) -> dict[str, Any]:
    payload = _load_json_dict(path)
    checks: dict[str, bool] = {
        "present": path.is_file(),
        "valid_json_object": bool(payload),
        "profile": payload.get("profile") == expected_profile,
        "policy_source_checkpoint": _policy_source_is_checkpoint(
            payload.get("policy_source"),
            checkpoint_name,
        ),
        "not_scripted_smoke": payload.get("policy_source") != "scripted_smoke",
        "rollout_ok": payload.get("rollout_ok") is True,
    }
    if combined:
        commands = payload.get("commands") if isinstance(payload.get("commands"), list) else []
        command_tasks = [
            item.get("task_id") for item in commands if isinstance(item, dict)
        ]
        command_motion_checks = [
            _policy_video_motion_checks(item, expected_task)
            for item, expected_task in zip(commands, expected_tasks or [], strict=False)
            if isinstance(item, dict)
        ]
        checks.update(
            {
                "commands_present": bool(commands),
                "expected_tasks": command_tasks == list(expected_tasks or []),
                "all_goal_success": bool(commands)
                and all(
                    isinstance(item, dict) and item.get("goal_success") is True
                    for item in commands
                ),
                "all_attempted_action": bool(commands)
                and all(
                    isinstance(item, dict) and item.get("attempted_action") is True
                    for item in commands
                ),
                "all_command_motion": bool(command_motion_checks)
                and all(
                    all(command_check.values())
                    for command_check in command_motion_checks
                ),
                "any_goal_success": payload.get("any_goal_success") is True,
            }
        )
    else:
        checks.update(
            {
                "task_id": payload.get("task_id") == expected_task,
                "goal_success": payload.get("goal_success") is True,
                "attempted_action": payload.get("attempted_action") is True,
                "nonzero_action_steps": int(payload.get("nonzero_action_steps") or 0) > 0
                or expected_task == "stand_up",
                "torso_series": _series_has_finite_value(payload.get("torso_z")),
                "action_norm_series": _series_has_finite_value(payload.get("action_norm")),
            }
        )
        if expected_task in {"walk_forward", "walk_backward"}:
            checks["delta_x_series"] = _series_has_finite_value(payload.get("delta_x_m"))
            checks.update(_policy_video_motion_checks(payload, expected_task))
        if expected_task in {"sidestep_left", "sidestep_right"}:
            checks["delta_y_series"] = _series_has_finite_value(payload.get("delta_y_m"))
            checks["delta_x_series"] = _series_has_finite_value(payload.get("delta_x_m"))
            checks.update(_policy_video_motion_checks(payload, expected_task))
        if expected_task in {"turn_left", "turn_right", "turn_around"}:
            checks["delta_yaw_series"] = _series_has_finite_value(
                payload.get("delta_yaw_rad")
            )
            checks.update(_policy_video_motion_checks(payload, expected_task))
    return {
        "ok": all(checks.values()),
        "telemetry": str(path),
        "checks": checks,
        "policy_source": payload.get("policy_source"),
        "task_id": payload.get("task_id"),
        "goal_success": payload.get("goal_success"),
        "rollout_ok": payload.get("rollout_ok"),
    }


def _validate_training_inputs_report(path: Path, tasks: tuple[str, ...]) -> dict[str, Any]:
    report = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    launch_tasks = report.get("launch_tasks") if isinstance(report.get("launch_tasks"), list) else []
    blockers = report.get("blockers") if isinstance(report.get("blockers"), list) else []
    curriculum = report.get("curriculum") if isinstance(report.get("curriculum"), dict) else {}
    datasets = report.get("datasets") if isinstance(report.get("datasets"), dict) else {}
    checks = {
        "present": path.is_file(),
        "ok": report.get("ok") is True,
        "launch_tasks_cover_requested": all(task in launch_tasks for task in tasks),
        "no_blockers": not blockers,
        "curriculum_hash": isinstance(curriculum.get("content_sha256"), str)
        and bool(curriculum.get("content_sha256")),
        "rl_from_sim_ready": datasets.get("rl_from_sim_ready") is True,
        "offline_datasets_not_blocking_current_plan": datasets.get(
            "offline_datasets_block_current_plan"
        )
        is False,
    }
    return {
        "ok": all(checks.values()),
        "report": str(path),
        "checks": checks,
        "launch_tasks": launch_tasks,
        "warning_kinds": [
            item.get("kind")
            for item in report.get("warnings", [])
            if isinstance(item, dict)
        ]
        if isinstance(report.get("warnings"), list)
        else [],
    }


def _validate_production_contract(
    *,
    checkpoint_manifest: Path,
    require_success: bool,
    run_deep_validators: bool,
    min_alberta_steps: int,
    min_backend_compare_steps: int,
    min_benchmark_steps_per_task: int,
    min_benchmark_seeds: int,
) -> dict[str, Any]:
    manifest = _load_json_dict(checkpoint_manifest)
    actual_total_steps = manifest.get("total_steps")
    actual_requested_total_steps = manifest.get("requested_total_steps")

    def _step_count_meets(value: Any, minimum: int) -> bool:
        if isinstance(value, bool):
            return False
        try:
            count = int(value)
        except (TypeError, ValueError):
            return False
        return count >= minimum

    checks = {
        "require_success": bool(require_success),
        "deep_validators_enabled": bool(run_deep_validators),
        "min_alberta_steps": min_alberta_steps >= PRODUCTION_MIN_ALBERTA_STEPS,
        "checkpoint_manifest_present": checkpoint_manifest.is_file(),
        "checkpoint_total_steps": _step_count_meets(
            actual_total_steps,
            PRODUCTION_MIN_ALBERTA_STEPS,
        ),
        "checkpoint_requested_total_steps": _step_count_meets(
            actual_requested_total_steps,
            PRODUCTION_MIN_ALBERTA_STEPS,
        ),
        "min_backend_compare_steps": min_backend_compare_steps
        >= PRODUCTION_MIN_BACKEND_COMPARE_STEPS,
        "min_benchmark_steps_per_task": min_benchmark_steps_per_task
        >= PRODUCTION_MIN_BENCHMARK_STEPS_PER_TASK,
        "min_benchmark_seeds": min_benchmark_seeds
        >= PRODUCTION_MIN_BENCHMARK_SEEDS,
    }
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "required": {
            "min_alberta_steps": PRODUCTION_MIN_ALBERTA_STEPS,
            "min_backend_compare_steps": PRODUCTION_MIN_BACKEND_COMPARE_STEPS,
            "min_benchmark_steps_per_task": PRODUCTION_MIN_BENCHMARK_STEPS_PER_TASK,
            "min_benchmark_seeds": PRODUCTION_MIN_BENCHMARK_SEEDS,
        },
        "actual": {
            "require_success": bool(require_success),
            "run_deep_validators": bool(run_deep_validators),
            "min_alberta_steps": int(min_alberta_steps),
            "checkpoint_manifest": str(checkpoint_manifest),
            "checkpoint_total_steps": actual_total_steps,
            "checkpoint_requested_total_steps": actual_requested_total_steps,
            "min_backend_compare_steps": int(min_backend_compare_steps),
            "min_benchmark_steps_per_task": int(min_benchmark_steps_per_task),
            "min_benchmark_seeds": int(min_benchmark_seeds),
        },
    }


def _validate_curriculum_eval_report(
    path: Path,
    *,
    checkpoint: Path,
    profile_id: str,
    tasks: tuple[str, ...],
    min_programmatic_pass_rate: float = 1.0,
) -> dict[str, Any]:
    report = _load_json_dict(path)
    task_rows = report.get("tasks") if isinstance(report.get("tasks"), list) else []
    task_by_id = {
        row.get("task_id"): row for row in task_rows if isinstance(row, dict)
    }
    expected_tasks = set(tasks)
    actual_tasks = {task_id for task_id in task_by_id if isinstance(task_id, str)}
    checkpoint_raw = report.get("checkpoint")
    checkpoint_matches = _checkpoint_path_matches_report(
        checkpoint_raw,
        report_path=path,
        checkpoint=checkpoint,
    )
    try:
        pass_rate = float(report.get("programmatic_pass_rate"))
    except (TypeError, ValueError):
        pass_rate = -1.0
    requested_rows = [task_by_id.get(task) for task in tasks]

    def _finite_float(value: Any) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if math.isfinite(number) else None

    def _positive_int(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value > 0

    def _error_absent(row: dict[str, Any]) -> bool:
        return row.get("error") in (None, "")

    success_rates = {
        task: _finite_float(task_by_id[task].get("success_rate"))
        for task in tasks
        if isinstance(task_by_id.get(task), dict)
    }
    mean_success_rate = _finite_float(report.get("mean_success_rate_overall"))
    n_successful_rows = sum(
        1
        for task in tasks
        if isinstance(task_by_id.get(task), dict)
        and task_by_id[task].get("success_programmatic") is True
        and success_rates.get(task) is not None
        and float(success_rates[task]) >= 1.0
        and _positive_int(task_by_id[task].get("episodes"))
        and _error_absent(task_by_id[task])
    )
    recomputed_pass_rate = (
        n_successful_rows / len(tasks) if len(tasks) > 0 else 0.0
    )
    policy_raw = report.get("policy")
    task_checks = {
        task: bool(
            isinstance(task_by_id.get(task), dict)
            and task_by_id[task].get("success_programmatic") is True
            and success_rates.get(task) is not None
            and float(success_rates[task]) >= 1.0
            and _positive_int(task_by_id[task].get("episodes"))
            and _error_absent(task_by_id[task])
        )
        for task in tasks
    }
    checks = {
        "present": path.is_file(),
        "valid_json_object": bool(report),
        "schema": report.get("schema") == CURRICULUM_EVAL_SCHEMA,
        "source": report.get("source") == "eval_text_policy",
        "profile": report.get("profile_id") == profile_id,
        "policy_checkpoint": isinstance(policy_raw, str)
        and policy_raw not in ("", "untrained_zero"),
        "checkpoint_matches": checkpoint_matches,
        "checkpoint_bound": checkpoint_matches,
        "task_set_exact": actual_tasks == expected_tasks,
        "task_count_covers_requested": all(task in task_by_id for task in tasks),
        "n_tasks": report.get("n_tasks") == len(tasks),
        "n_programmatic_pass": report.get("n_programmatic_pass") == len(tasks),
        "all_requested_tasks_programmatic_success": all(task_checks.values()),
        "task_success_rates": all(
            success_rates.get(task) is not None
            and float(success_rates[task]) >= 1.0
            for task in tasks
        ),
        "task_episodes": all(
            isinstance(row, dict) and _positive_int(row.get("episodes"))
            for row in requested_rows
        ),
        "task_errors_absent": all(
            isinstance(row, dict) and _error_absent(row) for row in requested_rows
        ),
        "programmatic_pass_rate": math.isfinite(pass_rate)
        and pass_rate >= min_programmatic_pass_rate,
        "programmatic_pass_rate_recomputed": math.isfinite(pass_rate)
        and math.isclose(pass_rate, recomputed_pass_rate, abs_tol=1e-9),
        "mean_success_rate_overall": mean_success_rate is not None
        and mean_success_rate >= min_programmatic_pass_rate,
    }
    return {
        "ok": all(checks.values()),
        "report": str(path),
        "checks": checks,
        "checkpoint": checkpoint_raw,
        "profile_id": report.get("profile_id"),
        "policy": policy_raw,
        "programmatic_pass_rate": pass_rate,
        "min_programmatic_pass_rate": float(min_programmatic_pass_rate),
        "recomputed_programmatic_pass_rate": recomputed_pass_rate,
        "task_checks": task_checks,
    }


def _checkpoint_path_matches_report(
    value: Any,
    *,
    report_path: Path,
    checkpoint: Path,
) -> bool:
    if not isinstance(value, str) or not value:
        return False
    raw = Path(value).expanduser()
    if raw.is_absolute():
        return raw.resolve(strict=False) == checkpoint.resolve()
    if len(raw.parts) <= 1:
        return False
    try:
        run_root = report_path.resolve().parents[2]
    except IndexError:
        return False
    return (run_root / raw).resolve(strict=False) == checkpoint.resolve()


def _validate_text_policy_eval_report(
    path: Path,
    *,
    checkpoint: Path,
    profile_id: str,
    tasks: tuple[str, ...],
) -> dict[str, Any]:
    report = _load_json_dict(path)
    task_metrics = report.get("tasks") if isinstance(report.get("tasks"), dict) else {}
    actual_tasks = set(task_metrics)
    checkpoint_raw = report.get("checkpoint")
    checkpoint_matches = _checkpoint_path_matches_report(
        checkpoint_raw,
        report_path=path,
        checkpoint=checkpoint,
    )
    def _finite_metric(task: str, key: str) -> bool:
        return (
            _series_finite_number({"final": task_metrics[task].get(key)})
            is not None
        )

    per_task_checks = {
        task: bool(
            isinstance(task_metrics.get(task), dict)
            and isinstance(task_metrics[task].get("episodes"), int)
            and not isinstance(task_metrics[task].get("episodes"), bool)
            and task_metrics[task].get("episodes") > 0
            and _finite_metric(task, "success_rate")
            and _finite_metric(task, "failure_rate")
        )
        for task in tasks
    }
    checks = {
        "present": path.is_file(),
        "valid_json_object": bool(report),
        "schema": report.get("schema") == TEXT_POLICY_EVAL_SCHEMA,
        "profile": report.get("profile_id") == profile_id,
        "checkpoint_matches": checkpoint_matches,
        "task_set_exact": actual_tasks == set(tasks),
        "task_count_covers_requested": all(task in task_metrics for task in tasks),
        "per_task_success_fields": all(per_task_checks.values()),
    }
    return {
        "ok": all(checks.values()),
        "report": str(path),
        "checks": checks,
        "checkpoint": checkpoint_raw,
        "profile_id": report.get("profile_id"),
        "task_checks": per_task_checks,
    }


def _validate_instance_launch_hygiene(run_root: Path) -> dict[str, Any]:
    path = run_root / "instance_launch_hygiene.json"
    report = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    if not report:
        preflight = _read_json_object(
            run_root / "evidence" / "full_training_preflight" / "preflight_report.json"
        )
        launch_hygiene = preflight.get("launch_hygiene")
        if not isinstance(launch_hygiene, dict):
            launch_template = preflight.get("launch_template")
            if isinstance(launch_template, dict):
                launch_hygiene = launch_template.get("hygiene")
        report = launch_hygiene if isinstance(launch_hygiene, dict) else {}
    checks = report.get("checks") if isinstance(report.get("checks"), dict) else {}
    required = {
        "present": bool(report),
        "ok": report.get("ok") is True,
        "no_inline_object_storage_credentials": checks.get(
            "no_inline_object_storage_credentials"
        )
        is True,
        "uses_repo_owned_stage_runner": checks.get("uses_repo_owned_stage_runner")
        is True,
        "uses_training_s3_uri": checks.get("uses_training_s3_uri") is True,
        "has_status_heartbeat_upload_contract": checks.get(
            "has_status_heartbeat_upload_contract"
        )
        is True,
    }
    return {
        "ok": all(required.values()),
        "report": str(path if path.is_file() else run_root / "evidence" / "full_training_preflight" / "preflight_report.json"),
        "checks": required,
        "secret_fields_embedded": report.get("secret_fields_embedded", []),
        "recommendations": report.get("recommendations", []),
    }


def _validate_status_consistency(
    run_root: Path,
    current_checks: dict[str, bool],
) -> dict[str, Any]:
    monitor = _read_json_object(run_root / "monitor_status.json")
    closeout = _read_json_object(run_root / "closeout_status.json")
    finalization = _read_json_object(run_root / "finalization_report.json")
    inventory = _read_json_object(run_root / "artifact_inventory.json")
    contradictions: list[dict[str, Any]] = []

    monitor_checks = monitor.get("checks") if isinstance(monitor.get("checks"), dict) else {}
    for gate, monitor_value in sorted(monitor_checks.items()):
        if gate not in current_checks:
            continue
        current_value = bool(current_checks[gate])
        if bool(monitor_value) and not current_value:
            contradictions.append(
                {
                    "source": "monitor_status",
                    "gate": gate,
                    "stale_value": bool(monitor_value),
                    "current_value": current_value,
                }
            )

    closeout_monitor = (
        closeout.get("monitor") if isinstance(closeout.get("monitor"), dict) else {}
    )
    closeout_monitor_summary = (
        closeout_monitor.get("summary")
        if isinstance(closeout_monitor.get("summary"), dict)
        else {}
    )
    for gate in closeout_monitor_summary.get("passed_gates", []) or []:
        if gate in current_checks and not bool(current_checks[gate]):
            contradictions.append(
                {
                    "source": "closeout_status.monitor.summary",
                    "gate": gate,
                    "stale_value": True,
                    "current_value": False,
                }
            )

    closeout_finalization = (
        closeout.get("finalization")
        if isinstance(closeout.get("finalization"), dict)
        else {}
    )
    if closeout_finalization.get("ok") is True and finalization.get("ok") is False:
        contradictions.append(
            {
                "source": "closeout_status.finalization",
                "gate": "finalization_report",
                "stale_value": True,
                "current_value": False,
            }
        )
    closeout_inventory = (
        closeout.get("artifact_inventory")
        if isinstance(closeout.get("artifact_inventory"), dict)
        else {}
    )
    if closeout_inventory.get("ok") is True and inventory.get("ok") is False:
        contradictions.append(
            {
                "source": "closeout_status.artifact_inventory",
                "gate": "artifact_inventory",
                "stale_value": True,
                "current_value": False,
                "stale_present_count": closeout_inventory.get("present_count"),
                "current_present_count": inventory.get("present_count"),
                "stale_required_count": closeout_inventory.get("required_count"),
                "current_required_count": inventory.get("required_count"),
            }
        )

    return {
        "ok": not contradictions,
        "checks": {
            "monitor_status_consistent": not any(
                item["source"] == "monitor_status" for item in contradictions
            ),
            "closeout_monitor_consistent": not any(
                item["source"] == "closeout_status.monitor.summary"
                for item in contradictions
            ),
            "closeout_finalization_consistent": not any(
                item["source"] == "closeout_status.finalization"
                for item in contradictions
            ),
            "closeout_inventory_consistent": not any(
                item["source"] == "closeout_status.artifact_inventory"
                for item in contradictions
            ),
        },
        "contradictions": contradictions,
    }


def validate_nebius_full_training_run(
    run_root: Path,
    *,
    run_id: str | None = None,
    profile_id: str = "asimov-1",
    tasks: tuple[str, ...] = DEFAULT_TASKS,
    min_alberta_steps: int = 150_000_000,
    min_backend_compare_steps: int = 30_000,
    min_benchmark_steps_per_task: int = 16_000,
    min_benchmark_seeds: int = 3,
    require_success: bool = True,
    run_deep_validators: bool = True,
) -> dict[str, Any]:
    """Validate all artifacts expected from the full H200 robot training run."""
    run_root = run_root.resolve()
    status_dir = run_root / "status"
    evidence_dir = run_root / "evidence"
    checkpoints_dir = run_root / "checkpoints"
    success_path = status_dir / "success.txt"
    failure_path = status_dir / "failure.txt"

    stage_report = _stage_checks(run_root)
    stage_status_report = _stage_status_checks(run_root)
    checks: dict[str, bool] = {
        "run_root": run_root.is_dir(),
        "success_marker": success_path.is_file(),
        "failure_marker_absent": not failure_path.exists(),
        "stage_logs": bool(stage_report["ok"]),
        "stage_status": bool(stage_status_report["ok"]),
    }
    reports: dict[str, Any] = {
        "stages": stage_report,
        "stage_status": stage_status_report,
    }

    reports["production_contract"] = _validate_production_contract(
        checkpoint_manifest=checkpoints_dir / "asimov_1_alberta_full" / "manifest.json",
        require_success=require_success,
        run_deep_validators=run_deep_validators,
        min_alberta_steps=min_alberta_steps,
        min_backend_compare_steps=min_backend_compare_steps,
        min_benchmark_steps_per_task=min_benchmark_steps_per_task,
        min_benchmark_seeds=min_benchmark_seeds,
    )
    checks["production_contract"] = bool(
        reports["production_contract"].get("ok")
    )

    reports["instance_launch_hygiene"] = _validate_instance_launch_hygiene(run_root)
    checks["instance_launch_hygiene"] = bool(
        reports["instance_launch_hygiene"].get("ok")
    )

    reports["training_inputs"] = _validate_training_inputs_report(
        evidence_dir / "full_training_preflight" / "training_inputs_report.json",
        tasks,
    )
    checks["training_inputs"] = bool(reports["training_inputs"].get("ok"))
    multi_robot_smoke_videos_dir = evidence_dir / "multi_robot_smoke_videos"
    production_videos_dir = evidence_dir / "agent_videos"
    reports["multi_robot_readiness"] = validate_multi_robot_training_readiness(
        profiles=list(DEFAULT_MULTI_ROBOT_PROFILES),
        commands=list(DEFAULT_MULTI_ROBOT_COMMANDS),
        video_evidence=multi_robot_smoke_videos_dir,
        pca_dim=32,
        min_video_bytes=1024,
        require_combined_videos=True,
    )
    checks["multi_robot_readiness"] = bool(
        reports["multi_robot_readiness"].get("ok")
    )

    alberta_ckpt = checkpoints_dir / "asimov_1_alberta_full"
    if run_deep_validators and alberta_ckpt.exists():
        reports["alberta_checkpoint"] = validate_alberta_robot_checkpoint(
            alberta_ckpt,
            profile_id=profile_id,
            required_tasks=list(tasks),
            min_steps=min_alberta_steps,
            require_domain_rand=True,
            require_inference=True,
            require_phase_promotion=True,
        )
        reports["asimov1_alberta_production"] = validate_asimov1_production_checkpoint(
            alberta_ckpt,
            min_steps=min_alberta_steps,
            require_inference_check=True,
        )
        checks["alberta_checkpoint"] = bool(reports["alberta_checkpoint"].get("ok"))
        checks["asimov1_alberta_production"] = bool(
            reports["asimov1_alberta_production"].get("ok")
        )
    else:
        checks["alberta_checkpoint"] = _has_alberta_checkpoint(alberta_ckpt)
        checks["asimov1_alberta_production"] = _has_alberta_checkpoint(alberta_ckpt)
        reports["alberta_checkpoint"] = {
            "ok": checks["alberta_checkpoint"],
            "checkpoint": str(alberta_ckpt),
            "skipped_deep_validation": not run_deep_validators,
        }

    backend_dir = evidence_dir / "backend_compare" / profile_id
    reports["backend_comparison"] = validate_backend_comparison_artifacts(
        backend_dir,
        expected_profile=profile_id,
        min_steps=min_backend_compare_steps,
    )
    checks["backend_comparison"] = bool(reports["backend_comparison"].get("ok"))

    reports["joint_reach_benchmark"] = validate_alberta_benchmark_artifacts(
        evidence_dir / "alberta_joint_reach",
        expected_env="joint_reach",
        min_seeds=min_benchmark_seeds,
        min_steps_per_task=min_benchmark_steps_per_task,
        min_tasks=4,
        require_alberta_acc_gte_ppo=True,
        require_alberta_forgetting_lte_ppo=True,
    )
    reports["obstacle_course_benchmark"] = validate_alberta_benchmark_artifacts(
        evidence_dir / "alberta_obstacle_course",
        expected_env="obstacle_course",
        min_seeds=min_benchmark_seeds,
        min_steps_per_task=min_benchmark_steps_per_task,
        min_tasks=4,
        require_alberta_forgetting_lte_ppo=True,
        require_demo_video=True,
    )
    checks["joint_reach_benchmark"] = bool(reports["joint_reach_benchmark"].get("ok"))
    checks["obstacle_course_benchmark"] = bool(
        reports["obstacle_course_benchmark"].get("ok")
    )

    brax_dir = evidence_dir / "full_training_preflight" / "asimov_1_brax_mjx_baseline"
    full_run = brax_dir / "full_training_run.json"
    if run_deep_validators and full_run.exists():
        reports["brax_full_training_run"] = validate_asimov1_full_training_run(
            full_run,
            job_dir=brax_dir,
        )
        reports["brax_production_checkpoint"] = validate_asimov1_production_checkpoint(
            brax_dir,
            min_steps=min_alberta_steps,
            require_inference_check=True,
        )
        checks["brax_full_training_run"] = bool(
            reports["brax_full_training_run"].get("ok")
        )
        checks["brax_production_checkpoint"] = bool(
            reports["brax_production_checkpoint"].get("ok")
        )
    else:
        checks["brax_full_training_run"] = full_run.is_file()
        checks["brax_production_checkpoint"] = _has_brax_checkpoint(brax_dir)
        reports["brax_full_training_run"] = {
            "ok": checks["brax_full_training_run"],
            "report": str(full_run),
            "skipped_deep_validation": not run_deep_validators,
        }
        reports["brax_production_checkpoint"] = {
            "ok": checks["brax_production_checkpoint"],
            "checkpoint": str(brax_dir),
            "skipped_deep_validation": not run_deep_validators,
        }

    reports["video_review"] = review_videos(
        production_videos_dir,
        out_dir=evidence_dir / "video_review_production",
        samples=5,
        min_frames=5,
        min_nonblank_ratio=0.05,
        min_mean_frame_delta=0.01,
        min_visual_progress=0.0001,
        require_telemetry=True,
    )
    checks["video_review"] = bool(reports["video_review"].get("ok"))
    reports["production_policy_videos"] = _validate_production_policy_videos(
        production_videos_dir,
        checkpoint=alberta_ckpt,
        profile_id=profile_id,
        commands=tuple(DEFAULT_MULTI_ROBOT_COMMANDS),
    )
    checks["production_policy_videos"] = bool(
        reports["production_policy_videos"].get("ok")
    )
    curriculum_eval_path = run_root / CURRICULUM_EVAL_REPORT_REL
    curriculum_eval_native_path = run_root / CURRICULUM_EVAL_NATIVE_REL
    reports["curriculum_eval_native"] = _validate_text_policy_eval_report(
        curriculum_eval_native_path,
        checkpoint=alberta_ckpt,
        profile_id=profile_id,
        tasks=tasks,
    )
    checks["curriculum_eval_native"] = bool(
        reports["curriculum_eval_native"].get("ok")
    )
    reports["curriculum_eval"] = _validate_curriculum_eval_report(
        curriculum_eval_path,
        checkpoint=alberta_ckpt,
        profile_id=profile_id,
        tasks=tasks,
        min_programmatic_pass_rate=1.0,
    )
    checks["curriculum_eval"] = bool(reports["curriculum_eval"].get("ok"))

    reports["status_consistency"] = _validate_status_consistency(run_root, checks)
    checks["status_consistency"] = bool(reports["status_consistency"].get("ok"))

    report = {
        "schema": "robot-nebius-full-training-validation-v1",
        "ok": all(checks.values()),
        "run_id": run_id,
        "run_root": str(run_root),
        "profile_id": profile_id,
        "tasks": list(tasks),
        "thresholds": {
            "min_alberta_steps": int(min_alberta_steps),
            "min_backend_compare_steps": int(min_backend_compare_steps),
            "min_benchmark_steps_per_task": int(min_benchmark_steps_per_task),
            "min_benchmark_seeds": int(min_benchmark_seeds),
            "require_success": bool(require_success),
            "run_deep_validators": bool(run_deep_validators),
        },
        "checks": checks,
        "reports": reports,
    }
    _write_json(run_root / "validation_report.json", report)
    _write_markdown(run_root / "validation_summary.md", report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--bucket", default=None)
    parser.add_argument(
        "--endpoint",
        default=os.environ.get(
            "NEBIUS_S3_ENDPOINT", "https://storage.eu-north1.nebius.cloud"
        ),
    )
    parser.add_argument(
        "--dest",
        type=Path,
        default=ROOT / "evidence" / "nebius_full_training" / "synced_run",
    )
    parser.add_argument("--skip-sync", action="store_true")
    parser.add_argument("--aws-bin", default="aws")
    parser.add_argument("--profile", default="asimov-1")
    parser.add_argument("--tasks", nargs="+", default=list(DEFAULT_TASKS))
    parser.add_argument("--min-alberta-steps", type=int, default=150_000_000)
    parser.add_argument("--min-backend-compare-steps", type=int, default=30_000)
    parser.add_argument("--min-benchmark-steps-per-task", type=int, default=16_000)
    parser.add_argument("--min-benchmark-seeds", type=int, default=3)
    parser.add_argument("--allow-incomplete", action="store_true")
    parser.add_argument("--no-deep-validators", action="store_true")
    args = parser.parse_args(argv)

    sync_report = None
    if not args.skip_sync:
        if not args.run_id or not args.bucket:
            parser.error("--run-id and --bucket are required unless --skip-sync is set")
        sync_report = sync_from_s3(
            run_id=args.run_id,
            bucket=args.bucket,
            endpoint=args.endpoint,
            dest=args.dest,
            aws_bin=args.aws_bin,
        )
        _write_json(args.dest / "sync_report.json", sync_report)
        if not sync_report["ok"]:
            print(json.dumps({"ok": False, "sync": sync_report}, indent=2))
            return 2

    report = validate_nebius_full_training_run(
        args.dest,
        run_id=args.run_id,
        profile_id=args.profile,
        tasks=tuple(args.tasks),
        min_alberta_steps=args.min_alberta_steps,
        min_backend_compare_steps=args.min_backend_compare_steps,
        min_benchmark_steps_per_task=args.min_benchmark_steps_per_task,
        min_benchmark_seeds=args.min_benchmark_seeds,
        require_success=not args.allow_incomplete,
        run_deep_validators=not args.no_deep_validators,
    )
    if sync_report is not None:
        report["sync"] = sync_report
        _write_json(args.dest / "validation_report.json", report)
        _write_markdown(args.dest / "validation_summary.md", report)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
