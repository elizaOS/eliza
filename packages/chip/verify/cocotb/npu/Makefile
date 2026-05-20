TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../../..)

VERILOG_SOURCES := \
	$(REPO)/rtl/npu/e1_npu.sv

TOPLEVEL ?= e1_npu
MODULE ?= test_iree_tiny_mlp_e2e
PYTHON ?= python3

EXTRA_ARGS += -Wall -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL -Wno-UNUSED -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
