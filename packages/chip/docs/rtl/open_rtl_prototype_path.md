# Open RTL Prototype Path

This note defines the first open RTL path for a Linux-first, Android-capable
RISC-V SoC prototype. It is scoped to RTL bring-up and simulation. The current
handwritten `e1_soc` remains the small contract harness; the first Linux-capable
CPU subsystem should be generated through Chipyard and wrapped behind the same
memory-map, interrupt, DMA, display, and accelerator contracts.

## v0 Baseline Decision

Use Chipyard with a small Rocket-based RV64GC subsystem as v0.

Initial target:

```text
Chipyard SoC generator
1x Rocket RV64GC application core
CLINT + PLIC
UART
DRAM model
Boot ROM path to OpenSBI + Linux
TileLink attachment point for Gemmini
AXI/MMIO attachment point for NPU, display, DMA, and future NVDLA wrapper
FireSim compatibility kept as a first-class constraint
```

Scale to 2x Rocket only after a single-hart Linux boot is repeatable in CI or
nightly simulation. BOOM is the first performance-oriented follow-up, not the
first baseline.

Rationale:

- Rocket is the lowest-risk Linux-capable Chipyard path and is already integrated
  with Chipyard, FireMarshal, FireSim, RoCC, TileLink, Verilator generation, and
  Gemmini examples.
- Chipyard keeps CPU, interconnect, boot flow, simulator, and FireSim collateral
  in one generator stack. That is more useful for a first open prototype than
  manually integrating a standalone core.
- Gemmini integration is native to the Rocket/BOOM RoCC path, so accelerator
  bring-up can start with known software tests before Android-facing NN/runtime
  work begins.
- Android capability depends first on boring Linux fundamentals: RV64GC with
  S-mode and MMU, interrupts, timers, coherent memory, DMA, boot firmware,
  device tree, and stable userspace ABI. Rocket satisfies the CPU-side starting
  point without forcing an out-of-order core into v0.

Do not claim phone-class CPU, GPU, NPU, or Android application performance from
this baseline. v0 proves bootability, integration, observability, and a path to
measurements.

## Core Comparison

| Candidate | Fit for v0 | Strengths | Main v0 risks | Decision |
| --- | --- | --- | --- | --- |
| Chipyard Rocket | High | Linux-capable RV64GC path, simple in-order core, mature Chipyard/FireSim/Gemmini integration, easier debug | Not representative of final mobile CPU performance | Pick for v0 |
| Chipyard BOOM | Medium | Open out-of-order RV64GC core in same Chipyard ecosystem, good follow-on for CPU exploration | More complex debug, longer simulation and FPGA builds, higher integration risk | Defer to v1 perf branch |
| CVA6 | Medium | SystemVerilog application-class core, Linux-capable configurations, OpenHW ecosystem | Less direct Gemmini/RoCC/FireSim path; integration work shifts onto this repo earlier | Track as alternate standalone CPU path |
| OpenC910 | Low/Medium | Higher-complexity application-class core with existing Linux/SoC heritage | More integration and verification burden; less aligned with Chipyard/Gemmini flow | Defer until baseline metrics exist |
| XiangShan | Low for v0, high for research | High-performance open RV64 core family, active project | Very large generator/core stack, debug and FPGA iteration cost, not needed for first boot | Research branch only |

Source anchors used for this decision:

- Chipyard stable docs: `https://chipyard.readthedocs.io/en/stable/`
- Chipyard Gemmini docs: `https://chipyard.readthedocs.io/en/stable/Generators/Gemmini.html`
- FireSim docs: `https://docs.fires.im/en/latest/`
- CVA6 user manual: `https://docs.openhwgroup.org/projects/cva6-user-manual/`
- CVA6 repository: `https://github.com/openhwgroup/cva6`
- OpenC910 repository: `https://github.com/T-head-Semi/openc910`
- XiangShan repository: `https://github.com/OpenXiangShan/XiangShan`
- NVDLA hardware repository: `https://github.com/nvdla/hw`
- NVDLA integration guide: `https://nvdla.org/hw/v1/integration_guide.html`

## Repository Setup

Keep heavy generated stacks out of the normal fast CI image. They belong under
`external/` and should be reproducible from pinned commits.

Bootstrap the current Chipyard slot:

```sh
scripts/bootstrap_chipyard.sh
cd external/chipyard
git rev-parse HEAD
git submodule status --recursive > ../../build/chipyard-submodules.txt
```

Before any generated RTL is accepted into this repo, record:

```text
external/chipyard git SHA
recursive submodule SHAs
Chipyard setup command used
Scala/JDK/SBT versions
Verilator version
FireSim version, if used
Gemmini SHA, if not exactly the Chipyard submodule version
```

