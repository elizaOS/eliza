#!/usr/bin/env python3
"""Validate the pad-ring -> substrate mapping against pin order and node profiles.

The ring sequence is cross-checked against pd/pin_order.cfg (logical names) so
the substrate ordering cannot drift from the padframe pin order. Each per-node
pitch rule must name a real pd/node-profiles/<node>.yaml and its posture must
agree with that profile's status: open_fabricable nodes carry wire-bond planning
rules, advanced (non-fabricable) nodes stay blocked placeholders. Fail-closed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
SUBSTRATE = ROOT / "pd/padframe/e1-demo-substrate.yaml"
PIN_ORDER = ROOT / "pd/pin_order.cfg"
NODE_PROFILE_DIR = ROOT / "pd/node-profiles"
EXPECTED_SCHEMA = "eliza.pkg_padring_substrate.v1"
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


def pin_order_logical_names() -> set[str]:
    names: set[str] = set()
    for raw in PIN_ORDER.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        names.add(line.removesuffix(".*"))
    return names


def check_ring_sequence(substrate: dict[str, Any], errors: list[str]) -> None:
    if not PIN_ORDER.is_file():
        fail(errors, "pd/pin_order.cfg missing for ring-sequence cross-check")
        return
    order_names = pin_order_logical_names()
    pad_ring = require_mapping(substrate.get("pad_ring"), "pad_ring", errors)
    ring = require_mapping(pad_ring.get("ring_sequence"), "pad_ring.ring_sequence", errors)
    ring_names: set[str] = set()
    for side, members in ring.items():
        for member in require_list(members, f"ring_sequence.{side}", errors):
            ring_names.add(str(member))
    missing = sorted(ring_names - order_names)
    if missing:
        fail(errors, "ring_sequence entries not in pin_order.cfg: " + ", ".join(missing))
    uncovered = sorted(order_names - ring_names)
    if uncovered:
        fail(errors, "pin_order.cfg names missing from ring_sequence: " + ", ".join(uncovered))


def check_node_rules(substrate: dict[str, Any], errors: list[str]) -> None:
    rules = require_list(substrate.get("node_pitch_rules"), "node_pitch_rules", errors)
    seen: set[str] = set()
    for rule in rules:
        rmap = require_mapping(rule, "node_pitch_rules[]", errors)
        node_id = rmap.get("node_id")
        if node_id not in NODE_IDS:
            fail(errors, f"unknown node_id: {node_id}")
            continue
        seen.add(node_id)
        profile_rel = rmap.get("node_profile")
        profile = NODE_PROFILE_DIR / f"{node_id}.yaml"
        if profile_rel != f"pd/node-profiles/{node_id}.yaml" or not profile.is_file():
            fail(errors, f"{node_id}: node_profile must point at the real profile file")
            continue
        profile_status = str(
            require_mapping(yaml.safe_load(profile.read_text()), node_id, errors).get("status", "")
        )
        posture = rmap.get("posture")
        if profile_status == "open_fabricable":
            if posture != "open_fabricable" or rmap.get("attach") != "wire_bond":
                fail(errors, f"{node_id}: open node must be open_fabricable wire_bond posture")
        else:
            if posture != "blocked":
                fail(errors, f"{node_id}: non-open node must stay blocked posture")
            for field in ("bump_pitch_um", "ball_pitch_um"):
                if not str(rmap.get(field, "")).startswith("blocked"):
                    fail(errors, f"{node_id}: {field} must stay a blocked placeholder")
    missing = sorted(NODE_IDS - seen - {"asap7"})
    if missing:
        fail(errors, "node_pitch_rules missing nodes: " + ", ".join(missing))


def main() -> int:
    errors: list[str] = []
    if not SUBSTRATE.is_file():
        fail(errors, f"missing {SUBSTRATE.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    substrate = require_mapping(yaml.safe_load(SUBSTRATE.read_text()), "substrate", errors)
    if substrate.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if substrate.get("release_use") != "prohibited":
        fail(errors, "release_use must remain prohibited")
    if not require_mapping(substrate.get("substrate_layers"), "substrate_layers", errors).get(
        "stack"
    ):
        fail(errors, "substrate_layers.stack must be defined")

    check_ring_sequence(substrate, errors)
    check_node_rules(substrate, errors)

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS padring_substrate pd/padframe/e1-demo-substrate.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
