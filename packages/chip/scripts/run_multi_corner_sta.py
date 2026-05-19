#!/usr/bin/env python3
"""Multi-corner STA wrapper for the Sky130 release flow.

Drives OpenSTA across Sky130 SS/TT/FF process corners times 2 RC corners
(min and max). Produces 6 per-corner timing reports plus a JSON summary that
captures setup/hold WNS, TNS, and worst-path digest per corner. Even at
130 nm this is the methodology that scales to POCV/SOCV with LVF at the
2028 advanced-node target (100-200 corners typical at N3/N2 today; we plan
to prune to 32-64 via ML corner selection).

This is fail-closed: if any required Liberty/SPEF/SDC/netlist is missing we
exit non-zero with a structured error block. We do NOT silently substitute
the TT/typical liberty for SS or FF.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_CORNERS = [
    {"name": "SS_min", "process": "ss", "rc": "min"},
    {"name": "SS_max", "process": "ss", "rc": "max"},
    {"name": "TT_min", "process": "tt", "rc": "min"},
    {"name": "TT_max", "process": "tt", "rc": "max"},
    {"name": "FF_min", "process": "ff", "rc": "min"},
    {"name": "FF_max", "process": "ff", "rc": "max"},
]


@dataclass
class CornerInputs:
    name: str
    liberty: Path
    spef: Path
    sdc: Path
    netlist: Path


def fail(message: str, **context: Any) -> int:
    payload = {"error": message, **context}
    print(f"FAIL: {message}", file=sys.stderr)
    json.dump(payload, sys.stderr, indent=2, sort_keys=True)
    sys.stderr.write("\n")
    return 1


def resolve(value: str) -> Path:
    p = Path(value)
    if not p.is_absolute():
        p = (ROOT / value).resolve()
    return p


def discover_inputs(run_dir: Path, corner: dict[str, str], pdk_root: Path) -> CornerInputs | str:
    """Return CornerInputs if all required files exist, otherwise an error string."""
    final = run_dir / "final"
    netlist_dirs = [final / "nl", final / "pnl"]
    netlist: Path | None = None
    for cand in netlist_dirs:
        if cand.is_dir():
            for v in cand.glob("*.v"):
                netlist = v
                break
        if netlist is not None:
            break
    if netlist is None:
        netlist = next(final.glob("**/*.v"), None)
    if netlist is None:
        return f"corner={corner['name']}: gate netlist missing under {final}"
    spef_glob = (
        list((final / "spef").glob(f"*{corner['rc']}*.spef")) if (final / "spef").is_dir() else []
    )
    if not spef_glob:
        spef_glob = list(final.glob(f"**/*{corner['rc']}*.spef"))
    if not spef_glob:
        return f"corner={corner['name']}: no SPEF matching '{corner['rc']}' under {final}"
    sdc = next(final.glob("**/*.sdc"), None)
    if sdc is None:
        sdc = (ROOT / "pd/constraints/e1_soc.sdc").resolve()
        if not sdc.is_file():
            return f"corner={corner['name']}: signoff SDC missing"
    lib_glob = list(
        pdk_root.glob(
            f"sky130A/libs.ref/sky130_fd_sc_hd/lib/sky130_fd_sc_hd__{corner['process']}*_*.lib"
        )
    )
    if not lib_glob:
        return (
            f"corner={corner['name']}: liberty for {corner['process']} not found under "
            f"{pdk_root}/sky130A/libs.ref/sky130_fd_sc_hd/lib/. PDK_ROOT may be wrong."
        )
    return CornerInputs(
        name=corner["name"],
        liberty=lib_glob[0],
        spef=spef_glob[0],
        sdc=sdc,
        netlist=netlist,
    )


def render_opensta_script(inp: CornerInputs, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    script = out_dir / f"{inp.name}.tcl"
    rpt = out_dir / f"{inp.name}.rpt"
    script.write_text(
        "\n".join(
            [
                f"read_liberty {inp.liberty}",
                f"read_verilog {inp.netlist}",
                "link_design e1_chip_top",
                f"read_sdc {inp.sdc}",
                f"read_spef {inp.spef}",
                "set_propagated_clock [all_clocks]",
                "report_checks -path_delay max -group_count 10 -slack_max 0",
                "report_checks -path_delay min -group_count 10 -slack_max 0",
                "report_tns",
                "report_wns",
                "report_worst_slack -max",
                "report_worst_slack -min",
                "report_check_types -max_slew -max_capacitance -max_fanout -violators",
                f"set fp [open {rpt} w]",
                'puts $fp "setup_wns [sta::worst_slack -max]"',
                'puts $fp "hold_wns [sta::worst_slack -min]"',
                'puts $fp "setup_tns [sta::total_negative_slack -max]"',
                'puts $fp "hold_tns [sta::total_negative_slack -min]"',
                "close $fp",
                "exit 0",
            ]
        )
        + "\n"
    )
    return script


SLACK_RE = re.compile(r"^(?P<key>\w+)\s+(?P<value>-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$")


def parse_corner_report(rpt: Path) -> dict[str, float]:
    metrics: dict[str, float] = {}
    if not rpt.is_file():
        return metrics
    for line in rpt.read_text().splitlines():
        m = SLACK_RE.match(line.strip())
        if m:
            metrics[m.group("key")] = float(m.group("value"))
    return metrics


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--corners-json")
    parser.add_argument("--pdk-root", default=os.environ.get("PDK_ROOT", ""))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_dir = resolve(args.run_dir)
    out_dir = resolve(args.out_dir)
    if not run_dir.is_dir():
        return fail("run dir missing", run_dir=str(run_dir))
    if not args.pdk_root:
        return fail("PDK_ROOT not set; pass --pdk-root or export PDK_ROOT")
    pdk_root = Path(args.pdk_root).resolve()
    corners = (
        json.loads(Path(args.corners_json).read_text()) if args.corners_json else DEFAULT_CORNERS
    )
    if not isinstance(corners, list) or len(corners) < 6:
        return fail(
            "corners list must hold at least 6 entries (SS/TT/FF x min/max minimum)",
            corners=corners,
        )

    out_dir.mkdir(parents=True, exist_ok=True)
    summary: dict[str, Any] = {
        "schema": "eliza.pd_multi_corner_sta.v1",
        "run_dir": str(run_dir),
        "pdk_root": str(pdk_root),
        "corners": [],
    }
    errors: list[str] = []
    if args.dry_run:
        for corner in corners:
            summary["corners"].append({"corner": corner, "dry_run": True})
        out_path = out_dir / "multi_corner_sta.json"
        out_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
        print(f"PASS: dry-run STA plan written: {out_path}")
        return 0

    sta_bin = shutil.which("sta") or shutil.which("openroad")
    if sta_bin is None:
        return fail("neither sta nor openroad on PATH; cannot run STA")

    for corner in corners:
        inp = discover_inputs(run_dir, corner, pdk_root)
        if isinstance(inp, str):
            errors.append(inp)
            summary["corners"].append({"corner": corner, "error": inp})
            continue
        script = render_opensta_script(inp, out_dir)
        if Path(sta_bin).name == "sta":
            cmd = [sta_bin, "-no_init", "-exit", str(script)]
        else:
            cmd = [sta_bin, "-exit", str(script)]
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, check=False)
        (out_dir / f"{inp.name}.stdout.log").write_text(proc.stdout)
        (out_dir / f"{inp.name}.stderr.log").write_text(proc.stderr)
        metrics = parse_corner_report(out_dir / f"{inp.name}.rpt")
        summary["corners"].append(
            {
                "corner": corner,
                "inputs": {
                    "liberty": str(inp.liberty),
                    "spef": str(inp.spef),
                    "sdc": str(inp.sdc),
                    "netlist": str(inp.netlist),
                },
                "metrics": metrics,
                "returncode": proc.returncode,
            }
        )

    out_path = out_dir / "multi_corner_sta.json"
    out_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n")
    if errors:
        print(f"FAIL: {len(errors)} corners could not run; see {out_path}", file=sys.stderr)
        return 1
    print(f"PASS: multi-corner STA written: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
