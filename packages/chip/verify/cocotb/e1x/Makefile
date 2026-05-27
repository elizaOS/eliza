include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_mesh_router.sv \
	$(REPO)/rtl/e1x/e1x_tiny_core_contract.sv \
	$(REPO)/rtl/e1x/e1x_tile.sv \
	$(PWD)/e1x_mesh_router_tb.sv \
	$(PWD)/e1x_mesh_2x2_tb.sv \
	$(PWD)/e1x_tiny_core_tb.sv \
	$(PWD)/e1x_tile_tb.sv

TOPLEVEL ?= e1x_mesh_router_tb
MODULE   ?= test_e1x_mesh_router

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
