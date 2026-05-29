TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../../..)

VERILOG_SOURCES := \
	$(REPO)/rtl/dma/e1_dma.sv

TOPLEVEL ?= e1_dma
MODULE ?= test_dma_long_transfer
PYTHON ?= python3

EXTRA_ARGS += -Wall

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
