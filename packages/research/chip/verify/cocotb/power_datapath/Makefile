# Power-delivery datapath integration smoke.
#
# Exercises the closed per-rail loop (droop_sensor + clock_stretcher +
# avfs_ctrl + dldo) that e1_power_datapath instantiates and that
# e1_soc_integrated now wires into pmc_top, proving the four power leaf cells
# are integrated and their telemetry is real instead of constant zero.

include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/power/power_pkg.sv \
	$(REPO)/rtl/power/droop_sensor.sv \
	$(REPO)/rtl/power/clock_stretcher.sv \
	$(REPO)/rtl/power/avfs_ctrl.sv \
	$(REPO)/rtl/power/dldo.sv \
	$(REPO)/rtl/top/e1_power_datapath.sv \
	$(REPO)/verify/cocotb/power_datapath/e1_power_datapath_tb.sv

TOPLEVEL ?= e1_power_datapath_tb
MODULE   ?= test_e1_power_datapath

EXTRA_ARGS += -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-IMPLICITSTATIC -Wno-SYNCASYNCNET -Wno-TIMESCALEMOD

include $(COCOTB_SIM_MK)
