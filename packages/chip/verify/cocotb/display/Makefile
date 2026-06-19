include ../common.mk

# test_display_scanout (TOPLEVEL e1_display_scanout_tb) drives the production
# AXI4-read-master framebuffer scanout controller. e1_axi4_pkg supplies the
# AXI4 constants/QoS classes consumed by the read master.
VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/display/e1_display_scanout.sv \
	$(PWD)/e1_display_scanout_tb.sv

TOPLEVEL ?= e1_display_scanout_tb
MODULE   ?= test_display_scanout

# Package-level constant tables (sizes/cache encodings) are intentionally
# broad; only the display-relevant subset is referenced here.
EXTRA_ARGS += -Wno-UNUSEDPARAM

include $(COCOTB_SIM_MK)
