#!/usr/bin/env python3
"""Generate the E1 phone supplier return evidence acceptance matrix.

This is a fail-closed intake matrix. It inventories expected supplier return
evidence and local intake paths, but it does not accept missing or unvalidated
evidence and cannot unlock KiCad, fabrication, enclosure, or phone release.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1] if len(ROOT.parents) > 1 else ROOT
REPORT_DATE = "2026-05-22"

DEFAULT_OUTBOUND_MANIFEST = (
    ROOT / "board/kicad/e1-phone/production/sourcing/"
    "supplier-evidence-outbound-intake-manifest-2026-05-22.yaml"
)
DEFAULT_GAP_MAP = ROOT / "board/kicad/e1-phone/supplier-evidence-drawing-gap-map-2026-05-22.yaml"
DEFAULT_REPORT = (
    ROOT / "board/kicad/e1-phone/production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)
DEFAULT_MARKDOWN_REPORT = DEFAULT_REPORT.with_suffix(".md")

EVIDENCE_KEY_TO_RETURN_FILE = {
    "rfq_response_pack": "rfq-response-pack.yaml",
    "signed_2d_drawing": "signed-2d-drawing.pdf",
    "pinout_or_pad_map": "pinout-or-pad-map.csv",
    "recommended_land_pattern": "recommended-land-pattern.pdf",
    "step_or_brep_model": "supplier-model.step",
    "sample_lot_tracking": "sample-lot-tracking.yaml",
    "incoming_inspection": "sample-inspection.yaml",
    "lifecycle_stock_quote": "lifecycle-stock-quote.yaml",
    "compliance_pack_index": "compliance-pack-index.yaml",
}

EVIDENCE_KEY_TO_KICAD_RELEASE_KEY = {
    "pinout_review_signoff": "pinout_review",
    "symbol_review": "symbol_review",
    "footprint_review": "footprint_review",
    "footprint_3d_binding": "footprint_3d_binding",
    "production_schematic_capture": "production_schematic_capture",
    "erc_after_capture": "erc_after_capture",
    "drc_after_footprint_replacement": "drc_after_footprint_replacement",
    "routed_clearance_or_functional_release": "functional_release",
}


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def read_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a YAML mapping")
    return data


def display_rel(path: Path) -> str:
    if path.is_relative_to(ROOT):
        return path.relative_to(ROOT).as_posix()
    if path.is_relative_to(REPO_ROOT):
        return path.relative_to(REPO_ROOT).as_posix()
    return str(path)


def resolve_repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return REPO_ROOT / path
    if path_text.startswith("board/"):
        return ROOT / path
    return ROOT / path


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def path_presence(path_text: str) -> dict[str, Any]:
    resolved = resolve_repo_path(path_text)
    kind = "missing"
    if resolved.is_file():
        kind = "file"
    elif resolved.is_dir():
        kind = "directory"
    return {
        "path": path_text,
        "resolved_path": display_rel(resolved),
        "present": resolved.exists(),
        "artifact_kind": kind,
    }


def return_file_paths(record: dict[str, Any], lane_record: dict[str, Any] | None) -> dict[str, str]:
    paths: dict[str, str] = {}
    response_pack = record.get("supplier_response_pack")
    if isinstance(response_pack, str):
        paths["rfq_response_pack"] = response_pack

    exact_missing = record.get("exact_missing_supplier_evidence", {})
    if isinstance(exact_missing, dict):
        for key, path_text in exact_missing.items():
            if isinstance(path_text, str):
                normalized_key = "signed_2d_drawing" if key == "signed_drawing" else key
                paths[normalized_key] = path_text

    if lane_record:
        archive_paths = as_list(
            lane_record.get("expected_return_archive")
            or lane_record.get("expected_return_archives")
        )
        archive_for_record = next(
            (
                path_text
                for path_text in archive_paths
                if isinstance(path_text, str) and path_text == response_pack
            ),
            None,
        )
        if archive_for_record is None and len(archive_paths) == 1:
            archive_for_record = archive_paths[0]
        if isinstance(archive_for_record, str):
            archive_dir = Path(archive_for_record).parent.as_posix()
            for file_name in lane_record.get("required_return_files", []):
                if isinstance(file_name, str):
                    for evidence_key, expected_file in EVIDENCE_KEY_TO_RETURN_FILE.items():
                        if file_name == expected_file and evidence_key not in paths:
                            paths[evidence_key] = f"{archive_dir}/{file_name}"

    return paths


def build_evidence_rows(
    record: dict[str, Any],
    lane_record: dict[str, Any] | None,
    required_keys: list[str],
) -> list[dict[str, Any]]:
    paths = return_file_paths(record, lane_record)
    kicad_release_evidence = record.get("kicad_capture_release_evidence", {})
    if isinstance(kicad_release_evidence, dict):
        for evidence_key, release_key in EVIDENCE_KEY_TO_KICAD_RELEASE_KEY.items():
            path_text = kicad_release_evidence.get(release_key)
            if isinstance(path_text, str):
                paths.setdefault(evidence_key, path_text)
    rows: list[dict[str, Any]] = []
    for evidence_key in required_keys:
        path_text = paths.get(evidence_key)
        row: dict[str, Any] = {
            "evidence_class": evidence_key,
            "required_return_file": EVIDENCE_KEY_TO_RETURN_FILE.get(evidence_key),
            "current_presence": False,
            "acceptance_state": "blocked_missing_required_supplier_return",
        }
        if path_text:
            presence = path_presence(path_text)
            row.update(
                {
                    "expected_local_intake_path": presence["path"],
                    "resolved_path": presence["resolved_path"],
                    "current_presence": presence["present"],
                    "artifact_kind": presence["artifact_kind"],
                }
            )
            if presence["present"]:
                row["acceptance_state"] = "blocked_present_but_unvalidated_fail_closed"
        else:
            row["expected_local_intake_path"] = None
            row["resolved_path"] = None
            row["artifact_kind"] = "missing_path_mapping"
        rows.append(row)
    return rows


def lane_records_by_function(outbound: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_function: dict[str, dict[str, Any]] = {}
    for lane_record in outbound.get("template_records", []):
        if not isinstance(lane_record, dict):
            continue
        functions = as_list(
            lane_record.get("maps_to_gap_map_function")
            or lane_record.get("maps_to_gap_map_functions")
        )
        for function in functions:
            if isinstance(function, str):
                by_function[function] = lane_record
    return by_function


def next_unblock_action(
    lane_record: dict[str, Any] | None,
    evidence_rows: list[dict[str, Any]],
    specialized_returns: list[str],
) -> str:
    missing = [row for row in evidence_rows if not row["current_presence"]]
    if lane_record is None:
        return (
            "Create an outbound intake template for this gap-map-only supplier "
            "function, then obtain the signed supplier response pack and all "
            "required return evidence."
        )
    if missing:
        return (
            "Receive and archive the supplier-signed response pack plus every "
            "missing required return file at the listed local intake paths; "
            "then run supplier, sample, lifecycle, pinout, symbol, footprint, "
            "3D, ERC, DRC, routed, and first-article review gates."
        )
    if specialized_returns:
        return (
            "Required files are present only as paths; verify specialized "
            "supplier returns, signatures, freshness, sample lot identity, "
            "inspection results, lifecycle/stock approval, and downstream "
            "KiCad/release review gates before any acceptance claim."
        )
    return (
        "Required files are present only as paths; complete validation and all "
        "downstream review gates before any acceptance claim."
    )


def build_matrix_rows(outbound: dict[str, Any], gap_map: dict[str, Any]) -> list[dict[str, Any]]:
    lane_by_function = lane_records_by_function(outbound)
    required_keys = gap_map.get("required_common_evidence_keys", [])
    if not isinstance(required_keys, list):
        raise SystemExit("gap map required_common_evidence_keys must be a list")

    rows: list[dict[str, Any]] = []
    for gap_record in gap_map.get("selected_function_gap_records", []):
        if not isinstance(gap_record, dict):
            continue
        function = gap_record.get("function")
        if not isinstance(function, str):
            raise SystemExit("gap-map record missing string function")
        lane_record = lane_by_function.get(function)
        evidence_rows = build_evidence_rows(gap_record, lane_record, required_keys)
        specialized_returns = [
            item
            for item in gap_record.get("required_specialized_returns", [])
            if isinstance(item, str)
        ]
        missing_rows = [row for row in evidence_rows if not row["current_presence"]]
        present_rows = [row for row in evidence_rows if row["current_presence"]]
        kicad_release_evidence = gap_record.get("kicad_capture_release_evidence", {})
        kicad_presence = []
        if isinstance(kicad_release_evidence, dict):
            kicad_presence = [
                {
                    "release_evidence_class": key,
                    **path_presence(path_text),
                    "release_allowed_by_presence": False,
                }
                for key, path_text in kicad_release_evidence.items()
                if isinstance(path_text, str)
            ]
        rows.append(
            {
                "lane": lane_record.get("lane") if lane_record else None,
                "function": function,
                "supplier_pack_id": gap_record.get("supplier_pack_id"),
                "selected_hardware": gap_record.get("selected_hardware"),
                "outbound_template": lane_record.get("template") if lane_record else None,
                "outbound_template_presence": (
                    path_presence(lane_record["template"])
                    if lane_record and isinstance(lane_record.get("template"), str)
                    else None
                ),
                "expected_return_archive_paths": [
                    path
                    for path in as_list(
                        (lane_record or {}).get("expected_return_archive")
                        or (lane_record or {}).get("expected_return_archives")
                    )
                    if isinstance(path, str)
                ],
                "required_supplier_return_evidence": evidence_rows,
                "required_specialized_returns": specialized_returns,
                "kicad_capture_and_release_evidence_presence": kicad_presence,
                "summary": {
                    "required_supplier_return_evidence_count": len(evidence_rows),
                    "present_supplier_return_evidence_count": len(present_rows),
                    "missing_supplier_return_evidence_count": len(missing_rows),
                    "kicad_release_evidence_present_count": sum(
                        1 for item in kicad_presence if item["present"]
                    ),
                    "all_required_supplier_return_evidence_present": not missing_rows,
                    "acceptance_state": "blocked_fail_closed",
                    "release_allowed": False,
                },
                "next_unblock_action": next_unblock_action(
                    lane_record, evidence_rows, specialized_returns
                ),
                "source_gap_status": gap_record.get("status"),
                "source_release_allowed": gap_record.get("release_allowed"),
            }
        )
    return rows


def build_report(
    outbound_path: Path,
    gap_map_path: Path,
    report_path: Path,
    markdown_report_path: Path,
) -> dict[str, Any]:
    outbound = read_yaml(outbound_path)
    gap_map = read_yaml(gap_map_path)
    matrix_rows = build_matrix_rows(outbound, gap_map)
    missing_required = sum(
        row["summary"]["missing_supplier_return_evidence_count"] for row in matrix_rows
    )
    present_required = sum(
        row["summary"]["present_supplier_return_evidence_count"] for row in matrix_rows
    )
    return {
        "schema": "eliza.e1_phone_supplier_return_evidence_acceptance_matrix.v1",
        "status": "blocked_fail_closed_supplier_return_evidence_missing_or_unvalidated",
        "date": REPORT_DATE,
        "claim_boundary": (
            "Fail-closed supplier return evidence acceptance matrix for E1 phone "
            "supplier lanes and gap-map functions. Presence is path existence "
            "only and does not prove supplier acceptance, signature validity, "
            "freshness, sample identity, lifecycle approval, KiCad correctness, "
            "fabrication readiness, enclosure clearance, or end-to-end phone release."
        ),
        "inputs": {
            "outbound_intake_manifest": display_rel(outbound_path),
            "drawing_gap_map": display_rel(gap_map_path),
            "report_path": display_rel(report_path),
            "markdown_report_path": display_rel(markdown_report_path),
            "outbound_manifest_schema": outbound.get("schema"),
            "outbound_manifest_status": outbound.get("status"),
            "drawing_gap_map_schema": gap_map.get("schema"),
            "drawing_gap_map_status": gap_map.get("status"),
        },
        "fail_closed_policy": {
            "supplier_return_required": True,
            "supplier_signature_required": True,
            "sample_lot_required": True,
            "public_listing_counts_as_response": False,
            "outbound_template_counts_as_response": False,
            "presence_only_counts_as_acceptance": False,
            "kicad_capture_allowed": False,
            "route_release_allowed": False,
            "enclosure_release_allowed": False,
            "fabrication_release_allowed": False,
            "end_to_end_phone_release_allowed": False,
            "release_allowed": False,
        },
        "summary": {
            "supplier_lane_or_function_count": len(matrix_rows),
            "required_supplier_return_evidence_count": present_required + missing_required,
            "present_supplier_return_evidence_count": present_required,
            "missing_supplier_return_evidence_count": missing_required,
            "all_required_supplier_return_evidence_present": missing_required == 0,
            "all_rows_fail_closed": True,
            "release_allowed": False,
        },
        "acceptance_matrix": matrix_rows,
        "forbidden_claims": sorted(
            set(outbound.get("forbidden_claims", [])) | set(gap_map.get("forbidden_claims", []))
        ),
    }


def markdown_table(report: dict[str, Any]) -> str:
    lines = [
        "# E1 Phone Supplier Return Evidence Acceptance Matrix",
        "",
        f"Date: `{report['date']}`",
        "",
        f"Status: `{report['status']}`",
        "",
        report["claim_boundary"],
        "",
        "| Lane | Function | Required | Present | Missing | Next unblock action |",
        "| --- | --- | ---: | ---: | ---: | --- |",
    ]
    for row in report["acceptance_matrix"]:
        summary = row["summary"]
        lane = row["lane"] or "gap-map-only"
        action = str(row["next_unblock_action"]).replace("|", "\\|")
        lines.append(
            "| "
            f"`{lane}` | `{row['function']}` | "
            f"{summary['required_supplier_return_evidence_count']} | "
            f"{summary['present_supplier_return_evidence_count']} | "
            f"{summary['missing_supplier_return_evidence_count']} | "
            f"{action} |"
        )
    lines.extend(
        [
            "",
            "## Forbidden Claims",
            "",
            *[f"- `{claim}`" for claim in report["forbidden_claims"]],
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outbound-manifest", type=Path, default=DEFAULT_OUTBOUND_MANIFEST)
    parser.add_argument("--gap-map", type=Path, default=DEFAULT_GAP_MAP)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--markdown-report", type=Path, default=DEFAULT_MARKDOWN_REPORT)
    parser.add_argument(
        "--write-report",
        action="store_true",
        help="Write YAML and Markdown reports instead of printing YAML to stdout.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(
        args.outbound_manifest,
        args.gap_map,
        args.report,
        args.markdown_report,
    )
    yaml_text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(yaml_text, encoding="utf-8")
        args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
        args.markdown_report.write_text(markdown_table(report), encoding="utf-8")
    else:
        print(yaml_text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
