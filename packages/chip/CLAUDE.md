# CLAUDE - Chip Package

The chip package should read like a publishable engineering artifact, not a
work log. Keep the repository clean, evidence-driven, and suitable for external
review.

## Native over Docker on Linux x64

On Linux x86_64 hosts, the entire chip toolchain is meant to run locally. `tools/env.sh` puts the native binaries first on `PATH` — Verilator, Icarus, Yosys, SymbiYosys, z3, OpenROAD, OpenLane, magic, klayout, netgen, QEMU, Renode, KiCad, OpenOCD, sigrok, RISC-V cross compilers — all sourced from `external/oss-cad-suite/`, `external/deb-tools/`, `external/openlane2/.venv/`, and `external/openroad/`. Use these directly; do not invoke Docker unless you are on a host where the native binary genuinely cannot be installed. The `run_openlane.sh` / `run_openroad.sh` wrappers already prefer the native binary and only fall back to Docker when none is on `PATH`. Docker remains documented for macOS and for reproducibility-pinned CI runs.

## Working Rules

- Production quality is the default. Do not take shortcuts that weaken
  contracts, hide blockers, or make claims without executable evidence.
- Preserve the existing architecture and improve it in place. Consolidate
  repeated logic, but do not introduce broad abstractions without a concrete
  maintenance win.
- Keep comments technical and durable. Remove comments that describe the act of
  editing, temporary status, or prior updates.
- Do not leave slop: no unused files, dead helpers, stale generated artifacts,
  copied loaders, unowned TODOs, or vague placeholder documentation.
- Every blocked milestone must fail closed with a gate, manifest, or evidence
  file that states the missing dependency and the command that will prove it.
- Prefer structured data and checked scripts over free-form prose for package,
  board, PD, benchmark, software, and release contracts.

## Validation

- Start with `make tools` to understand the local tool boundary.
- For Python/script changes, run `make lint` and `make typecheck`.
- For RTL changes, run the relevant `make rtl-check`, `make synth`,
  `make cocotb*`, or `make formal*` target that matches the touched block.
- For docs or evidence changes, run `make docs-check` plus the local gate that
  owns the artifact.
- For publishing readiness or broad cleanup, run `make smoke` when practical and
  document any blocker as an expected external dependency.
