# packages/chip — Eliza E1 RISC-V AI SoC

Pre-tapeout hardware/software **evidence package** for the Eliza E1 RISC-V AI
SoC scaffold. Treat every change as production-grade engineering work intended
for eventual publication — this directory should read like a publishable
artifact, not a work log. (No `package.json`; driven entirely by `make` and the
`tools/`, `scripts/`, and `external/` toolchain.)

## Native over Docker on Linux x64

The full PD / RTL / sim / formal toolchain is installed and supported
**natively** on Linux x86_64. `tools/env.sh` puts the local binaries first on
`PATH` — Verilator, Icarus, Yosys, SymbiYosys, z3, OpenROAD, OpenLane, magic,
klayout, netgen, QEMU, Renode, KiCad, OpenOCD, sigrok, the RISC-V cross
toolchains — sourced from `external/oss-cad-suite/`, `external/deb-tools/`,
`external/openlane2/.venv/`, and `external/openroad/`. Run flows directly on the
host; native is faster, gives real stack traces, and avoids docker-daemon
babysitting. The `run_openlane.sh` / `run_openroad.sh` wrappers already prefer
the native binary and fall back to Docker only when none is on `PATH`. Docker is
retained only as a documented fallback for macOS reproduction or pinned-image CI
lanes. If a make target hard-requires Docker when a native binary is on `PATH`,
treat that as a bug to fix.

## Package map

- `rtl/` — SystemVerilog RTL: top-level integration, interconnect, DMA, NPU,
  display, interrupts, memory, CPU/AP scaffolds, debug, boot ROM, lifecycle,
  peripherals.
- `verify/` — cocotb tests, formal properties, Verilator checks, verification
  gap tracking.
- `compiler/runtime/` — Python NPU runtime and simulation-scale contract checks.
- `fw/` — boot ROM, bare-metal, and OpenSBI payload scaffolds.
- `sw/` — Linux, Buildroot, OpenSBI, U-Boot, and AOSP BSP scaffolds.
- `benchmarks/` — benchmark plans, parsers, local model generators, power
  estimates, metadata, dry-run harnesses.
- `scripts/` — local gates, evidence capture, simulator orchestration, release
  checks, toolchain probes.
- `docs/` — architecture, software, simulator, security, benchmark, physical
  design, manufacturing, package, FPGA, evidence, and project documents.
- `pd/` — OpenLane/OpenROAD config, constraints, padframe inputs, signoff
  manifests.
- `board/`, `package/` — KiCad, FPGA, pinout, bonding, Wi-Fi interface, and
  artifact manifests.
- `research/` — macro-placement and chip-design research notes (inform, do not
  replace, checked implementation evidence).
- `tools/`, `external/` — `tools/env.sh` + vendored EDA toolchains (above).

## Tools and flows

- Python 3.11+, `ruff`, `mypy`, `pytest`, `pyyaml`, `yamllint`.
- RTL/verification: Verilator, cocotb, Yosys, SymbiYosys, SystemVerilog
  assertions, local C++ smoke tests.
- Simulation/software: QEMU, Renode, Buildroot, OpenSBI, U-Boot, Linux,
  AOSP/Cuttlefish scaffolds, RISC-V cross toolchains.
- Physical design/packaging: OpenLane, OpenROAD, KLayout/DRC evidence, SDC
  constraints, padframe manifests, KiCad board artifacts, FPGA flows.
- Benchmarking: CoreMark, STREAM, lmbench, fio, TensorFlow Lite benchmark
  tooling, deterministic simulator models, power/thermal evidence checks.

## Validation (run the narrow target for what you touched)

- `make tools` — first, to understand the local tool boundary.
- `make lint` + `make typecheck` — for any Python/script change.
- `make rtl-check` / `make synth` / `make cocotb*` / `make formal*` — for RTL
  changes, matching the touched block.
- `make docs-check` plus the gate that owns the artifact — for docs/evidence.
- `make smoke` — for publishing readiness or cross-package gate changes; record
  any blocker as an expected external dependency.

## Conventions / gotchas

- **Production quality is the default.** No shortcuts that weaken contracts,
  hide blockers, or make claims without executable evidence.
- **Fail closed.** Every blocked milestone must fail with a gate, manifest, or
  evidence file naming the missing dependency and the command that proves it
  (an explicit `BLOCKED` gate or evidence artifact).
- **No slop.** No unused files, dead helpers, stale generated artifacts, copied
  loaders/parsers, unowned task markers, or placeholder prose. Keep comments technical
  and durable — never work-log or status chatter.
- **Improve in place.** Build on the existing architecture, contracts, and
  evidence gates; share helpers for repeated script behavior; do not add
  parallel mechanisms when a local flow already exists.
- Generated or machine-local artifacts stay out of source unless they are
  intentional release evidence with stable provenance.
- Prefer structured data and checked scripts over free-form prose for package,
  board, PD, benchmark, software, and release contracts.
