# Three-week prototype workstreams

Generated on 2026-05-16 from subsystem agent reviews and local validation.
Updated on 2026-05-17 after the critical gap review pass.

Heartbeat update 2026-05-17 03:43 PDT: Renode, BSP, product/package, secure
boot, and benchmark workstreams now have stricter evidence intake. Renode
remains blocked by a missing host executable and missing real transcript.
Software BSP evidence remains blocked by missing external Buildroot, Linux,
OpenSBI, U-Boot, AOSP, CTS, and VTS logs. Benchmarks now reject repo-local
smoke shims as real tools; fio host runs pass, and local CoreMark, STREAM,
lmbench, and TensorFlow Lite `benchmark_model` binaries are available for
strict dry-run planning. e1-NPU NNAPI remains blocked until
`benchmarks/capabilities/e1_npu_nnapi.proof.json` capability evidence exists.

Heartbeat update 2026-05-17 04:33 PDT: CPU/AP is now an explicit MVP blocker,
not an implied Linux boot claim. The in-repo tiny CPU remains local contract
evidence only; the selected Linux-capable AP path is pinned to the Chipyard
Rocket manifest, and `make chipyard-generated-check cpu-ap-evidence-check`
must stay blocked until generated RV64GC artifacts and OpenSBI/Linux/trap/timer
logs exist.

Heartbeat update 2026-05-17 04:43 PDT: the 2028 performance-heavy NPU target is
now a checked project-plan input via `make npu-2028-target-check`, and smoke /
ci-fast include that gate. The current RTL remains classified as `L0_RTL_UNIT`;
the target file is an architecture and validation target, not a completion
claim.

## Current executable baseline

- Passing locally: `make docs-check project-plan-check npu-2028-target-check platform-contract-check`, `make rtl-check`, `make synth`, `make formal`, `make verilator`, `make cocotb`, `make cocotb-contract`, `make cocotb-cpu`, `make qemu-check`, `make pipeline-check`, and `python3 scripts/check_mvp_status.py --fail-on-fail`.
- Blocked locally: `make openroad` and `make openlane` because OpenROAD/OpenLane/Magic/Netgen are not installed or pulled.
- Tooling caveat: cocotb now runs from the repo `.venv` path through the Makefile wrapper. Release evidence still needs clean-checkout regeneration and archived tool/report checksums.
- Blocked by evidence, not local syntax: generated CPU/AP artifacts and boot logs, Renode executable smoke, software BSP external build logs, product/package/board fabrication evidence, real benchmarks, and PD signoff artifacts.

## Critical architecture boundary

The current e1 chip is a debug-MMIO hardware ABI, not a bootable phone SoC. `e1_chip_top` exposes a package debug nibble bridge into `e1_soc_top`. The Linux-capable AXI-Lite scaffold is separate under `rtl/interconnect`, `rtl/memory`, and `rtl/interrupts`; the CPU subsystem is intentionally non-bootable.

Prototype success in three weeks should therefore be defined as one of two tracks:

1. A stronger e1-chip demonstrator: debug bridge drives DMA/NPU/display contract behavior, with RTL/formal/cocotb/synthesis/PD artifact evidence.
2. A Linux-capable scaffold prototype: integrate a real or simulated RV64 path, DRAM, interrupt/timer/UART, generated DTS, and boot smoke tests.

Treating QEMU/Renode success as proof of the e1-chip ABI is invalid until an emulator model exists for the e1 hardware map.

## Workstream A: RTL and formal

Primary gaps:

- Detailed RTL/SoC gap inventory is maintained in `docs/project/rtl-soc-critical-gap-audit.md` and enforced as open machine-readable work orders by `verify/rtl_gap_work_order.yaml`.
- No real CPU, cache/MMU, memory controller, or shared-memory path in pad-level RTL.
- DMA has a prototype AXI-Lite memory master, but no production memory hierarchy, coherency policy, long-burst coverage, or throughput evidence.
- NPU is register-datapath only: no descriptors, queue, scratchpad, tensor layout, or backpressure.
- Display has a top-level SRAM-backed framebuffer read path verified by cocotb, but no production framebuffer client, panel PHY/DSI bridge, format conversion pipeline, or hardware-in-loop evidence.
- Formal is shallow BMC and misses AXI-Lite, DRAM, interrupt controller, display, reset, and CPU-contract wrappers.

Immediate work:

- Add randomized cocotb/reference-model coverage for all NPU opcodes, DMA edge cases, display timing, and AXI-Lite stalls.
- Add protocol assertions or an open AXI-Lite property set for interconnect, DRAM, and interrupt controller.
- Add coverage summaries for opcodes, MMIO regions, response codes, IRQs, and AXI timing permutations.
- Keep `make formal` fallback evidence labeled as fallback unless `REQUIRE_SBY=1` is set, and require `REQUIRE_DEEP_FORMAL=1` before treating top-level BMC as more than routine structural coverage.
- Decide whether week-one RTL work targets the e1 debug-MMIO demonstrator or the Linux-capable scaffold; they are different prototypes.

