#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone supplier-return evidence."""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT
    / "board/kicad/e1-phone/production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_supplier_return_evidence_acceptance_matrix.v1"
SUPPLIER_METADATA_FIELDS = {
    "supplier_name",
    "supplier_part_number",
    "manufacturer_part_number",
    "drawing_revision",
    "sample_lot_or_quote_id",
    "signed_supplier_response",
    "pinout_or_land_pattern_source",
    "mechanical_model_source",
}
COMMON_RELEASE_FIELDS = {
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
    if suffix in {".pdf", ".step", ".stp", ".brep"}:
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


def mapping_missing_fields(data: Any, fields: set[str]) -> list[str]:
    if not isinstance(data, dict):
        return sorted(fields)
    return sorted(field for field in fields if not data.get(field))


def evidence_failures(lane: str, evidence: dict[str, Any]) -> list[str]:
    failures: list[str] = []
    expected_path = evidence.get("expected_local_intake_path")
    if not isinstance(expected_path, str) or not expected_path:
        failures.append("missing_expected_local_intake_path")
        return failures
    path = repo_path(expected_path)
    if not path.is_file():
        failures.append("artifact_missing")
        return failures

    try:
        parsed = parse_file(path)
    except Exception as exc:  # noqa: BLE001 - this is a release gate error surface.
        failures.append(f"artifact_parse_failed:{type(exc).__name__}")
        return failures

    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml", ".json"}:
        failures.extend(
            f"missing_common_field:{field}"
            for field in mapping_missing_fields(parsed, COMMON_RELEASE_FIELDS)
        )
        failures.extend(
            f"missing_supplier_field:{field}"
            for field in mapping_missing_fields(parsed, SUPPLIER_METADATA_FIELDS)
        )
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            missing = {"net_or_pin", "supplier_pin_name", "source_revision"} - headers
            failures.extend(f"missing_csv_column:{field}" for field in sorted(missing))
    elif suffix in {".pdf", ".step", ".stp", ".brep"}:
        companion = path.with_suffix(path.suffix + ".metadata.yaml")
        if not companion.is_file():
            failures.append("missing_external_signed_review_metadata")
        else:
            metadata = load_yaml_mapping(companion)
            failures.extend(
                f"missing_common_field:{field}"
                for field in mapping_missing_fields(metadata, COMMON_RELEASE_FIELDS)
            )
            failures.extend(
                f"missing_supplier_field:{field}"
                for field in mapping_missing_fields(metadata, SUPPLIER_METADATA_FIELDS)
            )
    else:
        failures.append("unsupported_supplier_artifact_type")

    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    if path.stat().st_size == 0:
        failures.append("artifact_empty")
    if lane.lower() not in expected_path.lower():
        failures.append("artifact_path_not_lane_scoped")
    return failures


def main() -> int:
    try:
        matrix = load_yaml_mapping(MATRIX)
        if matrix.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {matrix.get('schema')!r}")
        rows = matrix.get("acceptance_matrix")
        if not isinstance(rows, list) or not rows:
            raise ValueError("acceptance_matrix must be a non-empty list")

        blocked: list[tuple[str, str, list[str]]] = []
        present = 0
        total = 0
        for row_index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"acceptance_matrix[{row_index}] must be a mapping")
            lane = row.get("lane") or row.get("function") or row.get("supplier_pack_id")
            if not isinstance(lane, str) or not lane:
                raise ValueError(
                    f"acceptance_matrix[{row_index}] missing lane/function/supplier_pack_id"
                )
            evidence_rows = row.get("required_supplier_return_evidence")
            if not isinstance(evidence_rows, list) or not evidence_rows:
                raise ValueError(f"{lane}: required_supplier_return_evidence must be non-empty")
            for evidence in evidence_rows:
                if not isinstance(evidence, dict):
                    raise ValueError(f"{lane}: evidence row must be a mapping")
                total += 1
                evidence_class = str(evidence.get("evidence_class") or "<missing_class>")
                failures = evidence_failures(lane, evidence)
                if failures:
                    blocked.append((lane, evidence_class, failures))
                else:
                    present += 1
    except ValueError as exc:
        print(f"FAIL: E1 phone supplier-return content contract invalid: {exc}")
        return 1

    if blocked:
        print(
            "STATUS: BLOCKED E1 phone supplier-return content "
            f"rows={total} validated={present} blocked={len(blocked)}"
        )
        for lane, evidence_class, failures in blocked[:10]:
            print(f"  - {lane}:{evidence_class}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked supplier rows")
        return 2

    print(f"STATUS: PASS E1 phone supplier-return content rows={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
