#!/usr/bin/env python3
"""Compute raw HPWL on a CT ``.plc`` placement using the netlist topology
from the matching ``.pb.txt`` file.

HPWL here is the sum over nets of (bbox_width + bbox_height) using node-center
coordinates derived from the ``.plc`` (lower-left + half size). This is the
same wirelength metric DREAMPlace optimizes and that ``plc.get_wirelength()``
in Circuit Training reports, modulo CT's per-edge weighting (uniform here).

Use to compare OpenROAD baseline, AlphaChip RL, and DREAMPlace placements
under a single, transparent metric.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from pb_to_bookshelf import parse_pb, parse_plc


def hpwl(pb_file: Path, plc_file: Path) -> dict[str, float]:
    nodes = parse_pb(pb_file)
    coords, header = parse_plc(plc_file)
    name_to_index = {n.name: i for i, n in enumerate(nodes)}

    pins = [n for n in nodes if n.type == "macro_pin"]
    ports = {n.name for n in nodes if n.type in ("PORT", "port")}
    macros = {n.name for n in nodes if n.type in ("macro", "MACRO")}

    name_to_node = {n.name: n for n in nodes}

    def node_xy(name: str) -> tuple[float, float] | None:
        n = name_to_node.get(name)
        if n is None:
            return None
        idx = name_to_index[name]
        x, y, _, _ = coords.get(idx, (n.x, n.y, "N", 0))
        # Center of cell for macros; ports are points.
        if name in macros:
            return (x + n.width / 2.0, y + n.height / 2.0)
        return (x, y)

    pin_owner = {p.name: (p.macro_name or "") for p in pins}

    total_hpwl = 0.0
    num_nets = 0
    for p in pins:
        owner = p.macro_name or ""
        if not owner:
            continue
        coords_list: list[tuple[float, float]] = []
        owner_xy = node_xy(owner)
        if owner_xy is not None:
            coords_list.append(owner_xy)
        for src_pin_name in p.inputs:
            src_owner = pin_owner.get(src_pin_name)
            sink_name = None
            if src_owner is None and src_pin_name in ports:
                sink_name = src_pin_name
            elif src_owner and src_owner in macros:
                sink_name = src_owner
            if sink_name is None:
                continue
            xy = node_xy(sink_name)
            if xy is not None:
                coords_list.append(xy)
        if len(coords_list) < 2:
            continue
        xs = [c[0] for c in coords_list]
        ys = [c[1] for c in coords_list]
        total_hpwl += (max(xs) - min(xs)) + (max(ys) - min(ys))
        num_nets += 1

    for port in [n for n in nodes if n.type in ("PORT", "port")]:
        for src_pin_name in port.inputs:
            src_owner = pin_owner.get(src_pin_name)
            if not src_owner or src_owner not in macros:
                continue
            a = node_xy(port.name)
            b = node_xy(src_owner)
            if a is None or b is None:
                continue
            total_hpwl += abs(a[0] - b[0]) + abs(a[1] - b[1])
            num_nets += 1

    return {
        "pb_file": str(pb_file),
        "plc_file": str(plc_file),
        "hpwl_microns": total_hpwl,
        "num_nets": num_nets,
        "canvas_width": header.get("width"),
        "canvas_height": header.get("height"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pb-file", required=True)
    parser.add_argument("--plc-file", required=True)
    parser.add_argument("--out-json")
    args = parser.parse_args()
    result = hpwl(Path(args.pb_file), Path(args.plc_file))
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.out_json:
        Path(args.out_json).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
