#!/usr/bin/env sh
set -eu

mkdir -p build
repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -d "$repo_dir/tools/bin" ]; then
    PATH="$repo_dir/tools/bin:$PATH"
fi
if [ "$(uname -s)" = "Darwin" ] && [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi

rtl_sources="
rtl/top/e1_chip_top.sv
rtl/clock/e1_reset_sync.sv
rtl/debug/e1_dbg_mmio_bridge.sv
rtl/top/e1_soc_top.sv
rtl/bootrom/e1_bootrom.sv
rtl/peripherals/e1_peripherals.sv
rtl/dma/e1_dma.sv
rtl/npu/e1_npu.sv
rtl/display/e1_display.sv
rtl/cpu/e1_cva6_wrapper.sv
rtl/cpu/e1_cpu_axi_bridge.sv
rtl/cpu/e1_cpu_subsystem_stub.sv
rtl/interconnect/e1_axi_lite_interconnect.sv
rtl/memory/e1_axi_lite_dram.sv
rtl/interrupts/e1_interrupt_controller.sv
rtl/interconnect/e1_linux_soc_contract.sv
"

if command -v verilator >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    verilator --lint-only -Wall -Wno-UNUSEDSIGNAL --top-module e1_chip_top $rtl_sources
elif command -v iverilog >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_chip_top $rtl_sources
else
    echo "STATUS: BLOCKED rtl.check - No local RTL checker found. Install Verilator or Icarus Verilog, or use the Docker/Nix shell."
    if [ "${REQUIRE_RTL_CHECK:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi
