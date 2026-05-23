#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone production/factory outputs."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
INVENTORY = (
    ROOT
    / "board/kicad/e1-phone/production/readiness/"
    "production-factory-required-output-presence-inventory-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_production_factory_required_output_presence_inventory.v1"
COMMON_FIELDS = {
    "artifact_id",
    "source_requirement_id",
    "owner",
    "created_at",
    "tool_or_supplier_revision",
    "input_artifact_hashes",
    "reviewer",
    "reviewed_at",
    "disposition",
}
FACTORY_FIELDS = {
    "release_package_revision",
    "fab_vendor_or_assembler",
    "program_or_fixture_revision",
    "limits_revision",
    "calibration_state",
    "lot_or_serial_traceability",
}
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


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return ROOT.parents[1] / path
    return ROOT / path


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing file: {rel(path)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{rel(path)} must be a YAML mapping")
    return data


def parse_file(path: Path) -> Any:
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    if suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))
    if suffix in {".txt", ".rpt", ".pos", ".bom", ".kicad_pcb"}:
        return path.read_text(encoding="utf-8")
    if suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        return {"binary_or_cad_artifact": True}
    return path.read_text(encoding="utf-8")


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


def missing_fields(data: Any, fields: set[str]) -> list[str]:
    if not isinstance(data, dict):
        return sorted(fields)
    return sorted(field for field in fields if not data.get(field))


def content_failures(path_text: str) -> list[str]:
    path = repo_path(path_text)
    if not path.exists():
        return ["artifact_missing"]
    if path.is_dir():
        release_files = [
            child for child in path.rglob("*") if child.is_file() and child.stat().st_size > 0
        ]
        if not release_files:
            return ["directory_empty_or_no_release_files"]
        return []
    if path.stat().st_size == 0:
        return ["artifact_empty"]

    try:
        parsed = parse_file(path)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"artifact_parse_failed:{type(exc).__name__}"]

    failures: list[str] = []
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml", ".json"}:
        failures.extend(f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS))
        failures.extend(f"missing_factory_field:{field}" for field in missing_fields(parsed, FACTORY_FIELDS))
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"fixture_revision", "limit", "result"} <= headers):
                failures.append("csv_missing_fixture_limit_result_columns")
    elif suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        if not metadata.is_file():
            failures.append("missing_external_signed_review_metadata")

    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    return sorted(dict.fromkeys(failures))


def main() -> int:
    try:
        inventory = load_yaml_mapping(INVENTORY)
        if inventory.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {inventory.get('schema')!r}")
        summary = inventory.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        rows = inventory.get("required_output_presence")
        if not isinstance(rows, list) or not rows:
            raise ValueError("required_output_presence must be a non-empty list")
        expected_count = summary.get("required_output_path_count")
        if len(rows) != expected_count:
            raise ValueError(
                f"required output count mismatch: rows={len(rows)} summary={expected_count}"
            )

        blocked: list[tuple[str, list[str]]] = []
        present = 0
        source_refs = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"required_output_presence[{index}] must be a mapping")
            path_text = row.get("path")
            if not isinstance(path_text, str) or not path_text:
                raise ValueError(f"required_output_presence[{index}] missing path")
            source_refs += len(row.get("source_pointers") or [])
            failures = content_failures(path_text)
            if failures:
                blocked.append((path_text, failures))
            else:
                present += 1
        missing = int(summary.get("missing_required_output_path_count") or 0)
    except ValueError as exc:
        print(f"FAIL: E1 phone factory-output content contract invalid: {exc}")
        return 1

    if blocked or missing:
        print(
            "STATUS: BLOCKED E1 phone factory-output content "
            f"paths={len(rows)} present={present} blocked={len(blocked)} "
            f"missing={missing} source_refs={source_refs}"
        )
        for path_text, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked factory outputs")
        return 2

    print(f"STATUS: PASS E1 phone factory-output content paths={len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
