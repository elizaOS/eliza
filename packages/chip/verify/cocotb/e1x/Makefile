include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/e1x/e1x_mesh_router.sv \
	$(REPO)/rtl/e1x/e1x_repair_aware_router.sv \
	$(REPO)/rtl/e1x/e1x_repair_mmio_programmer.sv \
	$(REPO)/rtl/e1x/e1x_repair_rom_loader.sv \
	$(REPO)/rtl/e1x/e1x_repair_state.sv \
	$(REPO)/rtl/e1x/e1x_repair_route_table.sv \
	$(REPO)/rtl/e1x/e1x_repair_routed_router.sv \
	$(REPO)/rtl/e1x/e1x_repair_routed_tile.sv \
	$(REPO)/rtl/e1x/e1x_tiny_core_contract.sv \
	$(REPO)/rtl/e1x/e1x_tile.sv \
	$(PWD)/e1x_mesh_router_tb.sv \
	$(PWD)/e1x_mesh_2x2_tb.sv \
	$(PWD)/e1x_repair_routed_mesh_2x2_tb.sv \
	$(PWD)/e1x_repair_aware_router_tb.sv \
	$(PWD)/e1x_repair_mmio_programmer_route_table_tb.sv \
	$(PWD)/e1x_repair_mmio_programmer_route_table_large_tb.sv \
	$(PWD)/e1x_repair_rom_loader_tb.sv \
	$(PWD)/e1x_repair_route_table_tb.sv \
	$(PWD)/e1x_repair_route_table_overflow_tb.sv \
	$(PWD)/e1x_repair_state_tb.sv \
	$(PWD)/e1x_repair_state_large_tb.sv \
	$(PWD)/e1x_repair_routed_router_tb.sv \
	$(PWD)/e1x_repair_routed_tile_tb.sv \
	$(PWD)/e1x_tiny_core_tb.sv \
	$(PWD)/e1x_tile_tb.sv

TOPLEVEL ?= e1x_mesh_router_tb
MODULE   ?= test_e1x_mesh_router

EXTRA_ARGS += -I$(REPO) -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
