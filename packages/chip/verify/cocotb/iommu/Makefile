include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/iommu/e1_riscv_iommu_pkg.sv \
	$(REPO)/rtl/iommu/e1_riscv_iommu.sv \
	$(PWD)/e1_iommu_tb.sv

TOPLEVEL ?= e1_iommu_tb
MODULE   ?= test_riscv_iommu

EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
