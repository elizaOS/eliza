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
    checks = {
        "manifest": manifest_path.is_file(),
        "manifest_ok": manifest.get("ok") is True,
        "checkpoint_exists": _has_alberta_checkpoint(checkpoint),
        "manifest_policy_checkpoint": manifest_checkpoint == checkpoint_path,
        "profile_entry": bool(entries),
        "profile_policy_checkpoint": any(value == checkpoint_path for value in profile_checkpoints),
        "expected_videos": not missing,
        "expected_telemetry": not missing_telemetry,
        "video_sizes": not undersized and len(sizes) == len(expected),
        "telemetry_sizes": not undersized_telemetry
        and len(telemetry_sizes) == len(expected_telemetry),
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
        "min_video_bytes": int(min_video_bytes),
        "undersized": undersized,
        "undersized_telemetry": undersized_telemetry,
        "missing": missing,
        "missing_telemetry": missing_telemetry,
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


def _validate_instance_launch_hygiene(run_root: Path) -> dict[str, Any]:
    path = run_root / "instance_launch_hygiene.json"
    report = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    checks = report.get("checks") if isinstance(report.get("checks"), dict) else {}
    required = {
        "present": path.is_file(),
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
        "report": str(path),
        "checks": required,
        "secret_fields_embedded": report.get("secret_fields_embedded", []),
        "recommendations": report.get("recommendations", []),
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

    reports["instance_launch_hygiene"] = _validate_instance_launch_hygiene(run_root)
    checks["instance_launch_hygiene"] = bool(
        reports["instance_launch_hygiene"].get("ok")
    )

    reports["training_inputs"] = _validate_training_inputs_report(
        evidence_dir / "full_training_preflight" / "training_inputs_report.json",
        tasks,
    )
    checks["training_inputs"] = bool(reports["training_inputs"].get("ok"))
    reports["multi_robot_readiness"] = validate_multi_robot_training_readiness(
        profiles=list(DEFAULT_MULTI_ROBOT_PROFILES),
        commands=list(DEFAULT_MULTI_ROBOT_COMMANDS),
        video_evidence=evidence_dir / "agent_videos",
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
        require_alberta_acc_gte_ppo=True,
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

    videos_dir = evidence_dir / "agent_videos"
    reports["video_review"] = review_videos(
        videos_dir,
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
        videos_dir,
        checkpoint=alberta_ckpt,
        profile_id=profile_id,
        commands=tuple(DEFAULT_MULTI_ROBOT_COMMANDS),
    )
    checks["production_policy_videos"] = bool(
        reports["production_policy_videos"].get("ok")
    )

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
