# Eliza E1 Chip

This repository is a CLI-first pre-tapeout scaffold for an open RISC-V AI phone SoC. The current executable milestone is a small `e1_soc` pipeline that ties together architecture contracts, RTL, cocotb/formal verification, QEMU/Renode software-facing smoke targets, FPGA/package evidence, and physical-design entry points.

The e1 chip is not the final phone SoC. It is the smallest end-to-end system used to prove the project conventions, evidence gates, and tool setup before scaling the design.

## Repository Layout

- `AGENTS.md`, `CLAUDE.md`: package-local contributor rules for production-grade,
  publishable changes.
- `rtl/`: SystemVerilog RTL for the e1 chip, NPU, DMA, display, interconnect, interrupt, memory, and CPU/AP stubs.
- `verify/`: cocotb tests, formal properties, and verification status artifacts.
- `compiler/runtime/`: Python runtime and simulator-facing NPU contract checks.
- `fw/`: boot ROM, bare-metal, and OpenSBI payload experiments.
- `sw/`: Linux, Buildroot, OpenSBI, U-Boot, and AOSP BSP scaffolds.
- `scripts/`: project gates, evidence capture, build orchestration, and simulator helpers.
- `benchmarks/`: benchmark plans, parsers, metadata, and dry-run tooling.
- `docs/`: architecture, software, evidence, PD, package, FPGA, simulator, and project planning docs.
- `pd/`, `board/`, `package/`: physical-design, board, packaging, and signoff artifacts.

## Quick Start

