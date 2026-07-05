# packages/research/chip — Eliza E1 RISC-V AI SoC

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
- `sim/` — Renode and Verilator simulation orchestration.
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
- `generators/` — Chipyard and XiangShan generator configurations.
- `viewer/` — chip viewer HTML app and associated data artifacts.
- `dts/` — device tree sources for Eliza E1 platform targets.
- `mechanical/` — mechanical design artifacts.
- `docker/` — Dockerfiles for KiCad tools and Chipyard; used as documented
  fallback when native binaries are absent.
- `tests/` — security negative tests and other non-RTL test suites.
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

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — CLI / tooling:**
- The real command/flow invocation transcript (args in, stdout/stderr, exit code) and the artifacts it generated (files, scaffolds, manifests, screenshots/recordings).
- Failure paths: bad args, missing deps, partial state, permission/network errors.
- A recording/log of the actual run end to end — not a unit test of one helper.
- Any model interaction captured as a live trajectory and reviewed.
<!-- END: evidence-and-e2e-mandate -->
