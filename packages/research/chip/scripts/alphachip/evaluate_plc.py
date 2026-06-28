#!/usr/bin/env python3
"""Evaluate a Circuit Training placement file.

This is intentionally small and runs inside the Circuit Training Docker image.
It reports the proxy metrics used by Circuit Training/AlphaChip so OpenROAD,
coordinate-descent, and trained-policy placements can be compared with the same
cost function.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from absl import flags
from circuit_training.environment import placement_util


def main() -> None:
    flags.FLAGS(["evaluate_plc"])
    parser = argparse.ArgumentParser()
    parser.add_argument("--netlist", required=True)
    parser.add_argument("--plc", required=True)
    parser.add_argument("--out-json")
    parser.add_argument("--fd-place", action="store_true")
    parser.add_argument("--save-plc")
    args = parser.parse_args()

    plc = placement_util.create_placement_cost(args.netlist, args.plc)
    if args.fd_place:
        placement_util.fd_placement_schedule(plc)
    wirelength = plc.get_cost()
    congestion = plc.get_congestion_cost()
    density = plc.get_density_cost()
    total = wirelength + 0.5 * congestion + 0.5 * density
    metrics = {
        "netlist": args.netlist,
        "plc": args.plc,
        "fd_place": args.fd_place,
        "wirelength_cost": wirelength,
        "congestion_cost": congestion,
        "density_cost": density,
        "proxy_cost": total,
        "wirelength": plc.get_wirelength(),
        "area": plc.get_area(),
        "canvas_width": plc.get_canvas_width_height()[0],
        "canvas_height": plc.get_canvas_width_height()[1],
        "grid_columns": plc.get_grid_num_columns_rows()[0],
        "grid_rows": plc.get_grid_num_columns_rows()[1],
    }
    print(json.dumps(metrics, indent=2, sort_keys=True))
    if args.out_json:
        Path(args.out_json).write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n")
    if args.save_plc:
        placement_util.save_placement(plc, args.save_plc)


if __name__ == "__main__":
    main()
