# Critical Gap Review - 2026-05-17

This is a critical review of stubs, scaffolds, LARP risks, open gaps,
partial implementations, missing evidence, and untested claims. It is not a
completion report. A gap is closed only when the listed gate passes with real
evidence or the claim is removed from scope.

## Active Subagent Workstreams

| Workstream | Subagent | Ownership | Completion gate |
|---|---|---|---|
| RTL/SoC critical audit | Franklin `019e34c0-9264-7fe0-a2e7-a9caf1989384` | `rtl/**`, `verify/**`, RTL architecture docs, platform contract as needed | `make stub-audit rtl-check synth formal` |
| Android/Linux/BSP audit | Carver `019e34c0-98d9-7141-b9af-452825d4c628` | `sw/**`, Android/Linux docs, BSP scaffold checkers | `make software-bsp-check aosp-bsp-check` |
| Board/package/PD/FPGA audit | Darwin `019e34c0-9f35-7051-9791-60bcb2198299` | `pd/**`, `package/**`, `board/**`, manufacturing and tapeout docs/checkers | `make product-check pd-contract-check fpga-check padframe-check` |
| Benchmarks/toolchain/sim audit | Boyle `019e34c0-a577-76b3-9d79-77a7e96c76e1` | `benchmarks/**`, `sim/**`, `scripts/check_tools.sh`, QEMU/Renode, toolchain docs | `make qemu-status-test benchmarks-dry-run tools` |

## Pass 2 Review Method

This pass searched for explicit and implicit gap markers: task tags,
fix-me tags, `stub`, `placeholder`, unsupported-implementation phrases,
deferred-status words, `blocked`, `scaffold`, `skeleton`, unresolved-owner
labels, `mock`, `dummy`, `fake`,
`software reference only`, and missing-tool paths. The results below are
classified by whether they are release blockers, implementation gaps, test
gaps, claim-boundary risks, or normal generated-artifact rerun requirements.

The most important rule remains: a local scaffold check may prove that a gap is
tracked, but it does not prove the real subsystem exists.

## Highest-Risk Findings

| Priority | Finding | Current posture | Required closure |
|---|---|---|---|
| P0 | The project can still look more complete than it is if generated build artifacts are absent or stale. | `make mvp-status` reports missing synthesis, Verilator, benchmark, and release artifacts as `BLOCK`; some are regenerated outputs, not source gaps. | Status output must distinguish "rerun needed" from "external blocker" and `pipeline-check` must own release evidence freshness. |
| P0 | The CPU path is not a production CPU or Linux-capable AP. | `e1_cpu_subsystem_stub` is a tiny executable RV subset with no RV64GC, CSR/trap, MMU/cache, privilege, timer, or interrupt handling. | Either integrate a pinned real core/generator or keep the CPU/AP path explicitly blocked with a boot-proof gate. |
| P0 | QEMU/Renode are not e1-chip hardware proof. | QEMU is qemu-virt firmware reference; Renode is a scaffold and blocked without the executable. | Scripts must only report PASS with a transcript from the exact target and must continue to label qemu-virt proof separately. |
| P0 | Physical product artifacts are not manufacturable or tapeout-ready. | Package, padframe, board, SI/PI, PDN, current, and lab evidence are blocked or placeholder. | Keep release gates blocked until vendor/foundry/board/lab artifacts exist and pass checkers. |
| P1 | Benchmarks are dry-run/planned, not performance evidence. | Missing CoreMark/STREAM/lmbench/fio/TFLite tools and model artifact are recorded. | Real reports must include claim level, platform, clocks, power/thermal, artifacts, and unsupported/fallback accounting. |
| P1 | Display/NPU/DMA are useful prototypes, not product subsystems. | Tests exist, but release-grade command queues, memory protection, framebuffer fetch, DSI/panel, backpressure, and coverage are incomplete. | Expand RTL/software contracts and tests before any phone-class claim. |
| P1 | Boot ROM and security are placeholder-level. | Boot ROM exposes contract words; security lifecycle, secure boot, key/fuse/debug auth are documentation-only. | Add a real boot program and fail-closed security lifecycle or explicitly exclude them from the release claim. |
| P2 | Toolchain reproducibility remains partial. | Fast tools are checked; heavy tools/images/upstreams are blocked or floating. | Pin external refs/digests and archive tool-version reports for every claimed gate. |

## Pass 2 Detailed Gap Inventory

