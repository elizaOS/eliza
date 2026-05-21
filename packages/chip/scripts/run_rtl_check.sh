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
rtl/top/e1_soc_pkg.sv
rtl/peripherals/e1_mmio_decode.sv
rtl/peripherals/e1_clint.sv
rtl/memory/e1_behavioral_dram.sv
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
rtl/memory/e1_weight_buffer_sram.sv
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

cache_pkg_sources="
rtl/cache/cache_pkg.sv
rtl/cache/ftq_to_l1i_pkg.sv
rtl/cache/lsu_to_l1d_pkg.sv
"

cache_unit_sources="
rtl/cache/prefetch/e1_berti_prefetcher.sv
rtl/cache/prefetch/e1_fdip_l1i_prefetcher.sv
rtl/cache/prefetch/e1_stride_prefetcher.sv
rtl/cache/prefetch/e1_best_offset_prefetcher.sv
rtl/cache/prefetch/e1_spp_prefetcher.sv
rtl/cache/prefetch/e1_ipcp_prefetcher.sv
rtl/cache/prefetch/e1_pythia_stub.sv
rtl/cache/replacement/e1_drrip.sv
rtl/cache/replacement/e1_hawkeye.sv
rtl/cache/replacement/e1_mockingjay.sv
rtl/cache/replacement/e1_mockingjay_prod.sv
rtl/cache/compression/e1_bdi_compress.sv
rtl/cache/compression/e1_bdi_decompress.sv
rtl/cache/coherence/tl_c_to_chi_bridge.sv
"

cache_lint_waivers="-Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-ASCRANGE -Wno-DECLFILENAME -Wno-VARHIDDEN -Wno-LATCH -Wno-MULTIDRIVEN"

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
    # Cache hierarchy. Each top-level cache module is lint-checked
    # individually so module-local issues surface cleanly.
    # shellcheck disable=SC2086
    verilator --lint-only -Wall $cache_lint_waivers \
        --top-module e1_l1i_cache $cache_pkg_sources rtl/cache/l1i/e1_l1i_cache.sv
    # shellcheck disable=SC2086
    verilator --lint-only -Wall $cache_lint_waivers \
        --top-module e1_l1d_cache $cache_pkg_sources rtl/cache/l1d/e1_l1d_cache.sv
    # shellcheck disable=SC2086
    verilator --lint-only -Wall $cache_lint_waivers \
        --top-module e1_l2_cache $cache_pkg_sources rtl/cache/l2/e1_l2_cache.sv
    # shellcheck disable=SC2086
    verilator --lint-only -Wall $cache_lint_waivers \
        --top-module e1_l3_cache $cache_pkg_sources rtl/cache/l3/e1_l3_cache.sv
    # shellcheck disable=SC2086
    verilator --lint-only -Wall $cache_lint_waivers \
        --top-module e1_slc $cache_pkg_sources \
        rtl/cache/compression/e1_bdi_compress.sv \
        rtl/cache/compression/e1_bdi_decompress.sv \
        rtl/cache/slc/e1_slc.sv
    for m in e1_berti_prefetcher e1_fdip_l1i_prefetcher e1_stride_prefetcher \
             e1_best_offset_prefetcher e1_spp_prefetcher e1_ipcp_prefetcher \
             e1_pythia_stub e1_drrip e1_hawkeye e1_mockingjay \
             e1_mockingjay_prod \
             e1_bdi_compress e1_bdi_decompress tl_c_to_chi_bridge; do
        # shellcheck disable=SC2086
        verilator --lint-only -Wall $cache_lint_waivers \
            --top-module "$m" $cache_pkg_sources $cache_unit_sources
    done
elif command -v iverilog >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_chip_top $rtl_sources
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_axi4_interconnect $axi4_sources
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_riscv_iommu rtl/interconnect/axi4/e1_axi4_pkg.sv $iommu_sources
    # Cache hierarchy via iverilog as a coarse-grained syntax check
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_l1d_cache $cache_pkg_sources \
        rtl/cache/l1d/e1_l1d_cache.sv
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_l1i_cache $cache_pkg_sources \
        rtl/cache/l1i/e1_l1i_cache.sv
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_l2_cache $cache_pkg_sources \
        rtl/cache/l2/e1_l2_cache.sv
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_l3_cache $cache_pkg_sources \
        rtl/cache/l3/e1_l3_cache.sv
    # shellcheck disable=SC2086
    iverilog -g2012 -tnull -s e1_slc $cache_pkg_sources \
        rtl/cache/compression/e1_bdi_compress.sv \
        rtl/cache/compression/e1_bdi_decompress.sv \
        rtl/cache/slc/e1_slc.sv
else
    echo "STATUS: BLOCKED rtl.check - No local RTL checker found. Install Verilator or Icarus Verilog, or use the Docker/Nix shell."
    if [ "${REQUIRE_RTL_CHECK:-0}" = "1" ]; then
        exit 2
    fi
    exit 0
fi
