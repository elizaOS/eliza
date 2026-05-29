# Prototype Status Dashboard

Snapshot: updated 2026-05-29 from current local gate output; generated-artifact rows remain scoped to simulator/build evidence and are not fabrication or phone release evidence.

## MVP Gate Snapshot

| Subsystem | Status | Evidence class | Next action |
| --- | --- | --- | --- |
| docs-and-project-plan | `PASS` | `command_pass` | `none` |
| architecture-docs | `PASS` | `command_pass` | `none` |
| toolchain-fast-path | `PASS` | `tool_available` | `none` |
| platform-contract | `PASS` | `command_pass` | `none` |
| linux-boot-prerequisites | `PASS` | `command_pass` | `none` |
| software-bsp | `PASS` | `command_pass` | `none` |
| real-world-release-gates | `PASS` | `command_pass` | `none` |
| rtl-source | `PASS` | `source_present` | `none` |
| synthesis | `PASS` | `generated_artifact` | `none` |
| cocotb | `BLOCK` | `regen_required` | `make cocotb cocotb-npu cocotb-contract cocotb-cpu` |
| verilator | `PASS` | `generated_artifact` | `none` |
| formal | `PASS` | `generated_artifact` | `none` |
| qemu | `PASS` | `generated_artifact` | `none` |
| renode | `PASS` | `generated_artifact` | `none` |
| npu-ml-proof | `PASS` | `generated_artifact` | `none` |
| minimum-linux-npu-target | `PASS` | `generated_artifact` | `none` |
| pd-contract | `PASS` | `command_pass` | `none` |
| product-package | `BLOCK` | `release_blocker` | `close package/FPGA/KiCad/PD/manufacturing release blockers or keep product claim below fabrication` |
| benchmarks | `PASS` | `generated_artifact` | `none` |
| release-pipeline | `PASS` | `generated_artifact` | `none` |

## Workstream Dashboard

| Workstream | Status | Boundary |
| --- | --- | --- |
| A: RTL and formal | PASS scaffold evidence | Directed RTL/formal evidence is present, not silicon signoff. |
| B: software, boot, OS, simulation | BLOCK | QEMU PASS is qemu-virt software-reference evidence; archived Renode and external BSP transcripts are still required. |
| C: PD, package, board, SI/PI | BLOCK | No selected OpenLane/OpenROAD run archive is present under `pd/openlane/runs/*` or `runs/*`. PD release remains blocked until a selected run is archived with clean signoff artifacts; see `build/reports/pd_signoff.json` and `build/reports/openlane_run_release_preflight.json` after running the release gates. |
| D: ISP, display, real-world verification | BLOCK | Display RTL has directed checks; ISP and real-world verification remain not implemented. |
| E: toolchain and upstreams | BLOCK | Missing optional/heavy tools must stay explicit. |
| F: product, security, radios, sensors, battery | BLOCK | secure boot, cellular, Wi-Fi/BT/GNSS/NFC, sensors, and battery/PMIC/thermal need real transcripts. |

## Claim Boundaries

Product scaffold PASS means blockers are named and fail closed.
PD contract PASS is preflight/scaffold evidence only; PD release remains blocked until post-route timing, antenna, DRC/LVS, and signoff artifacts are clean.
PD release BLOCK means the selected `e1_chip_top` run has GDS/DEF/netlists/SPEF/SDF and clean Magic/KLayout DRC plus LVS, but still has 22 antenna nets, 24 antenna pins, 3 hold violations, 23,099 max-slew violations, and 442 max-cap violations.
PD retry BLOCK means `pd/openlane/config.sky130.json` now points the SRAM macro OpenROAD netlist/model inputs at `pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v`; the next release run must confirm `OpenROAD.CheckMacroInstances` clears once local Docker/container runtime service is healthy.
Minimum Linux+NPU target PASS means generated-AP Linux boot, target-side e1 NPU ML smoke, and AP benchmark transcript evidence are present for the simulator-scoped target; it is not NNAPI, phone, silicon, or measured-power evidence.
Benchmark PASS means generated-AP benchmark smoke evidence has been imported into the benchmark schema with simulator provenance; it is not calibrated silicon, phone, or release performance evidence.
Android CTS/VTS, secure boot, radios, sensors, battery/PMIC/thermal, USB/storage/update, package, FPGA, KiCad, PD, SI/PI, and thermal release remain blocked until real evidence is archived.
