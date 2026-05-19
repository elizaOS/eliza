TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../../..)

# All BPU RTL is included on every test so the cocotb makefile does not need
# per-test source lists. The top-level wrapper drives the chosen TOPLEVEL.
COMMON_SOURCES := \
	$(REPO)/rtl/cpu/bpu/bpu_pkg.sv \
	$(REPO)/rtl/cpu/bpu/bimodal.sv \
	$(REPO)/rtl/cpu/bpu/tage_table.sv \
	$(REPO)/rtl/cpu/bpu/tage.sv \
	$(REPO)/rtl/cpu/bpu/ittage.sv \
	$(REPO)/rtl/cpu/bpu/sc.sv \
	$(REPO)/rtl/cpu/bpu/loop_predictor.sv \
	$(REPO)/rtl/cpu/bpu/ftb.sv \
	$(REPO)/rtl/cpu/bpu/uftb.sv \
	$(REPO)/rtl/cpu/bpu/ras.sv \
	$(REPO)/rtl/cpu/bpu/ftq.sv \
	$(REPO)/rtl/cpu/bpu/bpu_csr.sv \
	$(REPO)/rtl/cpu/bpu/bpu_top.sv

WRAPPERS := \
	$(REPO)/verify/cocotb/bpu/ras_tb.sv \
	$(REPO)/verify/cocotb/bpu/ftq_tb.sv \
	$(REPO)/verify/cocotb/bpu/ftb_tb.sv \
	$(REPO)/verify/cocotb/bpu/uftb_tb.sv \
	$(REPO)/verify/cocotb/bpu/loop_predictor_tb.sv \
	$(REPO)/verify/cocotb/bpu/tage_tb.sv \
	$(REPO)/verify/cocotb/bpu/ittage_tb.sv \
	$(REPO)/verify/cocotb/bpu/sc_tb.sv \
	$(REPO)/verify/cocotb/bpu/bpu_top_tb.sv

VERILOG_SOURCES := $(COMMON_SOURCES) $(WRAPPERS)

TOPLEVEL ?= bpu_top_tb
MODULE ?= test_bpu_top
PYTHON ?= python3

# Verilator: keep linting on but suppress warnings about unused package
# parameters (e.g. RAS-only test sees the full bpu_pkg) and unused signals
# in the verification-only flatten wrappers. Errors still surface as errors.
EXTRA_ARGS += -Wall -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL -Wno-UNUSED -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-MULTIDRIVEN -Wno-CASEINCOMPLETE -Wno-CASEX -Wno-LATCH -Wno-IMPORTSTAR

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
