#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone first-article bench evidence."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_first_article_bench_acceptance_matrix.v1"
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
FIRST_ARTICLE_FIELDS = {
    "board_serial_or_lot",
    "fixture_or_program_revision",
    "limits_revision",
    "operator_or_test_station",
    "pass_fail_result",
    "measurement_summary",
    "traceability_ids",
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
    "template_empty_not_executed",
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


def content_failures(path_text: str, evidence_kind: str) -> list[str]:
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
        failures.extend(
            f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS)
        )
        failures.extend(
            f"missing_first_article_field:{field}"
            for field in missing_fields(parsed, FIRST_ARTICLE_FIELDS)
        )
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"measurement", "limit", "result"} <= headers):
                failures.append("csv_missing_measurement_limit_result_columns")
    elif suffix in {".zip", ".pdf", ".step", ".stp", ".tgz", ".ipc"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        if not metadata.is_file():
            failures.append("missing_external_signed_review_metadata")

    if evidence_kind == "template":
        failures.append("template_cannot_unlock_release")
    if has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")
    return sorted(dict.fromkeys(failures))


def main() -> int:
    try:
        matrix = load_yaml_mapping(MATRIX)
        if matrix.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {matrix.get('schema')!r}")
        summary = matrix.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        rows = matrix.get("acceptance_matrix")
        if not isinstance(rows, list) or not rows:
            raise ValueError("acceptance_matrix must be a non-empty list")

        blocked: list[tuple[str, list[str]]] = []
        present = 0
        required = 0
        template_rows = 0
        for index, row in enumerate(rows):
            if not isinstance(row, dict):
                raise ValueError(f"acceptance_matrix[{index}] must be a mapping")
            path_text = row.get("path")
            evidence_kind = row.get("evidence_kind")
            if not isinstance(path_text, str) or not path_text:
                raise ValueError(f"acceptance_matrix[{index}] missing path")
            if not isinstance(evidence_kind, str) or not evidence_kind:
                raise ValueError(f"acceptance_matrix[{index}] missing evidence_kind")
            if row.get("template_only") is True or evidence_kind == "template":
                template_rows += 1
                continue
            required += 1
            failures = content_failures(path_text, evidence_kind)
            if failures:
                blocked.append((path_text, failures))
            else:
                present += 1

        missing = int(summary.get("missing_required_non_template_row_count") or 0)
        expected_required = int(summary.get("required_non_template_row_count") or 0)
        if required != expected_required:
            raise ValueError(
                f"required non-template count mismatch: rows={required} summary={expected_required}"
            )
    except ValueError as exc:
        print(f"FAIL: E1 phone first-article content contract invalid: {exc}")
        return 1

    if blocked or missing:
        print(
            "STATUS: BLOCKED E1 phone first-article content "
            f"rows={len(rows)} required={required} present={present} "
            f"blocked={len(blocked)} missing={missing} templates={template_rows}"
        )
        for path_text, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked first-article rows")
        return 2

    print(f"STATUS: PASS E1 phone first-article content required={required}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
