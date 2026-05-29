include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_mesh_router.sv \
	$(PWD)/e1x3d_mesh_router_tb.sv

TOPLEVEL ?= e1x3d_mesh_router_tb
MODULE   ?= test_e1x3d_mesh_router

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
