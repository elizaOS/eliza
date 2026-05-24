#!/usr/bin/env python3
"""Generate a fail-closed contract gate for E1 phone executed bench logs."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import yaml

CHIP_ROOT = Path(__file__).resolve().parents[1]
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_DATE = "2026-05-22"

DEFAULT_MATRIX = (
    BOARD_ROOT / "production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_DIAGNOSTIC = (
    BOARD_ROOT / "production/test/readiness/e1-phone-first-article-missing-evidence-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    BOARD_ROOT / "production/test/readiness/"
    "e1-phone-first-article-executed-log-contract-2026-05-22.yaml"
)

EXPECTED_MATRIX_SCHEMA = "eliza.e1_phone_first_article_bench_acceptance_matrix.v1"
EXPECTED_LOG_SCHEMA = "eliza.e1_phone_executed_first_article_bench_log.v1"
REPORT_SCHEMA = "eliza.e1_phone_first_article_executed_log_contract_gate.v1"

REQUIRED_TOP_LEVEL_FIELDS = (
    "schema",
    "artifact_id",
    "source_requirement_id",
    "evidence_role",
    "release_credit",
    "board_serial",
    "board_revision",
    "board_configuration",
    "supplier_lot_ids",
    "fixture_id",
    "fixture_calibration_id",
    "test_software_revision",
    "operator",
    "started_at",
    "completed_at",
    "limits_file",
    "measured_results",
    "pass_fail_disposition",
    "waivers",
    "reviewer",
    "reviewed_at",
    "disposition",
)
REQUIRED_MEASURED_RESULT_FIELDS = (
    "measurement_id",
    "metric",
    "value",
    "unit",
    "limit",
    "result",
)
ALLOWED_PASS_FAIL = {"pass", "fail"}
ALLOWED_RESULT = {"pass", "fail", "not_applicable"}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def display_rel(path: Path) -> str:
    if path.is_relative_to(CHIP_ROOT):
        return path.relative_to(CHIP_ROOT).as_posix()
    return path.as_posix()


def resolve_chip_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return CHIP_ROOT.parents[1] / path
    return CHIP_ROOT / path


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{display_rel(path)}: expected YAML mapping")
    return data


def scalar_missing(data: dict[str, Any], field: str) -> bool:
    value = data.get(field)
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    return bool(isinstance(value, (list, dict)) and not value)


def validate_measured_results(value: Any) -> list[str]:
    failures: list[str] = []
    if not isinstance(value, list) or not value:
        return ["measured_results_missing_or_empty"]
    for index, result in enumerate(value):
        if not isinstance(result, dict):
            failures.append(f"measured_results[{index}]_not_mapping")
            continue
        for field in REQUIRED_MEASURED_RESULT_FIELDS:
            if scalar_missing(result, field):
                failures.append(f"measured_results[{index}]_missing_{field}")
        if result.get("result") not in ALLOWED_RESULT:
            failures.append(f"measured_results[{index}]_invalid_result")
    return failures


def validate_executed_log(path: Path) -> tuple[bool, list[str]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report concrete gate failure.
        return False, [f"json_parse_failed:{type(exc).__name__}"]
    if not isinstance(data, dict):
        return False, ["log_root_not_mapping"]

    failures = []
    for field in REQUIRED_TOP_LEVEL_FIELDS:
        if field == "waivers":
            if field not in data:
                failures.append(f"missing_required_field:{field}")
            continue
        if scalar_missing(data, field):
            failures.append(f"missing_required_field:{field}")
    if data.get("schema") != EXPECTED_LOG_SCHEMA:
        failures.append("unexpected_schema")
    if data.get("evidence_role") != "executed_first_article_bench_log":
        failures.append("evidence_role_not_executed_first_article_bench_log")
    if data.get("release_credit") is not False:
        failures.append("release_credit_must_remain_false_in_contract_gate")
    if data.get("pass_fail_disposition") not in ALLOWED_PASS_FAIL:
        failures.append("invalid_pass_fail_disposition")
    if data.get("disposition") != "reviewed_lab_record":
        failures.append("disposition_not_reviewed_lab_record")
    if not isinstance(data.get("supplier_lot_ids"), list) or not data.get("supplier_lot_ids"):
        failures.append("supplier_lot_ids_missing_or_empty")
    if not isinstance(data.get("waivers"), list):
        failures.append("waivers_not_list")
    failures.extend(validate_measured_results(data.get("measured_results")))
    return not failures, sorted(dict.fromkeys(failures))


def executed_log_paths_from_diagnostic(diagnostic: dict[str, Any]) -> list[str]:
    for packet in diagnostic.get("recommended_next_evidence_packets", []):
        if not isinstance(packet, dict):
            continue
        if packet.get("id") == "executed_first_article_bench_logs":
            paths = packet.get("missing_paths", [])
            return sorted(path for path in paths if isinstance(path, str))
    return []


def executed_log_paths_from_matrix(matrix: dict[str, Any]) -> list[str]:
    rows = matrix.get("acceptance_matrix", [])
    if not isinstance(rows, list):
        raise SystemExit("acceptance_matrix must be a list")
    paths: list[str] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        path = row.get("path")
        if row.get("evidence_kind") == "executed_log" and isinstance(path, str):
            paths.append(path)
    return sorted(dict.fromkeys(paths))


def build_row(path_text: str) -> dict[str, Any]:
    path = resolve_chip_path(path_text)
    present = path.is_file()
    contract_valid = False
    failures = ["artifact_missing"]
    if present:
        contract_valid, failures = validate_executed_log(path)
    return {
        "path": path_text,
        "resolved_path": display_rel(path),
        "current_presence": {
            "present": present,
            "artifact_kind": "file" if present else "missing",
        },
        "schema_contract": EXPECTED_LOG_SCHEMA,
        "contract_valid": contract_valid,
        "release_credit": False,
        "acceptance_state": (
            "present_contract_valid_no_release_credit"
            if contract_valid
            else "blocked_fail_closed_missing_or_invalid_executed_log"
        ),
        "validation_failures": failures,
        "next_unblock_action": (
            "Capture the executed first-article JSON bench log with the required "
            "schema fields, reviewed_lab_record disposition, measured results, "
            "limits binding, board serial, supplier lots, fixture ID, calibration "
            "ID, operator, and test software revision. This contract gate still "
            "grants no release credit by itself."
        ),
    }


def build_report(matrix_path: Path, diagnostic_path: Path, report_path: Path) -> dict[str, Any]:
    matrix = load_yaml_mapping(matrix_path)
    if matrix.get("schema") != EXPECTED_MATRIX_SCHEMA:
        raise SystemExit(f"{display_rel(matrix_path)}: unexpected schema {matrix.get('schema')!r}")

    diagnostic = load_yaml_mapping(diagnostic_path) if diagnostic_path.is_file() else {}
    paths = executed_log_paths_from_diagnostic(diagnostic) or executed_log_paths_from_matrix(matrix)
    rows = [build_row(path) for path in paths]
    missing = [row for row in rows if row["current_presence"]["present"] is not True]
    invalid = [
        row
        for row in rows
        if row["current_presence"]["present"] is True and row["contract_valid"] is not True
    ]
    valid = [row for row in rows if row["contract_valid"] is True]

    return {
        "schema": REPORT_SCHEMA,
        "status": "blocked_fail_closed_executed_first_article_log_contract",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Schema and field contract for the highest-leverage executed first-article "
            "bench logs. It validates future lab-result JSON logs for required fields "
            "but is not release evidence, not a first-article pass, not enclosure "
            "signoff, and grants no release credit."
        ),
        "inputs": {
            "first_article_bench_acceptance_matrix": display_rel(matrix_path),
            "missing_evidence_diagnostic": display_rel(diagnostic_path),
            "report_path": display_rel(report_path),
        },
        "summary": {
            "release_allowed": False,
            "release_credit": False,
            "target_log_count": len(rows),
            "missing_log_count": len(missing),
            "present_invalid_log_count": len(invalid),
            "present_contract_valid_log_count": len(valid),
            "highest_leverage_packet": "executed_first_article_bench_logs",
        },
        "contract": {
            "log_schema": EXPECTED_LOG_SCHEMA,
            "required_top_level_fields": list(REQUIRED_TOP_LEVEL_FIELDS),
            "required_measured_result_fields": list(REQUIRED_MEASURED_RESULT_FIELDS),
            "allowed_pass_fail_disposition": sorted(ALLOWED_PASS_FAIL),
            "allowed_measured_result_values": sorted(ALLOWED_RESULT),
            "required_evidence_role": "executed_first_article_bench_log",
            "required_disposition": "reviewed_lab_record",
            "release_credit_required_value": False,
        },
        "acceptance_policy": {
            "missing_logs_are_release_evidence": False,
            "template_guidance_is_release_evidence": False,
            "contract_valid_logs_unlock_release": False,
            "signed_traveler_and_release_gate_still_required": True,
            "release_allowed": False,
        },
        "executed_log_contract_rows": rows,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matrix", type=Path, default=DEFAULT_MATRIX)
    parser.add_argument("--diagnostic", type=Path, default=DEFAULT_DIAGNOSTIC)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write the YAML report to --report instead of printing to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(args.matrix, args.diagnostic, args.report)
    output = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
        print(f"wrote {display_rel(args.report)}")
    else:
        print(output, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
