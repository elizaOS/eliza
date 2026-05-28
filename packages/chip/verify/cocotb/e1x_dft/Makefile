include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_sram_ecc.sv \
	$(REPO)/rtl/e1x/e1x_mbist.sv \
	$(PWD)/e1x_sram_ecc_tb.sv \
	$(PWD)/e1x_mbist_tb.sv

TOPLEVEL ?= e1x_sram_ecc_tb
MODULE   ?= test_e1x_sram_ecc

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
