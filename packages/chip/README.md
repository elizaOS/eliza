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
make ai-eda-optimization-targets
make ai-eda-all-target-captures
make ai-eda-bootstrap-setup-check
make ai-eda-bootstrap-local-smoke
make ai-eda-training-corpus-manifest
make ai-eda-cuda-payload
make ai-eda-cuda-run-plan-dry-run
make ai-eda-cuda-readiness-audit
```

Use `make ai-eda-bootstrap-metadata` on a fresh machine first. It downloads
nothing and also records local AI/EDA backend availability without installing
packages or cloning repositories. Use `make ai-eda-backend-preflight` directly
when preparing a CUDA/Linux host for optional ZigZag, Timeloop/Accelergy,
RTL-MUL, LLM4DV, AssertLLM, or Fault lanes. Use
`make ai-eda-bootstrap-setup-check` after reviewed payloads such as TILOS
MacroPlacement, OpenROAD EDA Corpus, CircuitNet 3.0, ChiPBench-D, OpenABC-D,
AiEDA/iDATA, EDALearn, Macro Placement Challenge 2026, MLCAD 2023 FPGA macro
placement, and research-code assets such as ChipDiffusion, ChiPFormer, CORE,
MapTune, ABC-RL, abcRL, RL4LS, MCP4EDA, ORFS-Agent, OpenROAD Agent,
OpenROAD MCP, Open3DBench, and DREAMPlace have been fetched or restored. It rebuilds
normalized corpora, bounded surrogate baselines, and E1 cases without CUDA
training. Use
`make ai-eda-optimization-targets` to validate the dry-run, fail-closed target
captures for the current public research watchlist, circuit foundation models,
EDA agents, DFM/yield/lithography, low-power intent, post-silicon validation,
and hardware security. Use
`make ai-eda-all-target-captures` to refresh all 36 dry-run AI-EDA domain
target reports before source-inventory validation, including HLS,
analog/mixed-signal, clock tree, extraction/parasitics, floorplan/IO/PDN,
memory, DFT/ATPG, CDC/RDC, board/package/FPGA, chiplet, compiler,
post-silicon, security, current-research watchlist, and benchmark-hygiene
lanes. Use
`make ai-eda-bootstrap-local-smoke` for the broader local evidence stack,
including candidate ranking, replay-plan generation, and guarded
macro-placement replay preflight without OpenLane/OpenROAD execution. Use
`make ai-eda-training-corpus-manifest` to hash and summarize the normalized
training/RAG records available for a run before model training. For
concurrent or repeated setup runs, pass a unique
`AI_EDA_RUN_ID=<machine-or-date>` so generated records do not share the default
`build/ai_eda/**/validation` directories. If the default `python3` points at a
broken local environment, override it with `PYTHON=/usr/bin/python3` or your
managed virtualenv interpreter.

On a CUDA host, run the generated payload flow with:

```sh
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile training-handoff --run-id cuda-host-training-handoff --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026 --include-torch
```

If a bootstrap run is interrupted or a transient make failure is fixed, rerun
the same command with `--resume`. The resumed report reuses successful prior
steps, reruns failed or missing steps, and records old failures under
`superseded_failed_steps` rather than current `failed_steps`.
The setup-check bootstrap has been validated with
`AI_EDA_RUN_ID=codex-bootstrap-setup5`; this run confirms target captures are
generated before local RAG/source-inventory checks so stale target hashes do not
poison setup evidence.

To intentionally pull reviewed assets into ignored local payload directories,
use explicit asset IDs:

```sh
python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id fetch-reviewed --asset tilos-macroplacement --asset openroad-eda-corpus --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026 --execute-fetch
```

Paper/method-only assets such as AssertLLM are recorded as metadata-only
payloads with hashes under ignored `external/repos/<asset>/payload` paths; no
paper PDF, model weights, or generated assertions are treated as chip evidence.
`make ai-eda-cuda-payload` also runs the payload checker, which validates the
tarball, embedded run plan, generated `cuda_handoff_README.md`, selected
assets, critical fetch commands, expected CUDA outputs, the current-research
watchlist capture handoff, OpenROAD ML snapshot handoff, the E1 AI workload
manifest/checker, the fail-closed CT/SA/Hier-RTLMP/ChipDiffusion real-wrapper
readiness contract, the quarantined assertion-candidate manifest checker, the
deterministic macro-placement replay queue for top ranked candidates, the
hash-pinned CUDA evidence bundle manifest, and the no-datasets/no-weights
payload boundary.
The latest current-research refresh (`codex-latest-research-refresh-20260521`)
validates 19 metadata-only watchlist entries, including EXPlace as a
domain-expert RL macro-placement successor candidate and AMS-IO-Agent as an
AMS I/O-ring layout-agent lane. These entries intentionally do not import
code/data or make E1 design claims; deterministic replay/signoff and reviewer
gates remain mandatory before any generated candidate can affect E1.
`make ai-eda-cuda-run-plan-dry-run`
expands the embedded CUDA run plan into a reviewed execution manifest without
running commands. `make ai-eda-cuda-run-plan-safety-matrix` then proves each
stage can be selected independently and that download, training, inference,
replay, and AlphaChip stages are blocked in execute mode unless their explicit
allow flags are present. Real execution through
`execute_cuda_run_plan.py --execute` must name one or more `--stage` values.
The executor also skips run-plan orchestration commands inside the plan so it
cannot recursively invoke itself. `make ai-eda-cuda-readiness-audit`
first validates that dry-run execution manifest and safety matrix, then
summarizes the preflight, payload, AlphaChip checkpoint blocker,
current-research watchlist, setup-check/bootstrap evidence, training-handoff
bootstrap evidence, OpenLane/OpenROAD replay prerequisites, and E1
replay-preflight state into one machine-readable blocked-or-ready report for
the CUDA host. For evidence produced under
different run IDs, pass `AI_EDA_SETUP_RUN_ID=<setup-run>` and
`AI_EDA_TRAINING_HANDOFF_RUN_ID=<handoff-run>` when invoking the audit. For
manual audits assembled from reviewed artifacts generated under separate run
IDs, `capture_cuda_readiness_audit.py` also accepts explicit
`--preflight-run-id`, `--payload-run-id`, `--run-plan-execution-run-id`,
`--run-plan-safety-run-id`, `--alphachip-run-id`,
`--alphachip-successor-reproduction-run-id`, `--watchlist-run-id`, and
`--replay-preflight-run-id` arguments. `make ai-eda-cuda-full-training-matrix`
records the required CUDA host jobs for full-dataset conversion, large
successor training/inference, replay, and closeout without running them; when
the payload and preflight evidence come from separate runs, pass
`--payload-run-id` and `--preflight-run-id` directly to
`capture_cuda_full_training_matrix.py`, then pass
`AI_EDA_FULL_TRAINING_MATRIX_RUN_ID=<matrix-run>` into the readiness/objective
audits. The CUDA run plan uses `--all-records` converter modes for CircuitNet3,
ChiPBench-D, OpenABC-D, AIEDA/iDATA, EDALearn, and Macro Placement Challenge
2026, plus the complete R-Zoo evaluation DEF conversion and deterministic
design-family train/validation/test split manifest. R-Zoo also carries a
training-only license review gate: local CUDA handoff is allowed, while
release, commercial use, model-weight release, and E1 signoff claims remain
false. FloorSet is pinned to the local verified checkout, carries a
training-only Apache-2.0 / CC BY 4.0 license review, and the CUDA run plan now
includes the 100-case Lite validation tensor conversion plus deterministic
`train=80`, `val=10`, `test=10` split manifest. The local Make targets keep
bounded samples for fast smoke validation where converters support sampling.
`make ai-eda-openlane-replay-prerequisites` records the OpenLane/OpenROAD binary,
PDK, config, run-tree, and replay-queue gates required before deterministic
replay execution. `make ai-eda-openlane-replay-handoff` then packages each
ready E1 replay candidate, generated macro-placement override, candidate and
placement-case manifest, replay queue/preflight input, and the exact PD-host
capture commands into a hash-pinned tarball without executing OpenLane.
`capture_openlane_replay_execution.py` and
`check_openlane_replay_execution.py` define the post-execution evidence
contract for PD hosts: metrics, OpenLane/OpenROAD logs, final DEF/GDS, and
hashes must be present before replay can count as optimization evidence. The
execution gate now also flattens nested metrics, requires timing/signoff/objective
metric coverage, and records OpenLane/OpenROAD log line counts plus error-like
line samples before a replay report can become ready.
`capture_openlane_replay_comparison.py` and
`check_openlane_replay_comparison.py` then compare a replayed baseline against
the candidate, require no timing/DRC/LVS/antenna regression, and require at
least one objective metric improvement before the optimization-claim gate can
open.
`make ai-eda-cuda-evidence-bundle` then packages the readiness audit and every
referenced handoff artifact path, SHA256, size, capability flag, and blocker
count into a replayable manifest. `make ai-eda-objective-readiness-audit`
consumes those artifacts plus the research doc, training handoff, replay queue,
AlphaChip blocker, full training matrix, OpenLane replay prerequisites, replay
execution evidence, and replay comparison evidence to report which parts of
the full AI-EDA objective are proven, incomplete, or blocked. `make
ai-eda-alphachip-successor-plan` records the checked fallback
route for AlphaChip-unavailable hosts: public-corpus PyTorch macro-placement
training/inference/replay now, and Circuit Training scratch only if
`plc_wrapper_main` is legally supplied and hash-pinned. `make
ai-eda-alphachip-successor-reproduction` then records whether that fallback has
actually reached CUDA-scale reproduction evidence: CUDA training/inference,
all-record matrix coverage, model/candidate hashes, ready replay queue, and a
baseline-vs-candidate replay comparison.
`make ai-eda-r-zoo-legality-baseline` trains the local dependency-free R-Zoo
rectilinear-floorplan legality baseline from the deterministic design-family
split manifest. It is wired into the corpus/payload/matrix path as
training-only evidence and never counts as E1 signoff or an optimization claim.

Current local validation uses `/usr/bin/python3` for non-Torch checks and
`/opt/miniconda3/bin/python` for Torch training/inference. The latest integrated
evidence refresh is `codex-full-conversion-objective`, with payload/run-plan
evidence from `codex-full-conversion-payload`, readiness/evidence-bundle output
from `codex-full-conversion-readiness` with 25/25 artifacts present, the
14-job full matrix from `codex-full-conversion-matrix`,
formal-prerequisite evidence from `codex-full-conversion-readiness`,
formal-execution fallback evidence from `codex-full-conversion-readiness`,
successor-reproduction evidence from `codex-successor-reproduction-contract`, setup
evidence from `codex-latest-setup-20260521`, replay handoff evidence from
`codex-openlane-replay-handoff-20260521`, and training handoff / validated
training corpus from `codex-handoff-dedupe-20260521-training-handoff`.
Current-research coverage is refreshed through
`codex-chipseek-watchlist-20260521`, adding ChipSeek to the gated RTL/PPA
feedback lane. That audit validates the 43-asset / 255-file payload,
232-command dry-run with 228
selected commands, safety matrix,
setup evidence, complete MPS training-handoff bootstrap, Torch
training/inference, R-Zoo and FloorSet conversion/split/license evidence, the
176-candidate full replay plan with seven ready candidates, the 23-entry replay
queue with one ready OpenLane candidate, OpenLane prerequisite report, the
ready seven-candidate PD-host OpenLane replay handoff package with generated
runbook and command stub, blocked strict formal prerequisites with Yosys fallback
recorded as smoke coverage only, fallback formal execution evidence blocked from
deep-proof claims, AlphaChip successor plan, blocked successor reproduction
evidence, blocked 14-job full-training matrix, and blocked replay comparison
contract. The objective audit proves 7 of 11
requirements and remains blocked by local CUDA absence, public AlphaChip
checkpoint access or CUDA-scale successor reproduction, OpenLane/OpenROAD/PDK
host prerequisites, missing strict SymbiYosys formal host and execution
readiness, E1 deterministic replay execution, and missing real
baseline-vs-candidate replay comparison evidence.

The latest FloorSet-specific refresh is `codex-floorset-full-archives-docs-20260521`:
FloorSet Lite conversion PASS with 100 cases / 300 normalized records, split
manifest PASS with `train=80`, `val=10`, `test=10`, and floorplanning readiness
PASS_BLOCKED with full Hugging Face archive evidence verified: 10/10 archives
and 29,665,773,263 bytes. The remaining blockers are generated-floorplan
quarantine for FloorSet and R-Zoo until deterministic E1 replay/signoff exists. The
training-handoff corpus refresh
`codex-handoff-dedupe-20260521-training-handoff` now includes FloorSet Lite in
the unified training corpus manifest: 18 datasets, 589 normalized records, and
2,689 logical records. The corresponding CUDA metadata payload is now folded
into `codex-floorset-payload-20260521` with 42 assets, 254 files, a
230-command dry-run with 226 selected commands, and a validated safety matrix.

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
