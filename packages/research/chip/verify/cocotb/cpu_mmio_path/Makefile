# CPU -> peripheral AXI-Lite/MMIO path test.
#
# Exercises the production chain e1_soc_top instantiates internally
# (e1_cpu_axi_bridge -> e1_axil_to_mmio -> e1_mmio_arb2 -> peripheral fabric)
# at a TB scope where the CVA6-side AXI4 master can be driven directly. Proves
# the CPU AXI-Lite master no longer dead-ends at 0xDEAD_BEEF: CPU reads/writes
# of real peripherals (bootrom / GPIO / NPU CSR) return OKAY with real data,
# and both the external debug master and the CPU master share the fabric.

include ../common.mk

VERILOG_SOURCES := \
	$(REPO)/rtl/peripherals/e1_mmio_decode.sv \
	$(REPO)/rtl/bootrom/e1_bootrom.sv \
	$(REPO)/rtl/peripherals/e1_peripherals.sv \
	$(REPO)/rtl/npu/e1_npu.sv \
	$(REPO)/rtl/cpu/e1_cpu_axi_bridge.sv \
	$(REPO)/rtl/interconnect/e1_axil_to_mmio.sv \
	$(REPO)/rtl/interconnect/e1_mmio_arb2.sv \
	$(REPO)/verify/cocotb/cpu_mmio_path/e1_cpu_mmio_path_tb.sv

TOPLEVEL ?= e1_cpu_mmio_path_tb
MODULE   ?= test_e1_cpu_mmio_path

EXTRA_ARGS += -Wno-DECLFILENAME -Wno-UNUSEDSIGNAL -Wno-UNUSEDPARAM -Wno-WIDTHEXPAND -Wno-WIDTHTRUNC -Wno-VARHIDDEN -Wno-CASEINCOMPLETE -Wno-UNOPTFLAT -Wno-IMPLICITSTATIC -Wno-PINMISSING -Wno-PINCONNECTEMPTY

include $(COCOTB_SIM_MK)
