#!/usr/bin/env python3
"""Validate the AMS block interface contracts under docs/spec-db/ams/.

Every contract is procurement/interface intent only. The checker fail-closes
when a contract claims an electrical result, drops a required signoff corner,
references a signal group that the package signal-group intent does not define,
or omits the procurement blockers that keep the block honestly BLOCKED.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
AMS_DIR = ROOT / "docs/spec-db/ams"
SIGNAL_GROUPS = ROOT / "package/signal-groups.yaml"
EXPECTED_SCHEMA = "eliza.ams_block_contract.v1"
REQUIRED_BLOCK_CLASSES = {"PLL", "SerDes", "PMIC", "RF", "IO"}
REQUIRED_TOP_KEYS = {
    "schema",
    "block_id",
    "block_class",
    "status",
    "claim_boundary",
    "supply_rails",
    "control_pins",
    "interface_revision",
    "target_process_nodes",
    "signoff_required_corners",
    "procurement",
    "forbidden_claims",
}
NODE_IDS = {
    "sky130",
    "gf180",
    "ihp-sg13g2",
    "asap7",
    "tsmc-n2p",
    "tsmc-a14",
    "intel-14a",
    "samsung-sf2p",
}


def fail(errors: list[str], message: str) -> None:
    errors.append(f"FAIL: {message}")


def require_mapping(value: Any, label: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        fail(errors, f"{label} must be a mapping")
        return {}
    return value


def require_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        fail(errors, f"{label} must be a list")
        return []
    return value


def load_signal_group_ids(errors: list[str]) -> set[str]:
    if not SIGNAL_GROUPS.is_file():
        fail(errors, "package/signal-groups.yaml missing for AMS cross-check")
        return set()
    intent = require_mapping(yaml.safe_load(SIGNAL_GROUPS.read_text()), "signal-groups", errors)
    ids: set[str] = set()
    for group in require_list(intent.get("signal_groups"), "signal_groups", errors):
        gid = require_mapping(group, "signal_groups[]", errors).get("id")
        if isinstance(gid, str):
            ids.add(gid)
    for name in require_mapping(
        intent.get("phone_board_impedance_classes"), "phone_board_impedance_classes", errors
    ):
        ids.add(name)
    return ids


def check_signal_group_refs(
    contract: dict[str, Any], group_ids: set[str], rel: str, errors: list[str]
) -> None:
    refs: list[str] = []
    for section_key in ("diff_pair_classes", "rf_feed_classes"):
        for entry in contract.get(section_key, []) or []:
            ref = require_mapping(entry, f"{section_key}[]", errors).get("signal_group_ref")
            if isinstance(ref, str):
                refs.append(ref)
    signaling = contract.get("signaling")
    if isinstance(signaling, dict):
        for ref in signaling.get("signal_group_refs", []) or []:
            if isinstance(ref, str):
                refs.append(ref)
    for ref in refs:
        if ref not in group_ids:
            fail(errors, f"{rel}: signal_group_ref not defined in signal-groups.yaml: {ref}")


def check_contract(path: Path, group_ids: set[str], errors: list[str]) -> str | None:
    rel = path.relative_to(ROOT).as_posix()
    contract = require_mapping(yaml.safe_load(path.read_text()), rel, errors)
    if contract.get("schema") != EXPECTED_SCHEMA:
        fail(errors, f"{rel}: unexpected schema")
    missing = sorted(REQUIRED_TOP_KEYS - set(contract))
    if missing:
        fail(errors, f"{rel}: missing keys: {', '.join(missing)}")
    status = str(contract.get("status", ""))
    if not status.startswith("BLOCKED"):
        fail(errors, f"{rel}: status must stay BLOCKED (procurement/interface only)")

    block_class = contract.get("block_class")
    nodes = require_list(contract.get("target_process_nodes"), f"{rel}.target_process_nodes", errors)
    for node in nodes:
        if node not in NODE_IDS:
            fail(errors, f"{rel}: unknown target_process_node: {node}")

    corners = require_mapping(
        contract.get("signoff_required_corners"), f"{rel}.signoff_required_corners", errors
    )
    if not corners or "required_tool" not in corners:
        fail(errors, f"{rel}: signoff_required_corners must name a required_tool")

    procurement = require_mapping(contract.get("procurement"), f"{rel}.procurement", errors)
    if not require_list(procurement.get("blockers"), f"{rel}.procurement.blockers", errors):
        fail(errors, f"{rel}: procurement.blockers must be non-empty")

    if not require_list(contract.get("forbidden_claims"), f"{rel}.forbidden_claims", errors):
        fail(errors, f"{rel}: forbidden_claims must be non-empty")

    check_signal_group_refs(contract, group_ids, rel, errors)
    return block_class if isinstance(block_class, str) else None


def main() -> int:
    errors: list[str] = []
    if not AMS_DIR.is_dir():
        fail(errors, f"missing {AMS_DIR.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    group_ids = load_signal_group_ids(errors)
    contracts = sorted(AMS_DIR.glob("*.yaml"))
    if not contracts:
        fail(errors, "no AMS block contracts found")

    seen_classes: set[str] = set()
    for path in contracts:
        block_class = check_contract(path, group_ids, errors)
        if block_class:
            seen_classes.add(block_class)

    missing_classes = sorted(REQUIRED_BLOCK_CLASSES - seen_classes)
    if missing_classes:
        fail(errors, "missing AMS block-class contracts: " + ", ".join(missing_classes))

    if errors:
        print("\n".join(errors))
        return 1
    print(f"STATUS: PASS ams_block_contract docs/spec-db/ams ({len(contracts)} blocks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
