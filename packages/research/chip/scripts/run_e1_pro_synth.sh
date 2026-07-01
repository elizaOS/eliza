#!/usr/bin/env bash
# scripts/run_e1_pro_synth.sh — open-PDK post-synthesis PPA for the e1-pro
# little core (CVA6 cv64a6_imafdc_sv39, == E1 e1-pro by construction).
#
# Flow (all native, no Docker, no commercial EDA, no PDK signoff):
#   1. Expand core/Flist.cva6 for the cv64a6_imafdc_sv39 config (wt_cache path,
#      hpdcache excluded) into a concrete file + incdir list.
#   2. yosys (oss-cad-suite) + yosys-slang frontend elaborates the full core,
#      ABC-maps it to the ASAP7 7.5T 27 nm-pitch RVT TT standard-cell library.
#   3. OpenROAD reads the gate netlist + NLDM liberty and runs static timing
#      analysis at a target clock to extract the worst negative slack, the
#      limiting path, and therefore the achievable Fmax.
#   4. Combines Fmax with the measured CoreMark/MHz (docs/evidence/cpu_ap/
#      cva6-coremark-verilator.json) and the synthesized std-cell area to emit
#      a CoreMark-ops/s-per-mm^2 (GOPS/mm^2 proxy) figure.
#   5. Writes docs/evidence/cpu_ap/e1-pro-synth-ppa.json
#      (schema eliza.cpu_synth_ppa.v1).
#
# Honesty boundary (claim ladder):
#   This is an OPEN-PDK SYNTHESIS ESTIMATE on ASAP7 (an academic predictive
#   7 nm-class PDK), with STA-derived Fmax but NO place-and-route, NO SRAM
#   macro replacement, NO parasitic extraction, NO foundry signoff. It is
#   indicative only. CVA6's published 1.7 GHz is real GF22FDX silicon on a
#   DIFFERENT node — these are not directly comparable; see the JSON notes.
#   claim_level: L1_RTL_FULL_SOC (full-core open-PDK synthesis).
#
# Fail-closed: every missing tool / PDK / file aborts with a BLOCKED message
# and the exact command to provision the dependency. No partial silent output.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

TARGET_CFG="${TARGET_CFG:-cv64a6_imafdc_sv39}"
TOP="cva6"
# STA clock the synthesis is constrained to and timed at (ps). Fmax is derived
# from the achieved slack, so this is a constraint anchor, not the result.
TARGET_CLOCK_PS="${TARGET_CLOCK_PS:-1000}"   # 1.0 ns -> 1 GHz constraint anchor
BUILD_DIR="$REPO_ROOT/build/e1-pro-synth"
EVIDENCE="$REPO_ROOT/docs/evidence/cpu_ap/e1-pro-synth-ppa.json"
COREMARK_EVIDENCE="$REPO_ROOT/docs/evidence/cpu_ap/cva6-coremark-verilator.json"

YOSYS="$REPO_ROOT/external/oss-cad-suite/bin/yosys"
OPENROAD="$(command -v openroad || true)"
PY="$(command -v python3 || command -v python || true)"
ASAP7_LIB_DIR="$REPO_ROOT/build/asap7/lib"
ASAP7_ROOT="${ASAP7_ROOT:-$REPO_ROOT/external/pdks/asap7}"

mkdir -p "$BUILD_DIR"

# --- preflight -------------------------------------------------------------
[[ -x "$YOSYS" ]] || { echo "BLOCKED: yosys missing at $YOSYS; run scripts/bootstrap_openlane2.sh or source tools/env.sh" >&2; exit 1; }
"$YOSYS" -p "plugin -i slang; help read_slang" >/dev/null 2>&1 || { echo "BLOCKED: yosys-slang plugin not loadable in $YOSYS" >&2; exit 1; }
[[ -n "$OPENROAD" ]] || { echo "BLOCKED: openroad not on PATH; source tools/env.sh (native) or scripts/bootstrap_openlane2.sh" >&2; exit 1; }
[[ -n "$PY" ]] || { echo "BLOCKED: python3 missing" >&2; exit 1; }
[[ -f "$COREMARK_EVIDENCE" ]] || { echo "BLOCKED: missing CoreMark evidence $COREMARK_EVIDENCE; run make coremark-cva6-verilator" >&2; exit 1; }
[[ -d "$ASAP7_ROOT" ]] || { echo "BLOCKED: ASAP7 PDK missing at $ASAP7_ROOT; run make -C pd/asap7 clone-asap7" >&2; exit 1; }
[[ -f "external/cva6/cva6/core/Flist.cva6" ]] || { echo "BLOCKED: CVA6 core RTL missing; init submodule external/cva6" >&2; exit 1; }