Expected host dependencies for Linux CPU subsystem work:

```text
Ubuntu 22.04 or 24.04 host/container
git
make
gcc/g++
device-tree-compiler
JDK version supported by the selected Chipyard release
sbt or Chipyard-managed Scala toolchain
Verilator
RISC-V GNU toolchain or Chipyard esp-tools flow
QEMU riscv64 system emulator for software cross-checks
OpenSBI
U-Boot, once the boot flow moves past direct kernel payloads
Buildroot or Debian/Fedora riscv64 rootfs image for first Linux boot
```

Expected additional dependencies for hardware acceleration:

```text
FireSim manager environment
Xilinx Vivado/Vitis version required by the selected FireSim platform
Supported FPGA host, for example an Alveo or VCU118 class board
AWS EC2 FPGA setup only if the project intentionally uses cloud FPGA capacity
```

Expected Android-facing dependencies, deferred until Linux is stable:

```text
AOSP riscv64 tree/toolchain selected by the software owner
device/eliza/eliza_ai_soc board files
Linux kernel config with binder, ashmem/memfd replacement path as needed,
  dma-buf, DRM/display, input, block, network, and SELinux support
Android boot image packaging path
```

## RTL Integration Plan

1. Keep `rtl/top/e1_soc_top.sv` and `rtl/interconnect/e1_linux_soc_contract.sv`
   as the fast handwritten contract path.
2. Add generated Chipyard RTL only through a documented generator target that
   records SHAs and config names.
3. Put generated or wrapped CPU subsystem RTL under a future `rtl/wrappers/`
   tree. Do not hand-edit generated Verilog.
4. Expose a narrow top-level wrapper contract:

```text
clock/reset
UART
external interrupt lines
DRAM AXI or TileLink-backed memory port
MMIO window for e1 DMA/NPU/display/peripherals
optional RoCC accelerator port for Gemmini configs
debug/JTAG only after basic boot works
```

5. Preserve the current MMIO map until Linux drivers and tests are deliberately
   migrated.
6. Treat CVA6/OpenC910/XiangShan as alternate CPU subsystem experiments with
   their own wrappers after the Rocket baseline has a passing boot log and
   benchmark harness.

## First Simulations

Fast local checks continue to validate the repo-owned handwritten RTL:

```sh
make clean ci-fast
make qemu-check
make renode-check
```

First generated Chipyard simulations should be:

```sh
cd external/chipyard
source env.sh
cd sims/verilator
make CONFIG=RocketConfig
./simulator-chipyard-RocketConfig /path/to/riscv-smoke.riscv
```

Project-specific configs should then be added in Chipyard as:

```text
ElizaRocketConfig
ElizaGemminiRocketConfig
ElizaBoomConfig, later only
```

Expected first-pass results:

```text
Bare-metal UART e1 exits or prints expected text
OpenSBI reaches next boot stage
Linux kernel reaches early console
Linux mounts initramfs and runs e1-mmio-smoke
IRQ smoke toggles timer/external interrupt path
DMA/NPU/display MMIO registers are visible from userspace test binaries
```

Acceptable first failures:

```text
Linux boot stops at missing block/network/display devices
Gemmini Linux tests build but need workload/rootfs cleanup
Android userspace is not bootable yet
FireSim bitstream build is manual or nightly-only
```

Not acceptable:

```text
Unpinned generator output
Generated Verilog edited by hand
Performance claims without a committed workload, image, simulator, and log
Skipping Linux boot logs before starting Android claims
```

## CI Jobs

Keep the existing fast job as the always-on gate:

```text
ci-fast:
  make clean ci-fast
  upload build/reports, netlists, cocotb XML, formal logs
```

Add a non-default generated-RTL job once the Chipyard config exists:

```text
chipyard-elaborate:
  bootstrap external/chipyard from pinned SHA/cache
  source Chipyard environment
  elaborate ElizaRocketConfig
  run FIRRTL/Verilog generation
  archive generated config manifest and elaboration logs
```

Add a scheduled or manually triggered simulation job:

```text
chipyard-verilator-smoke:
  build ElizaRocketConfig Verilator simulator
  run bare-metal UART smoke
  run OpenSBI + Linux early-boot smoke when image cache is available
  archive UART logs, boot logs, simulator command line, generated DTS
```

Add a separate accelerator job after Gemmini is enabled:

```text
gemmini-smoke:
  build ElizaGemminiRocketConfig
  build gemmini-rocc-tests baremetal and linux binaries
  run ISA-level Gemmini tests where supported
  run one RTL simulator Gemmini bare-metal test
  archive generated gemmini_params.h and test logs
```

