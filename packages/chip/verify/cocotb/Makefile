TOPLEVEL_LANG ?= verilog
SIM ?= verilator

PWD := $(shell pwd)
REPO := $(abspath ../..)

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
	$(REPO)/rtl/interconnect/e1_axi_lite_interconnect.sv \
	$(REPO)/rtl/memory/e1_axi_lite_dram.sv \
	$(REPO)/rtl/memory/e1_weight_buffer_sram.sv \
	$(REPO)/rtl/interrupts/e1_interrupt_controller.sv \
	$(REPO)/rtl/interconnect/e1_linux_soc_contract.sv \
	$(REPO)/rtl/security/lc/e1_lc_ctrl.sv \
	$(REPO)/verify/cocotb/e1_tiny_cpu_contract_tb.sv

TOPLEVEL ?= e1_chip_top
MODULE ?= test_e1_chip
PYTHON ?= python3

EXTRA_ARGS += -Wall

include $(shell $(PYTHON) -m cocotb.config --makefiles)/Makefile.sim
