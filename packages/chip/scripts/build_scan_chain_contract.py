#!/usr/bin/env python3
"""Emit the scan-chain contract CSV that pd/dft/fault_atpg.config.yaml expects.

`pd/dft/fault_atpg.config.yaml` declares ``scan_chain_definition:
build/dft/e1_chip_top.scan.csv`` as a required input for Fault. That CSV
enumerates the scan flops in shift order. The chain order itself is produced
by Fault's stitching pass, which is BLOCKED (Fault is not vendored under
external/). Until then this builder derives the *candidate* scan-flop set by
parsing the scan-inserted Yosys netlist (``build/dft/<top>.scan.v`` or a
``*.scan_ready.v`` leaf netlist), recording each scan-capable flop instance.

The emitted CSV is explicitly marked as a pre-stitch candidate set, not a
stitched chain. If the netlist is missing, contains no scan-capable flops, or
Yosys never ran, the builder fails closed: it does not invent a chain.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Scan-capable flop cell-name fragments per open standard-cell library. A cell
# is a scan flop if its instance type matches one of these patterns; the scan
# data input is the library's scan-in pin.
SCAN_CELL_PATTERNS: dict[str, re.Pattern[str]] = {
    "sky130_fd_sc_hd": re.compile(r"sky130_fd_sc_hd__sdf[a-z0-9_]*"),
    "gf180mcu": re.compile(r"gf180mcu_fd_sc_[a-z0-9]+__sdff[a-z0-9_]*"),
}

# Yosys structural-netlist instance: `<cell_type> <inst_name> (`
INSTANCE_RE = re.compile(r"^\s*([A-Za-z][\w$]*)\s+(\\?[\w$.\[\]:]+)\s*\(")


def classify(cell_type: str) -> str | None:
    for library, pattern in SCAN_CELL_PATTERNS.items():
        if pattern.fullmatch(cell_type):
            return library
    return None


def find_scan_flops(netlist_text: str) -> list[tuple[str, str, str]]:
    flops: list[tuple[str, str, str]] = []
    for line in netlist_text.splitlines():
        match = INSTANCE_RE.match(line)
        if not match:
            continue
        cell_type, inst_name = match.group(1), match.group(2).lstrip("\\")
        library = classify(cell_type)
        if library is not None:
            flops.append((inst_name, cell_type, library))
    return flops


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", default="e1_chip_top")
    parser.add_argument(
        "--netlist",
        type=Path,
        default=None,
        help="scan-inserted Yosys netlist (default build/dft/<top>.scan.v)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output CSV (default build/dft/<top>.scan.csv)",
    )
    return parser.parse_args()


def block(message: str) -> int:
    print(f"BLOCK: {message}", file=sys.stderr)
    return 2


def main() -> int:
    args = parse_args()
    netlist = args.netlist or (ROOT / "build/dft" / f"{args.top}.scan.v")
    out = args.out or (ROOT / "build/dft" / f"{args.top}.scan.csv")

    if not netlist.is_file():
        return block(
            f"scan-inserted netlist missing: {netlist}. "
            f"Run `make dft-scan-insert` (needs Yosys + sky130 Liberty) first."
        )

    flops = find_scan_flops(netlist.read_text(encoding="utf-8"))
    if not flops:
        return block(
            f"no scan-capable flops found in {netlist}. The netlist is either "
            f"combinational or scan-flop retargeting did not run; the scan-chain "
            f"contract fails closed (no chain is invented)."
        )

    out.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# schema: eliza.dft_scan_chain_contract.v1",
        "# status: pre_stitch_candidate_set_not_stitched_chain",
        "# claim_boundary: candidate_scan_flop_inventory_only_no_shift_order_claim",
        f"# source_netlist: {netlist.relative_to(ROOT) if netlist.is_relative_to(ROOT) else netlist}",
        f"# top: {args.top}",
        "# Shift order is produced by Fault stitching (BLOCKED: Fault not vendored).",
        "chain_index,scan_flop_instance,cell_type,std_cell_library",
    ]
    for index, (inst, cell_type, library) in enumerate(flops):
        lines.append(f"{index},{inst},{cell_type},{library}")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(
        f"STATUS: PASS scan_chain_contract {out.relative_to(ROOT)} "
        f"({len(flops)} candidate scan flops, pre-stitch)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
