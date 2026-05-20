# Critical Gap Review And Work Orders

Generated from the repository review pass on 2026-05-16. This file is an
execution backlog, not a completion claim. A workstream is complete only when
the listed gate passes and the evidence path contains real artifacts, logs, or
tests.

## Active Subagent Assignments

| Workstream | Subagent | Scope | First completion gate |
|---|---|---|---|
| RTL and verification | Franklin `019e34b6-afe8-7811-aac2-dde62ba4a3fa` | `rtl/**`, `verify/**`, RTL docs | `make rtl-check cocotb cocotb-contract cocotb-cpu formal` |
| Software BSP and simulation | Lorentz `019e34b6-ffd2-7862-938d-76b44a8575ff` | `sw/**`, `sim/**`, QEMU/Renode scripts | `make software-bsp-check qemu-check qemu-status-test renode-check` |
| Physical design, board, package | Kepler `019e34b7-6d1f-7063-bf7e-0f6fa7bcf1ee` | `pd/**`, `package/**`, `board/**`, manufacturing gates | `make pd-contract-check product-check` |
| Program backlog and evidence gates | Lagrange `019e34b7-b418-70c2-b3fd-011d26cd46f8` | `docs/project/**`, `docs/risks/**`, plan checks | `make project-plan-check mvp-status` |

## Review Summary

The repository is a useful CLI-first pre-tapeout scaffold. It is not yet a
complete Android phone, not yet a Linux-capable phone AP, not yet a signoff
silicon package, and not yet a manufacturable board.

The current concrete baseline is:

- a debug-MMIO e1-chip RTL path with cocotb, Verilator, synthesis, and formal
  evidence,
- a separate Linux-capable AXI-Lite contract wrapper,
- software BSP and AOSP skeletons tied to the platform contract,
- blocked physical-design, board, benchmark, and real-world release gates.

Any claim above that level must be backed by a new artifact and a passing gate.

## Workstream A: RTL, CPU, Interconnect, Memory

Assigned to Franklin.

Open gaps:

| Gap | Current evidence | Why it matters | Completion criteria |
|---|---|---|---|
| Linux-capable CPU is absent | `rtl/cpu/e1_cpu_subsystem_stub.sv`, `docs/arch/cpu-subsystem.md` | The tiny execution path is not RV64GC Linux-capable: no MMU, CSR/trap model, atomics, privilege modes, cache, or timer interrupts. | Bootable CPU integration contract exists and passes cocotb plus firmware smoke, or the repo imports a pinned external CPU generator with a reproducible build log. |
| Pad-level top and Linux scaffold are split | `rtl/top/e1_chip_top.sv`, `rtl/interconnect/e1_linux_soc_contract.sv` | The chip top validates debug MMIO, while the Linux scaffold validates a different integration shape. | A named top-level integration choice exists with a gate that proves which target is the prototype. |
| Shared memory is only a small model | `rtl/top/e1_soc_top.sv`, `rtl/memory/e1_axi_lite_dram.sv` | There is no LPDDR boundary, burst AXI, cache hierarchy, coherency, IOMMU, or QoS. | Memory hierarchy plan is represented in machine-readable contract and at least one burst-capable fabric or explicit blocked gate exists. |
| DMA is not a production DMA engine | `rtl/dma/e1_dma.sv` | It has useful command-state behavior, but no descriptor rings, scatter/gather, IOMMU isolation, interrupts per queue, or real software ABI. | Descriptor contract, error model, and protocol assertions exist; cocotb covers alignment, partial strobes, errors, and backpressure. |
| Display is not a phone display pipeline | `rtl/display/e1_display.sv` | Current scanout is timing/test-pattern oriented and lacks DSI, panel init, FIFO, underrun handling, composition, rotation, color, and DRM/KMS contract depth. | Framebuffer fetch, underflow status, format coverage, and driver-facing register tests pass. |
| NPU is a scalar/tile demonstrator | `rtl/npu/e1_npu.sv`, `docs/arch/npu.md` | It is not a tensor subsystem: no command queue, scratchpad management, compiler ABI, DMA descriptors, NNAPI delegate, or memory protection. | A versioned NPU command ABI, runtime smoke, and operator coverage report exist. |
| Security subsystem is documentation-only | `docs/arch/security.md` | No ROM verification, fuses, lifecycle states, key ladder, TRNG, debug authentication, or secure update. | Security lifecycle state machine and fail-closed debug policy are implemented or explicitly blocked by a checked gate. |

Immediate work orders:

