# Prototype Status Dashboard

Snapshot: generated during the 2026-05-17 fail-closed evidence pass.

## MVP Gate Snapshot

| Subsystem | Status | Evidence class | Next action |
| --- | --- | --- | --- |
| docs-and-project-plan | `PASS` | `command_pass` | `none` |
| architecture-docs | `PASS` | `command_pass` | `none` |
| toolchain-fast-path | `BLOCK` | `tool_blocker` | `scripts/check_tools.sh && scripts/tool_versions.sh` |
| platform-contract | `PASS` | `command_pass` | `none` |
| linux-boot-prerequisites | `PASS` | `command_pass` | `none` |
| software-bsp | `BLOCK` | `scaffold_only` | `make software-bsp-evidence-check` |
| real-world-release-gates | `PASS` | `command_pass` | `none` |
| rtl-source | `PASS` | `source_present` | `none` |
| synthesis | `PASS` | `generated_artifact` | `none` |
| cocotb | `PASS` | `generated_artifact` | `none` |
| verilator | `PASS` | `generated_artifact` | `none` |
| formal | `PASS` | `generated_artifact` | `none` |
| qemu | `BLOCK` | `tool_blocker` | `make qemu-check` |
| renode | `BLOCK` | `tool_blocker` | `make renode-check` |
| npu-ml-proof | `PASS` | `generated_artifact` | `none` |
| minimum-linux-npu-target | `BLOCK` | `tool_blocker` | `make minimum-linux-npu-target-strict` |
| pd-contract | `PASS` | `command_pass` | `none` |
| product-package | `BLOCK` | `release_blocker` | `close package/FPGA/KiCad/PD release blockers or keep product claim below fabrication` |
| benchmarks | `BLOCK` | `scaffold_only` | `python3 benchmarks/run_benchmarks.py run --metadata benchmarks/metadata/strict-blocked-template.json --strict-missing` |
| release-pipeline | `PASS` | `generated_artifact` | `none` |

## Workstream Dashboard

| Workstream | Status | Boundary |
| --- | --- | --- |
| A: RTL and formal | PASS scaffold evidence | Directed RTL/formal evidence is present, not silicon signoff. |
| B: software, boot, OS, simulation | BLOCK | QEMU PASS is qemu-virt software-reference evidence; Renode and external BSP transcripts are still required. |
| C: PD, package, board, SI/PI | BLOCK | PD contract PASS is preflight/scaffold evidence; release artifacts remain blocked. |
| D: ISP, display, real-world verification | BLOCK | Display RTL has directed checks; ISP and real-world verification remain not implemented. |
| E: toolchain and upstreams | BLOCK | Missing optional/heavy tools must stay explicit. |
| F: product, security, radios, sensors, battery | BLOCK | secure boot, cellular, Wi-Fi/BT/GNSS/NFC, sensors, and battery/PMIC/thermal need real transcripts. |

## Claim Boundaries

Product scaffold PASS means blockers are named and fail closed.
Minimum Linux+NPU target BLOCK means local NPU ML smoke evidence exists, but generated-AP Linux boot and target-side ML transcripts are still missing.
Benchmark BLOCK means reports are planning or dry-run evidence; `make benchmark-sim-metrics` is not performance evidence.
Android CTS/VTS, secure boot, radios, sensors, battery/PMIC/thermal, USB/storage/update, package, FPGA, KiCad, PD, SI/PI, and thermal release remain blocked until real evidence is archived.
