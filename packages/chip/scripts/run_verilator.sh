#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH=; cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -d "$repo_dir/external/oss-cad-suite/bin" ]; then
    PATH="$repo_dir/external/oss-cad-suite/bin:$PATH"
fi

if ! command -v verilator >/dev/null 2>&1; then
    echo "Verilator missing. Use Docker/Nix or install Verilator."
    exit 1
fi

rm -rf build/verilator build/verilator_npu_gemm
mkdir -p build/verilator
repo_dir="$(pwd)"
verilator -Wall -Wno-UNUSEDSIGNAL --cc --exe --build \
    --top-module e1_chip_top \
    "$repo_dir/rtl/top/e1_soc_pkg.sv" \
    "$repo_dir/rtl/peripherals/e1_mmio_decode.sv" \
    "$repo_dir/rtl/peripherals/e1_clint.sv" \
    "$repo_dir/rtl/memory/e1_behavioral_dram.sv" \
    "$repo_dir/rtl/top/e1_chip_top.sv" \
    "$repo_dir/rtl/clock/e1_reset_sync.sv" \
    "$repo_dir/rtl/debug/e1_dbg_mmio_bridge.sv" \
    "$repo_dir/rtl/top/e1_soc_top.sv" \
    "$repo_dir/rtl/bootrom/e1_bootrom.sv" \
    "$repo_dir/rtl/peripherals/e1_peripherals.sv" \
    "$repo_dir/rtl/dma/e1_dma.sv" \
    "$repo_dir/rtl/npu/e1_npu.sv" \
    "$repo_dir/rtl/display/e1_display.sv" \
    "$repo_dir/rtl/cpu/e1_cva6_wrapper.sv" \
    "$repo_dir/rtl/cpu/e1_cpu_axi_bridge.sv" \
    "$repo_dir/rtl/cpu/e1_cpu_subsystem_stub.sv" \
    "$repo_dir/rtl/interconnect/e1_axi_lite_interconnect.sv" \
    "$repo_dir/rtl/memory/e1_axi_lite_dram.sv" \
    "$repo_dir/rtl/memory/e1_weight_buffer_sram.sv" \
    "$repo_dir/rtl/interrupts/e1_interrupt_controller.sv" \
    "$repo_dir/rtl/interconnect/e1_linux_soc_contract.sv" \
    "$repo_dir/sim/verilator/sim_main.cpp" \
    -Mdir build/verilator

build/verilator/Ve1_chip_top

verilator -Wall -Wno-UNUSEDSIGNAL --cc --exe --build \
    --top-module e1_soc_top \
    "$repo_dir/rtl/top/e1_soc_pkg.sv" \
    "$repo_dir/rtl/peripherals/e1_mmio_decode.sv" \
    "$repo_dir/rtl/peripherals/e1_clint.sv" \
    "$repo_dir/rtl/memory/e1_behavioral_dram.sv" \
    "$repo_dir/rtl/top/e1_soc_top.sv" \
    "$repo_dir/rtl/bootrom/e1_bootrom.sv" \
    "$repo_dir/rtl/peripherals/e1_peripherals.sv" \
    "$repo_dir/rtl/dma/e1_dma.sv" \
    "$repo_dir/rtl/npu/e1_npu.sv" \
    "$repo_dir/rtl/display/e1_display.sv" \
    "$repo_dir/rtl/cpu/e1_cva6_wrapper.sv" \
    "$repo_dir/rtl/cpu/e1_cpu_axi_bridge.sv" \
    "$repo_dir/rtl/cpu/e1_cpu_subsystem_stub.sv" \
    "$repo_dir/rtl/interconnect/e1_axi_lite_interconnect.sv" \
    "$repo_dir/rtl/memory/e1_axi_lite_dram.sv" \
    "$repo_dir/rtl/memory/e1_weight_buffer_sram.sv" \
    "$repo_dir/rtl/interrupts/e1_interrupt_controller.sv" \
    "$repo_dir/rtl/interconnect/e1_linux_soc_contract.sv" \
    "$repo_dir/verify/verilator/test_npu_gemm.cpp" \
    -Mdir build/verilator_npu_gemm

build/verilator_npu_gemm/Ve1_soc_top
