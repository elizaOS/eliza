#!/usr/bin/env bash
# Dedicated, fully-isolated fast-functional boot run to userland for the E1 CVA6.
#
# Uses a UNIQUE SIM_BUILD dir, transcript, and report so it never shares
# sim_build / transcript / results with any concurrent boot sim.  Drives the
# real CVA6 RTL + OpenSBI v1.8.1 + the harder-trimmed Linux 6.12.90 + the real
# freestanding /init to ELIZA-USERLAND-OK with a generous cycle/idle budget.
#
# This is a FUNCTIONAL boot proof on the fast sim config (+E1_DRAM_FAST zero-wait
# DRAM, 32 MiB advertised RAM, Verilator -O2/threaded), NOT a timing/perf claim.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
source tools/env.sh >/dev/null 2>&1

COCOTB_DIR="$ROOT/verify/cocotb/integration"
MAKEFILE="$COCOTB_DIR/Makefile.linux-cva6-boot"
SIM_BUILD="sim_build_linux_cva6_boot_userland_final"
BOOT_HEX="$ROOT/fw/linux-cva6-boot/build/linux_boot.hex128"
TRANSCRIPT_NAME="linux_userland_final.transcript"

# Generous budget: the do_initcalls() stretch is output-light for tens of
# millions of cycles even with fast DRAM, so the idle watchdog is set high so
# the run is never killed mid-stretch.  A true wedge still stops it, just later.
export E1_BOOT_FAST=1
export CVA6_VERILATOR_FULL_OK=1
export E1_BOOT_REQUIRE="ELIZA-USERLAND-OK"
export E1_BOOT_TRANSCRIPT="$TRANSCRIPT_NAME"
export E1_BOOT_MAX_CYCLES="300000000"
export E1_BOOT_IDLE_LIMIT="80000000"
export E1_BOOT_HEARTBEAT="1000000"
# Isolated results file so we never race the canonical results.xml a concurrent
# check_linux_boot_cva6.py run reads/writes.
export COCOTB_RESULTS_FILE="results_userland_final.xml"

echo "[run_userland_final] SIM_BUILD=$SIM_BUILD"
echo "[run_userland_final] transcript=docs/evidence/cpu_ap/$TRANSCRIPT_NAME"
echo "[run_userland_final] boot_hex=fw/linux-cva6-boot/build/linux_boot.hex128"
echo "[run_userland_final] max_cycles=$E1_BOOT_MAX_CYCLES idle_limit=$E1_BOOT_IDLE_LIMIT"

rm -f "$COCOTB_DIR/results_userland_final.xml"
cd "$COCOTB_DIR"
make -f "$MAKEFILE" \
  SIM_BUILD="$SIM_BUILD" \
  MODULE=test_linux_boot_cva6 \
  PLUSARGS="+E1_DRAM_PRELOAD_HEX=$BOOT_HEX" 2>&1 \
  | python3 "$ROOT/scripts/provenance_sanitize.py"