| Workstream | Finding | Classification | Current evidence | Required subagent action |
|---|---|---|---|---|
| RTL/SoC | `rtl/cpu/e1_cpu_subsystem_stub.sv` remains in the synthesis source list. | Intentional stub / release blocker | Tiny CPU contract model and cocotb tests exist, but not a Linux-capable RV64GC AP. | Franklin must keep it explicitly inventoried or rename/wrap it so no release claim treats it as production CPU IP. |
| RTL/SoC | `e1_chip_top` debug-MMIO path and `e1_linux_soc_contract` AP scaffold prove different things. | Claim-boundary risk | Separate cocotb targets exercise different topologies. | Franklin must make all status/docs/check output name the exact proven boundary. |
| RTL/SoC | Top-level deep formal is solver-heavy and not routine CI. | Test gap | Routine `make formal` uses module SymbiYosys plus structural top-level Yosys evidence. | Franklin must document deep formal as a separate gate and ensure routine formal is not described as exhaustive SoC proof. |
| RTL/SoC | NPU remains a bounded scratch/GEMM prototype. | Implementation gap | MMIO/GEMM tests and runtime scaffolding exist. | Franklin must add operator coverage inventory and keep unsupported/fallback accounting explicit. |
| RTL/SoC | Display lacks phone panel path. | Implementation gap | Timing/register tests exist; no DSI/PHY/DRM/panel init. | Franklin must list panel/scanout/underflow/framebuffer gaps in machine-readable RTL work order. |
| RTL/SoC | Security and boot ROM are not real phone security. | Complete gap | Boot ROM exposes contract words; security docs are policy only. | Franklin must keep secure boot/key/fuse/debug-auth as explicit blockers. |
| Android/Linux/BSP | AOSP files are product scaffolds, not a bootable Android target. | LARP risk | `BoardConfig.mk`, `device.mk`, VINTF, init, SELinux snippets exist. | Carver must ensure `aosp-bsp-check` cannot be read as boot/CTS/VTS evidence. |
| Android/Linux/BSP | HAL entries do not correspond to built services. | Stub | VINTF names e1 NPU/HWC scaffolds; no compiled HAL artifact is archived. | Carver must add blocker metadata or a fail-closed host-unit-tested HAL skeleton. |
| Android/Linux/BSP | Linux DTS/drivers are not built in a kernel tree. | Untested | DTS, driver sources, smoke C file, and scaffold checks exist. | Carver must separate source scaffold checks from external kernel build/runtime checks. |
| Android/Linux/BSP | OpenSBI/U-Boot/Buildroot imports are external-tree blockers. | Blocked | README/import scripts describe workflows. | Carver must pin expected external refs or keep them named as unresolved dependencies. |
| Android/Linux/BSP | QEMU/Renode are qemu-virt software references, not e1-chip hardware proof. | Claim-boundary risk | QEMU firmware path exists; Renode is blocked. | Carver/Boyle must keep strict transcript gates separate from non-strict scaffold status. |
| Board/package/PD/FPGA | `docs/package/e1-demo-package.md` and `package: qfn64_placeholder` are not vendor package artifacts. | Placeholder / release blocker | Pinout/package docs exist for planning only. | Darwin must keep fabrication/tapeout gates blocked until vendor drawing/bond/footprint evidence exists. |
| Board/package/PD/FPGA | Padframe is a contract scaffold, not a foundry IO ring. | Scaffold / release blocker | `pd/padframe/e1_demo_padframe.yaml` and signoff manifest list blockers. | Darwin must ensure product checks do not imply padframe signoff. |
| Board/package/PD/FPGA | No real KiCad project exists. | Complete gap | `docs/board/kicad/e1-demo/fab-notes.md` only. | Darwin must list missing schematic/PCB/ERC/DRC/Gerber/drill/BOM/PnP/DFM gates. |
| Board/package/PD/FPGA | FPGA LPF is a skeleton. | Blocked | Board revision and pins are unassigned. | Darwin must keep bitstream release blocked until exact board pins and IO standards exist. |
| Board/package/PD/FPGA | OpenLane/OpenROAD signoff is not complete. | Blocked | Configs/manifests exist; no full clean signoff run. | Darwin must make missing GDS/DEF/netlist/STA/DRC/LVS/SPEF/SDF/power/congestion/density evidence explicit. |
| Benchmarks/toolchain/sim | Benchmark reports are dry-run/planned. | Missing dependency / no performance evidence | CoreMark/STREAM/lmbench/fio/TFLite report missing tools or model. | Boyle must keep blocked assets machine-readable and prevent simulator wall-clock comparisons. |
| Benchmarks/toolchain/sim | TFLite model generator is blocked without TensorFlow. | Missing tool | `benchmarks/results/tflite-generator-status.json` reports `TFLITE_SMOKE_MODEL_GENERATOR_UNAVAILABLE`. | Boyle must keep generator status in release evidence and avoid placeholder model commits. |
| Benchmarks/toolchain/sim | `scripts/test_qemu_smoke_status.py` uses fake tools for status behavior only. | Test double / possible LARP risk | Fake compiler/QEMU tests validate pass/block/fail parsing. | Boyle must ensure fake-tool tests are never counted as execution evidence. |
| Benchmarks/toolchain/sim | Toolchain reproducibility is partial. | Reproducibility gap | Dockerfile, flake, bootstrap scripts, tool report exist; heavy deps still external. | Boyle must list every floating external input and its pinning requirement. |
| Release/status | `make mvp-status` has PASS rows for scaffold quality and BLOCK rows for real product gaps. | Reporting risk | Status output is honest but easy to skim incorrectly. | All workers must ensure each PASS names its claim boundary and each BLOCK names the next evidence command. |

