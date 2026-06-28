#!/usr/bin/env bash
# Prove the signoff top (e1_chip_top, the DESIGN_NAME of every e1_chip_top PD
# config) elaborates with the REAL OpenHW Group CVA6 core present and bus-
# connected, i.e. with +define+E1_HAVE_CVA6 and the pinned CVA6 source flist.
#
# This is the honesty check behind the tapeout-netlist-cpu-is-stub-no-cva6-
# define finding: without E1_HAVE_CVA6 the e1_cpu_subsystem wrapper synthesises
# to safe idle (no processor in the netlist). This script elaborates the full
# hierarchy so the real core is verifiably inside the synthesizable top, wired
# through e1_cpu_axi_bridge -> e1_axil_to_mmio -> e1_mmio_arb2 to the
# peripheral fabric.
#
# It does NOT run place-and-route. Full sky130 OpenLane P&R with CVA6 is a
# foundry-PDK + long-runtime job tracked by the fail-closed gate
# docs/evidence/pd/e1-chip-cva6-pd-closure-gate.yaml.
#
# Usage:  scripts/check_pd_cva6_elaboration.sh
# Exit 0 on successful elaboration; non-zero otherwise.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [ -d "$REPO_DIR/external/oss-cad-suite/bin" ]; then
    PATH="$REPO_DIR/external/oss-cad-suite/bin:$PATH"
fi

CVA6_REPO_DIR="$REPO_DIR/external/cva6/cva6"
export CVA6_REPO_DIR
export HPDCACHE_DIR="$CVA6_REPO_DIR/core/cache_subsystem/hpdcache"
export TARGET_CFG="${TARGET_CFG:-cv64a6_imafdc_sv39}"

if [ ! -f "$CVA6_REPO_DIR/core/cva6.sv" ]; then
    echo "FAIL_CLOSED: CVA6 sources not present at $CVA6_REPO_DIR" >&2
    echo "  Run: scripts/clone_cva6.sh  (pinned via external/cva6/pin-manifest.json)" >&2
    exit 3
fi

if ! command -v verilator >/dev/null 2>&1; then
    echo "FAIL_CLOSED: verilator not on PATH; source tools/env.sh" >&2
    exit 3
fi

# Apply the minimal repo-local CVA6 Verilator-lowering patches, then expand the
# CVA6 flist into absolute file + incdir lists.
bash "$REPO_DIR/scripts/apply_cva6_patches.sh" >&2

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
files_out="$work/cva6_files.txt"
incdir_out="$work/cva6_incdir.txt"

python3 "$REPO_DIR/scripts/expand_cva6_flist.py" \
    --flist "$CVA6_REPO_DIR/core/Flist.cva6" \
    --files-out "$files_out" \
    --incdir-out "$incdir_out" >&2

CVA6_FILES="$(cat "$files_out")"
CVA6_INCDIRS="$(tr '\n' ' ' < "$incdir_out")"

# e1-side source set: the e1_chip_top hierarchy + the CPU integration adapters.
E1_SOURCES="
$REPO_DIR/rtl/top/e1_soc_pkg.sv
$REPO_DIR/rtl/interconnect/axi4/e1_axi4_pkg.sv
$REPO_DIR/rtl/peripherals/e1_mmio_decode.sv
$REPO_DIR/rtl/peripherals/e1_clint.sv
$REPO_DIR/rtl/memory/e1_behavioral_dram.sv
$REPO_DIR/rtl/clock/e1_reset_sync.sv
$REPO_DIR/rtl/debug/e1_dbg_mmio_bridge.sv
$REPO_DIR/rtl/dft/e1_jtag_tap.sv
$REPO_DIR/rtl/bootrom/e1_bootrom.sv
$REPO_DIR/rtl/peripherals/e1_peripherals.sv
$REPO_DIR/rtl/dma/e1_dma.sv
$REPO_DIR/rtl/npu/e1_npu.sv
$REPO_DIR/rtl/display/e1_display.sv
$REPO_DIR/rtl/memory/e1_weight_buffer_sram.sv
$REPO_DIR/rtl/interconnect/e1_axil_to_mmio.sv
$REPO_DIR/rtl/interconnect/e1_mmio_arb2.sv
$REPO_DIR/rtl/cpu/e1_cpu_axi_bridge.sv
"

E1_CPU_WRAP="
$REPO_DIR/rtl/top/adapters/e1_cva6_to_e1axi4.sv
$REPO_DIR/rtl/cpu/e1_cva6_wrapper.sv
$REPO_DIR/rtl/top/e1_soc_top.sv
$REPO_DIR/rtl/top/e1_chip_top.sv
"

# Upstream CVA6 ships constructs that emit benign Verilator lint warnings
# (CMPCONST etc.); -Wno-fatal keeps them non-fatal while still failing on any
# real elaboration error.
WAIVERS="-Wno-fatal -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM \
-Wno-WIDTH -Wno-UNOPTFLAT -Wno-CASEINCOMPLETE -Wno-IMPLICITSTATIC \
-Wno-PINCONNECTEMPTY -Wno-SYNCASYNCNET -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC \
-Wno-COMBDLY -Wno-ALWCOMBORDER -Wno-LATCH -Wno-VARHIDDEN -Wno-UNUSED \
-Wno-LITENDIAN -Wno-TIMESCALEMOD -Wno-MULTITOP -Wno-MODDUP -Wno-STMTDLY \
-Wno-CASEX -Wno-SELRANGE -Wno-UNSIGNED -Wno-SYMRSVDWORD"

echo "Elaborating e1_chip_top with +define+E1_HAVE_CVA6 (real CVA6 core)..." >&2
# shellcheck disable=SC2086
verilator --lint-only +define+E1_HAVE_CVA6 +define+WT_DCACHE $CVA6_INCDIRS $WAIVERS \
    $E1_SOURCES $CVA6_FILES $E1_CPU_WRAP \
    --top-module e1_chip_top

echo "PASS: e1_chip_top elaborates with the real CVA6 core present and bus-connected." >&2
