#!/usr/bin/env python3
"""Generate the fail-closed E1 phone first-article bench acceptance matrix."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml


CHIP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = CHIP_ROOT.parents[1]
BOARD_ROOT = CHIP_ROOT / "board/kicad/e1-phone"
REPORT_DATE = "2026-05-22"

DEFAULT_TEMPLATE_MANIFEST = (
    BOARD_ROOT / "production/test/bench-first-article-template-manifest-2026-05-22.yaml"
)
DEFAULT_SELECTED_HARDWARE_EXECUTION = (
    BOARD_ROOT / "selected-hardware-first-article-execution.yaml"
)
DEFAULT_ENCLOSURE_EXECUTION = (
    BOARD_ROOT / "production-enclosure-first-article-release-execution.yaml"
)
DEFAULT_FACTORY_BURNDOWN = (
    BOARD_ROOT / "production-factory-output-burndown-2026-05-22.yaml"
)
DEFAULT_REPORT = (
    BOARD_ROOT
    / "production/test/readiness/"
    "e1-phone-first-article-bench-acceptance-matrix-2026-05-22.yaml"
)


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping")
    return data


def display_rel(path: Path) -> str:
    if path.is_relative_to(CHIP_ROOT):
        return path.relative_to(CHIP_ROOT).as_posix()
    if path.is_relative_to(REPO_ROOT):
        return path.relative_to(REPO_ROOT).as_posix()
    return path.as_posix()


def resolve_repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return REPO_ROOT / path
    if path_text.startswith("mechanical/"):
        return CHIP_ROOT / path
    if path_text.startswith("board/"):
        return CHIP_ROOT / path
    return CHIP_ROOT / path


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def add_source(row: dict[str, Any], source: str, field: str, owner: str = "") -> None:
    source_row = {"source": source, "field": field}
    if owner:
        source_row["owner"] = owner
    if source_row not in row["source_refs"]:
        row["source_refs"].append(source_row)


def evidence_kind(path_text: str, source_field: str) -> str:
    name = Path(path_text).name
    lower_path = path_text.lower()
    if ".template." in lower_path or source_field == "template_path":
        return "template"
    if "traveler" in lower_path or lower_path.endswith("/production/first-article"):
        return "traveler"
    if name == "factory-test-limits.yaml":
        return "limits"
    if name == "probe-coordinates.csv" or "probe" in lower_path or "fixture" in lower_path:
        return "probe_or_fixture"
    if "rf-calibration" in lower_path or "/rf/" in lower_path:
        return "rf_or_calibration_log"
    if name.endswith(".json") and (
        "/production/reports/" in lower_path or "first-article-test-transcript" in name
    ):
        return "executed_log"
    if "clearance" in lower_path or "enclosure-fit" in lower_path or lower_path.endswith(".step"):
        return "clearance_or_enclosure_evidence"
    return "release_evidence"


def required_action(kind: str, path_text: str) -> str:
    actions = {
        "template": (
            "Keep as template-only evidence; execute routed first-article hardware "
            "and archive the corresponding real log before using it for release."
        ),
        "executed_log": (
            "Run the routed first-article bench step, capture the executed JSON log, "
            "and bind board serial, fixture ID, test software revision, operator, "
            "limits, and pass/fail disposition."
        ),
        "traveler": (
            "Create the signed first-article traveler with board serial, supplier "
            "lots, fixture IDs, measured results, waivers, and owner signoff."
        ),
        "limits": (
            "Derive stop-on-fail factory limits from routed first-article measurements "
            "and archive the signed limits file."
        ),
        "probe_or_fixture": (
            "Generate routed-board probe coordinates, fixture or flying-probe program, "
            "and accessibility evidence from the DRC-clean layout."
        ),
        "rf_or_calibration_log": (
            "Run conducted RF, VNA, coexistence, wireless identity, or calibration "
            "capture on routed hardware and archive the measured log."
        ),
        "clearance_or_enclosure_evidence": (
            "Archive routed-board clearance, board STEP, supplier-model, and enclosure "
            "physical-fit evidence before any enclosure or first-article release."
        ),
        "release_evidence": (
            "Produce and sign the required production release artifact from routed "
            "board, supplier, factory, or first-article evidence."
        ),
    }
    if path_text.endswith(".template.json") or path_text.endswith(".template.yaml"):
        return actions["template"]
    return actions.get(kind, actions["release_evidence"])


def ensure_row(rows: dict[str, dict[str, Any]], path_text: str, source_field: str) -> dict[str, Any]:
    resolved = resolve_repo_path(path_text)
    present = resolved.exists()
    if resolved.is_dir():
        artifact_kind = "directory"
    elif resolved.is_file():
        artifact_kind = "file"
    else:
        artifact_kind = "missing"
    kind = evidence_kind(path_text, source_field)
    row = rows.setdefault(
        path_text,
        {
            "path": path_text,
            "resolved_path": display_rel(resolved),
            "evidence_kind": kind,
            "source_refs": [],
            "current_presence": {
                "present": present,
                "artifact_kind": artifact_kind,
            },
            "release_evidence": False,
            "template_only": kind == "template",
            "acceptance_state": "blocked_fail_closed_template_only"
            if kind == "template"
            else "blocked_fail_closed_missing_required_evidence",
            "next_unblock_action": required_action(kind, path_text),
        },
    )
    if present and kind != "template":
        row["acceptance_state"] = "present_unvalidated_still_fail_closed"
        row["next_unblock_action"] = (
            "Validate content, signatures, traceability, limits, freshness, and "
            "owner disposition before treating this artifact as acceptance evidence."
        )
    return row


def collect_template_rows(
    rows: dict[str, dict[str, Any]], template_manifest: dict[str, Any]
) -> None:
    for item in as_list(template_manifest.get("template_inventory")):
        if not isinstance(item, dict):
            continue
        template_id = str(item.get("id", "unknown_template"))
        path = item.get("path")
        if isinstance(path, str):
            row = ensure_row(rows, path, "template_path")
            add_source(row, f"template_inventory.{template_id}", "path")
        future_path = item.get("future_evidence_path")
        if isinstance(future_path, str):
            row = ensure_row(rows, future_path, "future_evidence_path")
            add_source(row, f"template_inventory.{template_id}", "future_evidence_path")


def collect_selected_hardware_rows(
    rows: dict[str, dict[str, Any]], selected: dict[str, Any]
) -> None:
    policy = selected.get("first_article_policy")
    if isinstance(policy, dict):
        for field in (
            "required_transcript",
            "required_traveler",
            "required_factory_limits",
            "required_probe_coordinates",
            "required_routed_clearance_release",
        ):
            value = policy.get(field)
            if isinstance(value, str):
                row = ensure_row(rows, value, field)
                add_source(row, "first_article_policy", field)

    for record in as_list(selected.get("selected_hardware_first_article_records")):
        if not isinstance(record, dict):
            continue
        function = str(record.get("function", "unknown_function"))
        for path in as_list(record.get("required_outputs")):
            if isinstance(path, str):
                row = ensure_row(rows, path, "required_outputs")
                add_source(
                    row,
                    f"selected_hardware_first_article_records.{function}",
                    "required_outputs",
                    function,
                )

    inventory = selected.get("release_output_inventory")
    if isinstance(inventory, dict):
        for field in ("required_common_outputs",):
            for path in as_list(inventory.get(field)):
                if isinstance(path, str):
                    row = ensure_row(rows, path, field)
                    add_source(row, "release_output_inventory", field)


def collect_enclosure_rows(rows: dict[str, dict[str, Any]], enclosure: dict[str, Any]) -> None:
    for record in as_list(enclosure.get("selected_hardware_release_records")):
        if not isinstance(record, dict):
            continue
        function = str(record.get("function", "unknown_function"))
        for path in as_list(record.get("required_absent_evidence")):
            if isinstance(path, str):
                row = ensure_row(rows, path, "required_absent_evidence")
                add_source(
                    row,
                    f"selected_hardware_release_records.{function}",
                    "required_absent_evidence",
                    function,
                )
    for path in as_list(enclosure.get("required_absent_outputs")):
        if isinstance(path, str):
            row = ensure_row(rows, path, "required_absent_outputs")
            add_source(row, "production_enclosure_first_article_release_execution", "required_absent_outputs")


def collect_burndown_rows(rows: dict[str, dict[str, Any]], burndown: dict[str, Any]) -> None:
    for item in as_list(burndown.get("execution_burndown")):
        if not isinstance(item, dict):
            continue
        item_id = str(item.get("id", "unknown_burndown_item"))
        owner = str(item.get("owner", ""))
        for field in ("required_outputs", "required_common_outputs", "required_functional_transcripts"):
            for path in as_list(item.get(field)):
                if isinstance(path, str):
                    row = ensure_row(rows, path, field)
                    add_source(row, f"execution_burndown.{item_id}", field, owner)


def collect_forbidden_claims(*documents: dict[str, Any]) -> list[str]:
    claims: list[str] = []
    for document in documents:
        for claim in as_list(document.get("forbidden_claims")):
            if isinstance(claim, str) and claim not in claims:
                claims.append(claim)
    return sorted(claims)


def build_report(
    template_path: Path,
    selected_path: Path,
    enclosure_path: Path,
    burndown_path: Path,
    report_path: Path,
) -> dict[str, Any]:
    template_manifest = load_yaml(template_path)
    selected = load_yaml(selected_path)
    enclosure = load_yaml(enclosure_path)
    burndown = load_yaml(burndown_path)

    rows: dict[str, dict[str, Any]] = {}
    collect_template_rows(rows, template_manifest)
    collect_selected_hardware_rows(rows, selected)
    collect_enclosure_rows(rows, enclosure)
    collect_burndown_rows(rows, burndown)
    matrix = [rows[path] for path in sorted(rows)]

    template_rows = [row for row in matrix if row["template_only"]]
    required_non_template_rows = [row for row in matrix if not row["template_only"]]
    missing_required_rows = [
        row for row in required_non_template_rows if not row["current_presence"]["present"]
    ]
    present_required_rows = [
        row for row in required_non_template_rows if row["current_presence"]["present"]
    ]

    return {
        "schema": "eliza.e1_phone_first_article_bench_acceptance_matrix.v1",
        "status": "blocked_fail_closed_first_article_acceptance_evidence_missing",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Bench and first-article acceptance matrix for required E1 phone "
            "logs, traveler, limits, probe/fixture, RF, routed-clearance, and "
            "release evidence. This report distinguishes empty templates from "
            "executed logs and records current file presence only. It is not a "
            "first-article pass, not a factory release, not enclosure signoff, "
            "not fabrication approval, and not end-to-end readiness."
        ),
        "inputs": {
            "bench_first_article_template_manifest": {
                "path": display_rel(template_path),
                "schema": template_manifest.get("schema"),
                "status": template_manifest.get("status"),
                "date": template_manifest.get("date"),
            },
            "selected_hardware_first_article_execution": {
                "path": display_rel(selected_path),
                "schema": selected.get("schema"),
                "status": selected.get("status"),
                "date": selected.get("date"),
            },
            "production_enclosure_first_article_release_execution": {
                "path": display_rel(enclosure_path),
                "schema": enclosure.get("schema"),
                "status": enclosure.get("status"),
                "date": enclosure.get("date"),
            },
            "production_factory_output_burndown": {
                "path": display_rel(burndown_path),
                "schema": burndown.get("schema"),
                "status": burndown.get("status"),
                "date": burndown.get("date"),
            },
            "report_path": display_rel(report_path),
        },
        "summary": {
            "matrix_row_count": len(matrix),
            "template_row_count": len(template_rows),
            "required_non_template_row_count": len(required_non_template_rows),
            "present_required_non_template_row_count": len(present_required_rows),
            "missing_required_non_template_row_count": len(missing_required_rows),
            "executed_logs_present": False,
            "first_article_traveler_present": any(
                row["evidence_kind"] == "traveler" and row["current_presence"]["present"]
                for row in required_non_template_rows
            ),
            "factory_limits_present": any(
                row["evidence_kind"] == "limits" and row["current_presence"]["present"]
                for row in required_non_template_rows
            ),
            "probe_evidence_present": any(
                row["evidence_kind"] == "probe_or_fixture" and row["current_presence"]["present"]
                for row in required_non_template_rows
            ),
            "release_state": "blocked_fail_closed",
        },
        "acceptance_policy": {
            "templates_are_release_evidence": False,
            "presence_only_inventory_unlocks_release": False,
            "all_required_non_template_rows_must_exist_and_validate": True,
            "executed_logs_must_replace_templates": True,
            "board_serial_traceability_required": True,
            "fixture_id_traceability_required": True,
            "test_software_revision_required": True,
            "supplier_lot_traceability_required": True,
            "operator_and_owner_signoff_required": True,
            "release_allowed": False,
            "fabrication_release_allowed": False,
            "factory_test_release_allowed": False,
            "selected_hardware_first_article_release_allowed": False,
            "enclosure_physical_fit_release_allowed": False,
            "end_to_end_release_allowed": False,
        },
        "acceptance_matrix": matrix,
        "missing_required_evidence": missing_required_rows,
        "present_required_evidence_unvalidated": present_required_rows,
        "template_inventory": template_rows,
        "next_unblock_order": [
            "Route and DRC/ ERC close the EVT1 board and archive fabrication, assembly, and STEP outputs.",
            "Generate factory limits, probe coordinates, fixture program, and RF calibration procedure from routed first-article hardware.",
            "Execute bench logs for USB-C PD, USB2 ADB/fastboot, charger CC/CV, side-key force/travel/wake, display, camera, RF, and wireless identity.",
            "Bind every log to board serial, supplier lots, fixture ID, test software revision, operator, limits, and owner disposition.",
            "Sign the first-article traveler and routed-clearance/enclosure physical-fit release before changing any release flag.",
        ],
        "forbidden_claims": collect_forbidden_claims(
            template_manifest, selected, enclosure, burndown
        ),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--template-manifest", type=Path, default=DEFAULT_TEMPLATE_MANIFEST)
    parser.add_argument(
        "--selected-hardware-execution",
        type=Path,
        default=DEFAULT_SELECTED_HARDWARE_EXECUTION,
    )
    parser.add_argument(
        "--enclosure-execution",
        type=Path,
        default=DEFAULT_ENCLOSURE_EXECUTION,
    )
    parser.add_argument("--factory-burndown", type=Path, default=DEFAULT_FACTORY_BURNDOWN)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write the YAML report to --report instead of printing to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.template_manifest,
        args.selected_hardware_execution,
        args.enclosure_execution,
        args.factory_burndown,
        args.report,
    )
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
