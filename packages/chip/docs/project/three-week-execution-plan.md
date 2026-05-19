# Three-Week Execution Plan

This plan assumes aggressive parallel work, but it does not assume impossible
silicon. The finish line is a complete, reproducible prototype package for an
open Android-capable SoC research platform:

- source-backed SOTA specification database
- runnable `e1_soc` verification pipeline
- Android simulator bring-up path
- RISC-V physical-board baseline plan
- open RTL SoC expansion path
- benchmark harness definitions
- risk register and explicit non-goals
- workstream gap review with completion criteria and blocked gates

## Week 1: Control Plane And Baselines

| Workstream | Deliverable | Gate |
|---|---|---|
| Specs | `docs/spec-db/mobile-sota-2026.yaml` | source URLs and no pinout-clone claims |
| RTL | current `e1_soc` passes smoke | `make smoke` |
| Verification | cocotb/formal/Verilator evidence | `make ci-fast` where tools exist |
| Toolchain | `.venv` baseline and tool inventory | `scripts/check_tools.sh` and `scripts/tool_versions.sh` |
| Android | simulator and AOSP contract doc | `make aosp-bsp-check` |
| Benchmarks | benchmark matrix and report schema | benchmark doc exists and has claim levels |
| Risk | v0 exclusions and mitigation list | risk register exists |

## Week 2: Open RTL Expansion

| Workstream | Deliverable | Gate |
|---|---|---|
| Chipyard | selected baseline config for Rocket/BOOM/CVA6 | bootstrap script or documented blocker |
| Toolchain | OpenLane2/Chipyard/OSS CAD Suite pin decision | selected tags/SHAs or explicit release blockers |
| NPU | Gemmini/NVDLA path decision | operator and TFLite/MLPerf subset plan |
| Software | Linux driver/runtime smoke for e1 NPU | deterministic vector test |
| Android | HAL stub map and build notes | no undocumented device nodes |
| Benchmarks | scripts for CoreMark/STREAM/lmbench/fio/TFLite | dry-run or documented missing tool |

## Week 3: Integrated Prototype Package

| Workstream | Deliverable | Gate |
|---|---|---|
| Simulator | QEMU/Renode contract smoke | `make qemu-check renode-check` |
| RTL | full local CI evidence | `make ci-local` where tools exist |
| Android | runnable simulator recipe | command transcript and boot artifact list |
| Board | TH1520 procurement and board test plan | exact board, image, and benchmark plan |
| Release | archive package | `make archive-release` after pipeline evidence exists |

## Reproducibility Rules

- Local Python evidence should come from `.venv`; user-site Python is a
  temporary unblocker and must be named in status notes.
- Fast-path evidence may use Docker, Nix, or host tools, but the selected path
  must include `build/reports/tool_versions.txt`.
- Floating inputs are not release evidence. `ubuntu:24.04`, `nixos-unstable`,
  default-branch OpenLane2, and default-branch Chipyard remain blockers until
  pinned by digest, lockfile, tag, SHA, or checksum.
- Heavy tools can be absent during scaffold work, but absent tools must be tied
  to blocked gates instead of reported as passing.
- `make mvp-status` is the cross-workstream summary gate: every subsystem must
  show `PASS`, `BLOCK`, or `FAIL` with evidence and a next command.
- `docs/project/workstream-gap-review.md` is the backlog gate for stubs,
  scaffolds, LARPs, incomplete work, untested claims, not-implemented areas, and
  complete gaps. It must not be used as proof that subsystem gates passed.

## Ten-Minute Operating Loop

Each check-in should answer only four questions:

1. What artifact changed?
2. What gate passed or failed?
3. What is the highest-risk blocker?
4. What is the next command or patch?

This prevents the project from drifting into aspirational architecture writing.

## Automation Gates

The plan artifacts are part of smoke, not optional reading. `make smoke` runs
`scripts/check_project_plan.py`, which now checks that benchmark, Android, and
board artifacts keep their safety boundaries:

- benchmark reports keep the L0-L6 claim levels and block simulator wall-clock
  comparisons against phone scores,
- Android bring-up remains tied to `sw/platform/e1_platform_contract.json`
  and the `make aosp-bsp-check` evidence path,
- board and FPGA artifacts remain scaffold-only until board revision, package
  pins, and bitstream release blockers are resolved.
- the workstream gap review keeps project/program backlog status separate from
  subsystem-owned implementation evidence.

Release archives should carry the project-plan artifacts with the generated RTL
and verification evidence, so a reviewer can reproduce both the commands and
the claim boundaries from the archive alone.
