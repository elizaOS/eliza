#!/usr/bin/env python3
"""Validate E1 formal single-solver isolation evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/formal_solver_isolation/validation/formal_solver_isolation.json"
EXPECTED_SCHEMA = "eliza.ai_eda.formal_solver_isolation.v1"
EXPECTED_CLAIM_BOUNDARY = "single_solver_smoke_evidence_only_no_release_or_deep_proof_claim"


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


def validate_artifact(label: str, item: Any) -> list[str]:
    if not isinstance(item, dict):
        return [f"{label} must be a mapping"]
    errors: list[str] = []
    path_value = item.get("path")
    if not isinstance(path_value, str) or not path_value:
        errors.append(f"{label}.path must be present")
        return errors
    if item.get("status") not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    if item.get("required") is not False and item.get("required") is not True:
        errors.append(f"{label}.required must be boolean")
    if item.get("status") == "PRESENT":
        path = repo_path(path_value)
        if not path.is_file():
            errors.append(f"{label}.path missing on disk")
        elif item.get("sha256") != sha256_file(path):
            errors.append(f"{label}.sha256 is stale")
        if not isinstance(item.get("size_bytes"), int) or item["size_bytes"] < 0:
            errors.append(f"{label}.size_bytes must be non-negative")
    elif item.get("required") is True:
        errors.append(f"{label} required artifact is missing")
    return errors


def validate(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("release_use_allowed") is not False:
        errors.append("release_use_allowed must be false")
    if report.get("formal_proof_claim_allowed") is not False:
        errors.append("formal_proof_claim_allowed must be false")
    if report.get("status") not in {"SOLVER_ISOLATION_PASS", "SOLVER_ISOLATION_RECORDED_WITH_BLOCKERS"}:
        errors.append("unsupported status")
    cases = report.get("cases")
    if not isinstance(cases, list) or not cases:
        errors.append("cases must be a non-empty list")
    else:
        for index, case in enumerate(cases):
            if not isinstance(case, dict):
                errors.append(f"cases[{index}] must be a mapping")
                continue
            for field in ("block", "solver", "status", "returncode", "artifacts"):
                if field not in case:
                    errors.append(f"cases[{index}].{field} missing")
            if case.get("status") not in {"PASS", "FAIL", "ERROR", "TIMEOUT", "UNKNOWN", "MISSING_SPEC"}:
                errors.append(f"cases[{index}].status unsupported")
            artifacts = case.get("artifacts")
            if isinstance(artifacts, dict):
                for label, item in artifacts.items():
                    errors.extend(validate_artifact(f"cases[{index}].artifacts.{label}", item))
            else:
                errors.append(f"cases[{index}].artifacts must be a mapping")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
    elif isinstance(cases, list):
        if summary.get("case_count") != len(cases):
            errors.append("summary.case_count mismatch")
        if summary.get("passed") != sum(1 for case in cases if isinstance(case, dict) and case.get("status") == "PASS"):
            errors.append("summary.passed mismatch")
    if report.get("status") == "SOLVER_ISOLATION_PASS" and report.get("blockers"):
        errors.append("pass status must not list blockers")
    if report.get("status") == "SOLVER_ISOLATION_RECORDED_WITH_BLOCKERS" and not report.get("blockers"):
        errors.append("blocked status must list blockers")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.is_file():
        print(f"STATUS: FAIL ai_eda.formal_solver_isolation missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.formal_solver_isolation {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.formal_solver_isolation {error}")
        return 1
    status = "PASS" if report["status"] == "SOLVER_ISOLATION_PASS" else "PASS_BLOCKED"
    summary = report["summary"]
    print(
        "STATUS: "
        f"{status} ai_eda.formal_solver_isolation "
        f"status={report['status']} cases={summary['case_count']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
