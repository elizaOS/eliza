#!/usr/bin/env python3
"""Validate the per-node DFT scan-rule manifest (eliza.dft_scan_rules.v1)."""

from __future__ import annotations

from pathlib import Path

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "pd/dft/scan_rules.yaml"
NODE_PROFILE_DIR = ROOT / "pd/node-profiles"
EXPECTED_SCHEMA = "eliza.dft_scan_rules.v1"
EXPECTED_CLAIM_BOUNDARY = "scan_rule_capture_only_no_stitched_chain_or_coverage_claim"
OPEN_EXERCISABLE_NODES = {"sky130", "gf180", "ihp-sg13g2", "asap7"}
NDA_NODES = {"tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"}


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def known_node_ids() -> set[str]:
    return {profile.stem for profile in NODE_PROFILE_DIR.glob("*.yaml")}


def main() -> int:
    errors: list[str] = []
    if not MANIFEST.is_file():
        print(f"FAIL: missing {MANIFEST.relative_to(ROOT)}")
        return 1

    manifest = load_yaml_object(MANIFEST)
    if manifest.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if manifest.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        fail(errors, "unsafe claim boundary")
    if manifest.get("status") != "DRAFT_CAPTURE_ONLY":
        fail(errors, "status must be DRAFT_CAPTURE_ONLY")

    top = manifest.get("top")
    if not isinstance(top, str) or not (ROOT / top).is_file():
        fail(errors, "top must reference an existing RTL file")

    for section in ("clock_domains", "async_resets", "x_sources", "no_scan_cells"):
        if not isinstance(manifest.get(section), list) or not manifest[section]:
            fail(errors, f"{section} must be a non-empty list")

    nodes = manifest.get("nodes")
    if not isinstance(nodes, dict):
        fail(errors, "nodes must be a mapping keyed by node_id")
        nodes = {}

    profile_ids = known_node_ids()
    for node_id, node in nodes.items():
        if profile_ids and node_id not in profile_ids:
            fail(errors, f"nodes.{node_id} is not a known node-profile id")
        if not isinstance(node, dict):
            fail(errors, f"nodes.{node_id} must be a mapping")
            continue
        if node.get("node_id") != node_id:
            fail(errors, f"nodes.{node_id}.node_id must equal its key")
        scan_status = node.get("scan_status")
        if not isinstance(scan_status, str) or not scan_status:
            fail(errors, f"nodes.{node_id} missing scan_status")
            continue
        if node_id in NDA_NODES and not scan_status.startswith("BLOCKED"):
            fail(errors, f"nodes.{node_id} is an NDA node and must stay BLOCKED")
        if scan_status == "scan_capable_library_present":
            cells = node.get("scan_flop_cells")
            if not isinstance(cells, list) or not cells:
                fail(
                    errors,
                    f"nodes.{node_id} claims scan-capable library but lists no scan_flop_cells",
                )

    for required in OPEN_EXERCISABLE_NODES | NDA_NODES:
        if required not in nodes:
            fail(errors, f"nodes must include {required}")

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS dft_scan_rules pd/dft/scan_rules.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
