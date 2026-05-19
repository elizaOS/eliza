#!/usr/bin/env python3
"""Verify the multi-PDK portability index.

This check walks pd/openlane/portability-index.yaml and verifies:
1. Every entry's config file exists.
2. Every entry's library_manifest and corner_manifest file exists.
3. Every advanced-node entry has access_gate=blocked_until_foundry_agreement.
4. Every advanced-node entry has its access_gate file present.
5. Every open-PDK entry has access_gate=open_no_gate and matching library + corner manifests.
6. Schema fields are present and well-formed.

The check writes a structured report to docs/evidence/process/pdk-portability.json
that downstream gates can consume.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "pd/openlane/portability-index.yaml"
REPORT = ROOT / "docs/evidence/process/pdk-portability.json"

SCHEMA = "eliza.pd_portability_index.v1"

OPEN_PDK_NODES = {
    "open_130nm_planar_cmos",
    "open_180nm_mcu_cmos",
    "open_130nm_bicmos",
}
PREDICTIVE_NODES = {
    "predictive_7nm_finfet",
}
ADVANCED_NODES = {
    "tsmc_n2_class_gaa_nanosheet",
    "tsmc_a14_2nd_gen_gaa",
    "intel_14a_ribbonfet_2nd_gen_bspdn_high_na",
    "samsung_sf2p_3rd_gen_mbcfet_gaa",
}

REQUIRED_FIELDS = {
    "id",
    "config",
    "flow",
    "node_class",
    "foundry",
    "pdk_name",
    "open_pdk",
    "fabricable",
    "stdcell_library_primary",
    "library_manifest",
    "corner_manifest",
    "evidence_class",
    "role",
    "access_gate",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_yaml_mapping(path: Path, errors: list[str]) -> dict[str, Any]:
    if not path.is_file():
        errors.append(f"missing file: {rel(path)}")
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        errors.append(f"{rel(path)} must be a YAML mapping")
        return {}
    return data


def check_entry_required_fields(entry: dict[str, Any], errors: list[str]) -> None:
    missing = sorted(REQUIRED_FIELDS - set(entry))
    if missing:
        eid = entry.get("id", "<no_id>")
        errors.append(f"{eid}: missing required fields: {', '.join(missing)}")


def check_entry_paths(entry: dict[str, Any], errors: list[str]) -> None:
    eid = entry.get("id", "<no_id>")
    config_path = entry.get("config")
    if isinstance(config_path, str):
        cp = ROOT / config_path
        if not cp.exists():
            errors.append(f"{eid}: config file missing: {config_path}")
    library_manifest = entry.get("library_manifest")
    if isinstance(library_manifest, str):
        lm = ROOT / library_manifest
        if not lm.exists():
            errors.append(f"{eid}: library_manifest missing: {library_manifest}")
    corner_manifest = entry.get("corner_manifest")
    if isinstance(corner_manifest, str):
        cm = ROOT / corner_manifest
        if not cm.exists():
            errors.append(f"{eid}: corner_manifest missing: {corner_manifest}")


def check_entry_access_gate(entry: dict[str, Any], errors: list[str]) -> None:
    eid = entry.get("id", "<no_id>")
    node_class = entry.get("node_class", "")
    access_gate = entry.get("access_gate", "")
    config_path = entry.get("config", "")

    if node_class in ADVANCED_NODES:
        if access_gate != "blocked_until_foundry_agreement":
            errors.append(
                f"{eid}: advanced node {node_class} must have "
                f"access_gate=blocked_until_foundry_agreement, got {access_gate!r}"
            )
        if entry.get("fabricable") is not False:
            errors.append(f"{eid}: advanced node must have fabricable=false until unblocked")
        if entry.get("open_pdk") is not False:
            errors.append(f"{eid}: advanced node must have open_pdk=false")
        if entry.get("evidence_class") != "procurement_blocked_no_signoff_artifacts":
            errors.append(
                f"{eid}: advanced node evidence_class must be "
                f"procurement_blocked_no_signoff_artifacts"
            )
        if isinstance(config_path, str):
            cp = ROOT / config_path
            if cp.exists():
                stub = yaml.safe_load(cp.read_text(encoding="utf-8"))
                if not isinstance(stub, dict):
                    errors.append(f"{eid}: access-gate file is not a YAML mapping")
                else:
                    if stub.get("status") != "blocked_until_foundry_agreement":
                        errors.append(
                            f"{eid}: access-gate file status must be "
                            f"blocked_until_foundry_agreement"
                        )
                    forbid = stub.get("forbidden_claims_until_unblocked")
                    if not isinstance(forbid, list) or not forbid:
                        errors.append(
                            f"{eid}: access-gate file must list forbidden_claims_until_unblocked"
                        )
    elif node_class in OPEN_PDK_NODES:
        if access_gate != "open_no_gate":
            errors.append(
                f"{eid}: open PDK {node_class} must have access_gate=open_no_gate, "
                f"got {access_gate!r}"
            )
        if entry.get("open_pdk") is not True:
            errors.append(f"{eid}: open PDK must have open_pdk=true")
        if entry.get("fabricable") is not True:
            errors.append(f"{eid}: open PDK should be fabricable=true")
        if entry.get("evidence_class") != "real_open_pdk_methodology_evidence":
            errors.append(
                f"{eid}: open PDK evidence_class must be real_open_pdk_methodology_evidence"
            )
    elif node_class in PREDICTIVE_NODES:
        if access_gate != "open_no_gate":
            errors.append(f"{eid}: predictive PDK must have access_gate=open_no_gate")
        if entry.get("open_pdk") is not True:
            errors.append(f"{eid}: predictive PDK must have open_pdk=true")
        if entry.get("fabricable") is not False:
            errors.append(f"{eid}: predictive PDK must have fabricable=false")
        if entry.get("evidence_class") != "predictive_finfet_shape_only_not_signoff":
            errors.append(
                f"{eid}: predictive PDK evidence_class must be "
                f"predictive_finfet_shape_only_not_signoff"
            )
    else:
        errors.append(f"{eid}: unknown node_class {node_class!r}")


def write_report(entries: list[dict[str, Any]], errors: list[str]) -> None:
    lanes: list[dict[str, Any]] = []
    summary: dict[str, Any] = {
        "schema": "eliza.process_pdk_portability_report.v1",
        "evidence_class": "real_open_pdk_methodology_index_with_advanced_node_blocked_gates",
        "checked_index": rel(INDEX),
        "total_entries": len(entries),
        "errors": errors,
        "lanes": lanes,
    }
    for entry in entries:
        node_class = entry.get("node_class", "")
        if node_class in ADVANCED_NODES:
            lane_class = "advanced_node_blocked"
        elif node_class in PREDICTIVE_NODES:
            lane_class = "predictive_shape_only"
        elif node_class in OPEN_PDK_NODES:
            lane_class = "open_pdk_active"
        else:
            lane_class = "unknown"
        lanes.append(
            {
                "id": entry.get("id"),
                "pdk_name": entry.get("pdk_name"),
                "node_class": node_class,
                "lane_class": lane_class,
                "access_gate": entry.get("access_gate"),
                "config": entry.get("config"),
                "library_manifest": entry.get("library_manifest"),
                "corner_manifest": entry.get("corner_manifest"),
                "role": entry.get("role"),
                "fabricable": entry.get("fabricable"),
            }
        )
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    errors: list[str] = []
    data = load_yaml_mapping(INDEX, errors)
    if not data:
        for error in errors:
            print(f"  - {error}")
        print("PDK portability check FAILED")
        return 1

    if data.get("schema") != SCHEMA:
        errors.append(f"schema must be {SCHEMA}")

    configs = data.get("configs")
    if not isinstance(configs, list):
        errors.append("configs must be a list")
        configs = []

    seen_ids: set[str] = set()
    for entry in configs:
        if not isinstance(entry, dict):
            errors.append("configs entries must be mappings")
            continue
        eid = entry.get("id")
        if not isinstance(eid, str) or not eid:
            errors.append("entry missing id")
            continue
        if eid in seen_ids:
            errors.append(f"duplicate id: {eid}")
        seen_ids.add(eid)
        check_entry_required_fields(entry, errors)
        check_entry_paths(entry, errors)
        check_entry_access_gate(entry, errors)

    # At least one open-PDK + at least one advanced-node entry must be present.
    open_count = sum(
        1 for e in configs if isinstance(e, dict) and e.get("node_class") in OPEN_PDK_NODES
    )
    advanced_count = sum(
        1 for e in configs if isinstance(e, dict) and e.get("node_class") in ADVANCED_NODES
    )
    if open_count < 2:
        errors.append("portability index must include at least two open-PDK lanes")
    if advanced_count < 3:
        errors.append("portability index must include N2P, A14, and Intel 14A lanes")

    write_report([e for e in configs if isinstance(e, dict)], errors)

    if errors:
        print("PDK portability check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"PDK portability check passed: {len(configs)} lanes; report -> {rel(REPORT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
