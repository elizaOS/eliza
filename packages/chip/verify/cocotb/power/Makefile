include ../common.mk

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

EXTRA_ARGS += -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-TIMESCALEMOD

# Optional: wire the real Ibex into pmc_top when PMC_INSTANTIATE_IBEX=1 is set
# in the environment, so test_pmc_ibex_boot_sanity exercises the actual core's
# reset fetch instead of skipping. Reuses the same FuseSoC-staged Ibex flist as
# the integration lane (verify/cocotb/integration/ibex_pmc_min.f). Default-off
# keeps the mailbox/telemetry-only compile unit for the other PMC tests. Run
# scripts/bootstrap_ibex.sh first to populate external/ibex/ibex.
ifneq ($(PMC_INSTANTIATE_IBEX),)
ifneq ($(PMC_INSTANTIATE_IBEX),0)
IBEX_FLIST := $(REPO)/verify/cocotb/integration/ibex_pmc_min.f
ifeq ($(wildcard $(IBEX_FLIST)),)
$(error PMC_INSTANTIATE_IBEX=$(PMC_INSTANTIATE_IBEX) but $(IBEX_FLIST) is missing — run scripts/bootstrap_ibex.sh first)
endif
IBEX_INCDIRS  := $(shell awk '/^\+incdir\+/ {print $$0}' $(IBEX_FLIST) | sed 's|^+incdir+|+incdir+$(REPO)/|')
IBEX_SOURCES  := $(shell awk '/^[^#+[:space:]]/ {print $$0}' $(IBEX_FLIST) | sed 's|^|$(REPO)/|')
VERILOG_SOURCES := $(IBEX_SOURCES) $(VERILOG_SOURCES)
EXTRA_ARGS += +define+PMC_INSTANTIATE_IBEX +define+SYNTHESIS
EXTRA_ARGS += $(IBEX_INCDIRS)
EXTRA_ARGS += -Wno-DECLFILENAME -Wno-PINMISSING -Wno-CASEINCOMPLETE -Wno-LATCH -Wno-ASCRANGE -Wno-MULTIDRIVEN -Wno-CMPCONST -Wno-UNUSEDGENVAR -Wno-CONSTRAINTIGN -Wno-UNUSEDSIGNAL -Wno-UNOPTFLAT -Wno-PINCONNECTEMPTY -Wno-SYNCASYNCNET
endif
endif

include $(COCOTB_SIM_MK)
