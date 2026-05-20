# AGENTS - Chip Package

This package is a pre-tapeout hardware/software evidence package for the
Eliza E1 RISC-V AI SoC scaffold. Treat every change as production-grade
engineering work intended for eventual publication.

## Native over Docker on Linux x64

This package's full PD/RTL/sim/formal toolchain is installed and supported natively on Linux x86_64. `tools/env.sh` exposes the local binaries on `PATH`. Use the native installs by default — Verilator, Icarus, Yosys, SymbiYosys, z3, OpenROAD, OpenLane, magic, klayout, netgen, QEMU, Renode, KiCad, OpenOCD, sigrok, the RISC-V toolchains. They live under `external/oss-cad-suite/`, `external/deb-tools/`, `external/openlane2/.venv/`, and `external/openroad/`. Run flows directly on the host; Docker is retained only as a documented fallback for macOS reproduction or pinned-image CI lanes. Native is faster, gives real stack traces, and avoids docker-daemon babysitting. If a make target or script hard-requires Docker when a native binary is already on `PATH`, treat that as a bug to fix.

## Quality Bar

- Build on the existing architecture, contracts, and evidence gates. Do not
  add parallel mechanisms when a local flow already exists.
- Prefer small, reviewable changes that improve correctness, verification,
  reproducibility, or documentation clarity.
- Keep source files publishable. Do not leave progress notes, work-log
  comments, status chatter, TODOs without an owning gate, or placeholder prose.
- Claims must be evidence-backed. If a flow depends on unavailable EDA,
  simulator, BSP, Android, package, board, or silicon inputs, record it as an
  explicit `BLOCKED` gate or evidence artifact.
- Use shared helpers for repeated script behavior. Avoid copy-pasted parsers,
  JSON/YAML loaders, hashing routines, and gate validation logic when a common
  module can express the contract clearly.
- Generated or machine-local artifacts stay out of source unless they are
  intentional release evidence with stable provenance.

## Package Map

- `rtl/`: SystemVerilog RTL for top-level integration, interconnect, DMA, NPU,
  display, interrupts, memory, CPU/AP scaffolds, debug, boot ROM, lifecycle,
  and peripherals.
- `verify/`: cocotb tests, formal properties, Verilator checks, and verification
  gap tracking.
- `compiler/runtime/`: Python NPU runtime and simulation-scale contract checks.
- `fw/`: boot ROM, bare-metal, and OpenSBI payload scaffolds.
- `sw/`: Linux, Buildroot, OpenSBI, U-Boot, and AOSP BSP scaffolds.
- `benchmarks/`: benchmark plans, parsers, local model generators, power
  estimates, metadata, and dry-run harnesses.
- `scripts/`: local gates, evidence capture, simulator orchestration, release
  checks, and toolchain probes.
- `docs/`: architecture, software, simulator, security, benchmark, physical
  design, manufacturing, package, FPGA, evidence, and project documents.
- `pd/`: OpenLane/OpenROAD configuration, constraints, padframe inputs, and
  signoff manifests.
- `board/` and `package/`: KiCad, FPGA, pinout, bonding, Wi-Fi interface, and
  artifact manifests.
- `research/`: macro-placement and chip-design research notes that inform but
  do not replace checked implementation evidence.

## Tools And Flows

- Python 3.11+, `ruff`, `mypy`, `pytest`, `pyyaml`, `yamllint`.
- RTL and verification: Verilator, cocotb, Yosys, SymbiYosys, SystemVerilog
  assertions, and local C++ smoke tests.
- Simulation and software: QEMU, Renode, Buildroot, OpenSBI, U-Boot, Linux,
  AOSP/Cuttlefish scaffolds, and RISC-V cross toolchains.
- Physical design and packaging: OpenLane, OpenROAD, KLayout/DRC evidence,
  SDC constraints, padframe manifests, KiCad board artifacts, and FPGA flows.
- Benchmarking: CoreMark, STREAM, lmbench, fio, TensorFlow Lite benchmark
  tooling, deterministic simulator models, and power/thermal evidence checks.

Run `make tools` before deeper work, `make lint` and `make typecheck` before
publishing code changes, and the narrow make target for the subsystem you
touched. Use `make smoke` when the change affects cross-package gates.
