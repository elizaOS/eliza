include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_credit_router.sv \
	$(PWD)/e1x_credit_router_tb.sv \
	$(PWD)/e1x_credit_router_chain_tb.sv

TOPLEVEL ?= e1x_credit_router_tb
MODULE   ?= test_e1x_credit_router

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT -Wno-PINCONNECTEMPTY

include $(COCOTB_SIM_MK)
