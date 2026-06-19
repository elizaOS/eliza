# Shared prelude for the per-block cocotb sub-package Makefiles.
#
# Every sub-package Makefile under verify/cocotb/*/ opened with the same
# boilerplate — toolchain selection, the PWD/REPO/PYTHON variables, the
# baseline ``-Wall`` Verilator flag, and the cocotb Makefile.sim include —
# and then drifted in its per-block ``-Wno-*`` waiver list (dossier item
# §3.4 H27). This file owns the invariant prelude; each Makefile keeps only
# its own VERILOG_SOURCES, TOPLEVEL, MODULE, and block-specific waivers.
#
# Usage (from verify/cocotb/<block>/Makefile):
#
#     include ../common.mk
#     VERILOG_SOURCES := ...
#     TOPLEVEL ?= ...
#     MODULE   ?= ...
#     EXTRA_ARGS += -Wno-...        # block-specific Verilator waivers
#     include $(COCOTB_SIM_MK)
#
# REPO is resolved from this file's location so it is independent of the
# including Makefile's depth.

TOPLEVEL_LANG ?= verilog
SIM           ?= verilator
PYTHON        ?= python3

PWD  := $(shell pwd)
REPO := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))../..)

# Baseline Verilator lint: keep -Wall on for every block so real lint errors
# surface; blocks append their own justified -Wno-* waivers after this.
EXTRA_ARGS += -Wall

# Path to the cocotb simulation makefile, included by each block Makefile
# after it has declared its sources/top/module/waivers.
COCOTB_SIM_MK := $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
