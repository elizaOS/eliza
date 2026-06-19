# E1 demo FPGA target

The owned FPGA bring-up target is `e1_demo_fpga`. It is a non-fabrication target used to keep the chip-level interface runnable on a lab board before padframe and package data are final.

## Target scope

- Top-level RTL: `e1_chip_top`
- Primary board class: Radiona/FER ULX3S 85F bring-up board
- Synthesis family: ECP5
- Intended flow: Yosys plus nextpnr-ecp5 when installed locally
- Clock input: single 25 MHz board oscillator adapted to `CLK_IN`
- Reset input: active-low pushbutton or supervisor adapted to `RST_N`
- Debug transport: low-speed GPIO bridge driving the demo MMIO pins
- GPIO outputs: eight LEDs or header pins
- IRQ outputs: routed to header pins or logic analyzer probes

The target contract is machine-readable in `board/fpga/e1_demo_fpga.yaml`. The constraints file in `board/fpga/constraints/e1_demo_ulx3s.lpf` now carries a preliminary ULX3S 85F mapping for the clock, reset, LEDs, low-speed debug bridge, IRQ probes, and reserved user JTAG-like pins. It is still a scaffold, not release evidence, until the exact board revision and bring-up transcript are archived.

## Local build path

The deployable local flow is recorded in `board/fpga/artifact-manifest.yaml`. With OSS CAD Suite or equivalent tools on `PATH`, the assumed manual sequence is:

```sh
mkdir -p board/fpga/build board/fpga/reports
yosys -p "read_verilog -sv rtl/top/e1_chip_top.sv rtl/clock/e1_reset_sync.sv rtl/debug/e1_dbg_mmio_bridge.sv rtl/top/e1_soc_top.sv rtl/bootrom/e1_bootrom.sv rtl/dma/e1_dma.sv rtl/npu/e1_npu.sv rtl/display/e1_display.sv rtl/peripherals/e1_peripherals.sv rtl/cpu/e1_cpu_subsystem_stub.sv rtl/interconnect/e1_axi_lite_interconnect.sv rtl/memory/e1_axi_lite_dram.sv rtl/interrupts/e1_interrupt_controller.sv rtl/interconnect/e1_linux_soc_contract.sv; synth_ecp5 -top e1_chip_top -json board/fpga/build/e1_demo_fpga.json"
nextpnr-ecp5 --85k --package CABGA381 --freq 25 --json board/fpga/build/e1_demo_fpga.json --lpf board/fpga/constraints/e1_demo_ulx3s.lpf --textcfg board/fpga/build/e1_demo_fpga.config --report board/fpga/reports/e1_demo_nextpnr.json
ecppack --svf board/fpga/build/e1_demo_fpga.svf board/fpga/build/e1_demo_fpga.config board/fpga/build/e1_demo_fpga.bit
```

For SRAM-only programming on a lab ULX3S:

```sh
openFPGALoader -b ulx3s board/fpga/build/e1_demo_fpga.bit
```

Do not use this path for flash programming or release claims until `board/fpga/release_manifest.yaml` is complete.

## Gates

`make fpga-check` validates that the FPGA contract names the RTL top, clock, reset, debug, GPIO, and IRQ signals consistently with the current package and RTL contract. The check is a scaffold gate, not a bitstream build.

`make fpga-release-check` runs the stricter bitstream release preflight in `scripts/check_fpga_release.py`. It must fail until `board/fpga/e1_demo_fpga.yaml` and `board/fpga/release_manifest.yaml` name a real board revision, final LPF, timing report, bitstream, bitstream SHA-256, and tool-version archive.

Bitstream generation must remain blocked until the following release evidence is
checked in:

- Every `e1_chip_top` external signal has an assigned FPGA package pin.
- The assigned board revision is recorded.
- The clock constraint matches the physical oscillator.
- Reset polarity is verified on hardware.
- The debug bridge firmware or MCU host is identified.
