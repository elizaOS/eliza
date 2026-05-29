include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/cache/cache_pkg.sv \
	$(PWD)/e1_l1d_ecc_codec_tb.sv

TOPLEVEL ?= e1_l1d_ecc_codec_tb
MODULE   ?= test_l1d_ecc

EXTRA_ARGS += -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND

include $(COCOTB_SIM_MK)
