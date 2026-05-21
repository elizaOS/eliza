#!/usr/bin/env python3
"""Validate deterministic OpenLane/OpenROAD replay execution evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/openlane_replay_execution/validation/openlane_replay_execution.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.openlane_replay_execution.v1"
EXPECTED_CLAIM_BOUNDARY = "openlane_replay_execution_evidence_only_no_release_claim"
BASE_REQUIRED_ARTIFACTS = {
    "metrics",
    "openlane_log",
    "openroad_log",
    "def",
    "gds",
}


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
        raise ValueError(f"{rel(path)}: expected JSON object")
    return data


def validate_artifact(label: str, item: Any, allow_missing_required: bool) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    if item.get("status") not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    if (
        item.get("required") is True
        and item.get("status") != "PRESENT"
        and not allow_missing_required
    ):
        errors.append(f"{label} is required but missing")
    if item.get("status") == "PRESENT":
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
        if not isinstance(item.get("size_bytes"), int) or item["size_bytes"] <= 0:
            errors.append(f"{label}.size_bytes must be positive")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("status") not in {
        "EXECUTED_REPLAY_EVIDENCE_READY",
        "BLOCKED_EXECUTION_EVIDENCE",
    }:
        errors.append("unsupported status")
    if report.get("status") != "EXECUTED_REPLAY_EVIDENCE_READY" and report.get(
        "optimization_claim_allowed"
    ) is not False:
        errors.append("optimization_claim_allowed must be false unless execution evidence is ready")
    replay_role = report.get("replay_role", "candidate")
    if replay_role not in {"baseline", "candidate"}:
        errors.append("replay_role must be baseline or candidate")
    if not isinstance(report.get("candidate_id"), str) or not report["candidate_id"]:
        errors.append("candidate_id must be present")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict):
        return errors + ["artifacts must be a mapping"]
    required_artifacts = set(BASE_REQUIRED_ARTIFACTS)
    if replay_role == "candidate":
        required_artifacts.update({"replay_queue", "replay_preflight"})
        required_artifacts.add("replay_handoff")
    missing = sorted(required_artifacts - set(artifacts))
    if missing and report.get("status") == "EXECUTED_REPLAY_EVIDENCE_READY":
        errors.append(f"missing artifacts: {', '.join(missing)}")
    allow_missing_required = report.get("status") == "BLOCKED_EXECUTION_EVIDENCE"
    for name, item in artifacts.items():
        errors.extend(validate_artifact(name, item, allow_missing_required))
    metric_summary = report.get("metric_summary")
    if not isinstance(metric_summary, dict):
        errors.append("metric_summary must be a mapping")
    metric_key_summary = report.get("metric_key_summary")
    if not isinstance(metric_key_summary, dict):
        errors.append("metric_key_summary must be a mapping")
    else:
        for field in (
            "numeric_metric_count",
            "has_timing_metric",
            "has_drc_or_signoff_metric",
            "has_objective_metric",
        ):
            if field not in metric_key_summary:
                errors.append(f"metric_key_summary.{field} missing")
        if report.get("status") == "EXECUTED_REPLAY_EVIDENCE_READY":
            if metric_key_summary.get("numeric_metric_count", 0) <= 0:
                errors.append("ready execution needs numeric metrics")
            for field in ("has_timing_metric", "has_drc_or_signoff_metric", "has_objective_metric"):
                if metric_key_summary.get(field) is not True:
                    errors.append(f"ready execution needs metric_key_summary.{field}=true")
    log_summary = report.get("log_summary")
    if not isinstance(log_summary, dict):
        errors.append("log_summary must be a mapping")
    else:
        for label in ("openlane_log", "openroad_log"):
            summary = log_summary.get(label)
            if not isinstance(summary, dict):
                errors.append(f"log_summary.{label} must be a mapping")
                continue
            for field in ("status", "line_count", "error_like_line_count"):
                if field not in summary:
                    errors.append(f"log_summary.{label}.{field} missing")
            if report.get("status") == "EXECUTED_REPLAY_EVIDENCE_READY":
                if summary.get("status") != "PRESENT":
                    errors.append(f"ready execution needs {label} present")
                if summary.get("line_count", 0) <= 0:
                    errors.append(f"ready execution needs non-empty {label}")
                if summary.get("error_like_line_count", 0) != 0:
                    errors.append(f"ready execution needs zero error-like lines in {label}")
    blockers = report.get("blockers")
    if report.get("status") == "BLOCKED_EXECUTION_EVIDENCE" and not blockers:
        errors.append("blocked execution evidence must list blockers")
    if report.get("status") == "EXECUTED_REPLAY_EVIDENCE_READY" and blockers:
        errors.append("ready execution evidence must not list blockers")
    gates = report.get("next_required_gates")
    if not isinstance(gates, list) or len(gates) < 3:
        errors.append("next_required_gates must be concrete")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.openlane_replay_execution missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.openlane_replay_execution {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openlane_replay_execution {error}")
        return 1
    status = "PASS" if report["status"] == "EXECUTED_REPLAY_EVIDENCE_READY" else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.openlane_replay_execution "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
