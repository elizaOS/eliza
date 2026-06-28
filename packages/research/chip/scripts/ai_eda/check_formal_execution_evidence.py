#!/usr/bin/env python3
"""Validate captured E1 formal execution evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT / "build/ai_eda/formal_execution_evidence/validation/formal_execution_evidence.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.formal_execution_evidence.v1"
EXPECTED_CLAIM_BOUNDARY = "formal_execution_evidence_only_no_release_claim"


def false_claim_flags(report: dict[str, Any]) -> dict[str, bool]:
    flags = {"release_use_allowed": False}
    if report.get("status") != "STRICT_FORMAL_EVIDENCE_READY":
        flags["formal_proof_claim_allowed"] = False
    return flags


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
    if item.get("required") is not True:
        errors.append(f"{label}.required must be true")
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
        "STRICT_FORMAL_EVIDENCE_READY",
        "STRICT_FORMAL_EVIDENCE_BLOCKED_WITH_ENGINE_ERRORS",
        "FALLBACK_FORMAL_EVIDENCE_CAPTURED_WITH_BLOCKERS",
        "BLOCKED_FORMAL_EXECUTION_EVIDENCE",
    }:
        errors.append("unsupported status")
    if report.get("status") == "STRICT_FORMAL_EVIDENCE_READY":
        if report.get("formal_proof_claim_allowed") is not True:
            errors.append("strict evidence must allow formal_proof_claim gate")
        if report.get("strict_deep_formal_ready") is not True:
            errors.append("strict evidence must set strict_deep_formal_ready=true")
        if report.get("blockers"):
            errors.append("strict evidence must not list blockers")
    else:
        if report.get("formal_proof_claim_allowed") is not False:
            errors.append("non-strict evidence must not allow formal proof claim")
        if not report.get("blockers"):
            errors.append("non-strict evidence must list blockers")
    if report.get("false_claim_flags") != false_claim_flags(report):
        errors.append("false_claim_flags must match denied formal execution claims")
    if (
        report.get("fallback_evidence_only") is True
        and report.get("strict_deep_formal_ready") is True
    ):
        errors.append("fallback evidence cannot also be strict deep formal")
    entries = report.get("entry_summary")
    if not isinstance(entries, list) or not entries:
        errors.append("entry_summary must be a non-empty list")
    else:
        for index, item in enumerate(entries):
            if not isinstance(item, dict):
                errors.append(f"entry_summary[{index}] must be a mapping")
                continue
            for field in ("block", "status", "evidence_class", "has_log"):
                if field not in item:
                    errors.append(f"entry_summary[{index}].{field} missing")
    strict_attempts = report.get("strict_attempt_summary")
    if report.get("status") == "STRICT_FORMAL_EVIDENCE_BLOCKED_WITH_ENGINE_ERRORS":
        if not isinstance(strict_attempts, list) or not strict_attempts:
            errors.append("engine-error status must include strict_attempt_summary")
        else:
            if not any(
                item.get("has_error_marker") is True
                for item in strict_attempts
                if isinstance(item, dict)
            ):
                errors.append("engine-error status must include at least one failed strict attempt")
    elif strict_attempts is not None and not isinstance(strict_attempts, list):
        errors.append("strict_attempt_summary must be a list when present")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict) or "formal_manifest" not in artifacts:
        errors.append("artifacts.formal_manifest missing")
    elif isinstance(artifacts, dict):
        for label, item in artifacts.items():
            errors.extend(validate_artifact(f"artifacts.{label}", item))
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
        print(f"STATUS: FAIL ai_eda.formal_execution_evidence missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.formal_execution_evidence {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.formal_execution_evidence {error}")
        return 1
    status = "PASS" if report["status"] == "STRICT_FORMAL_EVIDENCE_READY" else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.formal_execution_evidence "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