Use Python 3.11 or newer. From a fresh checkout:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
make kicad-setup
make tools
make smoke
```

For a one-command package bootstrap, run `make setup`. It creates the Python
environment, installs the repo-scoped KiCad CLI/render toolchain when possible,
and checks the required package tools.

`make smoke` runs the locally available low-cost checks. Some checks report `BLOCKED` when an external EDA, simulator, BSP, Android, or hardware dependency is absent; those blockers are expected on a minimal laptop setup and are captured as evidence rather than hidden.

## AI-EDA Setup

The AI chip-optimization stack has a separate bootstrap entrypoint. It records
host readiness, validates source/dataset manifests, keeps external payloads
under ignored `external/**/payload` paths, and emits machine-readable reports
under `build/ai_eda/`.

```sh
make ai-eda-bootstrap-metadata
make ai-eda-backend-preflight
make ai-eda-bootstrap-setup-check
make ai-eda-bootstrap-local-smoke
make ai-eda-cuda-payload
```

Use `make ai-eda-bootstrap-metadata` on a fresh machine first. It downloads
nothing and also records local AI/EDA backend availability without installing
packages or cloning repositories. Use `make ai-eda-backend-preflight` directly
when preparing a CUDA/Linux host for optional ZigZag, Timeloop/Accelergy,
RTL-MUL, LLM4DV, AssertLLM, or Fault lanes. Use
`make ai-eda-bootstrap-setup-check` after reviewed payloads such as TILOS
MacroPlacement, OpenROAD EDA Corpus, CircuitNet 3.0, ChiPBench-D, OpenABC-D,
and AiEDA/iDATA have been fetched or restored; it rebuilds normalized corpora,
bounded surrogate baselines, and E1 cases without CUDA training. Use
`make ai-eda-bootstrap-local-smoke` for the broader local evidence stack,
including candidate ranking, replay-plan generation, and guarded
macro-placement replay preflight without OpenLane/OpenROAD execution. For
concurrent or repeated setup runs, pass a unique
`AI_EDA_RUN_ID=<machine-or-date>` so generated records do not share the default
`build/ai_eda/**/validation` directories. If the default `python3` points at a
broken local environment, override it with `PYTHON=/usr/bin/python3` or your
managed virtualenv interpreter.

On a CUDA host, run the generated payload flow with:

```sh
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile training-handoff --run-id cuda-host --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --include-torch
```

To intentionally pull reviewed assets into ignored local payload directories,
use explicit asset IDs:

```sh
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id fetch-reviewed --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --execute-fetch
```

Paper/method-only assets such as AssertLLM are recorded as metadata-only
payloads with hashes under ignored `external/repos/<asset>/payload` paths; no
paper PDF, model weights, or generated assertions are treated as chip evidence.
`make ai-eda-cuda-payload` also runs the payload checker, which validates the
tarball, embedded run plan, selected assets, critical fetch commands, expected
CUDA outputs, and the no-datasets/no-weights payload boundary.

## Docker Setup

Docker is the most reproducible starting point for a new machine:

```sh
docker build -t eliza-soc-tools .
docker run --rm -it -v "$PWD:/work" -w /work eliza-soc-tools make smoke
```

Use the Docker path when host package versions are inconvenient or when you need a clean Linux-like environment from macOS.

## macOS Setup

Install baseline tools with Homebrew:

```sh
brew install python make verilator yosys qemu dtc
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
make tools
make smoke
```

macOS caveats:

- Apple Silicon and Intel Macs can run the Python gates, docs checks, QEMU reference checks, and many RTL/synthesis checks.
- Full Linux BSP builds, OpenLane/OpenROAD closure, Chipyard/Verilator generation, and Android/Cuttlefish flows are best run in Linux or Docker.
- OpenSBI and bare-metal RISC-V builds may require a cross compiler such as `riscv64-unknown-elf-gcc` or `riscv64-elf-gcc`; `make tools` reports what is available.
- Docker Desktop file sharing must include the checkout directory for containerized flows.

## Linux Setup

On Ubuntu/Debian-like hosts:

```sh
sudo apt-get update
sudo apt-get install -y \
  build-essential git make python3 python3-venv python3-pip \
  device-tree-compiler qemu-system-misc verilator yosys
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
make tools
make smoke
```

Linux caveats:

- Package names differ across distributions; use equivalent packages for Fedora, Arch, Nix, or enterprise Linux.
- OpenLane/OpenROAD, Chipyard, Android/Cuttlefish, and full kernel/Buildroot builds have large dependency sets and are documented under `docs/`, `sw/`, and `scripts/`.
- Some flows need Docker privileges, KVM access, or a RISC-V cross toolchain. Run `make tools` first and follow the reported missing-tool output.

## Common Targets

```text
make tools                         show local tool availability
make setup                         install Python deps and KiCad render tools
make venv                          create .venv and install Python dependencies
make kicad-setup                   install repo-scoped KiCad CLI/render tools
make kicad-tools-check             verify KiCad CLI and render tools
make lint                          run ruff
make typecheck                     run mypy
make docs-check                    validate documentation skeletons
make smoke                         run locally available low-cost gates
make ci-fast                       run broader RTL/software/project checks
make cocotb                        run cocotb RTL tests when simulator tools exist
make formal                        run SymbiYosys checks when available
make synth                         run Yosys synthesis
make qemu-check                    run QEMU reference checks
make renode-check                  run Renode reference checks when available
make mvp-status                    report subsystem PASS/BLOCK/FAIL status
make product-check                 run product/evidence gates
make clean                         remove generated local build outputs
```

## Toolchain Surface

- Python package tooling: Python 3.11+, `ruff`, `mypy`, `pytest`, `pyyaml`, `yamllint`, and `types-PyYAML`.
- RTL and verification: SystemVerilog, cocotb, Verilator, Yosys, SymbiYosys, and C++ smoke tests.
- Simulation and BSP flows: QEMU, Renode, Buildroot, OpenSBI, U-Boot, Linux, AOSP/Cuttlefish scaffolds, and RISC-V cross compilers.
- Physical design and package flows: OpenLane, OpenROAD, KLayout/DRC evidence, SDC constraints, padframe manifests, KiCad artifacts, and FPGA build flows.
- Benchmarking and evidence: CoreMark, STREAM, lmbench, fio, TensorFlow Lite benchmark tooling, deterministic architecture models, and power/thermal evidence gates.

## External Flow Notes

- Chipyard generation and Linux boot smoke flows are wired through `scripts/bootstrap_chipyard.sh`, `scripts/generate_chipyard_eliza.py`, `scripts/run_chipyard_eliza_linux_smoke.sh`, and related `make chipyard-*` targets.
- Linux BSP import and evidence capture are under `sw/linux/scripts/` and `docs/sw/linux/`.
- Buildroot package scaffolds and import checks are under `sw/buildroot/` and `docs/sw/buildroot/`.
- OpenSBI, U-Boot, boot ROM, and QEMU/Renode boot-tier status are documented under `docs/sw/`, `docs/boot-rom/`, and `docs/sim/`.
- OpenLane/OpenROAD runs are local generated artifacts. Commit reports and evidence summaries, not machine-local lock directories or object files.

## Verification Discipline

The project treats unsupported local tools as explicit blockers. A check should either pass, fail with a concrete issue, or record a `BLOCKED` evidence artifact that explains the missing dependency or external handoff. Before claiming a milestone, run the relevant make target and update the associated evidence docs.