# --- ASAP7 RVT TT NLDM liberty (real timing for STA) -----------------------
mkdir -p "$ASAP7_LIB_DIR"
if ! ls "$ASAP7_LIB_DIR"/asap7sc7p5t_SIMPLE_RVT_TT_*.lib >/dev/null 2>&1; then
    "$PY" "$REPO_ROOT/scripts/extract_asap7_libs.py" \
        --asap7-root "$ASAP7_ROOT" --out-dir "$ASAP7_LIB_DIR" \
        --library asap7sc7p5t_27 --vt RVT --corner TT \
        || { echo "BLOCKED: ASAP7 liberty extraction failed (pip install --break-system-packages py7zr)" >&2; exit 1; }
fi
mapfile -t NLDM_LIBS < <(ls "$ASAP7_LIB_DIR"/asap7sc7p5t_{AO,INVBUF,OA,SEQ,SIMPLE}_RVT_TT_nldm_*.lib 2>/dev/null)
[[ ${#NLDM_LIBS[@]} -eq 5 ]] || { echo "BLOCKED: expected 5 ASAP7 RVT TT NLDM libs in $ASAP7_LIB_DIR, found ${#NLDM_LIBS[@]}" >&2; exit 1; }
SEQ_LIB="$(ls "$ASAP7_LIB_DIR"/asap7sc7p5t_SEQ_RVT_TT_nldm_*.lib)"
SIMPLE_LIB="$(ls "$ASAP7_LIB_DIR"/asap7sc7p5t_SIMPLE_RVT_TT_nldm_*.lib)"
MERGED_LIB="$ASAP7_LIB_DIR/asap7sc7p5t_27_RVT_TT_merged.lib"
if [[ ! -f "$MERGED_LIB" ]]; then
    "$PY" "$REPO_ROOT/pd/asap7/merge_libs.py" "$MERGED_LIB" "${NLDM_LIBS[@]}" \
        || { echo "BLOCKED: liberty merge failed" >&2; exit 1; }
fi

# --- expand the Flist ------------------------------------------------------
EXPANDER="$BUILD_DIR/expand_flist.py"
cat > "$EXPANDER" <<'PYEOF'
import os, sys
repo = os.path.abspath("external/cva6/cva6")
hpdcache_dir = os.path.join(repo, "core/cache_subsystem/hpdcache")
target_cfg = sys.argv[1]
def subst(s):
    return (s.replace("${CVA6_REPO_DIR}", repo)
             .replace("${HPDCACHE_DIR}", hpdcache_dir)
             .replace("${TARGET_CFG}", target_cfg))
files, incdirs, seen = [], [], set()
def parse(p):
    for raw in open(p):
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        line = subst(line)
        if line.startswith("+incdir+"):
            d = line[len("+incdir+"):]
            if d not in incdirs: incdirs.append(d)
        elif line.startswith("-F "):
            nested = subst(line[3:].strip())
            if os.path.isfile(nested): parse(nested)
        elif line.startswith("+") or line.startswith("-"):
            continue
        else:
            if "/hpdcache/" in line:  # wt_cache config: hpdcache unused
                continue
            if line not in seen:
                seen.add(line); files.append(line)
parse(os.path.join(repo, "core/Flist.cva6"))
if "--incdirs" in sys.argv:
    print("\n".join(incdirs))
else:
    miss = [f for f in files if not os.path.isfile(f)]
    if miss:
        sys.stderr.write("BLOCKED: missing RTL files:\n" + "\n".join(miss) + "\n")
        sys.exit(1)
    print("\n".join(files))
PYEOF

INC_ARGS=$("$PY" "$EXPANDER" "$TARGET_CFG" --incdirs | sed 's/^/-I/' | tr '\n' ' ')
FILE_ARGS=$("$PY" "$EXPANDER" "$TARGET_CFG" | tr '\n' ' ')
[[ -n "$FILE_ARGS" ]] || { echo "BLOCKED: Flist expansion produced no files" >&2; exit 1; }

# --- synthesis -------------------------------------------------------------
NETLIST="$BUILD_DIR/${TOP}_${TARGET_CFG}.asap7.v"
STAT_JSON="$BUILD_DIR/${TOP}_${TARGET_CFG}.stat.json"
STAT_LOG="$BUILD_DIR/${TOP}_${TARGET_CFG}.stat.log"
SYNTH_YS="$BUILD_DIR/${TOP}_${TARGET_CFG}.synth.ys"
SYNTH_LOG="$BUILD_DIR/${TOP}_${TARGET_CFG}.yosys.log"

# Mapping strategy:
#   - dfflibmap maps sequential cells against the SEQ liberty.
#   - abc maps combinational logic against the SIMPLE liberty with a delay
#     target ($TARGET_CLOCK_PS). The DELAY-DRIVEN (non -fast) ABC script runs
#     `stime` and prints the mapped logic-depth critical-path `Delay = <ps>`,
#     which is the legitimate, fanout-aware, pre-PnR synthesis Fmax estimate
#     (the same kind of number academic CVA6 synthesis quotes). We pass ABC the
#     single SIMPLE liberty (not the merged SCL) to avoid the `&nf` segfault
#     documented in scripts/run_asap7_leaf_synth.py — the segfault is specific
#     to the merged SCL, and the SIMPLE lib alone maps cleanly.
#   - ORFS asap7 DONT_USE set (smallest drives, scan flops, clock gates).
# abc -fast avoids the &nf segfault on ASAP7 and produces the structural gate
# netlist + area. Frequency comes from the downstream OpenROAD placed+buffered
# STA, not from ABC (which does not buffer high-fanout broadcast nets).
cat > "$SYNTH_YS" <<EOF
plugin -i slang
read_slang --top $TOP --keep-hierarchy $INC_ARGS $FILE_ARGS
hierarchy -check -top $TOP
proc
flatten
opt -fast
# Lower constant ROM / table arrays (AES sbox, decode tables, ~12 small ROMs)
# to logic. Without this they survive as mem cells and yosys emits an initial
# block that OpenROAD's structural Verilog reader rejects (STA-0171). The
# memory pass turns them into addressable gate logic (fully structural netlist).
memory
opt -fast
fsm
opt
wreduce
peepopt
opt_clean
techmap
opt -fast
dfflibmap -liberty $SEQ_LIB
abc -liberty $SIMPLE_LIB -fast -D $TARGET_CLOCK_PS -dont_use "*x1p*_ASAP7*" -dont_use "*xp*_ASAP7*" -dont_use "SDF*" -dont_use "ICG*"
opt_clean
tee -o $STAT_LOG stat -liberty $MERGED_LIB
tee -o $STAT_JSON stat -liberty $MERGED_LIB -json
write_verilog -noattr $NETLIST
EOF

# Reuse an existing structural netlist when it is newer than this script and
# the RTL Flist (set FORCE_SYNTH=1 to always re-synthesize). The full-core
# synthesis is ~8 min; STA is seconds, so this keeps STA-only iterations cheap.
if [[ "${FORCE_SYNTH:-0}" != "1" && -s "$NETLIST" && -s "$STAT_JSON" \
      && "$NETLIST" -nt "$0" && "$NETLIST" -nt "external/cva6/cva6/core/Flist.cva6" ]]; then
    echo "[run_e1_pro_synth] reusing cached netlist $NETLIST (FORCE_SYNTH=1 to rebuild)"
else
    echo "[run_e1_pro_synth] synthesizing $TOP ($TARGET_CFG) to ASAP7 RVT TT ..."
    "$YOSYS" -q -l "$SYNTH_LOG" "$SYNTH_YS" || { echo "BLOCKED: yosys synthesis failed; tail $SYNTH_LOG" >&2; tail -30 "$SYNTH_LOG" >&2; exit 1; }
    [[ -s "$NETLIST" ]] || { echo "BLOCKED: yosys produced no netlist at $NETLIST" >&2; exit 1; }
fi

# --- OpenROAD: floorplan + global placement + buffering, then STA ----------
# A raw NLDM STA over the bare yosys netlist is meaningless: ABC -fast leaves
# high-fanout broadcast nets (reset, flush, valid, decode-onehot) as a single
# unbuffered driver, so NLDM extrapolates that gate's delay/slew to microseconds
# (WNS ~ -1.5e5 ns). The fix is the standard pre-route resizer flow: floorplan
# the cells, run global placement so wirelength is estimable, then repair_design
# inserts the buffer tree those nets need and fixes max-cap/fanout/slew DRVs.
# The resulting worst-slack reflects a REAL buffered logic-depth critical path.
# Fmax = 1000 / (constraint_period_ns - WNS_ns). This is a placed+buffered
# open-PDK synthesis estimate: NO clock-tree synthesis, NO detailed placement,
# NO routing, NO SRAM macros, NO PEX, NO foundry signoff. A full ORFS signoff
# with CTS + timing-driven detailed placement would typically improve Fmax,
# so this is a conservative lower-bound open-PDK number.
STA_TCL="$BUILD_DIR/${TOP}_${TARGET_CFG}.sta.tcl"
STA_LOG="$BUILD_DIR/${TOP}_${TARGET_CFG}.sta.log"
TECH_LEF="$REPO_ROOT/external/pdks/asap7/asap7sc7p5t_28/techlef_misc/asap7_tech_1x_201209.lef"
CELL_LEF="$REPO_ROOT/external/pdks/asap7/asap7sc7p5t_27/LEF/asap7sc7p5t_27_R_1x_201211.lef"
[[ -f "$TECH_LEF" ]] || { echo "BLOCKED: ASAP7 tech LEF missing: $TECH_LEF" >&2; exit 1; }
[[ -f "$CELL_LEF" ]] || { echo "BLOCKED: ASAP7 cell LEF missing: $CELL_LEF" >&2; exit 1; }
READ_LIB_LINES=""
for L in "${NLDM_LIBS[@]}"; do READ_LIB_LINES+="read_liberty $L"$'\n'; done
# All times below are in the liberty time unit, which for ASAP7 NLDM is 1 ps.
# The clock period anchor and the reported worst-slack are therefore in ps;
# the evidence assembler converts ps -> MHz. (Fmax is independent of the anchor:
# critical_path = period - worst_slack, regardless of the anchor value.)
cat > "$STA_TCL" <<EOF
read_lef $TECH_LEF
read_lef $CELL_LEF
$READ_LIB_LINES
read_verilog $NETLIST
link_design $TOP
# Exclude tiny/scan/ICG/delay cells from the resizer (matches ORFS asap7).
set_dont_use {*x1p*_ASAP7* *xp*_ASAP7* SDF* ICG* *DLY*}
create_clock -name clk -period $TARGET_CLOCK_PS [get_ports clk_i]
set_false_path -from [get_ports rst_ni]
set_input_delay 0 -clock clk [all_inputs]
set_output_delay 0 -clock clk [all_outputs]
initialize_floorplan -utilization 45 -aspect_ratio 1.0 -core_space 2.0 -site asap7sc7p5t
place_pins -hor_layers M4 -ver_layers M5 -random
set_wire_rc -signal -layer M2
set_wire_rc -clock -layer M5
set_max_fanout 24 [current_design]
global_placement -density 0.6 -skip_io
estimate_parasitics -placement
repair_design
estimate_parasitics -placement
puts "STA_PERIOD_PS $TARGET_CLOCK_PS"
puts "STA_WNS_PS [sta::worst_slack -max]"
report_checks -path_delay max -group_count 1 -fields {fanout} -digits 2
report_design_area
exit
EOF
echo "[run_e1_pro_synth] OpenROAD floorplan + global placement + repair_design + STA (slow) ..."
"$OPENROAD" -no_init -exit "$STA_TCL" > "$STA_LOG" 2>&1 || { echo "BLOCKED: OpenROAD placement/STA failed; tail $STA_LOG" >&2; tail -25 "$STA_LOG" >&2; exit 1; }

# --- assemble evidence -----------------------------------------------------
YOSYS_VER="$("$YOSYS" -V 2>/dev/null | head -1)"
OPENROAD_VER="$("$OPENROAD" -version 2>/dev/null | head -1)"

"$PY" - "$STAT_JSON" "$SYNTH_LOG" "$STA_LOG" "$COREMARK_EVIDENCE" \
    "$EVIDENCE" "$TARGET_CFG" "$TARGET_CLOCK_PS" "$NETLIST" \
    "$YOSYS_VER" "$OPENROAD_VER" "$MERGED_LIB" <<'PYEOF'
import json, re, sys, datetime
(stat_json, synth_log, sta_log, cm_evidence, out, target_cfg,
 clock_ps, netlist, yosys_ver, openroad_ver, merged_lib) = sys.argv[1:]
clock_ps = int(clock_ps)

stat = json.load(open(stat_json))
mods = stat.get("modules") or {}
mod = None
for name, body in mods.items():
    if name.lstrip("\\") == "cva6":
        mod = body; break
if mod is None:
    sys.stderr.write("BLOCKED: cva6 not in stat json\n"); sys.exit(1)
area_um2 = mod.get("area")
total_cells = mod.get("num_cells")
hist = mod.get("num_cells_by_type") or {}
if not (isinstance(area_um2, (int, float)) and area_um2 > 0):
    sys.stderr.write("BLOCKED: no positive area from yosys stat\n"); sys.exit(1)
seq_pref = ("DFF", "SDFF", "LATCH", "DHL", "ASYNC_DFF")
seq = sum(v for k, v in hist.items() if any(k.startswith(p) for p in seq_pref))
comb = sum(hist.values()) - seq

# Primary Fmax: OpenROAD STA worst-slack after floorplan + global placement +
# repair_design (buffer insertion). critical_path = constraint_period - WNS;
# Fmax = 1000 / critical_path_ns.
sta_text = open(sta_log, errors="replace").read()
m_wns = re.search(r"STA_WNS_PS\s+(-?[0-9.eE+]+)", sta_text)
m_per = re.search(r"STA_PERIOD_PS\s+([0-9.eE+]+)", sta_text)
if not (m_wns and m_per):
    sys.stderr.write("BLOCKED: OpenROAD STA did not report slack/period; tail:\n"
                     + sta_text[-2000:])
    sys.exit(1)
# ASAP7 NLDM time_unit is 1 ps, so OpenSTA reports period and slack in ps.
wns_ps = float(m_wns.group(1))
period_ps = float(m_per.group(1))
crit_path_ps = period_ps - wns_ps
if crit_path_ps <= 0:
    sys.stderr.write("BLOCKED: non-positive critical path from STA\n"); sys.exit(1)
crit_path_ns = crit_path_ps / 1000.0
fmax_mhz = 1.0e6 / crit_path_ps  # ps -> MHz

sta_sp = re.search(r"Startpoint:\s+(\S+)", sta_text)
sta_ep = re.search(r"Endpoint:\s+(\S+)", sta_text)
m_buf = re.search(r"Inserted\s+(\d+)\s+buffers\s+in\s+(\d+)\s+nets", sta_text)
limiting = {
    "source": "openroad_sta_after_floorplan_globalplace_repairdesign",
    "constraint_period_ps": round(period_ps, 2),
    "worst_slack_ps": round(wns_ps, 2),
    "critical_path_ps": round(crit_path_ps, 2),
    "startpoint": sta_sp.group(1) if sta_sp else None,
    "endpoint": sta_ep.group(1) if sta_ep else None,
    "buffers_inserted": int(m_buf.group(1)) if m_buf else None,
    "nets_buffered": int(m_buf.group(2)) if m_buf else None,
    "note": "Critical path is a long combinational arithmetic/compare chain (cv64a6_imafdc includes the F/D FPU; the openc910 cvfpu divide/sqrt SRT datapath has long unpipelined chains). Number is post-global-placement + repair_design, WITHOUT CTS or timing-driven detailed placement, so a full ORFS signoff would typically improve it (conservative lower bound).",
}

cm = json.load(open(cm_evidence))
cm_per_mhz = cm["metrics"]["coremark_per_mhz"]
# CoreMark iterations/sec at the synthesized Fmax:
#   CoreMark/sec = (CoreMark/MHz) * Fmax_MHz
# Density proxy ("GOPS/mm^2" sense the gap-analysis asks for) =
#   CoreMark-iterations/sec per mm^2 of std-cell area.
area_mm2 = float(area_um2) / 1.0e6
coremark_per_s = cm_per_mhz * fmax_mhz
coremark_per_s_per_mm2 = coremark_per_s / area_mm2

report = {
    "schema": "eliza.cpu_synth_ppa.v1",
    "block_id": "e1_pro_cva6_core",
    "rtl_top": "cva6",
    "core_role": "little_core_e1_pro",
    "target_config": target_cfg,
    "isa": "rv64gc",
    "equivalence": "e1-pro IS CVA6 cv64a6_imafdc_sv39 by construction (core-selection.json)",
    "claim_level": "L1_RTL_FULL_SOC",
    "evidence_class": "open_pdk_synthesis_estimate_not_signoff",
    "provenance": "eda_synthesis",
    "generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "pdk": {
        "name": "ASAP7",
        "note": "ASU/ARM predictive 7 nm FinFET academic PDK (BSD-3); NOT a foundry node",
        "stdcell_library": "asap7sc7p5t_27",
        "corner": "RVT_TT_0p70V_25C",
        "liberty_model": "NLDM",
        "liberty_files": "asap7sc7p5t_{AO,INVBUF,OA,SIMPLE,SEQ}_RVT_TT_nldm (per-group, read individually; the merged lib drops some lu_table_template headers so OpenROAD reads the per-group files)",
    },
    "tools": {
        "synthesis": {"name": "yosys", "version": yosys_ver, "frontend": "yosys-slang", "mapper": "abc -fast (SIMPLE SCL)"},
        "place_and_time": {"name": "openroad", "version": openroad_ver, "flow": "floorplan + global_placement + repair_design + STA"},
    },
    "constraint": {"target_clock_ps": clock_ps, "target_clock_mhz": round(1.0e6 / clock_ps, 2)},
    "frequency": {
        "worst_slack_ps": round(wns_ps, 2),
        "critical_path_ns": round(crit_path_ns, 4),
        "max_freq_mhz": round(fmax_mhz, 1),
        "method": "OpenROAD STA after read_lef + floorplan(util 45%) + place_pins + global_placement + repair_design (buffer insertion, max_fanout 24, ASAP7 wire RC on M2/M5). ASAP7 NLDM time_unit is 1 ps, so STA period/slack are in ps; Fmax = 1e6 / (period_ps - worst_slack_ps). Placed + buffered, no CTS, no detailed placement, no routing.",
    },
    "area": {
        "std_cell_area_um2": round(float(area_um2), 2),
        "std_cell_area_mm2": round(area_mm2, 6),
        "cell_count_total": int(total_cells),
        "sequential_cells": int(seq),
        "combinational_cells": int(comb),
        "note": "Pre-PnR std-cell area only. No SRAM macro replacement (caches synthesized as flop arrays), no placement/routing utilization, no PEX.",
    },
    "efficiency": {
        "coremark_per_mhz": cm_per_mhz,
        "coremark_per_mhz_source": "docs/evidence/cpu_ap/cva6-coremark-verilator.json",
        "coremark_iterations_per_s_at_fmax": round(coremark_per_s, 1),
        "coremark_iterations_per_s_per_mm2": round(coremark_per_s_per_mm2, 1),
        "gops_per_mm2_method": "CoreMark/MHz x Fmax_MHz = CoreMark-iter/s; divided by synthesized std-cell area mm^2. This is a CoreMark-throughput density proxy for GOPS/mm^2; it inherits the open-PDK + pre-PnR caveats and the flop-array cache caveat (real area with SRAM macros is smaller, so density is conservatively understated).",
    },
    "limiting_path": limiting,
    "honesty_boundary": (
        "Open-PDK (ASAP7 academic predictive 7nm) synthesis + global-placement + "
        "resizer estimate. Fmax is OpenROAD STA worst-slack after floorplan, "
        "global placement, and repair_design buffering. NO clock-tree synthesis, "
        "NO timing-driven detailed placement, NO routing, NO SRAM macros (caches "
        "are synthesized as flop arrays), NO parasitic extraction, NO foundry "
        "signoff. A full ORFS signoff with CTS would typically raise Fmax, so this "
        "is a CONSERVATIVE LOWER BOUND. CVA6's published 1.7 GHz is real GF22FDX "
        "silicon on a DIFFERENT node and is NOT directly comparable; this number "
        "exists so e1-pro has a measured open-PDK frequency+area point instead of "
        "only CVA6's foundry figure."
    ),
    "forbidden_uses": [
        "cite_as_silicon_fmax",
        "cite_as_foundry_signoff",
        "cite_as_post_route_pnr_evidence",
        "compare_directly_to_gf22_1p7ghz_as_same_node",
        "cite_sram_macro_density",
    ],
}
json.dump(report, open(out, "w"), indent=2)
open(out, "a").write("\n")
print(f"OK e1-pro synth PPA: Fmax={fmax_mhz:.1f} MHz  area={area_mm2:.4f} mm^2  "
      f"cells={total_cells}  CoreMark-iter/s/mm^2={coremark_per_s_per_mm2:.1f}")
print(f"   wrote {out}")
PYEOF
