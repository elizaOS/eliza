#!/usr/bin/env python3
"""Collapse a placed CT protobuf into an AlphaChip soft-macro benchmark.

The current E1 netlist has no hard macros, which leaves AlphaChip without a
meaningful macro-placement action space. This utility turns an already placed
standard-cell protobuf into a coarse soft-macro problem by grouping standard
cells on the placement grid and preserving inter-group net connectivity.
"""

from __future__ import annotations

import argparse
import math
import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Node:
    name: str = ""
    inputs: list[str] = field(default_factory=list)
    attrs: dict[str, str | float] = field(default_factory=dict)


def parse_pb(path: Path) -> tuple[list[str], list[Node]]:
    comments: list[str] = []
    nodes: list[Node] = []
    current: Node | None = None
    key: str | None = None
    depth = 0
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if raw.startswith("#") and current is None:
            comments.append(raw)
            continue
        if line == "node {":
            current = Node()
            key = None
            depth = 1
            continue
        if current is None:
            continue
        if line.endswith("{"):
            depth += 1
            continue
        if line == "}":
            depth -= 1
            if depth == 0:
                if current.name:
                    nodes.append(current)
                current = None
                key = None
            continue
        if line.startswith("name:"):
            current.name = line.split(":", 1)[1].strip().strip('"')
        elif line.startswith("input:"):
            current.inputs.append(line.split(":", 1)[1].strip().strip('"'))
        elif line.startswith("key:"):
            key = line.split(":", 1)[1].strip().strip('"')
        elif line.startswith("placeholder:") and key:
            current.attrs[key] = line.split(":", 1)[1].strip().strip('"')
            key = None
        elif line.startswith("f:") and key:
            current.attrs[key] = float(line.split(":", 1)[1].strip())
            key = None
    return comments, nodes


def comment_value(comments: list[str], pattern: str) -> re.Match[str] | None:
    regex = re.compile(pattern)
    for comment in comments:
        match = regex.search(comment)
        if match:
            return match
    return None


def attr_float(node: Node, key: str, default: float = 0.0) -> float:
    value = node.attrs.get(key, default)
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def node_type(node: Node) -> str:
    return str(node.attrs.get("type", ""))


def grid_cluster(node: Node, width: float, height: float, cols: int, rows: int) -> str:
    x = min(max(attr_float(node, "x"), 0.0), max(width, 1e-9))
    y = min(max(attr_float(node, "y"), 0.0), max(height, 1e-9))
    col = min(cols - 1, max(0, int(x / max(width, 1e-9) * cols)))
    row = min(rows - 1, max(0, int(y / max(height, 1e-9) * rows)))
    return f"SM_r{row:02d}_c{col:02d}"


def write_attr(fp, key: str, value: str | float) -> None:
    fp.write("  attr {\n")
    fp.write(f'    key: "{key}"\n')
    fp.write("    value {\n")
    if isinstance(value, str):
        fp.write(f'      placeholder: "{value}"\n')
    else:
        fp.write(f"      f: {value}\n")
    fp.write("    }\n")
    fp.write("  }\n")


