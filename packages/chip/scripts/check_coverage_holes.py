#!/usr/bin/env python3
"""Requirement-linked coverage-hole report over merged verification evidence.

Consumes the merged ``eliza.verification_coverage.v1`` report (produced by
``scripts/merge_coverage.py``) and a coverage-to-requirement map, then reports
which REQ- IDs have no live verification evidence (a "coverage hole").

The canonical requirement registry is owned by the Traceability agent under
``docs/spec-db/requirements/``. This gate does NOT invent REQ- IDs: it reads a
configurable coverage-map file that references registry IDs and validates each
referenced ID exists in the registry. When the registry is absent the gate
fails closed with ``registry missing`` rather than passing on an unverifiable
map. A coverage hole (a mapped requirement whose evidence sources are empty or
failing) also fails closed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MERGED = REPO_ROOT / "build/reports/verification_coverage.json"
DEFAULT_MAP = REPO_ROOT / "docs/evidence/verification/coverage-requirement-map.yaml"
DEFAULT_REGISTRY = REPO_ROOT / "docs/spec-db/requirements"
DEFAULT_OUT = REPO_ROOT / "build/reports/coverage_holes.json"

MAP_SCHEMA = "eliza.coverage_requirement_map.v1"
MERGED_SCHEMA = "eliza.verification_coverage.v1"
PASSING_FORMAL_STATUSES = frozenset({"pass", "fallback_pass"})


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def load_registry_ids(registry_dir: Path, errors: list[str]) -> set[str] | None:
    """Return the set of known REQ- IDs, or None when the registry is missing."""
    if not registry_dir.is_dir():
        errors.append(
            f"requirement registry missing: {rel(registry_dir)} "
            "(owned by the Traceability agent at docs/spec-db/requirements/)"
        )
        return None
    ids: set[str] = set()
    for path in sorted(registry_dir.rglob("*.yaml")):
        try:
            doc = load_yaml_object(path)
        except ValueError as exc:
            errors.append(f"registry entry {rel(path)} is not a mapping: {exc}")
            continue
        entries = doc.get("requirements")
        candidates = entries if isinstance(entries, list) else [doc]
        for entry in candidates:
            if isinstance(entry, dict) and isinstance(entry.get("id"), str):
                ids.add(entry["id"])
    if not ids:
        errors.append(f"requirement registry {rel(registry_dir)} declares no requirement ids")
    return ids


def block_has_evidence(block: dict[str, Any]) -> bool:
    cocotb = block.get("cocotb")
    cocotb_ok = (
        isinstance(cocotb, dict)
        and not cocotb.get("missing_required_classes")
        and int(cocotb.get("bins_hit", 0)) > 0
    )
    formal = block.get("formal")
    formal_ok = isinstance(formal, dict) and formal.get("status") in PASSING_FORMAL_STATUSES
    return cocotb_ok or formal_ok


def property_has_evidence(prop: dict[str, Any]) -> bool:
    return prop.get("status") == "pass"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--merged", type=Path, default=DEFAULT_MERGED)
    parser.add_argument("--map", dest="map_path", type=Path, default=DEFAULT_MAP)
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    errors: list[str] = []

    if not args.merged.is_file():
        print(f"FAIL: missing merged coverage report {rel(args.merged)}; run merge_coverage.py")
        return 1
    merged = json.loads(args.merged.read_text(encoding="utf-8"))
    if merged.get("schema") != MERGED_SCHEMA:
        print(f"FAIL: {rel(args.merged)}: unexpected schema {merged.get('schema')!r}")
        return 1
    blocks = merged.get("blocks", {})
    properties = merged.get("cdc_rdc_properties", {})

    if not args.map_path.is_file():
        print(f"FAIL: coverage-requirement map missing: {rel(args.map_path)}")
        return 1
    cov_map = load_yaml_object(args.map_path)
    if cov_map.get("schema") != MAP_SCHEMA:
        print(f"FAIL: {rel(args.map_path)}: unexpected schema {cov_map.get('schema')!r}")
        return 1

    registry_ids = load_registry_ids(args.registry, errors)

    mappings = cov_map.get("mappings")
    if not isinstance(mappings, list) or not mappings:
        errors.append(f"{rel(args.map_path)}: mappings must be a non-empty list")
        mappings = []

    holes: list[dict[str, Any]] = []
    covered: list[str] = []
    for index, mapping in enumerate(mappings):
        if not isinstance(mapping, dict):
            errors.append(f"mappings[{index}] must be a mapping")
            continue
        req_id = mapping.get("requirement_id")
        if not isinstance(req_id, str) or not req_id:
            errors.append(f"mappings[{index}].requirement_id must be a non-empty string")
            continue
        if registry_ids is not None and req_id not in registry_ids:
            errors.append(f"{req_id} is not present in the requirement registry")
            continue

        evidence_blocks = mapping.get("blocks", []) or []
        evidence_props = mapping.get("properties", []) or []
        if not evidence_blocks and not evidence_props:
            errors.append(f"{req_id} maps to no blocks or properties")
            continue

        satisfied = False
        unmet: list[str] = []
        for block_name in evidence_blocks:
            block = blocks.get(block_name)
            if isinstance(block, dict) and block_has_evidence(block):
                satisfied = True
            else:
                unmet.append(f"block:{block_name}")
        for prop_name in evidence_props:
            prop = properties.get(prop_name)
            if isinstance(prop, dict) and property_has_evidence(prop):
                satisfied = True
            else:
                unmet.append(f"property:{prop_name}")

        if satisfied:
            covered.append(req_id)
        else:
            holes.append({"requirement_id": req_id, "unmet_evidence": unmet})

    report = {
        "schema": "eliza.coverage_hole_report.v1",
        "claim_boundary": "merged_local_evidence_only_no_signoff_no_hardware",
        "registry": rel(args.registry),
        "registry_present": registry_ids is not None,
        "map": rel(args.map_path),
        "covered_requirements": sorted(covered),
        "coverage_holes": holes,
        "errors": errors,
        "status": "passed" if not errors and not holes else "failed",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report["status"] != "passed":
        for error in errors:
            print(f"FAIL: {error}")
        for hole in holes:
            print(f"FAIL: coverage hole for {hole['requirement_id']}: {', '.join(hole['unmet_evidence'])}")
        print(f"report written: {rel(args.out)}")
        return 1
    print(f"PASS: coverage holes: {len(covered)} requirement(s) covered, {rel(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