2026-05-17 05:10 PDT heartbeat update:

- Ran the broad local validation stack: `make ci-local`, `make verify-all`, `make smoke`, `make qemu-check-strict`, host-capable `make benchmarks`, strict benchmark planning, and deep formal.
- Fixed a stale top-level formal address-map predicate: `e1_soc_top` now exposes a CLINT window at `0x0200_0000`, and `verify/formal/e1_soc_top_formal.sv` now treats that window as mapped instead of expecting unmapped `32'hDEAD_BEEF`.
- `REQUIRE_DEEP_FORMAL=1 make formal` passed after the CLINT predicate fix. This is local formal evidence only, not silicon/FPGA/OS boot evidence.
- Remaining RTL/verification priorities are protocol-property expansion, coverage reporting, and replacement of the tiny CPU scaffold with generated CPU/AP artifacts plus boot evidence before claiming Linux-capable completion.

## Workstream B: software, boot, OS, simulation

Primary gaps:

- Platform contract had drifted behind extended DMA/NPU RTL registers. This report run updated the JSON/header and checker to catch future undocumented readable RTL offsets.
- Linux drivers now consume the generated platform contract import header, and the platform-contract checker rejects stale generated/imported headers.
- DTS is not bootable: no CPU, memory, timer, interrupt-parent, UART, or complete RISC-V platform shape.
- `qemu-check` now builds/runs the qemu-virt software-reference firmware and archives `build/reports/qemu_smoke.log`; this is still not e1-chip hardware boot proof.
- `renode-check` remains a semantic scaffold plus explicit BLOCK until `renode` is installed and a transcript is archived.
- Buildroot/AOSP/OpenSBI/U-Boot paths are placeholders around external trees.
- CPU/AP completion is blocked until the selected Chipyard Rocket path produces
  generated RTL/import manifests plus OpenSBI, Linux, and trap/timer/IRQ logs.

Immediate work:

- Generate DTS/include fragments from `sw/platform/e1_platform_contract.json`.
- Keep `sw/platform/e1_platform_contract.json` at `has_cpu=false` until the
  CPU/AP generated-artifact and boot-evidence gates pass.
- Keep QEMU transcript evidence in `build/reports/qemu_smoke.log` and prevent qemu-virt success from being described as e1-chip hardware boot.
- Split software checks into scaffold checks versus real boot/image checks.
- Produce external Linux, Buildroot, and AOSP logs before allowing `make software-bsp-evidence-check` to pass.

## Workstream C: PD, package, board, SI/PI

Primary gaps:

- Padless PD only; no foundry IO cells, ESD clamps, corner pads, padframe-inclusive DRC/LVS, or package-approved bond diagram.
- No complete PD signoff run artifacts under the manifest.
- Signoff checker now names liberty/corners, SPEF/SDF, utilization/congestion, density/fill, tool-version, and waiver evidence as release artifacts, but no real run has produced them yet.
- Board/package are planning placeholders. No vendor-derived footprint, real KiCad project, rail current budget, PDN target impedance, decap plan, SI/PI report, or DFM review exists.
- FPGA LPF is a skeleton; no bitstream build target can be released until pins and IO standards are real.

Immediate work:

- Produce real OpenLane/OpenROAD signoff output for every artifact class named by `scripts/check_pd_signoff.py` and `pd/signoff/manifest.yaml`.
- Keep `docs/manufacturing/physical-closure-work-order.yaml` in sync with footprint checksum, current budget, SI/PI report, DFM review, and first-article checklist gates.
- Add an FPGA build target after pins are assigned: Yosys, nextpnr-ecp5, ecppack, and timing report parse.

## Workstream D: ISP, display, real-world verification

Primary gaps:

- No camera/ISP contract exists: no CSI/MIPI, sensor power/reset/I2C, calibration assets, tuning tables, image-quality tests, or board constraints.
- Display now has SRAM-backed framebuffer fetch and underflow accounting in the top-level demonstrator, but still lacks pixel formats beyond scaffold registers, panel init, DSI/PHY bridge, gamma/color, buffering, bandwidth checks, and real panel validation.
- Real-world verification is currently artifact/contract oriented, not hardware-in-loop.

Immediate work:

- Add an explicit camera/ISP not-implemented contract if camera remains in product scope.
- Add display validation around scanout DMA, format conversion, vsync semantics, underflow, mode programming, and software driver contract tests.
- Define bring-up evidence: FPGA board, logic analyzer traces, power measurements, serial logs, and signed-off manufacturing artifacts.

2026-05-17 05:57 PDT heartbeat update:

- Local setup now has `repo`, `sigrok-cli`, `renode`, `kicad-cli`, RISC-V
  bare-metal GCC, a RISC-V Linux compiler shim, the pinned OpenLane2 Docker
  image, and repo-local Sky130/GF180 PDK installs under `external/pdks`.
