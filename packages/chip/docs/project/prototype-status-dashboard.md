# Prototype Status Dashboard

Snapshot date: 2026-05-22. Volatile generated-artifact rows stay conservative until archived release evidence is produced by the named gates.

## MVP Gate Snapshot

| Subsystem | Status | Evidence class | Next action |
| --- | --- | --- | --- |
| docs-and-project-plan | `PASS` | `command_pass` | `none` |
| architecture-docs | `PASS` | `command_pass` | `none` |
| toolchain-fast-path | `BLOCK` | `tool_blocker` | `scripts/check_tools.sh && scripts/tool_versions.sh` |
| platform-contract | `PASS` | `command_pass` | `none` |
| linux-boot-prerequisites | `PASS` | `command_pass` | `none` |
| software-bsp | `PASS` | `command_pass` | `none` |
| real-world-release-gates | `BLOCK` | `fail_closed_contract` | `archive real evidence from the named gates` |
| rtl-source | `PASS` | `source_present` | `none` |
| synthesis | `BLOCK` | `tool_blocker` | `make synth` |
| cocotb | `BLOCK` | `regen_required` | `make cocotb cocotb-npu cocotb-contract cocotb-cpu` |
| verilator | `BLOCK` | `tool_blocker` | `make verilator` |
| formal | `BLOCK` | `tool_blocker` | `make formal inside Docker/Nix` |
| qemu | `BLOCK` | `tool_blocker` | `make qemu-check` |
| renode | `BLOCK` | `tool_blocker` | `make renode-check` |
| npu-ml-proof | `BLOCK` | `tool_blocker` | `make mvp-npu-ml-evidence-check` |
| minimum-linux-npu-target | `BLOCK` | `tool_blocker` | `make minimum-linux-npu-target-strict` |
| pd-contract | `PASS` | `command_pass` | `none` |
| product-package | `BLOCK` | `release_blocker` | `close package/FPGA/KiCad/PD/manufacturing release blockers or keep product claim below fabrication` |
| benchmarks | `BLOCK` | `scaffold_only` | `python3 benchmarks/run_benchmarks.py run --metadata benchmarks/metadata/strict-blocked-template.json --strict-missing` |
| release-pipeline | `BLOCK` | `regen_required` | `make tool-versions pipeline-check` |

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
PD release BLOCK means no selected signoff run archive is present; a release claim requires GDS/DEF/netlists/SPEF/SDF, clean DRC/LVS, clean antenna/timing/DRV evidence, and a run manifest from one selected run.
PD retry BLOCK means `pd/openlane/config.sky130.json` points the SRAM macro OpenROAD netlist/model inputs at `pd/openlane/sky130_sram_2kbyte_1rw1r_32x512_8.blackbox.v`; the next release run must prove `OpenROAD.CheckMacroInstances` and signoff closure in archived run evidence.
Minimum Linux+NPU target BLOCK means NPU ML smoke evidence is limited to the named diagnostic artifacts; generated-AP Linux boot and target-side ML transcripts are still missing.
Benchmark BLOCK means reports are planning or dry-run evidence; `make benchmark-sim-metrics` is not performance evidence.
Android CTS/VTS, secure boot, radios, sensors, battery/PMIC/thermal, USB/storage/update, package, FPGA, KiCad, PD, SI/PI, and thermal release remain blocked until real evidence is archived.
