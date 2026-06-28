include ../common.mk

# Integrated-top reachability KAT for the scatter-gather DMA + RISC-V AIA
# fabric (audit finding orphan-sg-dma-aplic-imsic-not-instantiated). The
# harness instantiates e1_soc_top with +define+E1_SOC_AIA_SG, which wires
# e1_dma_sg, e1_aplic, and e1_imsic into the synthesizable SoC hierarchy, and
# attaches a burst-capable DRAM model to the SG-DMA's exported AXI4 master.

VERILOG_SOURCES := \
	$(REPO)/rtl/interconnect/axi4/e1_axi4_pkg.sv \
	$(REPO)/rtl/top/e1_soc_pkg.sv \
	$(REPO)/rtl/peripherals/e1_mmio_decode.sv \
	$(REPO)/rtl/memory/e1_behavioral_dram.sv \
	$(REPO)/rtl/bootrom/e1_bootrom.sv \
	$(REPO)/rtl/peripherals/e1_peripherals.sv \
	$(REPO)/rtl/peripherals/e1_clint.sv \
	$(REPO)/rtl/dma/e1_dma.sv \
	$(REPO)/rtl/dma/e1_dma_sg.sv \
	$(REPO)/rtl/memory/dram_ctrl/e1_axi4_dram_model.sv \
	$(REPO)/rtl/interrupts/e1_aplic.sv \
	$(REPO)/rtl/interrupts/e1_imsic.sv \
	$(REPO)/rtl/npu/e1_npu.sv \
	$(REPO)/rtl/display/e1_display.sv \
	$(REPO)/rtl/cpu/e1_cva6_wrapper.sv \
	$(REPO)/rtl/cpu/e1_cpu_axi_bridge.sv \
	$(REPO)/rtl/cpu/e1_tiny_cpu_contract.sv \
	$(REPO)/rtl/cpu/e1_cpu_subsystem_stub.sv \
	$(REPO)/rtl/interconnect/e1_axil_to_mmio.sv \
	$(REPO)/rtl/interconnect/e1_mmio_arb2.sv \
	$(REPO)/rtl/memory/e1_weight_buffer_sram.sv \
	$(REPO)/rtl/top/e1_soc_top.sv \
	$(PWD)/e1_aia_sg_harness.sv

TOPLEVEL ?= e1_aia_sg_harness
MODULE   ?= test_aia_sg_top

EXTRA_ARGS += +define+E1_SOC_AIA_SG
# Leaf-model waivers already justified by the standalone gates: UNUSEDPARAM
# (AXI4 pkg constants), WIDTHEXPAND/WIDTHTRUNC (DRAM model beat counters),
# DECLFILENAME (harness file name vs module name). Public memory access for the
# white-box DRAM preload/readback (u_sg_dram.mem).
EXTRA_ARGS += -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-DECLFILENAME
EXTRA_ARGS += --public-flat-rw

include $(COCOTB_SIM_MK)
