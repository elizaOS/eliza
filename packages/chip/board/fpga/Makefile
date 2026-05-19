# E1-demo FPGA build (ULX3S 85F, ECP5, open-source toolchain).
#
# This Makefile drives the Yosys / nextpnr-ecp5 / ecppack / openFPGALoader
# flow. It does not assume the tools are present in the repository; targets
# only invoke them when called explicitly. CI does NOT run synth/pnr -- those
# require the OSS CAD Suite on the developer or lab machine.
#
# Usage:
#   make -C board/fpga synth
#   make -C board/fpga pnr
#   make -C board/fpga pack
#   make -C board/fpga prog
#   make -C board/fpga report
#   make -C board/fpga clean

TOP            ?= e1_chip_top
DEVICE         ?= 85k
PACKAGE        ?= CABGA381
SPEED          ?= 6
FREQ_MHZ       ?= 25

REPO_ROOT      := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/../..)
RTL_DIR        := $(REPO_ROOT)/rtl
LPF            := $(REPO_ROOT)/board/fpga/constraints/e1_demo_ulx3s.lpf

BUILD_DIR      ?= $(REPO_ROOT)/build/fpga/e1_demo
JSON           := $(BUILD_DIR)/$(TOP).json
CONFIG         := $(BUILD_DIR)/$(TOP).config
BITSTREAM      := $(BUILD_DIR)/$(TOP).bit
SYNTH_LOG      := $(BUILD_DIR)/yosys.log
PNR_LOG        := $(BUILD_DIR)/nextpnr.log
PACK_LOG       := $(BUILD_DIR)/ecppack.log
REPORT         := $(BUILD_DIR)/report.txt

# RTL file list. Keep narrow: only modules in the e1_chip_top cone.
RTL_SOURCES := \
  $(RTL_DIR)/top/e1_fpga_smoke_top.sv \
  $(RTL_DIR)/top/e1_chip_top.sv \
  $(RTL_DIR)/top/e1_soc_top.sv \
  $(RTL_DIR)/clock/e1_reset_sync.sv \
  $(RTL_DIR)/interconnect/e1_axi_lite_interconnect.sv \
  $(RTL_DIR)/interrupts/e1_interrupt_controller.sv \
  $(RTL_DIR)/peripherals/e1_peripherals.sv \
  $(RTL_DIR)/memory/e1_axi_lite_dram.sv \
  $(RTL_DIR)/cpu/e1_cva6_wrapper.sv \
  $(RTL_DIR)/cpu/e1_cpu_axi_bridge.sv \
  $(RTL_DIR)/npu/e1_npu.sv \
  $(RTL_DIR)/dma/e1_dma.sv \
  $(RTL_DIR)/display/e1_display.sv \
  $(RTL_DIR)/bootrom/e1_bootrom.sv \
  $(RTL_DIR)/debug/e1_dbg_mmio_bridge.sv

YOSYS          ?= yosys
NEXTPNR        ?= nextpnr-ecp5
ECPPACK        ?= ecppack
OPENFPGALOADER ?= openFPGALoader

.PHONY: all synth pnr pack prog report clean

all: pack

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

synth: $(JSON)

$(JSON): $(RTL_SOURCES) | $(BUILD_DIR)
	@echo ">> yosys synth for $(TOP) (ECP5 $(DEVICE))"
	$(YOSYS) -p "read_verilog -sv $(RTL_SOURCES); \
	             hierarchy -top $(TOP); \
	             synth_ecp5 -top $(TOP) -json $(JSON)" \
	         -l $(SYNTH_LOG)

pnr: $(CONFIG)

$(CONFIG): $(JSON) $(LPF)
	@echo ">> nextpnr-ecp5 place and route ($(DEVICE) $(PACKAGE) speed $(SPEED))"
	$(NEXTPNR) --$(DEVICE) --package $(PACKAGE) --speed $(SPEED) \
	  --freq $(FREQ_MHZ) \
	  --json $(JSON) \
	  --lpf $(LPF) \
	  --textcfg $(CONFIG) \
	  --log $(PNR_LOG)

pack: $(BITSTREAM)

$(BITSTREAM): $(CONFIG)
	@echo ">> ecppack -> $(BITSTREAM)"
	$(ECPPACK) --compress $(CONFIG) $(BITSTREAM) 2>&1 | tee $(PACK_LOG)

prog: $(BITSTREAM)
	@echo ">> openFPGALoader -> ULX3S"
	$(OPENFPGALOADER) -b ulx3s $(BITSTREAM)

report: $(BITSTREAM)
	@echo "E1 demo FPGA build report" > $(REPORT)
	@echo "Generated: $$(date -u +%FT%TZ)" >> $(REPORT)
	@echo "Top:       $(TOP)" >> $(REPORT)
	@echo "Device:    ECP5 $(DEVICE) $(PACKAGE) speed $(SPEED)" >> $(REPORT)
	@echo "Bitstream: $(BITSTREAM)" >> $(REPORT)
	@echo "" >> $(REPORT)
	@echo "--- nextpnr utilization (tail) ---" >> $(REPORT)
	@tail -n 60 $(PNR_LOG) >> $(REPORT) 2>/dev/null || echo "(no pnr log)" >> $(REPORT)
	@cat $(REPORT)

clean:
	rm -rf $(BUILD_DIR)