## Workstream A: RTL, CPU, Interconnect, Memory, Display, NPU

| Gap | Type | Evidence today | Local close task | Release closure |
|---|---|---|---|---|
| Legacy `e1_cpu_subsystem_stub` boundary | Stub/name debt | `rtl/cpu/e1_cpu_subsystem_stub.sv`, `verify/rtl_gap_work_order.yaml` | Rename or wrap with a non-stub module name without breaking tests; keep compatibility shim only if audited. | Pinned real CPU integration or explicit CPU-not-in-scope gate. |
| Tiny CPU subset | Complete gap | `make cocotb-cpu` proves a small instruction subset only. | Add more fail-closed tests for illegal, unaligned, bus-error, interrupt-pending, and reset behavior. | RV64GC/privileged boot path with timer, IRQ, UART, RAM, DTS, and boot transcript. |
| Pad-level chip vs Linux scaffold split | LARP risk | `e1_chip_top` and `e1_linux_soc_contract` prove different boundaries. | Add status/check output that names the proven boundary for each test. | One selected prototype top with end-to-end software and RTL evidence. |
| DRAM is SRAM-backed | Scaffold | `e1_soc_top` debug-visible DRAM aperture; `e1_axi_lite_dram` model. | Keep size/semantics machine-documented and tested for DMA/MMIO consistency. | External memory controller/PHY or a blocked DRAM-controller gate. |
| Display scanout lacks real framebuffer integration | Untested/partial | Display registers/timing tests, constant data in top integration. | Add framebuffer fetch contract tests and underflow/status behavior. | Panel/DSI/DRM path, pixel formats, bandwidth, underrun, and driver tests. |
| NPU is a bounded GEMM prototype | Prototype gap | Scratchpad GEMM and MMIO tests. | Add operator coverage report and fail-closed unsupported-op accounting. | Command queue, DMA descriptors, runtime ABI, NNAPI/delegate, and system memory protection. |
| Boot ROM placeholder | Placeholder | `boot_vector_placeholder` contract word. | Replace placeholder word with a tiny executable boot flow for the selected target or make it a blocked release gate. | Versioned boot ROM image, reset vector, signature/security policy, and boot smoke evidence. |
| Formal depth for top | Untested/deep-blocked | Routine top uses structural Yosys evidence; deep top BMC can stall on SRAM state. | Keep shallow formal bounded and add protocol-local assertions where tractable. | Deep/coverage proof plan with bounded memories or abstractions. |

## Workstream B: Software, Firmware, Linux, Android, QEMU, Renode

| Gap | Type | Evidence today | Local close task | Release closure |
|---|---|---|---|---|
| QEMU executable smoke blocked | Blocked | `scripts/run_qemu.sh --check` reports missing RISC-V ELF compiler. | Keep semantic checks and fake-tool status tests passing. | Install/pin compiler, build firmware, run QEMU, archive serial transcript. |
| Renode executable missing | Blocked | `make renode-check` reports missing `renode`. | Keep scaffold explicit and fail-closed. | Real Renode model plus transcript, or remove Renode from release scope. |
| OpenSBI/U-Boot not integrated | Scaffold | README/import scaffolds only. | Add exact external tree refs and blocked commands. | Build logs and boot-chain transcript for the selected target. |
| Linux DTS/drivers not boot-proven | Scaffold/untested | DTS, driver, smoke C source, scaffold checks. | Generate/check addresses from platform contract and fail if drift appears. | Kernel build, module/device-node runtime smoke, serial log. |
| AOSP device tree/HAL claims | Stub/LARP risk | Product files and HAL manifest scaffolds, no service binary or boot. | Keep manifest/service claims fail-closed or add host-unit-tested stub that fails closed. | AOSP build transcript, Cuttlefish/board boot, SELinux logs, HAL liveness, CTS/VTS subset. |
| Android phone compatibility | Complete gap | Explicitly excluded in docs. | Keep exclusions visible in risk/gap reports. | GMS/CTS/VTS, graphics/audio/camera/modem/power/security evidence. |

