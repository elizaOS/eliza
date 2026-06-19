#!/usr/bin/env python3
"""Expand a corner manifest's PVT x Vt x RC x aging cross-product and assert it
meets the declared `total_effective_corners_min`.

Corner manifests previously listed required corner axes as prose plus a
`total_effective_corners_min` integer, but nothing expanded or asserted the
cross-product. This script does both, for two manifest shapes:

  - Advanced (blocked) manifests declare axes under `required_after_unblock`
    (process, voltage_v, temperature_c, aging, rc) plus `multi_vt_required`.
    The Cartesian product of these axes is the effective-corner count that the
    signoff matrix must cover after a foundry agreement. The product must be
    >= `total_effective_corners_min`; short manifests fail closed.

  - Open / predictive manifests enumerate concrete `pvt_corners`, `rc_corners`,
    and a `vt_mix.available` list. The effective set is the realized product of
    those enumerations. These manifests do not declare a minimum (open PDKs do
    not require a 100+ corner matrix), so the assertion is skipped and the
    realized count is reported.

Output is a machine-readable corner set keyed by node_id
(eliza.pd_corner_expansion.v1).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
CORNER_DIR = ROOT / "pd/corner-manifests"
PROFILE_DIR = ROOT / "pd/node-profiles"

EXPANSION_SCHEMA = "eliza.pd_corner_expansion.v1"

# corner-manifest filename stem -> canonical node_id.
MANIFEST_TO_NODE = {
    "sky130": "sky130",
    "gf180": "gf180",
    "ihp-sg13g2": "ihp-sg13g2",
    "asap7": "asap7",
    "tsmc-n2p": "tsmc-n2p",
    "tsmc-a14": "tsmc-a14",
    "intel-14a": "intel-14a",
    "samsung-sf2p": "samsung-sf2p",
}

PVT_AXES = ("process", "voltage_v", "temperature_c", "aging", "rc")


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _axis_len(value: Any) -> int:
    return len(value) if isinstance(value, list) and value else 1


def expand_blocked(required: dict[str, Any]) -> dict[str, Any]:
    """Cartesian product of PVT axes x Vt for an advanced-node manifest."""
    axes = required.get("pvt_axes")
    if not isinstance(axes, dict):
        raise ValueError("required_after_unblock.pvt_axes must be a mapping")

    axis_sizes: dict[str, int] = {}
    product = 1
    for axis in PVT_AXES:
        size = _axis_len(axes.get(axis))
        axis_sizes[axis] = size
        product *= size

    vt = required.get("multi_vt_required")
    vt_size = _axis_len(vt)
    axis_sizes["vt"] = vt_size
    product *= vt_size

    return {
        "shape": "blocked_axis_cross_product",
        "axis_sizes": axis_sizes,
        "effective_corners": product,
    }


def expand_open(manifest: dict[str, Any]) -> dict[str, Any]:
    """Realized product of enumerated PVT x RC x Vt for an open/predictive manifest."""
    pvt = manifest.get("pvt_corners")
    rc = manifest.get("rc_corners")
    pvt_size = _axis_len(pvt)
    rc_size = _axis_len(rc)

    vt_mix = manifest.get("vt_mix")
    vt_available = vt_mix.get("available") if isinstance(vt_mix, dict) else None
    vt_size = _axis_len(vt_available)

    axis_sizes = {"pvt_corners": pvt_size, "rc_corners": rc_size, "vt": vt_size}
    return {
        "shape": "open_enumerated_product",
        "axis_sizes": axis_sizes,
        "effective_corners": pvt_size * rc_size * vt_size,
    }


def expand_manifest(path: Path, errors: list[str]) -> dict[str, Any] | None:
    manifest = load_yaml_object(path)
    if manifest.get("schema") != "eliza.pd_corner_manifest.v1":
        errors.append(f"{rel(path)}: schema must be eliza.pd_corner_manifest.v1")
        return None

    node_id = MANIFEST_TO_NODE.get(path.stem)
    if node_id is None:
        errors.append(f"{rel(path)}: filename stem {path.stem!r} is not a canonical node")
        return None

    required = manifest.get("required_after_unblock")
    if isinstance(required, dict):
        expansion = expand_blocked(required)
        minimum = required.get("total_effective_corners_min")
        if not isinstance(minimum, int) or isinstance(minimum, bool):
            errors.append(
                f"{rel(path)}: required_after_unblock.total_effective_corners_min must be int"
            )
            minimum = None
    else:
        expansion = expand_open(manifest)
        minimum = None  # open / predictive manifests declare no minimum.

    effective = expansion["effective_corners"]
    meets_minimum: bool | None = None
    if minimum is not None:
        meets_minimum = effective >= minimum
        if not meets_minimum:
            errors.append(
                f"{rel(path)}: effective corner cross-product {effective} < "
                f"total_effective_corners_min {minimum}"
            )

    return {
        "node_id": node_id,
        "pdk": manifest.get("pdk"),
        "status": manifest.get("status"),
        "corner_manifest": rel(path),
        "total_effective_corners_min": minimum,
        "meets_minimum": meets_minimum,
        **expansion,
    }


def write_report(node_sets: dict[str, Any], errors: list[str], out: Path) -> None:
    report = {
        "schema": EXPANSION_SCHEMA,
        "errors": errors,
        "nodes": node_sets,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", help="Expand a single node_id (default: all manifests)")
    parser.add_argument(
        "--out",
        default="docs/evidence/process/corner-expansion.json",
        help="Report path relative to the chip package root",
    )
    args = parser.parse_args(argv)

    manifests = sorted(CORNER_DIR.glob("*.yaml"))
    if args.node:
        manifests = [m for m in manifests if MANIFEST_TO_NODE.get(m.stem) == args.node]
        if not manifests:
            print(f"no corner manifest for node_id {args.node!r}")
            return 1
    if not manifests:
        print("no corner manifests found")
        return 1

    errors: list[str] = []
    node_sets: dict[str, Any] = {}
    for path in manifests:
        result = expand_manifest(path, errors)
        if result is not None:
            node_sets[result["node_id"]] = result

    write_report(node_sets, errors, ROOT / args.out)

    if errors:
        print("corner expansion FAILED:")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"corner expansion passed: {len(node_sets)} nodes; report -> {rel(ROOT / args.out)}")
    for node_id, result in sorted(node_sets.items()):
        minimum = result["total_effective_corners_min"]
        suffix = f" (min {minimum})" if minimum is not None else ""
        print(f"  - {node_id}: {result['effective_corners']} effective corners{suffix}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