Add FireSim only as manual/nightly infrastructure:

```text
firesim-build:
  elaborate selected FireSim target config
  run metasimulation if available
  build FPGA image on approved host only
  archive FireSim manager config, build logs, AGFI/bitstream metadata where
    policy allows

firesim-run:
  deploy known-good image
  boot Linux workload
  collect console logs, TracerV/printf/assertion artifacts if enabled
```

No pull-request job should require a commercial FPGA tool license or cloud FPGA
quota.

## FireSim and FPGA Path

The realistic acceleration path is:

1. Keep v0 inside Chipyard-compatible generators.
2. Run Rocket and Gemmini configs in Verilator until bare-metal and Linux logs
   are deterministic.
3. Enable FireSim target generation for the same configs.
4. Run FireSim metasimulation before spending FPGA build time.
5. Build a single-node FPGA image for the Rocket-only target.
6. Boot the same Linux image used in Verilator.
7. Add Gemmini to the FireSim target only after Rocket-only boot is stable.
8. Use FireSim debug features only to answer specific failures: synthesized
   assertions for invariants, printf synthesis for targeted traces, TracerV for
   instruction traces.

FPGA targets should be treated as simulation accelerators, not product FPGA
prototypes. Board-level FPGA bring-up for I/O belongs to the board flow; FireSim
belongs to full-system RTL execution.

## Accelerator Path

### Gemmini

Gemmini is the v0 accelerator path because it is already a Chipyard generator
and attaches as a RoCC accelerator to Rocket/BOOM. Start with the default
Gemmini config before changing array sizes, queues, DMA width, or dataflow.

What can be benchmarked honestly:

```text
Bare-metal Gemmini unit tests pass/fail and instruction traces
Linux Gemmini matmul/convolution test correctness
Cycle counts from a specific RTL simulator build and workload
FireSim run time for the same committed workload, reported as local measurement
Kernel/userspace driver overhead for submitting fixed test kernels
End-to-end tiny model latency only when model, quantization, batch size,
  memory layout, rootfs, compiler, and simulator target are committed
```

What should not be claimed from v0:

```text
Android NNAPI performance
Phone-class TOPS
Power efficiency
Thermal behavior
Comparisons against mobile NPUs
```

### NVDLA

NVDLA is a second accelerator path, not the v0 path. It should be evaluated as
an AXI/MMIO block behind the SoC interconnect, with a Linux driver and memory
allocation story before Android integration is attempted.

NVDLA bring-up sequence:

```text
Import unmodified NVDLA RTL under an external dependency or generated wrapper
Select one documented NVDLA configuration
Wrap CSB/MMIO control path into the SoC MMIO map
Connect AXI data path to coherent or explicitly managed DMA memory
Run lint/elaboration without modifying third-party RTL
Run register-access smoke
Run smallest available firmware/software correctness test
Only then connect Android HAL/NNAPI experiments
```

What can be benchmarked honestly:

```text
Register smoke and command submission latency
Memory bandwidth requirements from traces
Correctness on fixed convolution or tensor workloads
Driver overhead and DMA mapping behavior under Linux
FireSim/FPGA feasibility if the design fits the selected target
```

## Benchmark Policy

Every benchmark result must include:

```text
git SHA for this repo
Chipyard/FireSim/Gemmini/NVDLA SHAs
RTL config name
simulator or FPGA target
tool versions
software image hash
kernel command line
workload source and input hash
exact command line
raw log
```

Report only measured values. Label Verilator, FireSim, FPGA-hosted simulation,
FPGA prototype, and ASIC estimates separately. Do not extrapolate Android
performance from bare-metal tests.

## Milestones

```text
M0: current e1 RTL remains green under make ci-fast
M1: Chipyard checkout pinned and ElizaRocketConfig elaborates
M2: Rocket bare-metal UART smoke runs in Verilator
M3: OpenSBI + Linux early console runs in Verilator
M4: Linux initramfs runs e1-mmio-smoke against the project MMIO contract
M5: Gemmini default config runs one bare-metal correctness test
M6: Gemmini Linux test runs in the same rootfs as the MMIO smoke
M7: Rocket-only FireSim metasimulation passes
M8: Rocket-only FPGA-hosted FireSim boots the Linux smoke image
M9: Gemmini FireSim target runs the committed accelerator workload
M10: Android boot investigation starts from a stable Linux kernel/device tree
```

The first Android-capable claim is allowed only after M10 has a boot log, device
tree, kernel config, rootfs/userspace image, and failure list. Before that, this
is a Linux-first SoC prototype with an Android-oriented contract.
