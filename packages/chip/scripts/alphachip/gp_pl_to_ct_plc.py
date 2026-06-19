#!/usr/bin/env python3
"""Merge a DREAMPlace Bookshelf .gp.pl output into a CT-style .openroad.plc
shape, preserving the original .plc header + port lines and substituting the
soft-macro coordinates with the DREAMPlace solution.

Inputs:
  --pb-file       CT netlist (for node ordering + macro types)
  --src-plc       CT init .openroad.plc (header + node indexing source)
  --gp-pl         DREAMPlace .gp.pl output
  --out-plc       Destination CT-format .plc

Use to feed DREAMPlace results into the same evaluate_plc.py / HPWL routines.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from pb_to_bookshelf import parse_pb, parse_plc


def parse_gp_pl(path: Path) -> dict[str, tuple[float, float, str]]:
    out: dict[str, tuple[float, float, str]] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("UCLA"):
            continue
        parts = line.split()
        if len(parts) < 5:
            continue
        name = parts[0]
        try:
            x = float(parts[1])
            y = float(parts[2])
        except ValueError:
            continue
        orient = parts[4] if len(parts) > 4 else "N"
        out[name] = (x, y, orient)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pb-file", required=True)
    parser.add_argument("--src-plc", required=True)
    parser.add_argument("--gp-pl", required=True)
    parser.add_argument("--out-plc", required=True)
    args = parser.parse_args()

    nodes = parse_pb(Path(args.pb_file))
    src_coords, _header = parse_plc(Path(args.src_plc))
    gp = parse_gp_pl(Path(args.gp_pl))
    name_to_index = {n.name: i for i, n in enumerate(nodes)}

    out_lines: list[str] = []
    # Preserve original header comments.
    for raw in Path(args.src_plc).read_text().splitlines():
        if raw.startswith("#"):
            out_lines.append(raw)
        else:
            break

    # Ports keep their original fixed coordinates.
    for n in nodes:
        if n.type in ("PORT", "port"):
            idx = name_to_index[n.name]
            x, y, orient, _fixed = src_coords.get(idx, (n.x, n.y, "-", 1))
            out_lines.append(f"{idx} {x:.3f} {y:.3f} {orient or '-'} 1")

    # Macros get DREAMPlace coordinates.
    for n in nodes:
        if n.type in ("macro", "MACRO"):
            idx = name_to_index[n.name]
            if n.name in gp:
                x, y, orient = gp[n.name]
            else:
                fallback = src_coords.get(idx, (n.x, n.y, "N", 0))
                x, y, orient = fallback[0], fallback[1], fallback[2] or "N"
            out_lines.append(f"{idx} {x:.3f} {y:.3f} {orient or 'N'} 0")

    Path(args.out_plc).write_text("\n".join(out_lines) + "\n")
    print(f"PASS: wrote {args.out_plc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
