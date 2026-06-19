#!/usr/bin/env python3
"""Cross-probe the package signal-group / impedance / power-domain intent.

Validates package/signal-groups.yaml against the read-only package pinout by
logical-name equality (the same vectored-pin collapse the package cross-probe
uses). Fail-closes when a signal group references a pin, impedance class, power
domain, diff-pair member, or rail that the pinout does not actually carry, and
when a controlled-impedance class is asserted without a coupon-plan reference.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
INTENT = ROOT / "package/signal-groups.yaml"
EXPECTED_SCHEMA = "eliza.pkg_signal_group_intent.v1"
VECTOR_PIN_RE = re.compile(r"^(DBG_ADDR|DBG_WDATA|DBG_RDATA|GPIO)([0-9]+)$")
RAIL_PREFIXES = ("VDD", "VSS")


def logical_name(name: str) -> str:
    match = VECTOR_PIN_RE.match(name)
    return match.group(1) if match else name


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


def load_pinout(errors: list[str]) -> tuple[set[str], set[str], set[str]]:
    """Return (logical signal pins, rail pin names, board nets) from the pinout."""
    path = ROOT / "package/e1-demo-pinout.yaml"
    if not path.is_file():
        fail(errors, "package/e1-demo-pinout.yaml missing")
        return set(), set(), set()
    pinout = require_mapping(yaml.safe_load(path.read_text()), "pinout", errors)
    signal_pins: set[str] = set()
    rail_pins: set[str] = set()
    board_nets: set[str] = set()
    for pin in require_list(pinout.get("pins"), "pinout.pins", errors):
        name = str(require_mapping(pin, "pinout.pins[]", errors).get("name", ""))
        if not name:
            continue
        net = pin.get("board_net")
        if isinstance(net, str) and net not in {"", "NC"}:
            board_nets.add(net)
        if name.startswith(RAIL_PREFIXES):
            rail_pins.add(name)
        elif not name.startswith("NC"):
            signal_pins.add(logical_name(name))
    return signal_pins, rail_pins, board_nets


def check_groups(
    intent: dict[str, Any],
    signal_pins: set[str],
    classes: set[str],
    domains: set[str],
    diff_members: set[str],
    errors: list[str],
) -> None:
    seen: set[str] = set()
    for group in require_list(intent.get("signal_groups"), "signal_groups", errors):
        gmap = require_mapping(group, "signal_groups[]", errors)
        gid = gmap.get("id")
        if gmap.get("impedance_class") not in classes:
            fail(errors, f"signal_group {gid} references unknown impedance_class")
        if gmap.get("power_domain") not in domains:
            fail(errors, f"signal_group {gid} references unknown power_domain")
        for member in require_list(gmap.get("members"), f"signal_group {gid} members", errors):
            if member in seen:
                fail(errors, f"signal_group member assigned twice: {member}")
            seen.add(member)
            if member not in signal_pins:
                fail(errors, f"signal_group {gid} member not in pinout: {member}")
    uncovered = sorted(signal_pins - seen)
    if uncovered:
        fail(errors, "pinout signal pins not assigned to a signal_group: " + ", ".join(uncovered))
    orphan = sorted(diff_members - seen)
    if orphan:
        fail(errors, "diff_pairs members not present in any signal_group: " + ", ".join(orphan))


def check_rail_groups(
    intent: dict[str, Any], rail_pins: set[str], domains: set[str], errors: list[str]
) -> None:
    covered: set[str] = set()
    for group in require_list(intent.get("rail_groups"), "rail_groups", errors):
        gmap = require_mapping(group, "rail_groups[]", errors)
        gid = gmap.get("id")
        if gmap.get("power_domain") not in domains:
            fail(errors, f"rail_group {gid} references unknown power_domain")
        names = require_list(gmap.get("rail_names"), f"rail_group {gid} rail_names", errors)
        returns = require_list(gmap.get("return_names"), f"rail_group {gid} return_names", errors)
        for name in [*names, *returns]:
            covered.add(str(name))
            if str(name) not in rail_pins:
                fail(errors, f"rail_group {gid} references pin not in pinout: {name}")
    uncovered = sorted(rail_pins - covered)
    if uncovered:
        fail(errors, "pinout rail pins not assigned to a rail_group: " + ", ".join(uncovered))


def check_diff_pairs(intent: dict[str, Any], signal_pins: set[str], errors: list[str]) -> set[str]:
    members: set[str] = set()
    for pair in require_list(intent.get("diff_pairs"), "diff_pairs", errors):
        pmap = require_mapping(pair, "diff_pairs[]", errors)
        positive = pmap.get("p")
        negative = pmap.get("n")
        if not isinstance(positive, str) or not isinstance(negative, str):
            fail(errors, "diff_pairs entry must define string p and n members")
            continue
        for member in (positive, negative):
            members.add(member)
            if member not in signal_pins:
                fail(errors, f"diff_pair member not in pinout: {member}")
    return members


def check_classes(intent: dict[str, Any], errors: list[str]) -> set[str]:
    classes = require_mapping(intent.get("impedance_classes"), "impedance_classes", errors)
    names: set[str] = set()
    for name, body in classes.items():
        names.add(name)
        cmap = require_mapping(body, f"impedance_classes.{name}", errors)
        if cmap.get("controlled") is True and not cmap.get("coupon_plan_ref"):
            fail(errors, f"controlled impedance_class {name} must cite a coupon_plan_ref")
    return names


def main() -> int:
    errors: list[str] = []
    if not INTENT.is_file():
        fail(errors, f"missing {INTENT.relative_to(ROOT)}")
        print("\n".join(errors))
        return 1

    intent = require_mapping(yaml.safe_load(INTENT.read_text()), "intent", errors)
    if intent.get("schema") != EXPECTED_SCHEMA:
        fail(errors, "unexpected schema")
    if intent.get("release_use") != "prohibited":
        fail(errors, "release_use must remain prohibited")

    signal_pins, rail_pins, _ = load_pinout(errors)
    classes = check_classes(intent, errors)
    domains = set(require_mapping(intent.get("power_domains"), "power_domains", errors))
    diff_members = check_diff_pairs(intent, signal_pins, errors)
    check_groups(intent, signal_pins, classes, domains, diff_members, errors)
    check_rail_groups(intent, rail_pins, domains, errors)

    if errors:
        print("\n".join(errors))
        return 1
    print("STATUS: PASS signal_group_intent package/signal-groups.yaml")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
