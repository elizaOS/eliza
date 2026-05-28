#!/usr/bin/env python3
"""Create fail-closed supplier-return intake placeholders for the E1 phone.

These files are path placeholders only. They make every expected supplier
return intake path explicit on disk so downstream gates can fail on missing
supplier approval/content instead of missing local directories.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = (
    ROOT / "board/kicad/e1-phone/production/sourcing/readiness/"
    "supplier-return-evidence-acceptance-matrix-2026-05-22.yaml"
)

COMMON_FIELDS = {
    "artifact_id": "blocked_pending_supplier_return",
    "source_requirement_id": "blocked_pending_supplier_return",
    "owner": "blocked_pending_supplier_return",
    "created_at": "blocked_pending_supplier_return",
    "tool_or_supplier_revision": "blocked_pending_supplier_return",
    "input_artifact_hashes": ["blocked_pending_supplier_return"],
    "reviewer": "blocked_pending_supplier_return",
    "reviewed_at": "blocked_pending_supplier_return",
    "disposition": "blocked_pending_supplier_return",
}

SUPPLIER_FIELDS = {
    "supplier_name": "blocked_pending_supplier_return",
    "supplier_part_number": "blocked_pending_supplier_return",
    "manufacturer_part_number": "blocked_pending_supplier_return",
    "drawing_revision": "blocked_pending_supplier_return",
    "sample_lot_or_quote_id": "blocked_pending_supplier_return",
    "signed_supplier_response": False,
    "pinout_or_land_pattern_source": "blocked_pending_supplier_return",
    "mechanical_model_source": "blocked_pending_supplier_return",
}


def load_yaml(path: Path) -> dict[str, Any]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected YAML mapping")
    return data


def repo_path(path_text: str) -> Path:
    path = Path(path_text)
    if path.is_absolute():
        return path
    if path_text.startswith("packages/chip/"):
        return ROOT.parents[1] / path
    return ROOT / path


def placeholder_payload(
    lane: str, function: str, evidence_class: str, path_text: str
) -> dict[str, Any]:
    return {
        "schema": "eliza.e1_phone_supplier_return_intake_placeholder.v1",
        **COMMON_FIELDS,
        **SUPPLIER_FIELDS,
        "artifact_id": f"{lane or function}:{evidence_class}",
        "source_requirement_id": function,
        "owner": f"sourcing:{lane or function}",
        "expected_intake_path": path_text,
        "evidence_class": evidence_class,
        "release_credit": False,
        "claim_boundary": (
            "Local fail-closed supplier-return intake placeholder. This is not "
            "supplier evidence, not a signed drawing, not a verified pinout or "
            "land pattern, not a STEP/B-rep model, and not release evidence."
        ),
        "required_replacement": (
            "Replace this placeholder with the supplier-returned, reviewed, "
            "signed artifact and approved metadata before any KiCad, CAD, "
            "fabrication, enclosure, or production release claim."
        ),
        "forbidden_claims": [
            "supplier_return_received",
            "pinout_approved",
            "land_pattern_approved",
            "step_model_approved",
            "fabrication_ready",
            "release_ready",
        ],
    }


def write_yaml(path: Path, lane: str, function: str, evidence_class: str, path_text: str) -> None:
    payload = placeholder_payload(lane, function, evidence_class, path_text)
    path.write_text(yaml.safe_dump(payload, sort_keys=False), encoding="utf-8")


def write_json(path: Path, lane: str, function: str, evidence_class: str, path_text: str) -> None:
    payload = placeholder_payload(lane, function, evidence_class, path_text)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def write_csv(path: Path, lane: str, function: str, evidence_class: str, path_text: str) -> None:
    artifact_id = f"{lane or function}:{evidence_class}"
    metadata_fields = [
        "artifact_id",
        "source_requirement_id",
        "owner",
        "created_at",
        "tool_or_supplier_revision",
        "input_artifact_hashes",
        "reviewer",
        "reviewed_at",
        "disposition",
        "supplier_name",
        "supplier_part_number",
        "manufacturer_part_number",
        "drawing_revision",
        "sample_lot_or_quote_id",
        "signed_supplier_response",
        "pinout_or_land_pattern_source",
        "mechanical_model_source",
        "release_credit",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                *metadata_fields,
                "net_or_pin",
                "supplier_pin_name",
                "source_revision",
                "lane",
                "function",
                "evidence_class",
                "notes",
            ],
        )
        writer.writeheader()
        writer.writerow(
            {
                "artifact_id": artifact_id,
                "source_requirement_id": function,
                "owner": f"sourcing:{lane or function}",
                "created_at": "blocked_pending_supplier_return",
                "tool_or_supplier_revision": "blocked_pending_supplier_return",
                "input_artifact_hashes": "blocked_pending_supplier_return",
                "reviewer": "blocked_pending_supplier_return",
                "reviewed_at": "blocked_pending_supplier_return",
                "disposition": "blocked_pending_supplier_return",
                "supplier_name": "blocked_pending_supplier_return",
                "supplier_part_number": "blocked_pending_supplier_return",
                "manufacturer_part_number": "blocked_pending_supplier_return",
                "drawing_revision": "blocked_pending_supplier_return",
                "sample_lot_or_quote_id": "blocked_pending_supplier_return",
                "signed_supplier_response": "false",
                "pinout_or_land_pattern_source": "blocked_pending_supplier_return",
                "mechanical_model_source": "blocked_pending_supplier_return",
                "release_credit": "false",
                "net_or_pin": "blocked_pending_supplier_return",
                "supplier_pin_name": "blocked_pending_supplier_return",
                "source_revision": "blocked_pending_supplier_return",
                "lane": lane or function,
                "function": function,
                "evidence_class": evidence_class,
                "notes": f"placeholder for {path_text}; replace with supplier return",
            }
        )


def write_binary_placeholder(
    path: Path, lane: str, function: str, evidence_class: str, path_text: str
) -> None:
    text = (
        "E1 phone supplier-return placeholder\n"
        f"lane: {lane or function}\n"
        f"function: {function}\n"
        f"evidence_class: {evidence_class}\n"
        f"expected_intake_path: {path_text}\n"
        "release_credit: false\n"
        "This is not supplier evidence. Replace with signed supplier artifact.\n"
    )
    path.write_bytes(text.encode("utf-8"))


def write_placeholder(
    path: Path, lane: str, function: str, evidence_class: str, path_text: str
) -> bool:
    if path.exists():
        supplier_return_path = "/production/sourcing/" in path_text
        csv_placeholder = path.suffix.lower() == ".csv"
        existing = path.read_text(encoding="utf-8", errors="ignore") if path.is_file() else ""
        placeholder_markers = [
            "blocked_pending_supplier_return",
            "eliza.e1_phone_supplier_return_intake_placeholder.v1",
            "This is not supplier evidence",
        ]
        if not any(marker in existing for marker in placeholder_markers):
            return False
        kicad_schematic_placeholder = path.suffix.lower() == ".kicad_sch"
        if not supplier_return_path and not csv_placeholder and not kicad_schematic_placeholder:
            return False
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        write_yaml(path, lane, function, evidence_class, path_text)
    elif suffix == ".json":
        write_json(path, lane, function, evidence_class, path_text)
    elif suffix == ".csv":
        write_csv(path, lane, function, evidence_class, path_text)
    elif suffix in {".pdf", ".step", ".stp", ".brep"}:
        write_binary_placeholder(path, lane, function, evidence_class, path_text)
    elif suffix == ".kicad_sch":
        write_yaml(path, lane, function, evidence_class, path_text)
    else:
        path.write_text(
            f"blocked_pending_supplier_return: {lane or function}:{evidence_class}\n",
            encoding="utf-8",
        )
    return True


def main() -> int:
    matrix = load_yaml(MATRIX)
    created: list[str] = []
    existing = 0
    for row in matrix.get("acceptance_matrix", []):
        if not isinstance(row, dict):
            continue
        lane = str(row.get("lane") or row.get("function") or "")
        function = str(row.get("function") or lane)
        for evidence in row.get("required_supplier_return_evidence", []):
            if not isinstance(evidence, dict):
                continue
            path_text = evidence.get("expected_local_intake_path")
            evidence_class = str(evidence.get("evidence_class") or "supplier_return")
            if not isinstance(path_text, str) or not path_text:
                continue
            path = repo_path(path_text)
            if write_placeholder(path, lane, function, evidence_class, path_text):
                created.append(path_text)
            else:
                existing += 1
    print(
        "STATUS: generated fail-closed supplier-return intake placeholders "
        f"created={len(created)} existing={existing}"
    )
    for path_text in created[:20]:
        print(f"  - {path_text}")
    if len(created) > 20:
        print(f"  - ... {len(created) - 20} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
