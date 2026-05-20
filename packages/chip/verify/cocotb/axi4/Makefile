TOPLEVEL_LANG ?= verilog
SIM           ?= verilator

PWD  := $(shell pwd)
REPO := $(abspath ../../..)

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_interconnect.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_axi4_dram_model.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_dram_ctrl.sv \
	$(REPO)/rtl/top/adapters/e1_axi4_width_converter.sv \
	$(PWD)/e1_axi4_tb.sv \
	$(PWD)/e1_axi4_irq_w1c_tb.sv \
	$(PWD)/e1_axi4_multimaster_tb.sv \
	$(PWD)/e1_dram_ctrl_tb.sv \
	$(PWD)/e1_axi4_width_converter_tb.sv

TOPLEVEL ?= e1_axi4_tb
MODULE   ?= test_axi4_burst
PYTHON   ?= python3

EXTRA_ARGS += -Wall -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
