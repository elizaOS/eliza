# JTAG TAP integration smoke for e1_chip_top.
#
# Drives the pad-level JTAG TCK/TMS/TDI/TDO port through the real e1_jtag_tap
# now instantiated in e1_chip_top and shifts out the IDCODE data register,
# proving JTAG_TDO is no longer hardwired to 0.

include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/top/e1_soc_pkg.sv \
	$(REPO)/rtl/peripherals/e1_mmio_decode.sv \
	$(REPO)/rtl/peripherals/e1_clint.sv \
	$(REPO)/rtl/memory/e1_behavioral_dram.sv \
	$(REPO)/rtl/top/e1_chip_top.sv \
	$(REPO)/rtl/clock/e1_reset_sync.sv \
	$(REPO)/rtl/debug/e1_dbg_mmio_bridge.sv \
	$(REPO)/rtl/dft/e1_jtag_tap.sv \
	$(REPO)/rtl/top/e1_soc_top.sv \
	$(REPO)/rtl/bootrom/e1_bootrom.sv \
	$(REPO)/rtl/peripherals/e1_peripherals.sv \
	$(REPO)/rtl/dma/e1_dma.sv \
	$(REPO)/rtl/npu/e1_npu.sv \
	$(REPO)/rtl/display/e1_display.sv \
	$(REPO)/rtl/cpu/e1_cva6_wrapper.sv \
	$(REPO)/rtl/cpu/e1_cpu_axi_bridge.sv \
	$(REPO)/rtl/cpu/e1_tiny_cpu_contract.sv \
	$(REPO)/rtl/cpu/e1_cpu_subsystem_stub.sv \
	$(REPO)/rtl/interconnect/e1_axil_to_mmio.sv \
	$(REPO)/rtl/interconnect/e1_mmio_arb2.sv \
	$(REPO)/rtl/memory/e1_weight_buffer_sram.sv

TOPLEVEL ?= e1_chip_top
MODULE   ?= test_e1_chip_jtag

EXTRA_ARGS += -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-IMPLICITSTATIC

include $(COCOTB_SIM_MK)
