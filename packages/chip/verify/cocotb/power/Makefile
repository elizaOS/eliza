TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../../..)

# Each top is verified independently; the runner selects via TOPLEVEL+MODULE.
VERILOG_SOURCES_DROOP := \
	$(REPO)/rtl/power/power_pkg.sv \
	$(REPO)/rtl/power/droop_sensor.sv \
	$(REPO)/rtl/power/clock_stretcher.sv \
	$(REPO)/verify/cocotb/power/droop_stretch_tb.sv

VERILOG_SOURCES_AVFS := \
	$(REPO)/rtl/power/power_pkg.sv \
	$(REPO)/rtl/power/avfs_ctrl.sv

VERILOG_SOURCES_PMC := \
	$(REPO)/rtl/power/power_pkg.sv \
	$(REPO)/rtl/power/pmc_top.sv

ifeq ($(TOPLEVEL),droop_stretch_tb)
VERILOG_SOURCES := $(VERILOG_SOURCES_DROOP)
endif
ifeq ($(TOPLEVEL),avfs_ctrl)
VERILOG_SOURCES := $(VERILOG_SOURCES_AVFS)
endif
ifeq ($(TOPLEVEL),pmc_top)
VERILOG_SOURCES := $(VERILOG_SOURCES_PMC)
endif

TOPLEVEL ?= droop_stretch_tb
MODULE   ?= test_droop_event
PYTHON   ?= python3

EXTRA_ARGS += -Wall -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-TIMESCALEMOD

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
