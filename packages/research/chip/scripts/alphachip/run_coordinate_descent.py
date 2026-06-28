#!/usr/bin/env python3
"""Run Circuit Training coordinate descent on a placement benchmark."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from absl import flags
from circuit_training.environment import coordinate_descent_placer, environment, placement_util


def metrics(plc, netlist: str, plc_path: str, label: str) -> dict[str, float | str]:
    wirelength = plc.get_cost()
    congestion = plc.get_congestion_cost()
    density = plc.get_density_cost()
    return {
        "label": label,
        "netlist": netlist,
        "plc": plc_path,
        "wirelength_cost": wirelength,
        "congestion_cost": congestion,
        "density_cost": density,
        "proxy_cost": wirelength + 0.5 * congestion + 0.5 * density,
        "wirelength": plc.get_wirelength(),
        "area": plc.get_area(),
    }


def main() -> None:
    flags.FLAGS(["run_coordinate_descent"])
    parser = argparse.ArgumentParser()
    parser.add_argument("--netlist", required=True)
    parser.add_argument("--init-placement", required=True)
    parser.add_argument("--out-plc", required=True)
    parser.add_argument("--out-json")
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--seed", type=int, default=123)
    parser.add_argument("--node-order", default="descending_size_macro_first")
    parser.add_argument("--k-distance-bound", type=int, default=5)
    parser.add_argument("--cell-search-prob", type=float, default=1.0)
    parser.add_argument("--full-grid", action="store_true")
    parser.add_argument("--use-stdcell-placer", action="store_true")
    parser.add_argument("--stdcell-placer", default="fd")
    args = parser.parse_args()

    np.random.seed(args.seed)
    plc = placement_util.create_placement_cost(args.netlist, args.init_placement)

    before = metrics(plc, args.netlist, args.init_placement, "before")

    placer = coordinate_descent_placer.CoordinateDescentPlacer(
        plc=plc,
        cost_fn=lambda p: environment.cost_info_function(plc=p, done=True),
        epochs=args.epochs,
        use_stdcell_placer=args.use_stdcell_placer,
        stdcell_placer=args.stdcell_placer,
        node_order=args.node_order,
        cell_search_prob=args.cell_search_prob,
        k_distance_bounded_search=not args.full_grid,
        k_distance_bound=args.k_distance_bound,
        seed=args.seed,
    )
    placer.place()
    placement_util.save_placement(plc, args.out_plc)

    after = metrics(plc, args.netlist, args.out_plc, "after")
    result = {"before": before, "after": after}
    print(json.dumps(result, indent=2, sort_keys=True))
    if args.out_json:
        Path(args.out_json).write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