1. Add a machine-readable RTL gap inventory consumed by `verify/check_stub_audit.py`.
2. Expand cocotb coverage for NPU opcodes, DMA strobes/errors, display mode edges, and AXI-Lite stalls.
3. Add formal/protocol assertions for reset, address decode, AXI-Lite response, and interrupt claim/complete behavior.
4. Decide and encode whether the current prototype target is the debug-MMIO chip or the Linux-capable AP scaffold.

## Workstream B: Firmware, Linux, Android, Simulation

Assigned to Lorentz.

Open gaps:

| Gap | Current evidence | Why it matters | Completion criteria |
|---|---|---|---|
| QEMU is a qemu-virt reference path | `scripts/run_qemu.sh`, `docs/sim/qemu/README.md` | Passing qemu-virt proves software plumbing, not the e1-chip hardware ABI. | `make qemu-check` reports PASS only with serial transcript and compiled firmware, otherwise BLOCK with exact missing tool or artifact. |
| Renode does not model e1 hardware | `sim/renode/eliza_e1.repl`, `docs/sim/renode/README.md` | It models a generic CPU/RAM/UART shape, not the current MMIO map. | Renode check is either a real model with transcript or explicitly blocked as non-evidence. |
| OpenSBI/U-Boot are not integrated | `docs/sw/opensbi/README.md`, `docs/sw/u-boot/README.md` | Android/Linux AP bring-up needs a real boot chain. | Pinned build recipe, config fragments, and transcript exist for a bootable target. |
| Linux DTS is not a bootable platform | `sw/linux/dts/eliza-e1.dts` | It lacks a complete real RISC-V AP platform with CPU, timer, UART, memory, and usable interrupt topology for Linux boot. | DTS compiles in an external kernel tree and a boot transcript or blocked-gate report is archived. |
| Linux drivers are scaffold-only | `sw/linux/drivers/e1/**` | Drivers name the ABI, but there is no proven kernel build, device-node access, or runtime hardware smoke. | External kernel import script builds modules and runs `e1-mmio-smoke` against a real or emulated device. |
| AOSP device tree is not boot proof | `sw/aosp-device/**`, `docs/android/riscv-bringup.md` | Product files and HAL manifests exist, but no `lunch`, build transcript, Cuttlefish launch, SELinux log, CTS/VTS subset, or HAL binary proof is present. | AOSP import script produces a buildable target or reports blocked dependencies; logs are archived. |
| Android HALs are stubs | `manifest.xml`, `init.eliza.rc`, `sepolicy/e1_npu.te` | The manifest references a future `e1_npu` service; no implemented service, AIDL interface, or fail-closed behavior is proven. | HAL service compiles, fails closed when `/dev/e1-npu` is absent, and has a host/unit test. |

Immediate work orders:

1. Split scaffold checks from executable boot checks everywhere they are currently mixed.
2. Make QEMU status parsing fail-closed and archive serial output when tools exist.
3. Generate Linux/AOSP include or DTS fragments from `sw/platform/e1_platform_contract.json`.
4. Add a fail-closed NPU HAL skeleton or remove any manifest claim that implies it exists.

## Workstream C: Physical Design, Package, FPGA, Board

Assigned to Kepler.

Open gaps:

| Gap | Current evidence | Why it matters | Completion criteria |
|---|---|---|---|
| No real PD run artifacts | `pd/signoff/manifest.yaml`, `pd/openlane/config*.json` | There is no final GDS, DEF, netlist, SDC, clean DRC/LVS/antenna/STA, utilization, congestion, timing-corner, or tool-version evidence. | `make pd-signoff-check` passes against one real run directory and blocked gates are cleared only by evidence. |
| Package is a placeholder | `docs/package/e1-demo-package.md`, `package/e1-demo-pinout.yaml` | QFN64 planning data is not a foundry or package-vendor drawing. | Vendor package drawing, footprint source, bond diagram, and package electrical model are archived. |
| Padframe is a contract scaffold | `pd/padframe/e1_demo_padframe.yaml` | No foundry IO cells, ESD clamps, corner cells, power domains, pad-ring DRC/LVS, or bonding strategy. | Padframe-inclusive design passes checks with selected IO library and release evidence. |
| Board is not manufacturable | `docs/board/README.md`, `board/README.md`, `docs/board/kicad/e1-demo/fab-notes.md` | No real KiCad project, stackup, footprint, BOM, decap plan, DFM review, SI/PI review, or test-point plan. | Board release manifest references checked schematic/PCB/fab outputs and DFM signoff. |
| FPGA bitstream is blocked | `board/fpga/e1_demo_fpga.yaml`, `constraints/e1_demo_ulx3s.lpf` | Board revision and pins are intentionally unassigned; no nextpnr/ecppack/timing evidence. | Exact board revision, IO standards, pins, bitstream build, timing report, and bring-up transcript exist. |
| Power and thermal are estimates | `docs/manufacturing/real-world-verification-gaps.yaml` | No post-route power, IR/EM, PDN, current-limit, thermal, or bench measurements. | Current budgets and stop conditions are enforced in release manifest and first-article procedure. |

