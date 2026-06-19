#!/usr/bin/env python3
"""Run a yosys ABC mapping of a single leaf RTL module against the ASAP7
7.5T 27 nm-pitch RVT TT corner stdcell library and emit a predictive
FinFET-shape JSON.

This is the automation behind `make -C pd/asap7 leaf-shape MODULE=<module>`.
It is a synth-only flow (no PnR). The output is tagged
    evidence_class: predictive_finfet_shape_only_not_signoff
and must never be cited as TSMC N2P / A14 / Intel 14A / Samsung SF2P signoff.

Inputs:
  --module <name>      Verilog top to synthesize
  --rtl <path>         RTL file (repeatable)
  --lib <path>         Liberty file (repeatable; merged into a single ABC lib)
  --build-dir <path>   Working directory for logs and netlists
  --output <path>      JSON shape report destination
  --clock-ps <int>     Optional clock period target for ABC delay model
  --pdk-source <text>  Free-text PDK provenance string

Output JSON schema (lifted to keep `scripts/run_asap7_block.sh` consumers
happy):
  {
    "schema": "eliza.pd_asap7_leaf_shape.v1",
    "block_id": <module>,
    "evidence_class": "predictive_finfet_shape_only_not_signoff",
    "pdk": "ASAP7",
    "corner": "RVT_TT_0p70V_25C",
    "stdcell_library": "asap7sc7p5t_27",
    "synth_tool": {"name": "yosys", "version": ...},
    "abc_target_period_ps": <int|null>,
    "gate_count_total": <int>,
    "sequential_cells": <int>,
    "combinational_cells": <int>,
    "estimated_std_cell_area_um2": <float>,
    "std_cell_area_mm2": <float>,
    "abc_critical_path_delay_ps": <float|null>,
    "max_freq_mhz": <float|null>,
    "dyn_power_mw_per_mhz": null,
    "leakage_mw": null,
    "cell_histogram": {...},
    "forbidden_uses": [...],
  }

`dyn_power_mw_per_mhz` and `leakage_mw` are left null on a synth-only run
because activity-driven power requires a real switching trace plus a routed
netlist. The downstream `scripts/project_ppa_to_n2p.py` already null-checks
these fields and skips Monte Carlo bands when the source is missing.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

OUTPUT_EVIDENCE_CLASS = "predictive_finfet_shape_only_not_signoff"
PDK_ID = "ASAP7"
CORNER_ID = "RVT_TT_0p70V_25C"
STDCELL_LIBRARY_ID = "asap7sc7p5t_27"

# ABC reports area in lib units (square microns for ASAP7). The library header
# sets area_unit and converts to physical units, so the chip area is direct.
LIB_AREA_UNIT_UM2 = 1.0

YOSYS_BIN = ROOT / "external/oss-cad-suite/bin/yosys"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--module", required=True)
    p.add_argument(
        "--block-id",
        default=None,
        help="Block id stamped into the shape JSON (defaults to --module). "
        "Use this when the block id in pd/asap7/config.asap7.yaml differs "
        "from the SystemVerilog top-level module name.",
    )
    p.add_argument("--rtl", action="append", required=True, type=Path)
    p.add_argument("--lib", action="append", required=True, type=Path)
    p.add_argument("--build-dir", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--clock-ps", type=int, default=None)
    p.add_argument(
        "--pdk-source",
        default="external/pdks/asap7/asap7sc7p5t_27 (ASU/ARM predictive 7 nm FinFET, BSD-3)",
    )
    p.add_argument(
        "--unroll-limit",
        type=int,
        default=200000,
        help="Slang unroll-limit (needed for large parametric memories)",
    )
    p.add_argument(
        "--param",
        action="append",
        default=[],
        metavar="NAME=VALUE",
        help="Override a top-level parameter via slang's -G<NAME>=<VALUE>",
    )
    p.add_argument(
        "--memory-inference",
        action="store_true",
        help="Run the yosys `memory` pass to fold storage arrays into mems "
        "before proc lowering (much faster on large parametric tables)",
    )
    return p.parse_args()


def yosys_version(yosys_bin: Path) -> str:
    out = subprocess.run([str(yosys_bin), "-V"], capture_output=True, text=True, check=True)
    return out.stdout.strip().splitlines()[0]


def merged_lib_path(build_dir: Path) -> Path:
    return build_dir / "lib" / f"{STDCELL_LIBRARY_ID}_RVT_TT_merged.lib"


def merge_libs(libs: list[Path], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    merger = ROOT / "pd/asap7/merge_libs.py"
    subprocess.run(
        [sys.executable, str(merger), str(out_path), *[str(p) for p in libs]],
        check=True,
        cwd=ROOT,
    )


# ABC's modern `&nf` mapper segfaults on the ASAP7 merged SCL. We instruct
# yosys to use the simpler `abc -fast` path (strash; dretime; map {D}). This
# matches what OpenROAD-flow-scripts uses for the asap7 platform when run
# without an explicit ABC script override.
#
# DONT_USE_CELLS is the same exclusion set ORFS publishes in
#   flow/platforms/asap7/config.mk
# It removes the smallest drive variants ("x1p", "xp"), all scan flops (SDF*),
# and integrated clock-gates (ICG*).
ABC_DONT_USE_CELLS = (
    "*x1p*_ASAP7*",
    "*xp*_ASAP7*",
    "SDF*",
    "ICG*",
)

# Identify the SEQ liberty file (DFF, LATCH cells) so dfflibmap can target it
# directly. ABC's combinational mapper operates on the other groups.
SEQ_LIB_TAG = "_SEQ_"


def _split_seq_and_comb_libs(libs: list[Path]) -> tuple[Path, list[Path]]:
    seq = next((p for p in libs if SEQ_LIB_TAG in p.name), None)
    if seq is None:
        raise RuntimeError(
            f"no SEQ liberty file in {libs!r}; expected one with `{SEQ_LIB_TAG}` "
            "in its name (e.g. asap7sc7p5t_SEQ_RVT_TT_nldm_*.lib)"
        )
    comb = [p for p in libs if p is not seq]
    return seq, comb


def write_yosys_script(
    *,
    module: str,
    rtl_files: list[Path],
    libs: list[Path],
    merged_lib: Path,
    netlist_path: Path,
    json_stat_path: Path,
    stat_log_path: Path,
    script_path: Path,
    abc_clock_ps: int | None,
    unroll_limit: int,
    params: list[str],
    memory_inference: bool,
) -> None:
    seq_lib, comb_libs = _split_seq_and_comb_libs(libs)
    abc_clock_arg = f" -D {abc_clock_ps}" if abc_clock_ps else ""
    dont_use_args = " ".join(f'-dont_use "{p}"' for p in ABC_DONT_USE_CELLS)
    # ABC consumes one liberty for combinational mapping. The SIMPLE library
    # (basic and/or/nand/nor) is the densest and the one ORFS itself uses for
    # initial mapping. Other comb libs (AO, OA, INVBUF) are referenced via a
    # merged liberty in the post-mapping `stat -liberty` so the area report
    # covers every cell type ABC actually instantiated. Yosys' `stat` accepts
    # only one `-liberty`, so we feed it the merged file emitted by
    # `pd/asap7/merge_libs.py`.
    abc_lib = next((p for p in comb_libs if "_SIMPLE_" in p.name), comb_libs[0])

    lines: list[str] = [
        f"# Auto-generated by scripts/run_asap7_leaf_synth.py for module {module}",
        "plugin -i slang",
    ]
    read_args = " ".join(str(p) for p in rtl_files)
    param_args = " ".join(f"-G{p}" for p in params) if params else ""
    if param_args:
        param_args = " " + param_args
    lines.append(f"read_slang --top {module} --unroll-limit {unroll_limit}{param_args} {read_args}")
    passes = [
        f"hierarchy -check -top {module}",
        "proc",
    ]
    if memory_inference:
        passes.extend(["memory", "opt -fast"])
    passes.extend(
        [
            "flatten",
            "opt -fast",
            "fsm",
            "opt",
            "wreduce",
            "peepopt",
            "opt_clean",
            "techmap",
            "opt -fast",
            f"dfflibmap -liberty {seq_lib}",
            # `-fast` selects ABC's simple combinational mapper. The default
            # ABC script segfaults on the ASAP7 merged SCL inside the `&nf`
            # mapper, so we use `-fast` instead. ABC `-fast` does not emit a
            # `Delay = ...` line, so `abc_critical_path_delay_ps` is left
            # null in the shape JSON; the downstream projection already null-
            # checks this field.
            f"abc -liberty {abc_lib} -fast {dont_use_args}{abc_clock_arg}",
            "opt_clean",
            f"tee -o {stat_log_path} stat -liberty {merged_lib}",
            f"tee -o {json_stat_path} stat -liberty {merged_lib} -json",
            f"write_verilog {netlist_path}",
        ]
    )
    lines.extend(passes)
    script_path.parent.mkdir(parents=True, exist_ok=True)
    script_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_yosys(yosys_bin: Path, script_path: Path, log_path: Path) -> float:
    started = time.monotonic()
    completed = subprocess.run(
        [str(yosys_bin), "-q", "-l", str(log_path), str(script_path)],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    elapsed = time.monotonic() - started
    if completed.returncode != 0:
        tail = log_path.read_text(encoding="utf-8").splitlines()[-30:] if log_path.exists() else []
        print(
            f"FAIL: yosys exited {completed.returncode}; stderr tail:\n"
            + "\n".join(completed.stderr.splitlines()[-30:])
            + "\nlog tail:\n"
            + "\n".join(tail),
            file=sys.stderr,
        )
        sys.exit(completed.returncode)
    return elapsed


# Yosys `stat -json` emits the cell histogram and aggregated area. The schema:
# {
#   "modules": {
#     "tage_table": {
#       "num_cells": N,
#       "num_cells_by_type": { "DFFx1": ..., "INVx1": ..., ... },
#       "area": <float>
#     }
#   }
# }
def parse_stat_json(json_stat_path: Path, module: str) -> dict[str, object]:
    raw = json.loads(json_stat_path.read_text(encoding="utf-8"))
    mods = raw.get("modules") or {}
    mod = mods.get(module)
    if mod is None:
        # yosys sometimes prefixes the module name with the backslash escape.
        for name, body in mods.items():
            if name.lstrip("\\") == module:
                mod = body
                break
    if mod is None:
        raise RuntimeError(f"stat-json missing module {module!r}; got {list(mods)!r}")
    return mod


# Lib stat log also prints the chip area summary. Yosys writes a `Chip area
# for module '<m>': <area>` line we can pull as a cross-check on the JSON.
CHIP_AREA_RE = re.compile(r"Chip area for module '\\?[^']+':\s+([0-9.eE+-]+)")
SEQ_CELLS_PREFIXES = ("DFF", "SDFF", "LATCH", "DHL", "ASYNC_DFF")


def parse_stat_log(stat_log_path: Path) -> dict[str, object]:
    text = stat_log_path.read_text(encoding="utf-8")
    match = CHIP_AREA_RE.search(text)
    chip_area = float(match.group(1)) if match else None
    return {"chip_area_um2_from_log": chip_area}


def classify_cells(histogram: dict[str, int]) -> dict[str, int]:
    seq = 0
    comb = 0
    for cell, count in histogram.items():
        if any(cell.startswith(prefix) for prefix in SEQ_CELLS_PREFIXES):
            seq += count
        else:
            comb += count
    return {"sequential_cells": seq, "combinational_cells": comb}


def main() -> int:
    args = parse_args()
    build_dir = args.build_dir.resolve()
    build_dir.mkdir(parents=True, exist_ok=True)

    if not YOSYS_BIN.is_file():
        print(f"BLOCKED: yosys not found at {YOSYS_BIN}", file=sys.stderr)
        return 1

    # Filter out any merged-library file the caller passed by mistake: the
    # merged file is recomputed below for the post-mapping `stat` pass.
    lib_paths = [p.resolve() for p in args.lib if "_merged.lib" not in p.name]
    for p in lib_paths:
        if not p.is_file():
            print(f"BLOCKED: liberty file missing: {p}", file=sys.stderr)
            return 1
    rtl_paths = [p.resolve() for p in args.rtl]
    for p in rtl_paths:
        if not p.is_file():
            print(f"BLOCKED: rtl file missing: {p}", file=sys.stderr)
            return 1

    merged_lib = merged_lib_path(build_dir)
    merge_libs(lib_paths, merged_lib)

    netlist_path = build_dir / f"{args.module}.mapped.v"
    json_stat_path = build_dir / f"{args.module}.stat.json"
    stat_log_path = build_dir / f"{args.module}.stat.log"
    script_path = build_dir / f"{args.module}.synth.ys"
    yosys_log = build_dir / f"{args.module}.yosys.log"

    write_yosys_script(
        module=args.module,
        rtl_files=rtl_paths,
        libs=lib_paths,
        merged_lib=merged_lib,
        netlist_path=netlist_path,
        json_stat_path=json_stat_path,
        stat_log_path=stat_log_path,
        script_path=script_path,
        abc_clock_ps=args.clock_ps,
        unroll_limit=args.unroll_limit,
        params=args.param,
        memory_inference=args.memory_inference,
    )
    elapsed_s = run_yosys(YOSYS_BIN, script_path, yosys_log)

    mod_stats = parse_stat_json(json_stat_path, args.module)
    histogram = mod_stats.get("num_cells_by_type") or {}
    total_cells = mod_stats.get("num_cells")
    area_um2 = mod_stats.get("area")
    if not isinstance(area_um2, int | float):
        # Some yosys builds report area inside num_cells_by_type; fall back to
        # the log scrape.
        area_um2 = parse_stat_log(stat_log_path).get("chip_area_um2_from_log")

    if not isinstance(area_um2, int | float) or area_um2 <= 0:
        print(
            "BLOCKED: yosys stat did not yield a positive Chip area; cannot tag predictive shape",
            file=sys.stderr,
        )
        return 1
    if not isinstance(total_cells, int) or total_cells <= 0:
        print("BLOCKED: yosys stat did not yield a positive cell count", file=sys.stderr)
        return 1

    if not isinstance(histogram, dict):
        print("BLOCKED: yosys stat did not yield a cell histogram", file=sys.stderr)
        return 1
    cell_histogram = {str(k): int(v) for k, v in histogram.items()}

    seq_comb = classify_cells(cell_histogram)

    yosys_log_text = yosys_log.read_text(encoding="utf-8")
    abc_delay_ps: float | None = None
    # ABC `stime` emits one or more `Delay = <ps>` lines in the yosys log.
    # When `stime -c` is used we get a summary line of the form
    #   `... Area = NNN  Delay = MMM` (delay in ps).
    # When the default `-fast` script runs, no `stime` is invoked, so we also
    # accept the pre-map heuristic line `Path 0: Delay = NN.NN ps`.
    delay_patterns = (
        r"Delay\s*=\s*([0-9.]+)\s+ps",
        r"Path\s+\d+:\s+Delay\s+=\s+([0-9.]+)\s+ps",
        r"Arrival\s*=\s*([0-9.]+)\s+ps",
    )
    for pattern in delay_patterns:
        m = re.search(pattern, yosys_log_text)
        if m:
            abc_delay_ps = float(m.group(1))
            break
    max_freq_mhz: float | None = None
    if abc_delay_ps and abc_delay_ps > 0:
        max_freq_mhz = 1.0e6 / abc_delay_ps  # ps -> MHz

    area_mm2 = float(area_um2) / 1.0e6

    report = {
        "schema": "eliza.pd_asap7_leaf_shape.v1",
        "block_id": args.block_id or args.module,
        "rtl_top": args.module,
        "evidence_class": OUTPUT_EVIDENCE_CLASS,
        "pdk": PDK_ID,
        "corner": CORNER_ID,
        "stdcell_library": STDCELL_LIBRARY_ID,
        "stdcell_library_source": args.pdk_source,
        "synth_tool": {
            "name": "yosys",
            "version": yosys_version(YOSYS_BIN),
            "frontend": "slang (yosys-slang plugin)",
            "mapper": "abc",
            "memory_inference": bool(args.memory_inference),
            "param_overrides": list(args.param),
            "wall_clock_s": round(elapsed_s, 2),
        },
        "abc_target_period_ps": args.clock_ps,
        "gate_count_total": int(total_cells),
        "sequential_cells": seq_comb["sequential_cells"],
        "combinational_cells": seq_comb["combinational_cells"],
        "estimated_std_cell_area_um2": float(area_um2),
        "std_cell_area_mm2": area_mm2,
        "abc_critical_path_delay_ps": abc_delay_ps,
        "max_freq_mhz": max_freq_mhz,
        "dyn_power_mw_per_mhz": None,
        "leakage_mw": None,
        "cell_histogram": dict(sorted(cell_histogram.items())),
        "claim_boundary": (
            "Synth-only ABC mapping against ASAP7 7.5T 27 nm-pitch RVT TT "
            "stdcell library. No PnR, no SRAM macro replacement, no power "
            "estimation. Use only as predictive FinFET-class shape input "
            "into scripts/project_ppa_to_n2p.py."
        ),
        "forbidden_uses": [
            "cite_as_tsmc_n2p_signoff",
            "cite_as_tsmc_a14_signoff",
            "cite_as_intel_14a_signoff",
            "cite_as_samsung_sf2p_signoff",
            "cite_as_measured_silicon_evidence",
            "cite_as_post_route_pnr_evidence",
            "cite_as_sram_macro_density",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        f"OK leaf shape: {args.output}  "
        f"cells={total_cells} area_um2={area_um2:.1f} "
        f"area_mm2={area_mm2:.6f} max_freq_mhz={max_freq_mhz}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
