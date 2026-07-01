include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_dram_ctrl.sv \
	$(PWD)/e1_dram_ctrl_mem_tb.sv

TOPLEVEL ?= e1_dram_ctrl_mem_tb
MODULE   ?= test_dram_memory

EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
