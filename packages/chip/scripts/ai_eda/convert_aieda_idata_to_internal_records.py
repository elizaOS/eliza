#!/usr/bin/env python3
"""Convert bounded AiEDA/iDATA route-demand maps into internal records."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MAP_DIR = ROOT / "external/datasets/aieda-idata/payload/PPU/iEDA_route_process_data/PPU_a_place"
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/aieda_idata"
CLAIM_BOUNDARY = "aieda_idata_conversion_training_only_no_e1_signoff_or_release_claim"


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value)


def demand_map_sort_key(path: Path) -> tuple[int, int | str]:
    suffix = path.stem.removeprefix("demand_map_")
    if suffix == "final":
        return (1, suffix)
    try:
        return (0, int(suffix))
    except ValueError:
        return (0, suffix)


def percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return ordered[index]


def parse_demand_map(path: Path, max_graph_nodes: int) -> dict[str, Any]:
    rows: list[list[float]] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), start=1):
        cells = [cell.strip() for cell in raw_line.split(",") if cell.strip()]
        if not cells:
            continue
        try:
            row = [float(cell) for cell in cells]
        except ValueError as exc:
            raise ValueError(f"{path}: non-numeric value on line {line_number}") from exc
        if any(not math.isfinite(value) for value in row):
            raise ValueError(f"{path}: non-finite value on line {line_number}")
        rows.append(row)
    if not rows:
        raise ValueError(f"{path}: demand map is empty")
    width = len(rows[0])
    if width <= 0:
        raise ValueError(f"{path}: demand map has zero columns")
    for index, row in enumerate(rows, start=1):
        if len(row) != width:
            raise ValueError(f"{path}: row {index} has width {len(row)}, expected {width}")

    all_values: list[float] = []
    nonzero_cells: list[tuple[int, int, float]] = []
    for row_index, row in enumerate(rows):
        for col_index, demand in enumerate(row):
            all_values.append(demand)
            if demand > 0:
                nonzero_cells.append((row_index, col_index, demand))
    if not nonzero_cells:
        raise ValueError(f"{path}: demand map has no positive demand cells")

    row_count = len(rows)
    col_count = width
    cell_count = row_count * col_count
    max_demand = max(all_values)
    total_demand = sum(all_values)
    nonzero_values = [demand for _, _, demand in nonzero_cells]
    nodes = [
        {
            "id": f"cell_r{row}_c{col}",
            "node_type": "route_demand_grid_cell",
            "x_index": col,
            "y_index": row,
            "x_norm": 0.0 if col_count == 1 else col / (col_count - 1),
            "y_norm": 0.0 if row_count == 1 else row / (row_count - 1),
            "demand": demand,
            "demand_norm": 0.0 if max_demand == 0 else demand / max_demand,
        }
        for row, col, demand in nonzero_cells
    ]
    lookup = {(row, col): demand for row, col, demand in nonzero_cells}
    edges: list[dict[str, Any]] = []
    for row, col, demand in nonzero_cells:
        for next_row, next_col, direction in ((row, col + 1, "east"), (row + 1, col, "south")):
            other = lookup.get((next_row, next_col))
            if other is None:
                continue
            edges.append(
                {
                    "src": f"cell_r{row}_c{col}",
                    "dst": f"cell_r{next_row}_c{next_col}",
                    "edge_type": "grid_four_neighbor_positive_demand",
                    "direction": direction,
                    "src_demand": demand,
                    "dst_demand": other,
                    "demand_delta": other - demand,
                }
            )
    if not edges and len(nonzero_cells) > 1:
        for (row, col, demand), (next_row, next_col, other) in zip(nonzero_cells, nonzero_cells[1:]):
            edges.append(
                {
                    "src": f"cell_r{row}_c{col}",
                    "dst": f"cell_r{next_row}_c{next_col}",
                    "edge_type": "sparse_positive_demand_sequence_fallback",
                    "direction": "sequence",
                    "src_demand": demand,
                    "dst_demand": other,
                    "demand_delta": other - demand,
                }
            )
    full_node_count = len(nodes)
    full_edge_count = len(edges)
    if len(nodes) > max_graph_nodes:
        selected_ids = {
            item["id"]
            for item in sorted(
                nodes,
                key=lambda item: (
                    -float(item["demand"]),
                    int(item["y_index"]),
                    int(item["x_index"]),
                ),
            )[:max_graph_nodes]
        }
        nodes = [item for item in nodes if item["id"] in selected_ids]
        edges = [
            item
            for item in edges
            if item["src"] in selected_ids and item["dst"] in selected_ids
        ]
        if not edges and len(nodes) > 1:
            for src, dst in zip(nodes, nodes[1:]):
                edges.append(
                    {
                        "src": src["id"],
                        "dst": dst["id"],
                        "edge_type": "sampled_top_demand_sequence_fallback",
                        "direction": "sample_sequence",
                        "src_demand": src["demand"],
                        "dst_demand": dst["demand"],
                        "demand_delta": dst["demand"] - src["demand"],
                    }
                )
    stats = {
        "row_count": row_count,
        "col_count": col_count,
        "cell_count": cell_count,
        "nonzero_count": len(nonzero_cells),
        "edge_count": full_edge_count,
        "graph_node_count": len(nodes),
        "graph_edge_count": len(edges),
        "graph_node_sample_limit": max_graph_nodes,
        "graph_sampling_policy": "top_positive_demand_cells_preserve_full_aggregate_stats",
        "max_demand": max_demand,
        "total_demand": total_demand,
        "mean_demand": total_demand / cell_count,
        "nonzero_mean_demand": sum(nonzero_values) / len(nonzero_values),
        "nonzero_density": len(nonzero_cells) / cell_count,
        "p95_demand": percentile(all_values, 95.0),
        "p95_nonzero_demand": percentile(nonzero_values, 95.0),
    }
    return {"node_features": nodes, "edge_features": edges, "stats": stats}


def write_json(out_dir: Path, record: dict[str, Any]) -> Path:
    out_path = out_dir / f"{record['id']}.json"
    out_path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return out_path


def convert_map(path: Path, out_dir: Path, max_graph_nodes: int) -> list[dict[str, Any]]:
    name = path.stem
    prefix = f"aieda-idata-{safe_id(name)}"
    parsed = parse_demand_map(path, max_graph_nodes)
    stats = parsed["stats"]
    source = {"path": rel(path), "sha256": sha256_file(path)}
    design_bundle = {
        "schema": "eda.design_bundle.v1",
        "id": f"{prefix}-design-bundle",
        "claim_boundary": CLAIM_BOUNDARY,
        "design": {"name": name, "revision": "aieda_idata_local_payload", "top_module": "PPU"},
        "sources": {"rtl": [], "netlists": [], "manifests": ["external/datasets/aieda-idata/manifest.yaml"], "grids": [source]},
        "constraints": {"clocks": [], "resets": []},
        "technology": {"node": "aieda_idata_public_routing_demand_grid", "pdk": "public_dataset_no_pdk_collateral", "flow": "AiEDA/iDATA"},
    }
    graph_sample = {
        "schema": "eda.graph_sample.v1",
        "id": f"{prefix}-route-demand-graph",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "graph": {
            "node_features": parsed["node_features"],
            "edge_features": parsed["edge_features"],
            "coordinate_system": "aieda_idata_grid_indices_no_e1_layout_coordinates",
        },
        "labels": {
            "label_status": "public_aieda_idata_routing_demand_training_only_not_e1_signoff",
            "label_sources": [source],
            "values": stats,
        },
        "provenance": {"generated_by": "scripts/ai_eda/convert_aieda_idata_to_internal_records.py", "source_records": [source]},
    }
    flow_run = {
        "schema": "eda.flow_run.v1",
        "id": f"{prefix}-flow-run",
        "design_bundle_id": design_bundle["id"],
        "claim_boundary": CLAIM_BOUNDARY,
        "toolchain": {"tools": ["AiEDA/iDATA public route demand export"], "version_capture": "external/datasets/aieda-idata/manifest.yaml"},
        "command": "python3 scripts/ai_eda/convert_aieda_idata_to_internal_records.py --run-id <run-id>",
        "inputs": {"demand_map": source},
        "outputs": {"reports": [], "artifacts": [source]},
        "metrics": stats,
        "status": {
            "result": "CONVERTED_PUBLIC_ROUTING_DEMAND_GRID_NOT_REPLAYED",
            "blockers": [
                "public iDATA route demand map is not local E1 OpenROAD evidence",
                "routing-demand labels require leakage review before model release",
                "release use requires deterministic E1 replay through OpenLane/OpenROAD signoff",
            ],
        },
    }
    records = (design_bundle, graph_sample, flow_run)
    paths = [write_json(out_dir, record) for record in records]
    return [
        {
            "demand_map": rel(path),
            "schema": record["schema"],
            "json": rel(out_path),
            "nonzero_count": stats["nonzero_count"],
            "edge_count": stats["edge_count"],
            "graph_node_count": stats["graph_node_count"],
            "graph_edge_count": stats["graph_edge_count"],
        }
        for record, out_path in zip(records, paths)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map-dir", type=Path, default=DEFAULT_MAP_DIR)
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--sample-limit", type=int, default=3)
    parser.add_argument("--max-graph-nodes", type=int, default=1024)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.sample_limit <= 0:
        raise SystemExit("--sample-limit must be positive")
    if args.max_graph_nodes <= 1:
        raise SystemExit("--max-graph-nodes must be greater than 1")
    if not args.map_dir.exists():
        print(f"STATUS: BLOCKED ai_eda.aieda_idata_conversion missing_map_dir {args.map_dir}")
        return 2
    maps = sorted(args.map_dir.glob("demand_map_*.csv"), key=demand_map_sort_key)
    if not maps:
        print(f"STATUS: BLOCKED ai_eda.aieda_idata_conversion no_demand_maps {args.map_dir}")
        return 2
    selected = maps[: args.sample_limit]
    out_dir = args.out_root / args.run_id / "records"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale_record in out_dir.glob("aieda-idata-*.json"):
        stale_record.unlink()
    converted: list[dict[str, Any]] = []
    for demand_map in selected:
        converted.extend(convert_map(demand_map, out_dir, args.max_graph_nodes))
    report_path = args.out_root / args.run_id / "conversion_report.json"
    report = {
        "schema": "eliza.ai_eda.aieda_idata_conversion_report.v1",
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "run_id": args.run_id,
        "claim_boundary": CLAIM_BOUNDARY,
        "map_dir": rel(args.map_dir),
        "available_map_count": len(maps),
        "converted_map_count": len(selected),
        "converted_record_count": len(converted),
        "converted_records": converted,
        "release_use_allowed": False,
    }
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"STATUS: PASS ai_eda.aieda_idata_conversion maps={len(selected)} records={len(converted)} report={rel(report_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
