#!/usr/bin/env python3
"""Fail-closed approval/signature gate for E1 phone release evidence rows."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "release-evidence-content-contract-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_release_evidence_content_contract.v1"
ROW_SCHEMA = "eliza.e1_phone_release_evidence_artifact_content_requirement.v1"
PLACEHOLDER_MARKERS = {
    "tbd",
    "todo",
    "not_run",
    "presence-only",
    "presence_only",
    "unvalidated",
    "unsigned",
    "placeholder",
    "concept",
    "demo",
    "blocked",
}


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing content contract: {path.relative_to(ROOT)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def scalar_text(value: Any) -> list[str]:
    if isinstance(value, dict):
        values: list[str] = []
        for key, item in value.items():
            values.append(str(key))
            values.extend(scalar_text(item))
        return values
    if isinstance(value, list):
        values = []
        for item in value:
            values.extend(scalar_text(item))
        return values
    if value is None:
        return []
    return [str(value)]


def has_placeholder(value: Any) -> bool:
    haystack = " ".join(scalar_text(value)).lower()
    return any(marker in haystack for marker in PLACEHOLDER_MARKERS)


def row_failures(row: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    if row.get("schema") != ROW_SCHEMA:
        failures.append("invalid_row_schema")
    if row.get("approval_status") != "approved":
        failures.append("approval_status_not_approved")
    for field in ("owner", "reviewer"):
        if not row.get(field):
            failures.append(f"missing_{field}")
    if not row.get("captured_at"):
        failures.append("missing_captured_at")
    if not row.get("revision_or_lot"):
        failures.append("missing_revision_or_lot")
    if not row.get("sha256"):
        failures.append("missing_sha256")
    if row.get("validated") is not True:
        failures.append("row_not_validated")
    if row.get("release_allowed") is not True:
        failures.append("release_not_allowed")
    if row.get("template_only") is True:
        failures.append("template_only")
    if row.get("presence_only") is True:
        failures.append("presence_only")
    if has_placeholder(row):
        failures.append("placeholder_or_blocked_marker_present")
    return failures


def main() -> int:
    try:
        contract = load_yaml_mapping(CONTRACT)
        if contract.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {contract.get('schema')!r}")
        rows = contract.get("artifact_content_requirements")
        if not isinstance(rows, list) or not rows:
            raise ValueError("artifact_content_requirements must be a non-empty list")

        blocked_rows: list[tuple[str, list[str]]] = []
        approved_rows = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"row {index}: expected mapping")
            failures = row_failures(row)
            if failures:
                evidence_id = str(row.get("evidence_id") or f"row_{index}")
                blocked_rows.append((evidence_id, failures))
            else:
                approved_rows += 1
    except ValueError as exc:
        print(f"FAIL: E1 phone release approval signature contract invalid: {exc}")
        return 1

    if blocked_rows:
        print(
            "STATUS: BLOCKED E1 phone release approval signatures "
            f"rows={len(rows)} approved={approved_rows} blocked={len(blocked_rows)}"
        )
        for evidence_id, failures in blocked_rows[:10]:
            print(f"  - {evidence_id}: {', '.join(failures)}")
        if len(blocked_rows) > 10:
            print(f"  - ... {len(blocked_rows) - 10} more blocked rows")
        return 2

    print(f"STATUS: PASS E1 phone release approval signatures rows={len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
