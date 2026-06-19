# Parallel Workstreams

Each workstream owns artifacts and gates. Work can run in parallel, but claims
only advance when the gate passes.

| Workstream | Owned artifacts | First gate | Three-week deliverable |
|---|---|---|---|
| SOTA references | `docs/spec-db/**` | `make project-plan-check` | Source-linked reference database for SoC design budgets. |
| Benchmarking | `docs/benchmarks/**`, future `benchmarks/**` | report schema exists | Runnable CPU, memory, storage, AI, and Android smoke harnesses. |
| Open RTL | `rtl/**`, `verify/**`, `sim/**`, `pd/**` | `make smoke` | `e1_soc` evidence plus Chipyard Rocket baseline plan. |
| Android | `sw/aosp-device/**`, `docs/android/**` | `make aosp-bsp-check` | Simulator recipe and contract-tied HAL/device stubs. |
| Linux/BSP | `sw/linux/**`, `sw/buildroot/**` | `make software-bsp-check` | Linux smoke path for MMIO, DMA, NPU, display stubs. |
| Board/package | `board/**`, `package/**`, `pd/padframe/**` | `make product-check` | Conservative debug-first board/package release notes. |
| Risk/legal/cert | `docs/risks/**` | project-plan check | Explicit exclusions and escalation gates before product claims. |
| Toolchain reproducibility | `docs/toolchain/**`, `scripts/check_tools.sh`, `scripts/tool_versions.sh`, `Dockerfile`, `flake.nix`, `requirements.txt` | `scripts/check_tools.sh` and `scripts/tool_versions.sh` | Pinned fast-path evidence plus named blockers for floating/heavy tools. |

## Gap Review

The detailed gap inventory lives in `docs/project/workstream-gap-review.md`.
It is authoritative for project/program backlog status and must stay stricter
than subsystem completion claims.

## Agent Queue

When a worker becomes available, assign the next unblocked item:

1. Convert benchmark matrix into scripts under `benchmarks/` with dry-run mode.
2. Add Android riscv64/Cuttlefish command transcript once a local AOSP checkout exists.
3. Add Chipyard pinned-SHA manifest and bootstrap verification log.
4. Add TH1520 physical-board procurement and test checklist.
5. Add Linux NPU runtime fixed-vector smoke test.
6. Add Perfetto trace collection recipe for Android simulator and board.
7. Add release manifest entries for all new documentation artifacts.
8. Replace floating OpenLane2/Chipyard clone defaults with selected refs and manifests.
9. Add `.venv` creation to local bring-up notes and capture `build/reports/tool_versions.txt` in release evidence.

## Completion Bar

A workstream is not complete because text exists. It is complete when:

- artifacts are committed or staged in the repo,
- checks pass locally or inside Docker,
- blocked tools are named with exact install/runtime requirements,
- floating tools are either pinned or listed as release blockers,
- the next command is obvious to a new engineer.
