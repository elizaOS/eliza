include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_pe_core.sv \
	$(PWD)/e1x_pe_core_tb.sv

TOPLEVEL ?= e1x_pe_core_tb
MODULE   ?= test_e1x_pe_core

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
