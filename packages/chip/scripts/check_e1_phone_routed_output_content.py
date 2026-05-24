#!/usr/bin/env python3
"""Fail-closed content gate for E1 phone routed-board release outputs."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "routed-board-release-acceptance-matrix-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_routed_board_release_acceptance_matrix.v1"
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
ROUTED_FIELDS = {
    "kicad_project_revision",
    "routed_pcb_hash",
    "erc_result",
    "drc_result",
    "stackup_revision",
    "impedance_coupon_reference",
    "si_pi_rf_report_references",
    "fab_output_manifest",
    "routed_step_reference",
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
    if suffix in {".kicad_pcb", ".kicad_sch", ".pos", ".bom", ".txt", ".rpt"}:
        return path.read_text(encoding="utf-8")
    if suffix in {".zip", ".step", ".stp", ".pdf", ".ipc", ".tgz"}:
        return {"binary_or_cad_artifact": True}
    if path.is_dir():
        return {"directory": True}
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


def collect_required_outputs(matrix: dict[str, Any]) -> dict[str, dict[str, Any]]:
    outputs: dict[str, dict[str, Any]] = {}

    def add(artifact: Any) -> None:
        if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
            outputs.setdefault(artifact["path"], artifact)

    for row in matrix.get("missing_production_outputs", []):
        add(row)
    for domain in matrix.get("route_domain_acceptance_matrix", []):
        for artifact in domain.get("required_production_outputs", []):
            add(artifact)
    for category in matrix.get("required_acceptance_evidence", []):
        for artifact in category.get("required_artifacts", []):
            if artifact.get("present") is True:
                add(artifact)
    return outputs


def content_failures(path_text: str) -> list[str]:
    failures: list[str] = []
    path = repo_path(path_text)
    if not path.exists():
        return ["artifact_missing"]
    if path.is_dir():
        children = [
            child for child in path.iterdir() if child.is_file() and child.stat().st_size > 0
        ]
        if not children:
            failures.append("directory_empty_or_no_release_files")
        return failures
    if path.stat().st_size == 0:
        failures.append("artifact_empty")

    try:
        parsed = parse_file(path)
    except Exception as exc:  # noqa: BLE001 - release gate error surface.
        return [f"artifact_parse_failed:{type(exc).__name__}"]

    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml", ".json"}:
        failures.extend(
            f"missing_common_field:{field}" for field in missing_fields(parsed, COMMON_FIELDS)
        )
        failures.extend(
            f"missing_routed_field:{field}" for field in missing_fields(parsed, ROUTED_FIELDS)
        )
        if isinstance(parsed, dict) and parsed.get("disposition") != "approved":
            failures.append("disposition_not_approved")
    elif suffix == ".csv":
        if not isinstance(parsed, list) or not parsed:
            failures.append("csv_empty")
        else:
            headers = set(parsed[0])
            if not ({"net", "measured_value", "limit", "result"} <= headers):
                failures.append("csv_missing_measurement_limit_result_columns")
    elif suffix in {".step", ".stp", ".pdf", ".zip", ".ipc", ".tgz"}:
        metadata = path.with_suffix(path.suffix + ".metadata.yaml")
        if not metadata.is_file():
            failures.append("missing_external_signed_review_metadata")
    elif isinstance(parsed, str) and has_placeholder(parsed):
        failures.append("placeholder_or_blocked_marker_present")

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
        outputs = collect_required_outputs(matrix)
        if len(outputs) != summary.get("required_output_path_count"):
            raise ValueError(
                "required output inventory count mismatch: "
                f"collected={len(outputs)} summary={summary.get('required_output_path_count')}"
            )

        blocked: list[tuple[str, list[str]]] = []
        present = 0
        for path_text in sorted(outputs):
            failures = content_failures(path_text)
            if failures:
                blocked.append((path_text, failures))
            else:
                present += 1

        missing_categories = int(summary.get("missing_validation_evidence_category_count") or 0)
        missing_outputs = int(summary.get("missing_required_output_path_count") or 0)
        domains_missing_outputs = int(summary.get("domains_with_missing_production_outputs") or 0)
        domains_missing_nets = int(summary.get("domains_with_missing_exact_nets") or 0)
    except ValueError as exc:
        print(f"FAIL: E1 phone routed-output content contract invalid: {exc}")
        return 1

    if (
        blocked
        or missing_categories
        or missing_outputs
        or domains_missing_outputs
        or domains_missing_nets
    ):
        print(
            "STATUS: BLOCKED E1 phone routed-output content "
            f"paths={len(outputs)} present={present} blocked={len(blocked)} "
            f"missing_outputs={missing_outputs} missing_validation_categories={missing_categories} "
            f"domains_missing_outputs={domains_missing_outputs} domains_missing_nets={domains_missing_nets}"
        )
        for path_text, failures in blocked[:10]:
            print(f"  - {path_text}: {', '.join(failures)}")
        if len(blocked) > 10:
            print(f"  - ... {len(blocked) - 10} more blocked routed outputs")
        return 2

    print(f"STATUS: PASS E1 phone routed-output content paths={len(outputs)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
