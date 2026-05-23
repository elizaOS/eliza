#!/usr/bin/env python3
"""Validate E1 formal/equivalence host prerequisite reports."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = (
    ROOT
    / "build/ai_eda/formal_verification_prerequisites/validation/formal_verification_prerequisites.json"
)
EXPECTED_SCHEMA = "eliza.ai_eda.formal_verification_prerequisites.v1"
EXPECTED_CLAIM_BOUNDARY = "formal_verification_prerequisites_only_no_proof_or_release_claim"
REQUIRED_TOOLS = {"sby", "yosys", "yosys-smtbmc", "z3", "boolector", "bitwuzla", "abc"}


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
    if item.get("required") is not True:
        errors.append(f"{label}.required must be true")
    if item.get("status") not in {"PRESENT", "MISSING"}:
        errors.append(f"{label}.status is invalid")
    path_value = item.get("path")
    if item.get("status") == "PRESENT":
        if not isinstance(path_value, str) or not path_value:
            errors.append(f"{label}.path must be present")
        else:
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
    if report.get("formal_proof_claim_allowed") is not False:
        errors.append("formal_proof_claim_allowed must be false for prerequisites")
    if report.get("status") not in {
        "READY_FOR_STRICT_FORMAL_HOST",
        "BLOCKED_FORMAL_PREREQUISITES",
    }:
        errors.append("unsupported status")
    capabilities = report.get("capabilities")
    if not isinstance(capabilities, dict):
        errors.append("capabilities must be a mapping")
    else:
        for field in (
            "fallback_counts_as_deep_formal",
            "runs_formal",
            "runs_yosys",
            "mutates_source_tree",
        ):
            if capabilities.get(field) is not False:
                errors.append(f"capabilities.{field} must be false")
        if (
            report.get("status") == "READY_FOR_STRICT_FORMAL_HOST"
            and capabilities.get("strict_sby_ready") is not True
        ):
            errors.append("ready report must set strict_sby_ready=true")
    tools = report.get("tools")
    if not isinstance(tools, dict):
        errors.append("tools must be a mapping")
    else:
        missing = sorted(REQUIRED_TOOLS - set(tools))
        if missing:
            errors.append(f"missing tool entries: {', '.join(missing)}")
        for name, item in tools.items():
            if not isinstance(item, dict):
                errors.append(f"tools.{name} must be a mapping")
            elif item.get("status") not in {"PRESENT", "MISSING"}:
                errors.append(f"tools.{name}.status is invalid")
    artifacts = report.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        errors.append("artifacts must be a non-empty mapping")
    else:
        present = 0
        for label, item in artifacts.items():
            errors.extend(validate_artifact(f"artifacts.{label}", item))
            if isinstance(item, dict) and item.get("status") == "PRESENT":
                present += 1
        if present == 0:
            errors.append("at least one formal artifact must be present")
    blockers = report.get("blockers")
    if report.get("status") == "BLOCKED_FORMAL_PREREQUISITES" and not blockers:
        errors.append("blocked report must list blockers")
    if report.get("status") == "READY_FOR_STRICT_FORMAL_HOST" and blockers:
        errors.append("ready report must not list blockers")
    templates = report.get("execution_templates")
    if not isinstance(templates, dict) or "formal-strict" not in str(templates):
        errors.append("execution_templates must include formal-strict")
    evidence = report.get("required_post_execution_evidence")
    if not isinstance(evidence, list) or len(evidence) < 4:
        errors.append("required_post_execution_evidence must be concrete")
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
        print(
            f"STATUS: FAIL ai_eda.formal_verification_prerequisites missing_report {rel(args.report)}"
        )
        return 1
    try:
        report = load_json(args.report)
        errors = validate(report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.formal_verification_prerequisites {exc}")
        return 1
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.formal_verification_prerequisites {error}")
        return 1
    status = "PASS" if report["status"] == "READY_FOR_STRICT_FORMAL_HOST" else "PASS_BLOCKED"
    print(
        "STATUS: "
        f"{status} ai_eda.formal_verification_prerequisites "
        f"status={report['status']} blockers={len(report.get('blockers', []))}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
