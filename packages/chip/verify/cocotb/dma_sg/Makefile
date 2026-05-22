include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/dma/e1_dma_sg.sv

TOPLEVEL ?= e1_dma_sg
MODULE   ?= test_dma_sg

EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM

include $(COCOTB_SIM_MK)
