#!/usr/bin/env python3
"""Merge ASAP7 7p5t RVT TT corner Liberty files into a single ABC-friendly lib.

ABC inside Yosys consumes one Liberty file at a time, but the ASAP7 stdcell
release ships the cells split into INVBUF / SIMPLE / AO / OA / SEQ groups (one
.lib per group). This merger reads each input lib, strips the outer `library
(...) { ... }` wrapper, and emits a single `library (...) { ... }` that
contains the union of cells, library-level attributes, and lookup tables.

The merged library is tagged in its name so consumers know what they got. The
output is deterministic given the same inputs.

Usage:
    merge_libs.py <out.lib> <in1.lib> [<in2.lib> ...]
"""

from __future__ import annotations

import sys
from pathlib import Path


def split_lib(text: str) -> tuple[str, str]:
    """Return (header_attrs, cells_block) for a single ASAP7 NLDM lib."""
    start = text.find("library (")
    if start == -1:
        raise ValueError("no `library (` in file")
    open_brace = text.find("{", start)
    if open_brace == -1:
        raise ValueError("no `{` after `library (...)`")
    end = text.rfind("}")
    if end == -1 or end <= open_brace:
        raise ValueError("no matching `}` for library block")
    inner = text[open_brace + 1 : end]

    # The header contains library-level attributes (technology, units, lu
    # tables, voltage maps, etc.) up to the first `cell (` line. The cells
    # block is everything from that line onward.
    cell_idx = inner.find("\n  cell (")
    if cell_idx == -1:
        # No cells in this lib — return whole inner as header.
        return inner, ""
    return inner[:cell_idx], inner[cell_idx:]


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: merge_libs.py <out.lib> <in1.lib> [<in2.lib> ...]", file=sys.stderr)
        return 2
    out_path = Path(argv[1])
    in_paths = [Path(p) for p in argv[2:]]

    header_attrs: str | None = None
    cells_blocks: list[str] = []
    for in_path in in_paths:
        text = in_path.read_text(encoding="utf-8")
        header, cells = split_lib(text)
        if header_attrs is None:
            header_attrs = header
        cells_blocks.append(cells)

    if header_attrs is None:
        print("FAIL: no input libs parsed", file=sys.stderr)
        return 1

    merged_name = "asap7sc7p5t_27_RVT_TT_merged_201020"
    parts = [f"library ({merged_name}) {{", header_attrs.rstrip(), ""]
    parts.extend(cells_blocks)
    parts.append("}")
    out_path.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print(f"merged {len(in_paths)} libs -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
