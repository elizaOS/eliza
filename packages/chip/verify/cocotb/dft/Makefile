include ../common.mk

VERILOG_SOURCES := $(REPO)/rtl/dft/e1_jtag_tap.sv

TOPLEVEL ?= e1_jtag_tap
MODULE ?= test_e1_jtag_tap

# The TAP is self-contained, so only standard verification-flow waivers
# apply; --timing enables event-controlled testbench delays.
EXTRA_ARGS += -Wno-DECLFILENAME --timing

include $(COCOTB_SIM_MK)
