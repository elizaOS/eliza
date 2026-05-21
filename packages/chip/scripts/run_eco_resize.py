#!/usr/bin/env python3
"""Emit and (optionally) run an OpenROAD resizer-ECO on a routed design.

Generates a self-contained OpenROAD TCL that loads a post-route DEF + Liberty,
runs incremental timing repair (repair_design / repair_timing resizer ECO), and
writes an incremental ECO DEF plus a write_verilog patch netlist. The ECO is an
*incremental* edit (gate sizing / buffer insertion) that must be proven
logically equivalent to the pre-ECO netlist before it may be consumed
(scripts/check_eco_equivalence.py).

Fail-closed: missing DEF / Liberty / OpenROAD -> non-zero (or BLOCKED exit 2 for
a missing tool) naming the exact reproduction command. The emitted patch is
never trusted until check_eco_equivalence.py passes.

Usage:
  scripts/run_eco_resize.py --def-in <routed.def> --liberty <lib> \
      --netlist-in <pre_eco.v> --node-id sky130 [--run] [--out-dir <dir>]

With --run, OpenROAD executes the TCL; without it, only the TCL is emitted for
review (the default, so a tool-less host still produces a reviewable artifact).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

SCHEMA = "eliza.eco_resize.v1"


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def resolve(rel: str) -> Path:
    path = Path(rel)
    return path if path.is_absolute() else (ROOT / rel).resolve()


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT)) if path.is_relative_to(ROOT) else str(path)


def emit_tcl(
    *,
    def_in: Path,
    liberty: Path,
    netlist_in: Path,
    def_out: Path,
    netlist_out: Path,
    report_out: Path,
    tcl_out: Path,
) -> Path:
    tcl = f"""# Auto-generated resizer-ECO by scripts/run_eco_resize.py
# Incremental gate-sizing / buffering ECO on a routed Sky130 design.
# Equivalence MUST be proven (scripts/check_eco_equivalence.py) before use.
read_liberty {liberty}
read_def {def_in}
link_design e1_chip_top

# Incremental timing repair: resizer ECO (cell resize + buffer insertion only;
# no logic restructuring, preserving the boolean function for equivalence).
estimate_parasitics -placement
repair_design
repair_timing -setup -hold

# Emit the incremental ECO DEF and the patched gate-level netlist.
write_def {def_out}
write_verilog {netlist_out}

report_checks -path_delay max -fields {{slew cap input_pins}} > {report_out}
report_design_area >> {report_out}
exit
"""
    tcl_out.parent.mkdir(parents=True, exist_ok=True)
    tcl_out.write_text(tcl)
    return tcl_out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--def-in", required=True)
    parser.add_argument("--liberty", required=True)
    parser.add_argument("--netlist-in", required=True)
    parser.add_argument("--node-id", default="sky130")
    parser.add_argument("--out-dir", default=None)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()

    def_in = resolve(args.def_in)
    liberty = resolve(args.liberty)
    netlist_in = resolve(args.netlist_in)

    out_dir = (
        resolve(args.out_dir)
        if args.out_dir
        else ROOT / "build" / "qor" / "eco" / args.node_id
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    def_out = out_dir / "eco.def"
    netlist_out = out_dir / "eco_patch.v"
    report_out = out_dir / "eco_timing.rpt"
    tcl_out = out_dir / "eco_resize.tcl"
    manifest_out = out_dir / "eco_manifest.json"

    emit_tcl(
        def_in=def_in,
        liberty=liberty,
        netlist_in=netlist_in,
        def_out=def_out,
        netlist_out=netlist_out,
        report_out=report_out,
        tcl_out=tcl_out,
    )

    missing = [
        str(p.relative_to(ROOT)) if p.is_relative_to(ROOT) else str(p)
        for p in (def_in, liberty, netlist_in)
        if not p.is_file()
    ]

    manifest = {
        "schema": SCHEMA,
        "node_id": args.node_id,
        "def_in": str(def_in),
        "liberty": str(liberty),
        "netlist_in": str(netlist_in),
        "def_out": str(def_out),
        "netlist_patch": str(netlist_out),
        "tcl": rel(tcl_out),
        "release_use_allowed": False,
        "claim_boundary": "incremental_resizer_eco_requires_equivalence_proof",
        "equivalence_gate": "scripts/check_eco_equivalence.py",
        "ran_openroad": False,
        "missing_inputs": missing,
    }

    if not args.run:
        manifest_out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        print(
            f"PASS: ECO resizer TCL emitted {rel(tcl_out)} "
            f"(review-only; pass --run to execute OpenROAD)"
        )
        return 0

    if missing:
        return fail("ECO inputs missing; cannot run OpenROAD", missing=missing)

    openroad = shutil.which("openroad")
    if openroad is None:
        manifest_out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        repro = f". tools/env.sh && openroad -no_init -exit {rel(tcl_out)}"
        print(
            "STATUS: BLOCKED eco-resize - openroad missing. "
            f"TCL emitted at {rel(tcl_out)}. Reproduce: {repro}",
            file=sys.stderr,
        )
        return 2

    completed = subprocess.run(
        [openroad, "-no_init", "-exit", str(tcl_out)],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    (out_dir / "openroad.log").write_text(completed.stdout + "\n" + completed.stderr)
    if completed.returncode != 0:
        return fail(
            "openroad ECO run failed",
            returncode=completed.returncode,
            log=rel(out_dir / "openroad.log"),
        )
    if not def_out.is_file() or not netlist_out.is_file():
        return fail(
            "openroad completed but ECO outputs missing",
            def_out=str(def_out),
            netlist_out=str(netlist_out),
        )
    manifest["ran_openroad"] = True
    manifest_out.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(
        f"PASS: ECO resizer run complete -> {rel(def_out)}, "
        f"{rel(netlist_out)} (equivalence still required)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
