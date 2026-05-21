#!/usr/bin/env python3
"""Validate baseline-vs-candidate OpenLane/OpenROAD replay comparison evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/openlane_replay_comparison/validation/openlane_replay_comparison.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.openlane_replay_comparison.v1"
EXPECTED_CLAIM_BOUNDARY = "openlane_replay_comparison_evidence_only_no_release_claim"


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


def validate_artifact(label: str, item: Any, allow_missing: bool) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        return [f"{label}.path must be present"]
    status = item.get("status")
    if status not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    if status == "MISSING" and not allow_missing:
        errors.append(f"{label} is required but missing")
    if status == "PRESENT":
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
    if report.get("status") not in {"COMPARISON_READY", "BLOCKED_COMPARISON_EVIDENCE"}:
        errors.append("unsupported status")
    if report.get("status") != "COMPARISON_READY" and report.get("optimization_claim_allowed") is not False:
        errors.append("optimization_claim_allowed must be false unless comparison is ready")
    if report.get("status") == "COMPARISON_READY" and report.get("optimization_claim_allowed") is not True:
        errors.append("ready comparison must allow optimization claim gate")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict):
        return errors + ["artifacts must be a mapping"]
    for name in ("baseline_execution", "candidate_execution"):
        if name not in artifacts:
            errors.append(f"artifacts.{name} missing")
        else:
            errors.extend(
                validate_artifact(
                    f"artifacts.{name}",
                    artifacts[name],
                    report.get("status") == "BLOCKED_COMPARISON_EVIDENCE",
                )
            )
    comparisons = report.get("comparisons")
    if not isinstance(comparisons, list):
        errors.append("comparisons must be a list")
    elif report.get("comparison_count") != len(comparisons):
        errors.append("comparison_count mismatch")
    improvements = report.get("improvements")
    if not isinstance(improvements, list):
        errors.append("improvements must be a list")
    elif report.get("improvement_count") != len(improvements):
        errors.append("improvement_count mismatch")
    regressions = report.get("signoff_regressions")
    if not isinstance(regressions, list):
        errors.append("signoff_regressions must be a list")
    elif report.get("signoff_regression_count") != len(regressions):
        errors.append("signoff_regression_count mismatch")
    blockers = report.get("blockers")
    if report.get("status") == "BLOCKED_COMPARISON_EVIDENCE" and not blockers:
        errors.append("blocked comparison must list blockers")
    if report.get("status") == "COMPARISON_READY":
        if blockers:
            errors.append("ready comparison must not list blockers")
        if not improvements:
            errors.append("ready comparison must include at least one improvement")
        if regressions:
            errors.append("ready comparison must not include signoff regressions")
        if report.get("baseline_candidate_id") == report.get("candidate_id"):
            errors.append("baseline and candidate ids must differ")
        baseline_path = artifacts.get("baseline_execution", {}).get("path")
        candidate_path = artifacts.get("candidate_execution", {}).get("path")
        if isinstance(baseline_path, str):
            baseline = load_json(repo_path(baseline_path))
            if baseline.get("replay_role", "candidate") != "baseline":
                errors.append("ready comparison baseline execution must have replay_role=baseline")
        if isinstance(candidate_path, str):
            candidate = load_json(repo_path(candidate_path))
            if candidate.get("replay_role", "candidate") != "candidate":
                errors.append("ready comparison candidate execution must have replay_role=candidate")
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
        print(f"STATUS: FAIL ai_eda.openlane_replay_comparison missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.openlane_replay_comparison {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.openlane_replay_comparison {error}")
        return 1
    status = "PASS" if report["status"] == "COMPARISON_READY" else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.openlane_replay_comparison "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
