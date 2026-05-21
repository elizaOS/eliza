#!/usr/bin/env python3
"""Preflight or execute a quarantined macro-placement replay bundle.

Default mode is a dry-run preflight. It inspects one replay-plan entry, verifies
the candidate/bundle artifacts, records OpenLane/OpenROAD availability, and
fails closed unless the plan is ready and --execute is explicitly supplied.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PLAN = ROOT / "build/ai_eda/macro_placement_replay/validation/replay_plan.json"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/macro_placement_replay_preflight"
DEFAULT_OPENLANE_CONFIG = ROOT / "pd/openlane/config.sky130.json"
CLAIM_BOUNDARY = "macro_placement_replay_preflight_only_no_ppa_signoff_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def repo_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else ROOT / path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def select_plan(report: dict[str, Any], candidate_id: str | None) -> dict[str, Any]:
    plans = report.get("plans")
    if not isinstance(plans, list) or not plans:
        raise ValueError("replay plan contains no candidate plans")
    if candidate_id:
        for item in plans:
            if isinstance(item, dict) and item.get("candidate_id") == candidate_id:
                return item
        raise ValueError(f"candidate_id not found in replay plan: {candidate_id}")
    ordered = sorted(
        (item for item in plans if isinstance(item, dict)),
        key=lambda item: (
            0 if item.get("status") == "READY_FOR_DETERMINISTIC_REPLAY" else 1,
            str(item.get("candidate_id", "")),
        ),
    )
    if not ordered:
        raise ValueError("replay plan contains no valid candidate plan mappings")
    return ordered[0]


def artifact_status(plan: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    artifacts: list[dict[str, Any]] = []
    errors: list[str] = []
    expected_hash_fields = {
        "candidate_path": "candidate_sha256",
        "placement_case_path": "placement_case_sha256",
    }
    for field in ("candidate_path", "placement_case_path", "tool_action_manifest"):
        value = plan.get(field)
        if not isinstance(value, str) or not value:
            errors.append(f"missing {field}")
            continue
        path = repo_path(value)
        item = {"kind": field, "path": rel(path), "exists": path.exists()}
        if path.is_file():
            item["sha256"] = sha256_file(path)
            expected = plan.get(expected_hash_fields.get(field, ""))
            if isinstance(expected, str) and item["sha256"] != expected:
                errors.append(f"{field} sha256 mismatch")
        else:
            errors.append(f"{field} does not exist: {rel(path)}")
        artifacts.append(item)
    bundle_artifacts = plan.get("artifacts")
    if not isinstance(bundle_artifacts, dict):
        errors.append("plan.artifacts must be a mapping")
        return artifacts, errors
    for field in ("bundle_dir", "macro_placement_cfg", "placement_overrides"):
        value = bundle_artifacts.get(field)
        if not isinstance(value, str) or not value:
            errors.append(f"missing artifacts.{field}")
            continue
        path = repo_path(value)
        item = {"kind": field, "path": rel(path), "exists": path.exists()}
        if path.is_file():
            item["sha256"] = sha256_file(path)
        elif field == "bundle_dir" and path.is_dir():
            item["entry_count"] = len(list(path.iterdir()))
        else:
            errors.append(f"artifacts.{field} does not exist: {rel(path)}")
        artifacts.append(item)
    return artifacts, errors


def tool_status(openlane_bin: str, openroad_bin: str, config: Path) -> dict[str, Any]:
    openlane_path = shutil.which(openlane_bin)
    openroad_path = shutil.which(openroad_bin)
    return {
        "openlane_bin": openlane_bin,
        "openlane_path": openlane_path,
        "openlane_available": openlane_path is not None,
        "openroad_bin": openroad_bin,
        "openroad_path": openroad_path,
        "openroad_available": openroad_path is not None,
        "openlane_config": rel(config),
        "openlane_config_exists": config.is_file(),
    }


def execute_openlane(
    openlane_bin: str,
    openlane_config: Path,
    macro_cfg: Path,
    out_dir: Path,
    timeout_seconds: int,
) -> dict[str, Any]:
    command = [
        openlane_bin,
        "--config",
        str(openlane_config),
    ]
    env = {"MACRO_PLACEMENT_CFG": str(macro_cfg)}
    stdout_path = out_dir / "openlane.stdout.txt"
    stderr_path = out_dir / "openlane.stderr.txt"
    try:
        result = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={**os.environ, **env},
        )
        stdout_path.write_text(result.stdout, encoding="utf-8")
        stderr_path.write_text(result.stderr, encoding="utf-8")
        return {
            "command": command,
            "environment_overrides": env,
            "returncode": result.returncode,
            "stdout": rel(stdout_path),
            "stderr": rel(stderr_path),
        }
    except subprocess.TimeoutExpired as exc:
        stdout_path.write_text(exc.stdout or "", encoding="utf-8")
        stderr_path.write_text(exc.stderr or "", encoding="utf-8")
        return {
            "command": command,
            "environment_overrides": env,
            "returncode": 124,
            "stdout": rel(stdout_path),
            "stderr": rel(stderr_path),
            "error": f"timeout after {timeout_seconds}s",
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default="validation")
    parser.add_argument("--plan", type=Path, default=DEFAULT_PLAN)
    parser.add_argument("--candidate-id")
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--openlane-bin", default="openlane")
    parser.add_argument("--openroad-bin", default="openroad")
    parser.add_argument("--openlane-config", type=Path, default=DEFAULT_OPENLANE_CONFIG)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--timeout-seconds", type=int, default=6 * 3600)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.plan.exists():
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight missing_plan {args.plan}")
        return 1
    out_dir = args.out_root / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    report_path = out_dir / "replay_preflight_report.json"
    try:
        replay_plan = load_json(args.plan)
        plan = select_plan(replay_plan, args.candidate_id)
        artifacts, artifact_errors = artifact_status(plan)
        tools = tool_status(args.openlane_bin, args.openroad_bin, args.openlane_config)
        blockers = list(plan.get("blockers") or [])
        if artifact_errors:
            blockers.extend(artifact_errors)
        if not tools["openlane_config_exists"]:
            blockers.append("OpenLane config is missing")
        if not tools["openlane_available"]:
            blockers.append("OpenLane executable is not available")
        if not tools["openroad_available"]:
            blockers.append("OpenROAD executable is not available")
        if plan.get("status") != "READY_FOR_DETERMINISTIC_REPLAY":
            blockers.append(
                "selected replay-plan candidate is not marked READY_FOR_DETERMINISTIC_REPLAY"
            )

        execution: dict[str, Any] = {
            "requested": bool(args.execute),
            "attempted": False,
            "reason": "dry_run_preflight_only",
        }
        if args.execute and not blockers:
            macro_cfg = repo_path(str(plan["artifacts"]["macro_placement_cfg"]))
            execution = {
                "requested": True,
                "attempted": True,
                **execute_openlane(
                    args.openlane_bin,
                    args.openlane_config,
                    macro_cfg,
                    out_dir,
                    args.timeout_seconds,
                ),
            }
            if execution.get("returncode") != 0:
                blockers.append("OpenLane execution returned nonzero status")
        elif args.execute:
            execution["reason"] = "blocked_before_execution"

        status = (
            "READY_TO_EXECUTE" if not blockers and not args.execute else "BLOCKED_REPLAY_EXECUTION"
        )
        if args.execute and execution.get("attempted") and execution.get("returncode") == 0:
            status = "EXECUTED_OPENLANE_REPLAY_UNVERIFIED"

        report = {
            "schema": "eliza.ai_eda.macro_placement_replay_preflight.v1",
            "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "run_id": args.run_id,
            "claim_boundary": CLAIM_BOUNDARY,
            "release_use_allowed": False,
            "source_replay_plan": rel(args.plan),
            "candidate_id": plan.get("candidate_id"),
            "placement_case_id": plan.get("placement_case_id"),
            "plan_status": plan.get("status"),
            "artifacts": artifacts,
            "tool_status": tools,
            "execution": execution,
            "status": status,
            "blockers": blockers,
            "next_required_gates": [
                "check_candidate_manifests for the selected candidate",
                "check_macro_placement_replay_plan for the source replay plan",
                "OpenLane/OpenROAD replay on an isolated run directory",
                "parse final metrics and compare against the baseline E1 run",
                "human PD review before any source or release claim",
            ],
        }
    except Exception as exc:  # noqa: BLE001
        report = {
            "schema": "eliza.ai_eda.macro_placement_replay_preflight.v1",
            "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "run_id": args.run_id,
            "claim_boundary": CLAIM_BOUNDARY,
            "release_use_allowed": False,
            "source_replay_plan": rel(args.plan),
            "status": "FAIL_INVALID_REPLAY_PREFLIGHT",
            "blockers": [str(exc)],
        }
        report_path.write_text(
            json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight {exc}")
        return 1

    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if report["status"] == "FAIL_INVALID_REPLAY_PREFLIGHT":
        print(f"STATUS: FAIL ai_eda.macro_placement_replay_preflight {report_path}")
        return 1
    if report["status"].startswith("BLOCKED"):
        print(
            "STATUS: PASS_BLOCKED ai_eda.macro_placement_replay_preflight "
            f"candidate={report['candidate_id']} blockers={len(report['blockers'])} {report_path}"
        )
        return 0
    print(
        "STATUS: PASS ai_eda.macro_placement_replay_preflight "
        f"candidate={report['candidate_id']} status={report['status']} {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