## Workstream C: PD, Package, Board, FPGA, SI/PI, Manufacturing

| Gap | Type | Evidence today | Local close task | Release closure |
|---|---|---|---|---|
| Routed PD signoff absent | Blocked | `pd/signoff/manifest.yaml`, no complete run artifacts. | Keep manifest strict; do not allow blocked gates to pass full signoff. | Final GDS/DEF/netlist/SDC/SPEF/SDF/DRC/LVS/STA/power/congestion/density/tool evidence. |
| Package is placeholder | Placeholder | QFN64 planning package and pinout. | Ensure fabrication/release docs reject placeholder package. | Vendor drawing, bond diagram, footprint source, package electrical model. |
| Padframe is scaffold | Scaffold | `pd/padframe/e1_demo_padframe.yaml`. | Check every release gate points at gap evidence. | Foundry IO/ESD/corners, pad-ring DRC/LVS, power-domain strategy. |
| Board is not manufacturable | Complete gap | Notes/checklists, no real KiCad project. | Add/fix machine-readable board artifact checklist. | KiCad schematic/PCB/ERC/DRC/Gerbers/drill/BOM/PnP/DFM/first-article limits. |
| FPGA bitstream blocked | Blocked | LPF skeleton, unassigned board revision/pins. | Keep bitstream release blocked until exact board/pins exist. | nextpnr/ecppack/timing/bitstream and board bring-up transcript. |
| SI/PI/current/lab validation absent | Complete gap | Real-world verification gap manifest. | Keep all power/current/SI/PI/lab blockers named and checked. | SI/PI reports, current budgets, IR/EM, thermal, bench logs, stop conditions. |

## Workstream D: Tooling, Reporting, Benchmarks, Release Evidence

| Gap | Type | Evidence today | Local close task | Release closure |
|---|---|---|---|---|
| Missing generated artifacts appear as `BLOCK` | Reporting gap | `mvp-status` cannot fully distinguish stale generated outputs from external blockers. | Add status category/evidence text for "rerun target" vs "external missing tool". | Release archive records freshness and command transcript. |
| Benchmark dry-run only | Planned/missing deps | Dry-run report records missing tools/model. | Keep dry-run schema strict and add generated sample model only if clearly non-performance. | Real measured reports at declared claim level. |
| Toolchain refs not all pinned | Reproducibility gap | Docker and docs list tools; heavy refs may float. | Strengthen checker docs and version report. | Lockfiles/digests/source SHAs for all release gates. |
| Stub audit ownership narrow | Reporting blind spot | `verify/check_stub_audit.py` focuses RTL/sim/verification. | Centralize allowed stub inventory across workstreams or link to manifests. | No unaudited placeholder term in release scope. |
| Archive claim level | LARP risk | Archive can contain useful scaffold evidence. | Ensure archive includes claim level, blocked gates, and mvp-status output. | Release bundle is self-describing and cannot be mistaken for product readiness. |

## Workstream E: Product Feature Evidence Pending

These are complete gaps until explicitly staffed. They must remain excluded from
any MVP/product claim.

| Area | Missing evidence |
|---|---|
| Cellular/modem | Modem selection, RIL, SIM/eSIM, antenna, certification, call/data tests. |
| Wi-Fi/Bluetooth/GNSS/NFC | Controller/module integration, firmware loading, coexistence, antennas, drivers, Android HALs. |
| Camera/ISP | CSI/PHY, sensor power/reset/I2C, ISP, tuning/calibration, Camera HAL3, image quality tests. |
| Audio | Codec/I2S/PDM, speaker/mic path, Audio HAL, latency/acoustic tests. |
| Sensors/input/haptics | I2C/SPI controllers, Sensor HAL, calibration, wake behavior. |
| USB/storage/update | USB host/device, ADB/fastboot, eMMC/UFS/SD, partitioning, AVB, OTA/update flow. |
| Battery/PMIC/thermal | PMIC, charger, fuel gauge, thermal safety, Android power/health HALs. |
| Security/compliance | Secure boot, key storage, debug lock, rollback, FCC/PTCRB/GCF/CE/USB/BT/Wi-Fi evidence. |

## Immediate Queue

1. Regenerate local evidence with `make ci-fast tool-versions benchmarks-dry-run pipeline-check mvp-status` after workers land changes.
2. Convert any source-level placeholder that is not in this file, `verify/rtl_gap_work_order.yaml`, or `docs/manufacturing/real-world-verification-gaps.yaml` into either implementation or an audited blocker.
3. Make every `PASS` in `make mvp-status` name the claim boundary it proves.
4. Keep every missing external dependency as `BLOCK`, never `PASS`.
