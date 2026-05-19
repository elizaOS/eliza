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

axi4_sources="
rtl/interconnect/axi4/e1_axi4_pkg.sv
rtl/interconnect/axi4/e1_axi4_interconnect.sv
rtl/memory/dram_ctrl/e1_axi4_dram_model.sv
rtl/memory/dram_ctrl/e1_dram_ctrl.sv
rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv
"

iommu_sources="
rtl/iommu/e1_riscv_iommu_pkg.sv
rtl/iommu/e1_riscv_iommu.sv
"

if command -v verilator >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    verilator --lint-only -Wall -Wno-UNUSEDSIGNAL --top-module e1_chip_top $rtl_sources
    # AXI4 burst-capable production path
    # shellcheck disable=SC2086
    verilator --lint-only -Wall -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT \
        --top-module e1_axi4_interconnect $axi4_sources
    # RISC-V IOMMU v1.0.1
    # shellcheck disable=SC2086
    verilator --lint-only -Wall -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT \
        --top-module e1_riscv_iommu rtl/interconnect/axi4/e1_axi4_pkg.sv $iommu_sources
elif command -v iverilog >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_chip_top $rtl_sources
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_axi4_interconnect $axi4_sources
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_riscv_iommu rtl/interconnect/axi4/e1_axi4_pkg.sv $iommu_sources
else
    echo "STATUS: BLOCKED rtl.check - No local RTL checker found. Install Verilator or Icarus Verilog, or use the Docker/Nix shell."
    if [ "${REQUIRE_RTL_CHECK:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi
