#!/usr/bin/env python3
"""Convert a Circuit Training ``.pb.txt`` netlist + ``.openroad.plc`` placement
into ISPD-style Bookshelf benchmark files so stock DREAMPlace can read them.

Bookshelf consists of five files:

* ``<design>.aux``      manifest listing the other four files
* ``<design>.nodes``    one row per movable cell or fixed pad: ``name w h [terminal]``
* ``<design>.nets``     net membership and pin offsets
* ``<design>.pl``       initial placement (``name x y : N``); ports are pinned
                        with ``/FIXED`` so DREAMPlace treats them as terminals
* ``<design>.scl``      placement-row description (single core area row)

The Circuit Training (CT) ``.pb.txt`` format used by AlphaChip groups the
original standard cells into soft macros (here: 256 SMs on a 16x16 grid) plus
ports and per-macro pin nodes. We map:

  * ``type=PORT``        -> Bookshelf fixed terminal at the port coordinate
  * ``type=macro``       -> Bookshelf movable cell with the CT macro w/h
  * ``type=macro_pin``   -> Bookshelf pin on its owning macro (zero offset is
                            the CT convention; CT's proxy uses macro center).

Initial placement comes from the matching ``.openroad.plc`` (lower-left
coordinates per the CT placement file convention).

Run:

    python3 scripts/alphachip/pb_to_bookshelf.py \\
        --pb-file /tmp/e1-alphachip/e1_softmacro_full/e1_softmacro.pb.txt \\
        --plc-file /tmp/e1-alphachip/e1_softmacro_full/e1_softmacro.openroad.plc \\
        --out-dir /tmp/e1-alphachip/e1_softmacro_full/bookshelf \\
        --design e1_softmacro
"""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Node:
    name: str
    type: str
    width: float = 0.0
    height: float = 0.0
    x: float = 0.0
    y: float = 0.0
    side: str | None = None
    orientation: str = "N"
    x_offset: float = 0.0
    y_offset: float = 0.0
    macro_name: str | None = None
    inputs: list[str] = field(default_factory=list)


_NODE_HEADER = re.compile(r"^node\s*\{")
_NAME_LINE = re.compile(r'^\s*name:\s*"([^"]+)"\s*$')
_INPUT_LINE = re.compile(r'^\s*input:\s*"([^"]+)"\s*$')
_KEY_LINE = re.compile(r'^\s*key:\s*"([^"]+)"\s*$')
_PLACEHOLDER_LINE = re.compile(r'^\s*placeholder:\s*"([^"]+)"\s*$')
_FLOAT_LINE = re.compile(r"^\s*f:\s*([-+0-9.eE]+)\s*$")


def parse_pb(pb_path: Path) -> list[Node]:
    nodes: list[Node] = []
    current: Node | None = None
    pending_key: str | None = None
    brace_depth = 0
    with pb_path.open() as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if _NODE_HEADER.match(line):
                if current is not None:
                    nodes.append(current)
                current = Node(name="", type="")
                pending_key = None
                brace_depth = 1
                continue
            if current is None:
                continue
            if "{" in line:
                brace_depth += line.count("{")
            if "}" in line:
                brace_depth -= line.count("}")
                if brace_depth <= 0:
                    nodes.append(current)
                    current = None
                    pending_key = None
                    brace_depth = 0
                    continue
            m = _NAME_LINE.match(line)
            if m:
                current.name = m.group(1)
                continue
            m = _INPUT_LINE.match(line)
            if m:
                current.inputs.append(m.group(1))
                continue
            m = _KEY_LINE.match(line)
            if m:
                pending_key = m.group(1)
                continue
            m = _PLACEHOLDER_LINE.match(line)
            if m and pending_key is not None:
                val = m.group(1)
                if pending_key == "type":
                    current.type = val
                elif pending_key == "side":
                    current.side = val
                elif pending_key == "macro_name":
                    current.macro_name = val
                elif pending_key == "orientation":
                    current.orientation = val or "N"
                continue
            m = _FLOAT_LINE.match(line)
            if m and pending_key is not None:
                val = float(m.group(1))
                if pending_key == "x":
                    current.x = val
                elif pending_key == "y":
                    current.y = val
                elif pending_key == "width":
                    current.width = val
                elif pending_key == "height":
                    current.height = val
                elif pending_key == "x_offset":
                    current.x_offset = val
                elif pending_key == "y_offset":
                    current.y_offset = val
                continue
    if current is not None:
        nodes.append(current)
    return nodes


def parse_plc(plc_path: Path) -> tuple[dict[int, tuple[float, float, str, int]], dict[str, float]]:
    """Return {node_index: (x, y, orient, fixed)} plus header floats."""
    coords: dict[int, tuple[float, float, str, int]] = {}
    header: dict[str, float] = {}
    with plc_path.open() as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#"):
                if "Width" in line and "Height" in line:
                    parts = line.replace(",", " ").split()
                    for i, token in enumerate(parts):
                        if token == "Width":
                            header["width"] = float(parts[i + 2])
                        if token == "Height":
                            header["height"] = float(parts[i + 2])
                if "Columns" in line and "Rows" in line:
                    parts = line.replace(",", " ").split()
                    for i, token in enumerate(parts):
                        if token == "Columns":
                            header["columns"] = float(parts[i + 2])
                        if token == "Rows":
                            header["rows"] = float(parts[i + 2])
                continue
            parts = line.split()
            if len(parts) < 5:
                continue
            try:
                idx = int(parts[0])
                x = float(parts[1])
                y = float(parts[2])
                orient = parts[3]
                fixed = int(parts[4])
            except ValueError:
                continue
            coords[idx] = (x, y, orient or "N", fixed)
    return coords, header


def write_bookshelf(
    out_dir: Path,
    design: str,
    nodes: list[Node],
    coords: dict[int, tuple[float, float, str, int]],
    header: dict[str, float],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    nodes_path = out_dir / f"{design}.nodes"
    nets_path = out_dir / f"{design}.nets"
    pl_path = out_dir / f"{design}.pl"
    scl_path = out_dir / f"{design}.scl"
    wts_path = out_dir / f"{design}.wts"
    aux_path = out_dir / f"{design}.aux"

    name_to_index = {n.name: i for i, n in enumerate(nodes)}

    cells = [n for n in nodes if n.type in ("macro", "MACRO")]
    ports = [n for n in nodes if n.type in ("PORT", "port")]
    pins = [n for n in nodes if n.type == "macro_pin"]

    num_terminals = len(ports)
    num_cells = len(cells) + num_terminals

    with nodes_path.open("w") as fh:
        fh.write("UCLA nodes 1.0\n")
        fh.write(f"# Generated from CT pb.txt for {design}\n\n")
        fh.write(f"NumNodes : {num_cells}\n")
        fh.write(f"NumTerminals : {num_terminals}\n\n")
        for n in cells:
            w = max(1, int(round(n.width)))
            h = max(1, int(round(n.height)))
            fh.write(f"\t{n.name}\t{w}\t{h}\n")
        for n in ports:
            fh.write(f"\t{n.name}\t1\t1\tterminal\n")

    with pl_path.open("w") as fh:
        fh.write("UCLA pl 1.0\n")
        fh.write(f"# Initial placement for {design}\n\n")
        for n in cells:
            idx = name_to_index[n.name]
            x, y, orient, _fixed = coords.get(idx, (n.x, n.y, n.orientation, 0))
            fh.write(f"{n.name}\t{x:.4f}\t{y:.4f}\t:\t{orient or 'N'}\n")
        for n in ports:
            idx = name_to_index[n.name]
            x, y, orient, _fixed = coords.get(idx, (n.x, n.y, n.orientation, 1))
            o = orient if orient and orient != "-" else "N"
            fh.write(f"{n.name}\t{x:.4f}\t{y:.4f}\t:\t{o}\t/FIXED\n")

    # Build nets: a "driver" is a macro_pin's owner; each input on that pin is
    # a sink. CT models per-port adjacencies, so we coalesce edges per net by
    # treating each (driver, sink-list) cluster as one net.
    # Strategy: each macro_pin with outgoing inputs becomes a net rooted at
    # itself (output) with the driving macros being the listed "input:"
    # entries. Mirror CT's convention: nets connect macros via macro_pin nodes.
    pin_owner: dict[str, str] = {p.name: (p.macro_name or "") for p in pins}
    port_set = {p.name for p in ports}
    macro_set = {c.name for c in cells}

    nets: list[tuple[str, list[tuple[str, float, float]]]] = []
    for p in pins:
        # Driver = macro that owns this output pin.
        owner = p.macro_name or ""
        if not owner:
            continue
        driver_pins: list[tuple[str, float, float]] = []
        if owner in macro_set:
            driver_pins.append((owner, p.x_offset, p.y_offset))
        # Sinks come from "input:" references.
        sinks: list[tuple[str, float, float]] = []
        for src_pin_name in p.inputs:
            # src_pin_name is something like "SM_r02_c03/Poutput".
            src_owner = pin_owner.get(src_pin_name)
            if src_owner is None and src_pin_name in port_set:
                sinks.append((src_pin_name, 0.0, 0.0))
            elif src_owner and src_owner in macro_set:
                sinks.append((src_owner, 0.0, 0.0))
        if not sinks:
            continue
        net_pins = driver_pins + sinks
        if len(net_pins) < 2:
            continue
        nets.append((p.name, net_pins))

    # Ports also have an "input:" list; convert each port->driver into a net.
    for port in ports:
        for src_pin_name in port.inputs:
            src_owner = pin_owner.get(src_pin_name)
            if not src_owner or src_owner not in macro_set:
                continue
            nets.append((f"{port.name}__net", [(port.name, 0.0, 0.0), (src_owner, 0.0, 0.0)]))

    total_pins = sum(len(p) for _, p in nets)
    with nets_path.open("w") as fh:
        fh.write("UCLA nets 1.0\n\n")
        fh.write(f"NumNets : {len(nets)}\n")
        fh.write(f"NumPins : {total_pins}\n\n")
        for net_name, net_pins in nets:
            fh.write(f"NetDegree : {len(net_pins)}   {net_name}\n")
            for i, (cell_name, ox, oy) in enumerate(net_pins):
                direction = "O" if i == 0 else "I"
                fh.write(f"\t{cell_name}\t{direction} : {ox:.4f}\t{oy:.4f}\n")

    with wts_path.open("w") as fh:
        fh.write("UCLA wts 1.0\n\n")

    # Bookshelf requires row_height == every movable cell's height. The
    # Circuit-Training bridge in limbo018/DREAMPlace sidesteps this by feeding
    # PlaceDB in-process, but stock DREAMPlace's Bookshelf legalizer asserts
    # uniform row height. We
    # set row_height = 1 site_h unit and rewrite cell heights to integer
    # multiples; the proxy of interest here is HPWL after global placement,
    # which is invariant under uniform y-scaling.
    canvas_w = header.get("width", max((n.x + n.width for n in cells + ports), default=0.0))
    canvas_h = header.get("height", max((n.y + n.height for n in cells + ports), default=0.0))
    site_h = 1
    num_rows = max(1, int(round(canvas_h / site_h)))
    site_width = 1
    with scl_path.open("w") as fh:
        fh.write("UCLA scl 1.0\n\n")
        fh.write(f"NumRows : {num_rows}\n\n")
        for r in range(num_rows):
            y = r * site_h
            fh.write("CoreRow Horizontal\n")
            fh.write(f"  Coordinate    :   {y}\n")
            fh.write(f"  Height        :   {site_h}\n")
            fh.write(f"  Sitewidth     :    {site_width}\n")
            fh.write(f"  Sitespacing   :    {site_width}\n")
            fh.write("  Siteorient    :    1\n")
            fh.write("  Sitesymmetry  :    1\n")
            fh.write(f"  SubrowOrigin  :    0    NumSites  :    {int(canvas_w)}\n")
            fh.write("End\n")

    with aux_path.open("w") as fh:
        fh.write(
            f"RowBasedPlacement : {design}.nodes {design}.nets {design}.wts "
            f"{design}.pl {design}.scl\n"
        )

    print(f"PASS: wrote {aux_path}")
    print(f"  nodes={num_cells}  terminals={num_terminals}  nets={len(nets)}  pins={total_pins}")
    print(f"  canvas={canvas_w:.2f} x {canvas_h:.2f}  rows={num_rows} site_h={site_h}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pb-file", required=True)
    parser.add_argument("--plc-file", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--design", default="design")
    args = parser.parse_args()

    pb_path = Path(args.pb_file)
    plc_path = Path(args.plc_file)
    out_dir = Path(args.out_dir)
    if not pb_path.is_file():
        raise SystemExit(f"missing pb file: {pb_path}")
    if not plc_path.is_file():
        raise SystemExit(f"missing plc file: {plc_path}")

    nodes = parse_pb(pb_path)
    coords, header = parse_plc(plc_path)
    write_bookshelf(out_dir, args.design, nodes, coords, header)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