Immediate work orders:

1. Extend physical release gates so placeholder package, padframe, board, and PD artifacts cannot be misread as signoff.
2. Add missing required evidence classes: utilization, congestion, corner record, SPEF/SDF, fill/density, waiver metadata, package model, and board DFM.
3. Keep FPGA release blocked until real board pins exist; do not assign guessed pins.

## Workstream D: Benchmarks, Toolchain, CI, Release Evidence

Assigned to Lagrange for backlog, with support from all implementation workers.

Open gaps:

| Gap | Current evidence | Why it matters | Completion criteria |
|---|---|---|---|
| Benchmarks are dry-run/planned | `benchmarks/run_benchmarks.py`, `docs/benchmarks/**` | They prevent false claims, but do not yet produce phone-class performance evidence. | At least one CPU, memory, storage, graphics, and NPU workload produces schema-valid measured output for a declared claim level. |
| Toolchain still has floating inputs | `Dockerfile`, `flake.nix`, bootstrap scripts | Reproducibility can drift through apt, Nix, OpenLane, Chipyard, PDKs, or Python packages. | Lockfiles, image digests, source SHAs, and tool reports are archived by release. |
| CI does not prove heavy gates | `.github/workflows/ci.yml`, `Makefile` | Fast CI covers scaffold quality, not OpenLane/Renode/KiCad/AOSP/FPGA signoff. | Heavy gates are either split into explicit jobs or listed as blocked release requirements. |
| Release archive may package scaffold evidence | `scripts/archive_release.sh`, `scripts/pipeline_check.py` | A passing archive can be mistaken for product readiness if claim level is not clear. | Archive includes claim level, blocked gates, and failed/not-run heavy gate summary. |
| Stub audit has narrow ownership | `verify/check_stub_audit.py` | Many stubs are allowed or outside the current owned path. | Stub inventory is centralized, reviewed, and tied to owners, gates, and acceptable claim levels. |

Immediate work orders:

1. Add this gap-review document to `make project-plan-check`.
2. Extend MVP status output so PASS/BLOCK/FAIL includes claim level and next evidence command.
3. Require release archives to include blocked-gate summary and tool-version report.

## Workstream E: Phone Product Features Not Started

No implementation owner yet. These are full product gaps, not week-one tasks.

| Feature area | Current state | Missing before phone claim |
|---|---|---|
| Cellular | External modem strategy only | Module selection, RIL integration, SIM/eSIM, antenna plan, certification path, call/data tests. |
| Wi-Fi/Bluetooth/GNSS/NFC | Interface contract scaffold only | Host controller RTL or module integration, Linux drivers, firmware loading, coexistence, antennas, Android HALs. |
| Camera/ISP | Explicitly excluded or absent | Sensor module, CSI/PHY, ISP or UVC path, Camera HAL, tuning, calibration, image-quality validation. |
| Audio | Absent | Codec/I2S/TDM/PDM, speakers/mics, Audio HAL, routing, latency, acoustic validation. |
| Sensors/input/haptics | Mostly absent | I2C/SPI controllers, Android Sensor HAL, calibration, suspend/resume wake behavior. |
| USB/storage | Mostly absent | USB device/host, fastboot/ADB path, eMMC/UFS/SD controller, partitioning, AVB, update flow. |
| Battery/PMIC | Board-level planning only | PMIC interface, charger, fuel gauge, thermal safety, Android health/power HALs. |
| Security/compliance | Documentation only | Secure boot, key storage, debug lock, rollback protection, FCC/PTCRB/GCF/CE/USB/Bluetooth/Wi-Fi certification artifacts. |

## Claim Rules

- `PASS` means the exact gate named in the workstream passed and artifacts exist.
- `BLOCK` means the work is structurally represented but lacks tools, hardware, vendor artifacts, or transcripts.
- `FAIL` means a required local gate failed and must be fixed before higher-level claims.
- A scaffold check is never a boot proof, signoff proof, board proof, Android compatibility proof, or phone proof.
- The phrase complete phone is reserved for claim level `L6_COMPLETE_PHONE` with hardware, software, certification, and compatibility evidence.