def write_node(fp, node: Node) -> None:
    fp.write("node {\n")
    fp.write(f'  name: "{node.name}"\n')
    for source in sorted(set(node.inputs)):
        fp.write(f'  input: "{source}"\n')
    for key, value in node.attrs.items():
        write_attr(fp, key, value)
    fp.write("}\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pb", required=True)
    parser.add_argument("--out-pb", required=True)
    parser.add_argument("--out-plc", required=True)
    parser.add_argument("--cols", type=int, default=8)
    parser.add_argument("--rows", type=int, default=8)
    parser.add_argument("--min-area", type=float, default=0.01)
    parser.add_argument(
        "--area-scale",
        type=float,
        default=0.08,
        help="Scale OpenDB pin/cell geometry into soft-macro area.",
    )
    args = parser.parse_args()

    comments, nodes = parse_pb(Path(args.pb))
    bbox = comment_value(comments, r"FP bbox: \{[-\d.]+ [-\d.]+\} \{([\d.]+) ([\d.]+)\}")
    grid = comment_value(comments, r"Columns : (\d+)\s+Rows : (\d+)")
    width = float(bbox.group(1)) if bbox else 100.0
    height = float(bbox.group(2)) if bbox else 100.0
    plc_cols = int(grid.group(1)) if grid else args.cols
    plc_rows = int(grid.group(2)) if grid else args.rows

    ports = [node for node in nodes if node_type(node).upper() == "PORT"]
    cells = [node for node in nodes if node_type(node).upper() == "STDCELL"]
    name_to_cluster: dict[str, str] = {}
    clusters: dict[str, list[Node]] = {}
    for cell in cells:
        cluster = grid_cluster(cell, width, height, args.cols, args.rows)
        clusters.setdefault(cluster, []).append(cell)
        name_to_cluster[cell.name] = cluster

    port_names = {port.name for port in ports}
    out_nodes: list[Node] = []
    for port in ports:
        out_nodes.append(Node(name=port.name, attrs=dict(port.attrs)))

    source_pin_for_cluster: dict[str, str] = {}
    cluster_pin_count: dict[str, int] = {}

    def source_ref(name: str) -> str | None:
        if name in port_names:
            return name
        cluster = name_to_cluster.get(name)
        if not cluster:
            return None
        if cluster not in source_pin_for_cluster:
            pin_name = f"{cluster}/Poutput"
            source_pin_for_cluster[cluster] = pin_name
        return source_pin_for_cluster[cluster]

    pending_inputs: dict[str, set[str]] = {cluster: set() for cluster in clusters}
    port_inputs: dict[str, set[str]] = {port.name: set() for port in ports}
    for sink in nodes:
        sink_type = node_type(sink).upper()
        sink_cluster = name_to_cluster.get(sink.name)
        for source in sink.inputs:
            src = source_ref(source)
            if not src:
                continue
            if sink_type == "PORT":
                port_inputs.setdefault(sink.name, set()).add(src)
            elif sink_cluster and src != source_pin_for_cluster.get(sink_cluster):
                pending_inputs.setdefault(sink_cluster, set()).add(src)

    for port in out_nodes:
        if node_type(port).upper() == "PORT":
            port.inputs = sorted(set(port.inputs) | port_inputs.get(port.name, set()))

    for cluster, members in sorted(clusters.items()):
        area = sum(
            max(
                args.min_area,
                attr_float(m, "width") * attr_float(m, "height") * args.area_scale,
            )
            for m in members
        )
        sum_area = max(area, args.min_area)
        sum_x = sum(
            attr_float(m, "x")
            * max(
                args.min_area,
                attr_float(m, "width") * attr_float(m, "height") * args.area_scale,
            )
            for m in members
        )
        sum_y = sum(
            attr_float(m, "y")
            * max(
                args.min_area,
                attr_float(m, "width") * attr_float(m, "height") * args.area_scale,
            )
            for m in members
        )
        side = math.sqrt(sum_area)
        macro_w = side
        macro_h = side
        out_nodes.append(
            Node(
                name=cluster,
                attrs={
                    "height": macro_h,
                    "type": "macro",
                    "width": macro_w,
                    "x": sum_x / sum_area,
                    "y": sum_y / sum_area,
                },
            )
        )
        if cluster in source_pin_for_cluster:
            out_nodes.append(
                Node(
                    name=source_pin_for_cluster[cluster],
                    attrs={
                        "macro_name": cluster,
                        "type": "macro_pin",
                        "x": sum_x / sum_area,
                        "x_offset": 0.0,
                        "y": sum_y / sum_area,
                        "y_offset": 0.0,
                    },
                )
            )
        for src in sorted(pending_inputs.get(cluster, set())):
            idx = cluster_pin_count.get(cluster, 0)
            cluster_pin_count[cluster] = idx + 1
            out_nodes.append(
                Node(
                    name=f"{cluster}/Pinput_{idx}",
                    inputs=[src],
                    attrs={
                        "macro_name": cluster,
                        "type": "macro_pin",
                        "x": sum_x / sum_area,
                        "x_offset": 0.0,
                        "y": sum_y / sum_area,
                        "y_offset": 0.0,
                    },
                )
            )

    out_pb = Path(args.out_pb)
    out_pb.parent.mkdir(parents=True, exist_ok=True)
    with out_pb.open("w") as fp:
        for comment in comments:
            fp.write(comment + "\n")
        fp.write(f"# Soft macro source : {args.pb}\n")
        fp.write(f"# Soft macro grid : {args.cols} x {args.rows}\n")
        for node in out_nodes:
            write_node(fp, node)

    out_plc = Path(args.out_plc)
    with out_plc.open("w") as fp:
        fp.write("# Placement file for Circuit Training\n")
        fp.write(f"# Source input file(s) : {out_pb}\n")
        fp.write(f"# Columns : {plc_cols}  Rows : {plc_rows}\n")
        fp.write(f"# Width : {width:.3f}  Height : {height:.3f}\n")
        fp.write("# Routes per micron, hor : 70.330  ver : 74.510\n")
        fp.write("# Routes used by macros, hor : 0.000  ver : 0.000\n")
        fp.write("# Smoothing factor : 2\n")
        fp.write("# Overlap threshold : 0.004\n")
        fp.write("# node_index x y orientation fixed\n")
        for idx, node in enumerate(out_nodes):
            typ = node_type(node)
            if typ == "PORT":
                fp.write(f"{idx} {attr_float(node, 'x'):.3f} {attr_float(node, 'y'):.3f} - 1\n")
            elif typ == "macro":
                fp.write(f"{idx} {attr_float(node, 'x'):.3f} {attr_float(node, 'y'):.3f} N 0\n")

    print(f"Generated {out_pb}")
    print(f"Generated {out_plc}")
    print(f"Soft macros: {len(clusters)}")
    print(f"Ports: {len(ports)}")
    print(f"Original stdcells: {len(cells)}")


if __name__ == "__main__":
    main()
