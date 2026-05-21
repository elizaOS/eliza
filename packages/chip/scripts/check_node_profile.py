#!/usr/bin/env python3
"""Fail-closed gate over eliza.pd_node_profile.v1 files.

This is the FAIL-CLOSED LAW enforcer for node profiles. It rejects any
NDA-locked advanced node that has been flipped toward fabricability:

  - status other than blocked_until_foundry_agreement
  - fabricable != false
  - a non-null pdk_adapter (a real buildable adapter seam)
  - an empty forbidden_claims_until_unblocked list

It mirrors the rejection intent of scripts/test_pdk_portability.py
(test_rejects_unblocked_advanced_node) at the node-profile layer, so that
neither surface can silently mark an advanced node as buildable. The drift /
shape checks live in scripts/build_node_profile.py; this gate is the narrow,
non-negotiable advanced-node guard.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "pd/node-profiles"

PROFILE_SCHEMA = "eliza.pd_node_profile.v1"
STATUS_BLOCKED = "blocked_until_foundry_agreement"

# Advanced (NDA-locked) node_ids that must stay fail-closed.
ADVANCED_NODE_IDS = {"tsmc-n2p", "tsmc-a14", "intel-14a", "samsung-sf2p"}


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def reject_unblocked_advanced(node_id: str, profile: dict[str, Any]) -> list[str]:
    """Return rejection errors if an advanced node is not fully fail-closed."""
    if node_id not in ADVANCED_NODE_IDS:
        return []
    errors: list[str] = []
    if profile.get("status") != STATUS_BLOCKED:
        errors.append(
            f"{node_id}: advanced node status must be {STATUS_BLOCKED}, "
            f"got {profile.get('status')!r}"
        )
    if profile.get("fabricable") is not False:
        errors.append(
            f"{node_id}: advanced node fabricable must be false, "
            f"got {profile.get('fabricable')!r}"
        )
    if profile.get("pdk_adapter") is not None:
        errors.append(
            f"{node_id}: advanced node pdk_adapter must be null until a foundry "
            f"agreement is in place"
        )
    forbidden = profile.get("forbidden_claims_until_unblocked")
    if not isinstance(forbidden, list) or not forbidden:
        errors.append(
            f"{node_id}: advanced node must list forbidden_claims_until_unblocked"
        )
    return errors


def main() -> int:
    if not PROFILE_DIR.is_dir():
        print(f"missing node-profile directory: {rel(PROFILE_DIR)}")
        return 1

    profiles = sorted(PROFILE_DIR.glob("*.yaml"))
    if not profiles:
        print("no node profiles found")
        return 1

    errors: list[str] = []
    advanced_seen = 0
    for path in profiles:
        profile = load_yaml_object(path)
        if profile.get("schema") != PROFILE_SCHEMA:
            errors.append(f"{rel(path)}: schema must be {PROFILE_SCHEMA}")
            continue
        node_id = profile.get("node_id")
        if not isinstance(node_id, str) or not node_id:
            errors.append(f"{rel(path)}: node_id must be a non-empty string")
            continue
        if node_id in ADVANCED_NODE_IDS:
            advanced_seen += 1
        for err in reject_unblocked_advanced(node_id, profile):
            errors.append(f"{rel(path)}: {err}")

    if advanced_seen < len(ADVANCED_NODE_IDS):
        errors.append(
            f"expected {len(ADVANCED_NODE_IDS)} advanced-node profiles, found {advanced_seen}"
        )

    if errors:
        print("node profile fail-closed gate FAILED:")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(
        f"node profile fail-closed gate passed: "
        f"{advanced_seen} advanced nodes blocked, {len(profiles)} profiles total"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
