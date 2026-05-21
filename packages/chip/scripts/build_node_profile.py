#!/usr/bin/env python3
"""Validate eliza.pd_node_profile.v1 files and detect drift against the four
per-node source files.

Node identity used to be duplicated across four files per node:

  - pd/<node>-stub/access-gate.yaml      (advanced nodes only)
  - pd/corner-manifests/<node>.yaml
  - pd/library-manifests/<node>.yaml
  - one row in pd/openlane/portability-index.yaml

pd/node-profiles/<node_id>.yaml is the documented single source of truth for
node identity. This script makes the other four files cross-checked
downstream: it derives the expected identity from the portability-index row +
access-gate and asserts the profile agrees with all of them. Any mismatch is
reported and the script exits non-zero. It never rewrites the four files.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "pd/node-profiles"
INDEX = ROOT / "pd/openlane/portability-index.yaml"

PROFILE_SCHEMA = "eliza.pd_node_profile.v1"

STATUS_OPEN = "open_fabricable"
STATUS_PREDICTIVE = "predictive_shape_only"
STATUS_BLOCKED = "blocked_until_foundry_agreement"
VALID_STATUS = {STATUS_OPEN, STATUS_PREDICTIVE, STATUS_BLOCKED}

# Canonical node_id -> portability-index entry id. node_id is the stable key
# this project owns; the index keys lanes by a longer release id.
NODE_TO_INDEX_ID = {
    "sky130": "sky130A_release",
    "gf180": "gf180mcu_release",
    "ihp-sg13g2": "ihp_sg13g2_release",
    "asap7": "asap7_predictive",
    "tsmc-n2p": "tsmc_n2p_stub",
    "tsmc-a14": "tsmc_a14_stub",
    "intel-14a": "intel_14a_stub",
    "samsung-sf2p": "samsung_sf2p_stub",
}

ADVANCED_NODE_IDS = {"tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"}

REQUIRED_PROFILE_FIELDS = {
    "schema",
    "node_id",
    "foundry",
    "status",
    "fabricable",
    "bspdn",
    "bump_pitch_um",
    "metal_stack",
    "pdk_adapter",
    "default_corner_manifest",
    "source_files",
    "forbidden_claims_until_unblocked",
}

REQUIRED_ADAPTER_FIELDS = {
    "openlane_config",
    "flow",
    "pdk_key",
    "std_cell_library",
    "max_routing_layer",
    "corner_views",
}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def index_rows() -> dict[str, dict[str, Any]]:
    data = load_yaml_object(INDEX)
    configs = data.get("configs")
    if not isinstance(configs, list):
        raise ValueError(f"{rel(INDEX)} configs must be a list")
    rows: dict[str, dict[str, Any]] = {}
    for entry in configs:
        if isinstance(entry, dict) and isinstance(entry.get("id"), str):
            rows[entry["id"]] = entry
    return rows


def check_schema_and_shape(profile: dict[str, Any], errors: list[str]) -> None:
    if profile.get("schema") != PROFILE_SCHEMA:
        errors.append(f"schema must be {PROFILE_SCHEMA}, got {profile.get('schema')!r}")
    missing = sorted(REQUIRED_PROFILE_FIELDS - set(profile))
    if missing:
        errors.append(f"missing required fields: {', '.join(missing)}")
    status = profile.get("status")
    if status not in VALID_STATUS:
        errors.append(f"status must be one of {sorted(VALID_STATUS)}, got {status!r}")


def check_status_invariants(node_id: str, profile: dict[str, Any], errors: list[str]) -> None:
    status = profile.get("status")
    adapter = profile.get("pdk_adapter")
    fabricable = profile.get("fabricable")
    forbidden = profile.get("forbidden_claims_until_unblocked")

    if status == STATUS_OPEN:
        if fabricable is not True:
            errors.append("open_fabricable node must have fabricable=true")
        if not isinstance(adapter, dict):
            errors.append("open_fabricable node must have a non-null pdk_adapter mapping")
        if forbidden:
            errors.append("open_fabricable node must have empty forbidden_claims_until_unblocked")
    elif status == STATUS_PREDICTIVE:
        if fabricable is not False:
            errors.append("predictive_shape_only node must have fabricable=false")
        if not isinstance(adapter, dict):
            errors.append("predictive_shape_only node must have a non-null pdk_adapter mapping")
    elif status == STATUS_BLOCKED:
        if fabricable is not False:
            errors.append("blocked node must have fabricable=false")
        if adapter is not None:
            errors.append("blocked node must have pdk_adapter=null")
        if not isinstance(forbidden, list) or not forbidden:
            errors.append("blocked node must list forbidden_claims_until_unblocked")

    if node_id in ADVANCED_NODE_IDS and status != STATUS_BLOCKED:
        errors.append(f"advanced node {node_id} must have status={STATUS_BLOCKED}")

    if isinstance(adapter, dict):
        amissing = sorted(REQUIRED_ADAPTER_FIELDS - set(adapter))
        if amissing:
            errors.append(f"pdk_adapter missing fields: {', '.join(amissing)}")


def _check_adapter_matches_config(adapter: dict[str, Any], errors: list[str]) -> None:
    """For OPEN-node adapters whose config is OpenLane JSON, confirm the
    PDK / STD_CELL_LIBRARY keys match the real config.*.json."""
    config_ref = adapter.get("openlane_config")
    if not isinstance(config_ref, str) or not config_ref.endswith(".json"):
        return  # ORFS yaml configs (asap7) do not use these JSON keys.
    config_path = ROOT / config_ref
    if not config_path.exists():
        errors.append(f"pdk_adapter.openlane_config missing: {config_ref}")
        return
    config = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        errors.append(f"{config_ref} must be a JSON object")
        return
    if config.get("PDK") != adapter.get("pdk_key"):
        errors.append(
            f"pdk_adapter.pdk_key {adapter.get('pdk_key')!r} != {config_ref} PDK "
            f"{config.get('PDK')!r}"
        )
    if config.get("STD_CELL_LIBRARY") != adapter.get("std_cell_library"):
        errors.append(
            f"pdk_adapter.std_cell_library {adapter.get('std_cell_library')!r} != "
            f"{config_ref} STD_CELL_LIBRARY {config.get('STD_CELL_LIBRARY')!r}"
        )


def check_drift(
    node_id: str,
    profile: dict[str, Any],
    rows: dict[str, dict[str, Any]],
    errors: list[str],
) -> None:
    index_id = NODE_TO_INDEX_ID.get(node_id)
    if index_id is None:
        errors.append(f"{node_id}: not a canonical node_id")
        return
    row = rows.get(index_id)
    if row is None:
        errors.append(f"{node_id}: no portability-index row with id {index_id}")
        return

    src = profile.get("source_files")
    if not isinstance(src, dict):
        errors.append(f"{node_id}: source_files must be a mapping")
        return
    if src.get("portability_index_id") != index_id:
        errors.append(
            f"{node_id}: source_files.portability_index_id {src.get('portability_index_id')!r} "
            f"!= {index_id}"
        )

    # Identity fields the profile and the index row must agree on.
    if profile.get("foundry") != row.get("foundry"):
        errors.append(
            f"{node_id}: foundry drift profile={profile.get('foundry')!r} "
            f"index={row.get('foundry')!r}"
        )
    if profile.get("fabricable") != row.get("fabricable"):
        errors.append(
            f"{node_id}: fabricable drift profile={profile.get('fabricable')!r} "
            f"index={row.get('fabricable')!r}"
        )

    # metal_stack: profile is null for blocked nodes; index uses a blocked
    # sentinel string. For open/predictive nodes the strings must match.
    if profile.get("status") == STATUS_BLOCKED:
        if profile.get("metal_stack") is not None:
            errors.append(f"{node_id}: blocked node metal_stack must be null")
    elif profile.get("metal_stack") != row.get("metal_stack"):
        errors.append(
            f"{node_id}: metal_stack drift profile={profile.get('metal_stack')!r} "
            f"index={row.get('metal_stack')!r}"
        )

    # Manifest references must match the index row exactly.
    if src.get("corner_manifest") != row.get("corner_manifest"):
        errors.append(
            f"{node_id}: corner_manifest drift profile={src.get('corner_manifest')!r} "
            f"index={row.get('corner_manifest')!r}"
        )
    if src.get("library_manifest") != row.get("library_manifest"):
        errors.append(
            f"{node_id}: library_manifest drift profile={src.get('library_manifest')!r} "
            f"index={row.get('library_manifest')!r}"
        )
    if profile.get("default_corner_manifest") != row.get("corner_manifest"):
        errors.append(
            f"{node_id}: default_corner_manifest {profile.get('default_corner_manifest')!r} "
            f"!= index corner_manifest {row.get('corner_manifest')!r}"
        )

    # The four source files must exist and carry the matching pdk identity.
    _check_source_file(node_id, "corner_manifest", src.get("corner_manifest"), row, errors)
    _check_source_file(node_id, "library_manifest", src.get("library_manifest"), row, errors)

    access_gate = src.get("access_gate")
    if node_id in ADVANCED_NODE_IDS:
        _check_access_gate(node_id, access_gate, profile, row, errors)
    elif access_gate is not None:
        errors.append(f"{node_id}: non-advanced node must have source_files.access_gate=null")

    adapter = profile.get("pdk_adapter")
    if isinstance(adapter, dict):
        _check_adapter_matches_config(adapter, errors)


def _check_source_file(
    node_id: str,
    label: str,
    ref: Any,
    row: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(ref, str):
        errors.append(f"{node_id}: source_files.{label} must be a string path")
        return
    path = ROOT / ref
    if not path.exists():
        errors.append(f"{node_id}: source_files.{label} missing file: {ref}")
        return
    data = load_yaml_object(path)
    pdk = data.get("pdk")
    expected = row.get("pdk_name")
    if pdk != expected:
        errors.append(
            f"{node_id}: {label} pdk {pdk!r} != portability-index pdk_name {expected!r}"
        )
    node_class = data.get("node_class")
    if node_class != row.get("node_class"):
        errors.append(
            f"{node_id}: {label} node_class {node_class!r} != index node_class "
            f"{row.get('node_class')!r}"
        )


def _check_access_gate(
    node_id: str,
    ref: Any,
    profile: dict[str, Any],
    row: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(ref, str):
        errors.append(f"{node_id}: advanced node must reference an access-gate file")
        return
    path = ROOT / ref
    if not path.exists():
        errors.append(f"{node_id}: access-gate file missing: {ref}")
        return
    gate = load_yaml_object(path)
    if gate.get("status") != STATUS_BLOCKED:
        errors.append(f"{node_id}: access-gate status must be {STATUS_BLOCKED}")
    if gate.get("pdk") != row.get("pdk_name"):
        errors.append(
            f"{node_id}: access-gate pdk {gate.get('pdk')!r} != index pdk_name "
            f"{row.get('pdk_name')!r}"
        )
    # forbidden_claims drift: every claim in the profile must be present in the
    # access-gate file (the profile may be a subset focused on signoff claims).
    gate_forbidden = gate.get("forbidden_claims_until_unblocked")
    profile_forbidden = profile.get("forbidden_claims_until_unblocked")
    if not isinstance(gate_forbidden, list) or not gate_forbidden:
        errors.append(f"{node_id}: access-gate must list forbidden_claims_until_unblocked")
        return
    if isinstance(profile_forbidden, list):
        extra = set(profile_forbidden) - set(gate_forbidden)
        if extra:
            errors.append(
                f"{node_id}: profile forbidden_claims not present in access-gate: "
                f"{sorted(extra)}"
            )


def validate_profile(path: Path, rows: dict[str, dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    profile = load_yaml_object(path)
    node_id = profile.get("node_id")
    if not isinstance(node_id, str) or not node_id:
        errors.append(f"{rel(path)}: node_id must be a non-empty string")
        return errors
    if path.stem != node_id:
        errors.append(f"{rel(path)}: filename stem {path.stem!r} != node_id {node_id!r}")
    check_schema_and_shape(profile, errors)
    check_status_invariants(node_id, profile, errors)
    check_drift(node_id, profile, rows, errors)
    return errors


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--node",
        help="Validate a single node_id (default: all profiles under pd/node-profiles/)",
    )
    args = parser.parse_args(argv)

    if not PROFILE_DIR.is_dir():
        print(f"missing node-profile directory: {rel(PROFILE_DIR)}")
        return 1

    rows = index_rows()
    profiles = sorted(PROFILE_DIR.glob("*.yaml"))
    if args.node:
        profiles = [p for p in profiles if p.stem == args.node]
        if not profiles:
            print(f"no node profile for node_id {args.node!r}")
            return 1

    if not profiles:
        print("no node profiles found")
        return 1

    found_ids = {p.stem for p in profiles}
    all_errors: list[str] = []
    if not args.node:
        missing_canonical = set(NODE_TO_INDEX_ID) - found_ids
        if missing_canonical:
            all_errors.append(f"missing canonical node profiles: {sorted(missing_canonical)}")

    for path in profiles:
        for err in validate_profile(path, rows):
            all_errors.append(f"{rel(path)}: {err}")

    if all_errors:
        print("node profile drift / validation FAILED:")
        for err in all_errors:
            print(f"  - {err}")
        return 1
    print(f"node profile check passed: {len(profiles)} profiles, no drift vs source files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
