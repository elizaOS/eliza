TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../../..)

VERILOG_SOURCES := $(REPO)/rtl/dft/e1_jtag_tap.sv

TOPLEVEL ?= e1_jtag_tap
MODULE ?= test_e1_jtag_tap
PYTHON ?= python3

# Verilator: keep linting on; the TAP is self-contained so only standard
# verification-flow waivers apply.
EXTRA_ARGS += -Wall -Wno-DECLFILENAME --timing

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
