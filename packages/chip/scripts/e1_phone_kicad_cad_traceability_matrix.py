#!/usr/bin/env python3
"""Generate a fail-closed KiCad-to-CAD traceability matrix for the E1 phone."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "board/kicad/e1-phone/kicad-cad-traceability-matrix-2026-05-22.yaml"
FOOTPRINT_MANIFEST = ROOT / "board/kicad/e1-phone/development-footprint-library-manifest-2026-05-22.yaml"
PAD_AUDIT = ROOT / "board/kicad/e1-phone/development-pad-pin-coverage-audit-2026-05-22.yaml"
BOARD_BINDING = ROOT / "board/kicad/e1-phone/real-footprint-development-board-binding-2026-05-22.yaml"
STEP_INTAKE = ROOT / "board/kicad/e1-phone/real-footprint-development-step-intake-2026-05-22.yaml"
PINOUT_MANIFEST = ROOT / "board/kicad/e1-phone/supplier-pinouts/pinout-evidence-manifest.yaml"
CAD_CONNECTIONS = ROOT / "mechanical/e1-phone/review/cad-connection-coverage.json"


class NoAliasDumper(yaml.SafeDumper):
    def ignore_aliases(self, data: Any) -> bool:
        return True


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)} must be a YAML mapping")
    return data


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{rel(path)} must be a JSON object")
    return data


def footprint_name(value: str) -> str:
    return value.split(":")[-1]


def file_exists(path_text: str) -> bool:
    path = ROOT / path_text
    return path.exists()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def public_source_urls(pinout: dict[str, Any]) -> list[str]:
    source_doc = pinout.get("source_doc")
    if isinstance(source_doc, str):
        urls = [source_doc]
    elif isinstance(source_doc, list):
        urls = [str(item.get("url", "")) if isinstance(item, dict) else str(item) for item in source_doc]
    else:
        urls = []
    for item in pinout.get("source_doc_alt", []):
        urls.append(str(item))
    return sorted({url for url in urls if url.startswith("http")})


def declared_pin_count(pinout: dict[str, Any]) -> int:
    part = pinout.get("part")
    if isinstance(part, dict):
        connector = part.get("connector")
        if isinstance(connector, dict) and connector.get("pin_count"):
            return int(connector["pin_count"])
    mechanical = pinout.get("mechanical")
    if isinstance(mechanical, dict):
        for key in ("fpc_pin_count", "pin_count", "bump_count", "positions"):
            if key in mechanical:
                return int(mechanical[key])
        if "contacts_per_row" in mechanical and "rows" in mechanical:
            return int(mechanical["contacts_per_row"]) * int(mechanical["rows"])
    numbering = pinout.get("pin_numbering")
    if isinstance(numbering, dict) and numbering.get("scheme") == "dual_row_A_B":
        row_a_end = str(numbering["row_A_range"][1])
        row_b_end = str(numbering["row_B_range"][1])
        return int(row_a_end.removeprefix("A")) + int(row_b_end.removeprefix("B"))
    pins = pinout.get("pins")
    if isinstance(pins, list):
        concrete = [item for item in pins if isinstance(item, dict) and str(item.get("pin")) != "ALL"]
        if concrete:
            return len(concrete)
    return 0


def recursive_pin_record_count(value: Any) -> int:
    if isinstance(value, dict):
        total = 1 if "pin" in value and str(value.get("pin")) != "ALL" else 0
        return total + sum(recursive_pin_record_count(item) for item in value.values())
    if isinstance(value, list):
        return sum(recursive_pin_record_count(item) for item in value)
    return 0


def build_report() -> dict[str, Any]:
    footprint_manifest = load_yaml(FOOTPRINT_MANIFEST)
    pad_audit = load_yaml(PAD_AUDIT)
    board_binding = load_yaml(BOARD_BINDING)
    step_intake = load_yaml(STEP_INTAKE)
    pinouts = load_yaml(PINOUT_MANIFEST)
    connections = load_json(CAD_CONNECTIONS)

    library_records = {
        str(record["name"]): record
        for record in footprint_manifest.get("records", [])
        if isinstance(record, dict) and record.get("name")
    }
    pad_records = {
        str(record["footprint"]): record
        for record in pad_audit.get("records", [])
        if isinstance(record, dict) and record.get("footprint")
    }
    binding_records = [
        record
        for record in board_binding.get("bindings", [])
        if isinstance(record, dict)
    ]
    step_records = [
        record
        for record in step_intake.get("footprints", [])
        if isinstance(record, dict)
    ]
    captured_pinouts = [
        record
        for record in pinouts.get("captured_pinouts", [])
        if isinstance(record, dict)
    ]
    connection_records = [
        record
        for record in connections.get("connections", [])
        if isinstance(record, dict)
    ]

    binding_by_type: dict[str, list[dict[str, Any]]] = {}
    for record in binding_records:
        binding_by_type.setdefault(footprint_name(str(record.get("target", ""))), []).append(record)
    step_by_type: dict[str, list[dict[str, Any]]] = {}
    for record in step_records:
        step_by_type.setdefault(footprint_name(str(record.get("footprint", ""))), []).append(record)

    footprint_rows: list[dict[str, Any]] = []
    incomplete_footprints: list[str] = []
    for name in sorted(library_records):
        library = library_records[name]
        pad = pad_records.get(name, {})
        bindings = binding_by_type.get(name, [])
        steps = step_by_type.get(name, [])
        footprint_file = str(pad.get("footprint_file") or library.get("model_binding", {}).get("footprint_file") or "")
        row = {
            "footprint": name,
            "footprint_file": footprint_file,
            "footprint_file_present": file_exists(footprint_file) if footprint_file else False,
            "library_status": library.get("status"),
            "step_binding_status": library.get("step_binding_status"),
            "manifest_pin_count": library.get("pin_count"),
            "pad_audit_present": bool(pad),
            "pad_count": pad.get("pad_count"),
            "electrical_pad_count": pad.get("electrical_pad_count"),
            "electrical_pad_count_matches_manifest": pad.get(
                "electrical_pad_count_matches_manifest"
            ),
            "pinout_file": pad.get("pinout_file", ""),
            "pinout_status": pad.get("pinout_status", ""),
            "pinout_release_allowed": pad.get("release_allowed"),
            "coverage": pad.get("coverage", ""),
            "land_pattern_basis": pad.get("land_pattern_basis", ""),
            "local_terminal_contract": pad.get("local_terminal_contract", []),
            "support_pattern_has_explicit_provenance": pad.get(
                "support_pattern_has_explicit_provenance"
            ),
            "board_instance_count": len(bindings),
            "board_bound_instance_count": sum(1 for item in bindings if item.get("bound") is True),
            "board_embedded_body_count": sum(
                1
                for item in bindings
                if item.get("embedded_library_body") in (True, 1, "1", "true")
            ),
            "board_assigned_pad_net_count": sum(
                int(item.get("assigned_pad_net_count") or 0) for item in bindings
            ),
            "board_unassigned_pad_count": sum(
                int(item.get("unassigned_pad_count") or 0) for item in bindings
            ),
            "step_instance_count": len(steps),
            "step_pad_visual_count": sum(int(item.get("pad_count") or 0) for item in steps),
            "release_credit": False,
        }
        row["pass"] = bool(
            row["footprint_file_present"]
            and row["pad_audit_present"]
            and row["electrical_pad_count_matches_manifest"] is True
            and row["board_instance_count"] == row["board_bound_instance_count"]
            and row["board_instance_count"] == row["board_embedded_body_count"]
            and row["board_instance_count"] == row["step_instance_count"]
        )
        if not row["pass"]:
            incomplete_footprints.append(name)
        footprint_rows.append(row)

    cad_rows: list[dict[str, Any]] = []
    incomplete_connections: list[str] = []
    for record in connection_records:
        row = {
            "id": record.get("id"),
            "cad_part": record.get("cad_part"),
            "connection_type": record.get("connection_type", ""),
            "physical_medium": record.get("physical_medium", ""),
            "electrical_class": record.get("electrical_class", ""),
            "controlled_impedance_required": bool(
                record.get("controlled_impedance_required", False)
            ),
            "impedance_requirement": record.get("impedance_requirement", ""),
            "min_bend_radius_mm": record.get("min_bend_radius_mm"),
            "supplier_release_required": bool(record.get("supplier_release_required", False)),
            "cad_step": record.get("cad_step"),
            "cad_part_present": record.get("cad_part_present"),
            "cad_step_bytes": record.get("cad_step_bytes"),
            "visual_route_span_mm": record.get("visual_route_span_mm"),
            "represented_net_count": record.get("represented_net_count"),
            "represented_nets": record.get("represented_nets", record.get("nets", [])),
            "from_terminal_part": record.get("from_terminal_part"),
            "from_terminal_step": record.get("from_terminal_step"),
            "from_terminal_step_bytes": record.get("from_terminal_step_bytes"),
            "to_terminal_part": record.get("to_terminal_part"),
            "to_terminal_step": record.get("to_terminal_step"),
            "to_terminal_step_bytes": record.get("to_terminal_step_bytes"),
            "terminal_marker_count": record.get("terminal_marker_count"),
            "terminal_markers_present": record.get("terminal_markers_present"),
            "terminal_step_bytes_total": record.get("terminal_step_bytes_total"),
            "endpoint_center_distance_mm": record.get("endpoint_center_distance_mm"),
            "endpoints_present": record.get("endpoints_present"),
            "net_count": len(record.get("nets", [])),
            "nets": record.get("nets", []),
            "all_nets_in_routed_development_board": record.get(
                "all_nets_in_routed_development_board"
            ),
            "controlled_impedance_requirement_defined": bool(
                record.get("controlled_impedance_requirement_defined", False)
            ),
            "bend_radius_requirement_defined": bool(
                record.get("bend_radius_requirement_defined", False)
            ),
            "release_credit": record.get("release_credit"),
            "pass": record.get("pass") is True,
        }
        if (
            not row["pass"]
            or row["represented_nets"] != row["nets"]
            or int(row.get("represented_net_count") or 0) != len(row["represented_nets"])
        ):
            incomplete_connections.append(str(row["id"]))
        cad_rows.append(row)

    captured_files_missing = [
        str(record.get("file"))
        for record in captured_pinouts
        if not (ROOT / "board/kicad/e1-phone/supplier-pinouts" / str(record.get("file"))).is_file()
    ]
    captured_pinout_rows: list[dict[str, Any]] = []
    incomplete_pinout_details: list[str] = []
    for record in captured_pinouts:
        file_name = str(record.get("file", ""))
        path = ROOT / "board/kicad/e1-phone/supplier-pinouts" / file_name
        pinout = load_yaml(path) if path.is_file() else {}
        urls = public_source_urls(pinout)
        declared_count = declared_pin_count(pinout)
        concrete_record_count = recursive_pin_record_count(pinout)
        row = {
            "file": file_name,
            "function": record.get("function"),
            "part": record.get("part"),
            "schema": pinout.get("schema"),
            "evidence_class": pinout.get("evidence_class"),
            "manifest_evidence_class": record.get("evidence_class"),
            "status": record.get("status"),
            "present": path.is_file(),
            "sha256": file_sha256(path) if path.is_file() else "",
            "public_source_url_count": len(urls),
            "declared_pin_count": declared_count,
            "captured_pin_record_count": concrete_record_count,
            "public_source_present": bool(urls),
            "release_credit": False,
        }
        row["pass"] = bool(
            row["present"]
            and row["schema"] == "eliza.e1_phone_supplier_pinout.v1"
            and row["evidence_class"] in {
                "public_supplier_datasheet",
                "public_som_connector_pinout",
                "public_hardware_design_pdf",
            }
            and (
                row["manifest_evidence_class"] in ("", None)
                or row["manifest_evidence_class"] == row["evidence_class"]
            )
            and row["public_source_present"]
            and row["declared_pin_count"] > 0
        )
        if not row["pass"]:
            incomplete_pinout_details.append(file_name)
        captured_pinout_rows.append(row)
    status = (
        "local_traceability_complete_not_release"
        if not incomplete_footprints
        and not incomplete_connections
        and not captured_files_missing
        and not incomplete_pinout_details
        and len(library_records) == 32
        and len(pad_records) == 32
        and len(binding_records) == 89
        and len(step_records) == 89
        and len(connection_records) == 21
        else "blocked_traceability_gap"
    )
    return {
        "schema": "eliza.e1_phone_kicad_cad_traceability_matrix.v1",
        "date": "2026-05-22",
        "status": status,
        "claim_boundary": (
            "Local KiCad-to-CAD traceability matrix across public pinout captures, "
            "development footprint patterns, board-bound footprints, generated STEP "
            "visuals, and CAD connection markers. This is not supplier approval, DRC/ERC, "
            "fabrication release, or physical first-article evidence."
        ),
        "source_artifacts": [
            rel(FOOTPRINT_MANIFEST),
            rel(PAD_AUDIT),
            rel(BOARD_BINDING),
            rel(STEP_INTAKE),
            rel(PINOUT_MANIFEST),
            rel(CAD_CONNECTIONS),
        ],
        "summary": {
            "footprint_library_count": len(library_records),
            "pad_audit_record_count": len(pad_records),
            "board_bound_instance_count": len(binding_records),
            "step_footprint_instance_count": len(step_records),
            "captured_pinout_file_count": len(captured_pinouts),
            "captured_pinout_declared_pin_count_total": sum(
                int(row["declared_pin_count"] or 0) for row in captured_pinout_rows
            ),
            "captured_pinout_record_count_total": sum(
                int(row["captured_pin_record_count"] or 0) for row in captured_pinout_rows
            ),
            "captured_pinout_public_source_count": sum(
                1 for row in captured_pinout_rows if row["public_source_present"]
            ),
            "pinout_bound_footprint_count": int(
                pad_audit.get("pinout_bound_footprint_count") or 0
            ),
            "all_pinout_bound_footprints_have_terminal_contract": bool(
                pad_audit.get("all_pinout_bound_footprints_have_terminal_contract")
            ),
            "cad_connection_count": len(connection_records),
            "cad_connection_represented_net_count_total": sum(
                int(record.get("represented_net_count") or len(record.get("nets", [])))
                for record in connection_records
            ),
            "cad_connection_visual_route_span_total_mm": round(
                sum(float(record.get("visual_route_span_mm") or 0.0) for record in connection_records),
                3,
            ),
            "cad_connection_terminal_marker_count": sum(
                int(record.get("terminal_marker_count") or 0) for record in connection_records
            ),
            "cad_connection_terminal_pair_count": sum(
                1 for record in connection_records if record.get("terminal_markers_present") is True
            ),
            "cad_connection_solid_step_part_count": int(
                connections.get("required_connection_solid_step_part_count", 0) or 0
            ),
            "cad_connection_solid_step_part_set_count": int(
                connections.get("passing_connection_solid_step_part_set_count", 0) or 0
            ),
            "cad_connection_solid_step_part_bytes_total": int(
                connections.get("connection_solid_step_part_bytes_total", 0) or 0
            ),
            "cad_connection_physical_medium_counts": connections.get(
                "physical_medium_counts", {}
            ),
            "cad_connection_electrical_class_counts": connections.get(
                "electrical_class_counts", {}
            ),
            "cad_connection_controlled_impedance_count": int(
                connections.get("controlled_impedance_connection_count", 0) or 0
            ),
            "cad_connection_controlled_impedance_requirement_defined_count": int(
                connections.get("controlled_impedance_requirement_defined_count", 0) or 0
            ),
            "cad_connection_bend_radius_requirement_defined_count": int(
                connections.get("bend_radius_requirement_defined_count", 0) or 0
            ),
            "cad_connection_supplier_release_required_count": int(
                connections.get("supplier_release_required_connection_count", 0) or 0
            ),
            "explicit_support_pattern_count": int(
                pad_audit.get("explicit_support_pattern_count") or 0
            ),
            "all_support_patterns_have_explicit_provenance": bool(
                pad_audit.get("all_support_patterns_have_explicit_provenance")
            ),
            "incomplete_footprint_count": len(incomplete_footprints),
            "incomplete_cad_connection_count": len(incomplete_connections),
            "missing_captured_pinout_file_count": len(captured_files_missing),
            "incomplete_captured_pinout_detail_count": len(incomplete_pinout_details),
            "release_credit": False,
        },
        "footprint_traceability": footprint_rows,
        "cad_connection_traceability": cad_rows,
        "captured_pinouts": captured_pinout_rows,
        "gaps": {
            "incomplete_footprints": incomplete_footprints,
            "incomplete_cad_connections": incomplete_connections,
            "captured_pinout_files_missing": captured_files_missing,
            "incomplete_captured_pinout_details": incomplete_pinout_details,
        },
        "release_blockers_preserved": [
            "supplier-approved land patterns and pad maps",
            "supplier-approved STEP/B-rep models",
            "clean DRC/ERC/SI/PI/RF and fabrication approval",
            "physical routed-board clearance and first-article signoff",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUT)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    report = build_report()
    text = yaml.dump(report, Dumper=NoAliasDumper, sort_keys=False, width=100)
    if args.write_report:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
        print(f"wrote {args.output}")
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
