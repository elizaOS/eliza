include ../common.mk

# Order matters: packages first (in dependency order), then leaf RTL,
# then the integrated top, then the harness wrapper.
VERILOG_SOURCES := \
	$(REPO)/rtl/top/e1_topology_pkg.sv \
	$(REPO)/rtl/top/e1_soc_pkg.sv \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/cache/cache_pkg.sv \
	$(REPO)/rtl/cache/ftq_to_l1i_pkg.sv \
	$(REPO)/rtl/cache/lsu_to_l1d_pkg.sv \
	$(REPO)/rtl/cpu/bpu/bpu_pkg.sv \
	$(REPO)/rtl/cpu/csr/zihpm.sv \
	$(REPO)/rtl/power/power_pkg.sv \
	$(REPO)/rtl/iommu/e1_riscv_iommu_pkg.sv \
	$(REPO)/rtl/cpu/bpu/bimodal.sv \
	$(REPO)/rtl/cpu/bpu/bpu_csr.sv \
	$(REPO)/rtl/cpu/bpu/ftb.sv \
	$(REPO)/rtl/cpu/bpu/ftq.sv \
	$(REPO)/rtl/cpu/bpu/h2p_corrector.sv \
	$(REPO)/rtl/cpu/bpu/ittage.sv \
	$(REPO)/rtl/cpu/bpu/loop_predictor.sv \
	$(REPO)/rtl/cpu/bpu/ras.sv \
	$(REPO)/rtl/cpu/bpu/sc.sv \
	$(REPO)/rtl/cpu/bpu/tage.sv \
	$(REPO)/rtl/cpu/bpu/tage_table.sv \
	$(REPO)/rtl/cpu/bpu/uftb.sv \
	$(REPO)/rtl/cpu/bpu/bpu_top.sv \
	$(REPO)/rtl/cpu/bpu/ftq_to_fetch_stream.sv \
	$(REPO)/rtl/cpu/bpu/fetch_stream_to_l1i_demand.sv \
	$(REPO)/rtl/cpu/bpu/ftq_to_l1i_shim.sv \
	$(REPO)/rtl/cpu/csr/bpu_to_zihpm_remap.sv \
	$(REPO)/rtl/cache/l1i/e1_l1i_cache.sv \
	$(REPO)/rtl/cache/l1i/e1_l1i_dual_miss_to_l2.sv \
	$(REPO)/rtl/cache/l2/e1_l2_cache.sv \
	$(REPO)/rtl/cpu/cluster/e1_cluster_top.sv \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_interconnect.sv \
	$(REPO)/rtl/interconnect/chi_bridge/e1_chi_to_axi4_bridge.sv \
	$(REPO)/rtl/iommu/e1_riscv_iommu.sv \
	$(REPO)/rtl/cache/slc/e1_slc.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_axi4_dram_model.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_dram_ctrl.sv \
	$(REPO)/rtl/power/pmc_top.sv \
	$(REPO)/rtl/memory/e1_weight_buffer_sram.sv \
	$(REPO)/rtl/bootrom/e1_bootrom.sv \
	$(REPO)/rtl/peripherals/e1_peripherals.sv \
	$(REPO)/rtl/dma/e1_dma.sv \
	$(REPO)/rtl/npu/e1_npu.sv \
	$(REPO)/rtl/display/e1_display.sv \
	$(REPO)/rtl/display/e1_display_scanout.sv \
	$(REPO)/rtl/top/adapters/e1_slc_to_chi_line_shim.sv \
	$(REPO)/rtl/top/adapters/e1_axi4_width_converter.sv \
	$(REPO)/rtl/peripherals/e1_mmio_decode.sv \
	$(REPO)/rtl/peripherals/e1_clint.sv \
	$(REPO)/rtl/memory/e1_behavioral_dram.sv \
	$(REPO)/rtl/top/e1_soc_integrated.sv \
	$(PWD)/e1_soc_integrated_tb.sv

TOPLEVEL ?= e1_soc_integrated_tb
MODULE   ?= test_soc_boot_smoke

EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-DECLFILENAME -Wno-PINCONNECTEMPTY -Wno-SYNCASYNCNET

# Optional: wire the real Ibex into pmc_top when PMC_INSTANTIATE_IBEX=1 is set
# in the environment. Default-off keeps the existing 26+25 baseline cocotb
# tests on the same (smaller) compile unit; flipping the gate adds the
# resolved Ibex sources from the FuseSoC-staged tree under
# external/ibex/ibex/build/. See external/ibex/ibex_pmc_min.f.
ifneq ($(PMC_INSTANTIATE_IBEX),)
ifneq ($(PMC_INSTANTIATE_IBEX),0)
IBEX_FLIST := $(PWD)/ibex_pmc_min.f
ifeq ($(wildcard $(IBEX_FLIST)),)
$(error PMC_INSTANTIATE_IBEX=$(PMC_INSTANTIATE_IBEX) but $(IBEX_FLIST) is missing — run scripts/bootstrap_ibex.sh first)
endif
# Split the flist into +incdir+ (passed via EXTRA_ARGS) and source paths
# (prepended to VERILOG_SOURCES so package declarations elaborate first).
IBEX_INCDIRS  := $(shell awk '/^\+incdir\+/ {print $$0}' $(IBEX_FLIST) | sed 's|^+incdir+|+incdir+$(REPO)/|')
IBEX_SOURCES  := $(shell awk '/^[^#+[:space:]]/ {print $$0}' $(IBEX_FLIST) | sed 's|^|$(REPO)/|')
VERILOG_SOURCES := $(IBEX_SOURCES) $(VERILOG_SOURCES)
# Upstream Ibex has a UNOPTFLAT loop reported by Verilator on the
# load_store_unit / fetch_fifo cross-couplings; suppress at the build
# level instead of patching upstream RTL (per
# external/ibex/pin-manifest.json "no_fork_use_upstream_via_submodule").
# DECLFILENAME, PINMISSING, UNUSEDSIGNAL similarly come from upstream
# lint waivers in the FuseSoC build.
EXTRA_ARGS += +define+PMC_INSTANTIATE_IBEX +define+SYNTHESIS
EXTRA_ARGS += $(IBEX_INCDIRS)
EXTRA_ARGS += -Wno-DECLFILENAME -Wno-PINMISSING -Wno-WIDTHTRUNC -Wno-WIDTHEXPAND -Wno-CASEINCOMPLETE -Wno-UNUSEDPARAM -Wno-LATCH -Wno-ASCRANGE -Wno-MULTIDRIVEN -Wno-CMPCONST -Wno-UNUSEDGENVAR -Wno-CONSTRAINTIGN
endif
endif

include $(COCOTB_SIM_MK)
