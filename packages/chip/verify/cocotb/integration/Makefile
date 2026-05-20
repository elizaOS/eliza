TOPLEVEL_LANG ?= verilog
SIM           ?= verilator

PWD  := $(shell pwd)
REPO := $(abspath ../../..)

# Order matters: packages first (in dependency order), then leaf RTL,
# then the integrated top, then the harness wrapper.
VERILOG_SOURCES := \
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
	$(REPO)/rtl/cpu/bpu/ittage.sv \
	$(REPO)/rtl/cpu/bpu/loop_predictor.sv \
	$(REPO)/rtl/cpu/bpu/ras.sv \
	$(REPO)/rtl/cpu/bpu/sc.sv \
	$(REPO)/rtl/cpu/bpu/tage.sv \
	$(REPO)/rtl/cpu/bpu/tage_table.sv \
	$(REPO)/rtl/cpu/bpu/uftb.sv \
	$(REPO)/rtl/cpu/bpu/bpu_top.sv \
	$(REPO)/rtl/cpu/bpu/ftq_to_l1i_shim.sv \
	$(REPO)/rtl/cpu/csr/bpu_to_zihpm_remap.sv \
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
	$(REPO)/rtl/top/adapters/e1_slc_to_chi_line_shim.sv \
	$(REPO)/rtl/top/adapters/e1_axi4_width_converter.sv \
	$(REPO)/rtl/top/e1_soc_integrated.sv \
	$(PWD)/e1_soc_integrated_tb.sv

TOPLEVEL ?= e1_soc_integrated_tb
MODULE   ?= test_soc_boot_smoke
PYTHON   ?= python3

EXTRA_ARGS += -Wall -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-DECLFILENAME -Wno-PINCONNECTEMPTY -Wno-SYNCASYNCNET

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
