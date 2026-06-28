include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/npu/e1_npu.sv

TOPLEVEL ?= e1_npu
MODULE ?= test_iree_tiny_mlp_e2e

EXTRA_ARGS += -Wno-UNUSEDPARAM -Wno-UNUSEDSIGNAL -Wno-UNUSED -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC

include $(COCOTB_SIM_MK)
