# SoC integration smoke: real CLINT + PLIC + AXI4 DRAM composed into
# e1_soc_top behind +define+E1_SOC_REAL_IRQ +define+E1_SOC_REAL_DRAM.
#
# The bring-up CLINT (rtl/peripherals/e1_clint.sv) is intentionally NOT in the
# source list: in the integrated config e1_soc_top instantiates the real
# rtl/interrupts/e1_clint.sv (same module name), so including both would be a
# duplicate-module declaration.

include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/top/e1_soc_pkg.sv \
	$(REPO)/rtl/peripherals/e1_mmio_decode.sv \
	$(REPO)/rtl/memory/e1_behavioral_dram.sv \
	$(REPO)/rtl/clock/e1_reset_sync.sv \
	$(REPO)/rtl/bootrom/e1_bootrom.sv \
	$(REPO)/rtl/peripherals/e1_peripherals.sv \
	$(REPO)/rtl/dma/e1_dma.sv \
	$(REPO)/rtl/npu/e1_npu.sv \
	$(REPO)/rtl/display/e1_display.sv \
	$(REPO)/rtl/cpu/e1_cva6_wrapper.sv \
	$(REPO)/rtl/cpu/e1_cpu_axi_bridge.sv \
	$(REPO)/rtl/cpu/e1_tiny_cpu_contract.sv \
	$(REPO)/rtl/cpu/e1_cpu_subsystem_stub.sv \
	$(REPO)/rtl/memory/e1_weight_buffer_sram.sv \
	$(REPO)/rtl/interrupts/e1_clint.sv \
	$(REPO)/rtl/interrupts/e1_plic.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_dram_ctrl.sv \
	$(REPO)/rtl/security/rot/e1_rot_reset_seq.sv \
	$(REPO)/rtl/top/adapters/e1_soc_real_subsys.sv \
	$(REPO)/rtl/top/e1_soc_top.sv

TOPLEVEL ?= e1_soc_top
MODULE   ?= test_e1_soc_integrated_smoke

EXTRA_ARGS += +define+E1_SOC_REAL_IRQ +define+E1_SOC_REAL_DRAM +define+E1_SOC_ROT_GATED
EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-DECLFILENAME -Wno-VARHIDDEN -Wno-IMPLICITSTATIC -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT

include $(COCOTB_SIM_MK)
