#!/usr/bin/env python3
"""Validate AI-EDA backend/tool readiness preflight reports."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_REPORT = ROOT / "build/ai_eda/backend_preflight/validation/backend_preflight_report.json"
EXPECTED_SCHEMA = "eliza.ai_eda.backend_preflight.v1"
EXPECTED_CLAIM_BOUNDARY = "local_backend_preflight_only_no_external_import_or_release_use"
EXPECTED_BACKENDS = {
    "zigzag",
    "timeloop_accelergy",
    "rtlmul",
    "llm4dv",
    "assertllm",
    "fault_dft",
}
ALLOWED_STATUS = {
    "LOCAL_BACKEND_CANDIDATE_PRESENT",
    "BLOCKED_BACKEND_NOT_INSTALLED",
}
FALSE_POLICY_FIELDS = (
    "installs_packages",
    "clones_repositories",
    "downloads_model_weights",
    "release_use_allowed",
    "external_api_required",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: expected JSON object")
    return data


def validate_probe_list(
    backend_id: str,
    field: str,
    items: Any,
    required_keys: tuple[str, ...],
    allowed_status: set[str],
) -> list[str]:
    errors: list[str] = []
    if not isinstance(items, list):
        return [f"{backend_id}: {field} must be a list"]
    for index, item in enumerate(items):
        label = f"{backend_id}: {field}[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{label}: must be a mapping")
            continue
        for key in required_keys:
            if key not in item:
                errors.append(f"{label}: missing {key}")
        status = item.get("status")
        if status not in allowed_status:
            errors.append(f"{label}: unsupported status {status!r}")
    return errors


def validate_backend(backend: dict[str, Any], seen: set[str]) -> list[str]:
    errors: list[str] = []
    backend_id = backend.get("id")
    if not isinstance(backend_id, str) or not backend_id:
        return ["backend entry missing non-empty id"]
    if backend_id in seen:
        errors.append(f"{backend_id}: duplicate backend id")
    seen.add(backend_id)
    if backend_id not in EXPECTED_BACKENDS:
        errors.append(f"{backend_id}: unexpected backend id")
    if not isinstance(backend.get("source_id"), str) or not backend["source_id"]:
        errors.append(f"{backend_id}: source_id is required")
    if not isinstance(backend.get("kind"), str) or not backend["kind"]:
        errors.append(f"{backend_id}: kind is required")
    if backend.get("status") not in ALLOWED_STATUS:
        errors.append(f"{backend_id}: unsupported status {backend.get('status')!r}")
    if backend.get("release_use_allowed") is not False:
        errors.append(f"{backend_id}: release_use_allowed must be false")
    if not isinstance(backend.get("required_for"), list) or not backend["required_for"]:
        errors.append(f"{backend_id}: required_for must be non-empty")
    if not isinstance(backend.get("next_action"), str) or not backend["next_action"]:
        errors.append(f"{backend_id}: next_action is required")
    errors.extend(
        validate_probe_list(
            backend_id,
            "python_modules",
            backend.get("python_modules"),
            ("module", "status"),
            {"PRESENT", "MISSING"},
        )
    )
    errors.extend(
        validate_probe_list(
            backend_id,
            "commands",
            backend.get("commands"),
            ("command", "status", "path", "version"),
            {"PRESENT", "MISSING"},
        )
    )
    errors.extend(
        validate_probe_list(
            backend_id,
            "local_paths",
            backend.get("local_paths"),
            ("path", "status", "is_dir"),
            {"PRESENT", "MISSING"},
        )
    )
    return errors


def validate_report(report: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if report.get("schema") != EXPECTED_SCHEMA:
        errors.append("schema mismatch")
    if report.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary mismatch")
    if report.get("mode") != "local-preflight":
        errors.append("mode must be local-preflight")
    if report.get("status") != "PASS_WITH_BLOCKERS_RECORDED":
        errors.append("status must be PASS_WITH_BLOCKERS_RECORDED")
    policy = report.get("policy")
    if not isinstance(policy, dict):
        errors.append("policy must be a mapping")
    else:
        for field in FALSE_POLICY_FIELDS:
            if policy.get(field) is not False:
                errors.append(f"policy.{field} must be false")
    environment = report.get("environment")
    if not isinstance(environment, dict) or not environment.get("python_executable"):
        errors.append("environment.python_executable is required")
    backends = report.get("backends")
    if not isinstance(backends, list) or not backends:
        errors.append("backends must be a non-empty list")
        return errors
    if report.get("backend_count") != len(backends):
        errors.append("backend_count does not match backends length")
    seen: set[str] = set()
    status_counts: dict[str, int] = {}
    for backend in backends:
        if not isinstance(backend, dict):
            errors.append("backend entry must be a mapping")
            continue
        errors.extend(validate_backend(backend, seen))
        status = backend.get("status")
        if isinstance(status, str):
            status_counts[status] = status_counts.get(status, 0) + 1
    missing = sorted(EXPECTED_BACKENDS - seen)
    if missing:
        errors.append(f"missing backend ids: {', '.join(missing)}")
    if report.get("status_counts") != status_counts:
        errors.append("status_counts does not match backend statuses")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.report.exists():
        print(f"STATUS: FAIL ai_eda.backend_preflight missing_report {rel(args.report)}")
        return 1
    try:
        report = load_json(args.report)
    except Exception as exc:  # noqa: BLE001
        print(f"STATUS: FAIL ai_eda.backend_preflight {rel(args.report)}: {exc}")
        return 1
    errors = validate_report(report)
    if errors:
        for error in errors:
            print(f"STATUS: FAIL ai_eda.backend_preflight {error}")
        return 1
    counts = report.get("status_counts", {})
    print(
        "STATUS: PASS ai_eda.backend_preflight "
        f"backends={report['backend_count']} status_counts={counts} report={rel(args.report)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