- `make qemu-check`, `make renode-check`, `make pd-preflight-check`, and
  `scripts/check_tools.sh` pass for installed local tooling. `nix`, `cvd`, and
  `launch_cvd` remain unavailable on this macOS host.
- `make android-sim-boot-check` is correctly blocked until `AOSP_DIR` points
  at a real AOSP checkout and Cuttlefish is available on a Linux-capable host.
- A real OpenLane run now reaches tool/PDK execution instead of missing-tool
  failure, but it is not clean: the first run failed at global placement with
  771.788% utilization, and the Docker/manual-PDK path exposed Sky130 PDK
  compatibility variables that still need a proper OpenLane-compatible PDK
  pin or config update before claiming PD evidence.

2026-05-17 06:07 PDT heartbeat update:

- Completed the OpenLane-compatible Sky130 Volare revision
  `0fe599b2afb6708d281543108caf8310912f54af` and switched
  `external/pdks/sky130A` to that revision. The partial-PDK failure is closed.
- Retried `OPENLANE_CONFIG=pd/openlane/config.sky130.json make openlane`.
  The flow now starts cleanly, passes lint checks into Yosys synthesis, maps
  DFFs to `sky130_fd_sc_hd`, and records a large scaffold netlist
  (`438487` cells, `754058.201600` reported area) in
  `build/reports/openlane_bounded_attempt.txt`.
- The run was stopped intentionally during long synthesis/ABC to avoid leaving
  a runaway heartbeat job active. The current blocker is no longer missing PDK
  setup; it is that the e1-chip scaffold is too large/unstructured for a
  fast PD smoke target. Next PD work should add a smaller PD smoke top or
  parameterized synthesis configuration before asking OpenLane for full
  placement/routing evidence.

## Workstream E: toolchain and upstreams

Primary gaps:

- Docker apt packages and Nix `nixos-unstable` float; no `flake.lock` exists.
- Bootstrap scripts clone moving OpenLane2/Chipyard branches.
- OpenLane/OpenROAD/Magic/Netgen/Renode/KiCad are missing locally.
- Boolector is end-of-maintenance; Bitwuzla is now wired as a second engine alongside z3 in every `verify/formal/*.sby` and `verify/formal/bpu/*.sby` plus the BPU config.sby pair. SBY skips Bitwuzla when the binary is missing on the host; the z3 gate stays authoritative until a Bitwuzla install lands in CI.
- Repo-local `.venv` is the current cocotb path. Release-grade reproducibility still needs clean-checkout regeneration and archived package/tool checksums.

Upstream review targets:

- OpenLane2 tags and PRs: https://github.com/chipfoundry/openlane2/tags
- Chipyard releases: https://github.com/ucb-bar/chipyard/releases
- OSS CAD Suite/Yosys/SBY/nextpnr/OpenROAD releases: https://github.com/YosysHQ/oss-cad-suite-build/releases, https://github.com/YosysHQ/yosys/releases, https://github.com/YosysHQ/nextpnr/releases, https://github.com/The-OpenROAD-Project/OpenROAD/tags
- cocotb/Python dependency upgrade path: https://github.com/cocotb/cocotb/releases
- Renode/KiCad only when those paths become release gates.

Fork policy:

- Do not vendor Chipyard, OpenLane/OpenROAD, PDKs, AOSP, or OSS CAD Suite.
- Pin reproducible refs, image digests, and tarball checksums.
- Fork only for unavoidable local patches that block a release; keep fork branches thin and upstream-rebaseable.

Validation commands:

- `scripts/check_tools.sh` inventories fast, host, and heavy tools without installing anything.
- `scripts/check_tools.sh --strict` fails when required fast-path Python packages are missing.
- `scripts/tool_versions.sh` records command paths, versions, Python package versions, and hashes for the toolchain control files.

Blockers to close before release-grade reproducibility:

- commit or archive a Python lock/constraints file,
- pin Docker by digest or archive an apt package manifest,
- commit `flake.lock` if Nix is a supported path,
- replace default-branch OpenLane2/Chipyard clones with selected tags/SHAs,
- record image digests/checksums for OpenLane, OSS CAD Suite, PDK archives, and any forked tool refs.

## Three-week cadence

Week 1:

- Close verification/tooling drift: isolated Python env, source manifest, stronger platform-contract check, qemu-stub build, cocotb/formal coverage expansion.
- Run `scripts/check_tools.sh` and `scripts/tool_versions.sh`; attach `build/reports/tool_versions.txt` to evidence notes.
- Pick prototype track: debug-MMIO demonstrator or Linux-capable scaffold.

Week 2:

- Implement the chosen track end to end.
- For debug-MMIO: connect stronger DMA/NPU/display behavior and verify from runtime/tests.
- For Linux scaffold: add bootable CPU/timer/UART/memory contract and build a QEMU/Renode boot smoke.

Week 3:

- Harden evidence: full CI target, PD/signoff manifest enforcement, FPGA/board/package gates, release archive, and residual risk report.
- Keep non-passing gates named as blocked gates, not passing scaffold checks.
