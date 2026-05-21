# Full Stack AI Chip Optimization Plan - 2026-05-20

Scope: build a reproducible, lawful, data-hungry AI optimization stack for the
Eliza E1 RISC-V AI SoC scaffold. The target is not a benchmark leaderboard. The
target is an end-to-end system that ingests public chip-design corpora, trains
or adapts placement/synthesis/routability/timing/power models, proposes
candidate optimizations for E1, and proves or rejects those candidates with the
existing deterministic RTL, formal, simulator, OpenLane/OpenROAD, software, and
evidence gates.

This document incorporates the user-provided public RISC-V / AlphaChip corpus,
the current `packages/chip` tree, and a fresh public-source check on
2026-05-20. It is research and implementation planning evidence only. No AI
prediction, generated script, model score, or proxy cost is an E1 design claim
until the corresponding deterministic E1 gate passes.

## Executive decision

The right stack is not "AlphaChip only." It is a multi-lane optimizer:

1. Macro placement: Google Circuit Training / AlphaChip code, MacroPlacement,
   ChiPBench-D, OpenROAD Hier-RTLMP, simulated annealing, coordinate descent,
   ChipDiffusion, ChiPFormer, and CORE-style search.
2. Physical-design predictors: CircuitNet 1.0/2.0/3.0, EDALearn, iDATA/AiEDA,
   OpenROAD-flow-scripts run data, OpenROAD Assistant / EDA Corpus, and local E1
   OpenLane/OpenROAD snapshots.
3. Logic-synthesis policy: OpenABC-D, ABC-RL, abcRL, MapTune, Yosys/ABC recipe
   sweeps, and E1 synthesis before/after labels.
4. NPU and architecture DSE: Timeloop/Accelergy, SCALE-Sim, ZigZag, DRAMSim3,
   ChampSim, local `compiler/runtime` NPU simulators, and E1 workload traces.
5. Verification and repair: cocotb stimulus search, formal property candidate
   generation, netlist equivalence, CDC/RDC target capture, log triage, and
   fail-closed replay manifests.
6. Agentic orchestration: read-only local RAG first, then typed command schemas
   for selected OpenROAD/Yosys/simulator actions only after sandboxing,
   allowlists, logs, hashes, and reviewer disposition exist.

The highest-priority implementation gap is not more research. The repo already
has the outlines. The gap is asset intake plus a reproducible training/eval
spine:

- exact external source pins and manifests under a repo-owned external asset
  layout;
- dataset download, hash, license, split, and schema manifests;
- conversion pipelines into common graph/layout formats;
- training recipes that can run locally small and remotely large;
- E1 inference adapters that output quarantined candidates;
- deterministic replay gates that accept/reject candidates using real E1
  artifacts.

## Current E1 state in this repo

The current repository is already unusually prepared for this work:

- `packages/chip` is the E1 chip package. Its `AGENTS.md` says to treat it as a
  pre-tapeout hardware/software evidence package for an open RISC-V AI SoC
  scaffold and to make claims only through evidence gates.
- `packages/chip/README.md` defines E1 as the smallest end-to-end system used
  to prove conventions, evidence gates, and tool setup before scaling the final
  phone SoC.
- `packages/chip/research/00_index.md` already contains research packets for
  NPU, compiler/runtime, CPU, memory, PD/EDA, process/packaging, security, BSP,
  benchmarks/formal, mobile platform, and AlphaChip macro placement.
- `packages/chip/research/alpha_chip_macro_placement/00_index.md` already
  describes an AlphaChip path: Circuit Training, MacroPlacement, E1 softmacro
  benchmarks, OpenLane replay, and post-route validation.
- `packages/chip/docs/toolchain/alphachip-checkpoint-blocker.md` already
  records the main external blocker: Google-hosted AlphaChip checkpoint,
  DREAMPlace tarballs, and `plc_wrapper_main` return HTTP 403 from documented
  GCS URLs.
- `packages/chip/scripts/alphachip/` already has wrappers for Circuit Training
  setup, conversion, smoke tests, toy training, E1 softmacro benchmark
  preparation, single-host training, H200 payload packaging, proxy-cost
  comparison, coordinate descent, and checkpoint mirror/bootstrap handling.
- `packages/chip/scripts/ai_eda/` already contains target-capture and dry-run
  scripts for most AI-EDA lanes: local RAG, external metadata probing,
  OpenROAD ML snapshots, OpenROAD autotune, RTL model evaluation, cocotb
  stimulus search, ZigZag NPU DSE, RTL PPA advisory, HLS, timing, routing,
  clock tree, parasitics, memory/interconnect, DFT, power/thermal, hardware
  security, CDC/RDC, BSP/firmware, RTL rewrite equivalence, board/package/FPGA,
  low-power intent, verification debug, post-silicon validation, circuit
  foundation models, DFM/yield/lithography, compiler autotuning, reliability,
  external model/corpus intake, benchmark hygiene, EDA tool-agent interop,
  spec traceability, IP/register contracts, memory macro libraries, 3DIC, logic
  synthesis, netlist equivalence, physical verification, placement, and
  legalization.
- `packages/chip/scripts/check_ai_eda_source_inventory.py` is already the main
  fail-closed guard for these lanes. `make docs-check` depends on it.
- `packages/chip/pd/openlane/` has OpenLane/OpenROAD configs for SKY130, GF180,
  IHP SG13G2, ASAP7, exploratory variants, padframe inputs, and portability
  metadata.
- `packages/chip/verify/` has cocotb and formal collateral, including NPU, DMA,
  top-level, IOMMU, and AI-EDA assertion/coverage/seed candidate artifacts.
- `packages/chip/compiler/runtime/` has E1 NPU runtime, delegate, partitioner,
  StableHLO/lowering, simulation-scale model, and tests.
- `packages/chip/benchmarks/` has benchmark plans, CPU/memory/ML parsers, local
  TFLite smoke model generation, power workload plans, and simulation drivers
  for NPU scale, NPU context queues, memory/IOMMU/QoS, thermal sweeps, and
  operating-point optimization.
- `packages/chip/docs/project/chip-os-boot-gap-survey-2026-05-20.md` is honest
  about the main product blocker: the checked-in E1 RTL is still a debug/MMIO
  scaffold, generated Chipyard AP boot reaches only a partial Linux banner, and
  no Linux/AOSP phone claim should be made yet.

The implication: this plan should extend existing mechanisms, not create a
second project. All new assets should land behind manifests, scripts, and gates
that match the current `packages/chip` style.

## Public-source findings checked on 2026-05-20

### AlphaChip / Circuit Training

Google's public `google-research/circuit_training` repository still describes
AlphaChip as an open-source framework for chip floorplanning with distributed
deep RL. Its README says it optimizes wirelength, congestion, and density;
supports fixed macros and spacing constraints; supports DREAMPlace; and points
to TILOS converters for LEF/DEF and Bookshelf to AlphaChip protobuf.

Source: https://github.com/google-research/circuit_training

The artifact problem remains live. Issue #86, opened 2026-01-13, reports the
documented `tpu_checkpoint_20240815.tar.gz` path returning `AccessDenied`.
Issue #85, opened 2026-01-09, reports GCS access denied for DREAMPlace,
`plc_wrapper_main`, and model paths. Issue #87, opened 2026-02-19, reports
HTTP 403 for both `plc_wrapper_main` and DREAMPlace and notes that Docker can
write the XML error body as a bogus executable.

Sources:

- https://github.com/google-research/circuit_training/issues/85
- https://github.com/google-research/circuit_training/issues/86
- https://github.com/google-research/circuit_training/issues/87

Operational conclusion: treat Circuit Training as code and format reference,
not as a reliable source of pretrained weights or required binaries. If a
private pre-February-2026 copy of the checkpoint or binary exists, it may be
used only through a private mirror with SHA256 verification and provenance.
Otherwise, train from scratch or use lawful substitute models.

### MacroPlacement

TILOS MacroPlacement is still the best public direct AlphaChip-style corpus. It
contains reproducible benchmark/evaluator infrastructure and explicitly lists
RTL/testcases for Ariane, MemPool, NVDLA, and BlackParrot. The repository's
public notes also include 2025/2026 updates on Circuit Training / AlphaChip
evaluation and CT-AC-DP comparisons.

Source: https://github.com/TILOS-AI-Institute/MacroPlacement

Use it as the canonical direct macro-placement dataset and as the standard
source for E1 placement evaluation discipline. It should be mirrored/pinned
before any training run.

### ChiPBench-D

ChiPBench-D is a 2.68 GB Hugging Face dataset containing per-case `def`, `lef`,
`lib`, synthesized Verilog, and `constraint.sdc`. The dataset explicitly
documents `pre_place.def` and `macro_placed.def`, making it directly useful for
macro placement and final PPA comparison through OpenROAD-style flows.

Source: https://huggingface.co/datasets/MIRA-Lab/ChiPBench-D

Use it as the first end-to-end placement-to-routing evaluation corpus after
MacroPlacement, because it provides the actual artifacts needed to compare
proxy optimization against downstream implementation behavior.

### CircuitNet 1.0/2.0/3.0

CircuitNet's public site lists CircuitNet 1.0 at 28 nm, CircuitNet 2.0 at
14 nm, and CircuitNet 3.0 at 45 nm. CircuitNet 3.0's public Hugging Face page
summarizes 8,659 validated open-source RTL designs and 15,863 design instances
after augmentation, with timing labels and power summaries.

Sources:

- https://circuitnet.github.io/
- https://huggingface.co/datasets/SKLP-EDA-LAB/CircuitNet3.0
- https://openreview.net/forum?id=lEDb4gQ4dB

Use CircuitNet for auxiliary predictors and representation pretraining:
timing, power, routability, congestion, DRC/IR-risk where available. Do not use
CircuitNet labels as signoff evidence for E1.

### OpenROAD Assistant / EDA Corpus

OpenROAD-Assistant/EDA-Corpus provides QA pairs and prompt-script pairs for
OpenROAD and OpenROAD-flow-scripts. The README reports 593 non-augmented and
1,533 augmented combined QA/PS pairs and a CC-BY-4.0 license.

Source: https://github.com/OpenROAD-Assistant/EDA-Corpus

Use it to train or evaluate a local OpenROAD command assistant and log-triage
assistant. Do not let it directly write E1 Tcl or shell until typed command
schemas and deterministic replay exist.

### iDATA / AiEDA

AiEDA/iDATA is a public Hugging Face dataset for AI+EDA tasks such as PPA
prediction and PPA-aware physical design. The public dataset page shows
synthesized netlists/SDC, place-stage DEF/SDC/vectors, and route-stage
DEF/Verilog/SPEF/vector-style data.

Source: https://huggingface.co/datasets/AiEDA/iDATA

Use it for design-to-vector experiments, graph/path feature schema work, and
PPA/timing/power predictors. Add it behind a license and storage review before
download because the public page is large and schema-rich.

### ChipDiffusion

`vint-1/chipdiffusion` is public code for "Chip Placement with Diffusion
Models" (ICML 2025). The README documents benchmark generation and provides a
pretrained Large+v2 checkpoint link. It warns that checkpoint mismatch can fall
back to random model weights.

Source: https://github.com/vint-1/chipdiffusion

Use it as a non-RL macro-placement baseline and candidate generator. The
checkpoint should be treated like any other model artifact: pinned URL,
checksum, license/provenance review, and deterministic E1 replay.

### 2026 macro-placement and floorplanning additions

The Partcl/HRT Macro Placement Challenge repository is a live 2026 benchmark
lane with Apache-2.0 repository licensing metadata and OpenROAD-oriented
scoring. Its README states a May 21, 2026 submission deadline, a one-hour
per-benchmark runtime limit, and final evaluation of top submissions through
OpenROAD on NG45 designs including hidden designs.

Source: https://github.com/partcleda/macro-place-challenge-2026

Use it as a benchmark-hygiene and scoring-policy reference, not as an E1
release gate. If imported, it must stay behind exact revision pinning,
challenge-term review, public/hidden split handling, non-overlap checks,
candidate quarantine, and downstream E1 OpenLane/OpenROAD replay.

Intel FloorSet is now directly relevant because it is the basis for the ICCAD
2026 FloorSet Challenge. The public README reports 2M synthetic fixed-outline
floorplan layouts, 1M training samples per dataset family, 100 local validation
samples, hidden final test samples, and about 35 GB of storage for the public
dataset workflow.

Source: https://github.com/IntelLabs/FloorSet

Use it for floorplanning pretraining and constraint handling only after license
review and split manifests. It is synthetic and cannot prove E1 macro, IO, PDN,
package, or timing quality.

VeoPlace / "See it to Place it" is a 2026 VLM-guided evolutionary macro
placement method. The public abstract reports using a VLM without fine-tuning
to constrain a base placer to subregions, outperforming prior learning-based
approaches on 9 of 10 open benchmarks and improving DREAMPlace in all 8
evaluated benchmarks.

Source: https://arxiv.org/abs/2603.28733

Use it as a high-priority experimental search policy once E1 placement cases
can be rendered as deterministic floorplan images. Hosted VLM inference is
blocked until data-handling terms, prompt/image hashes, model/version IDs,
subregion proposals, legalizer outputs, OpenROAD replay, and PD review exist.

Recent 2026 RL/search placement papers also add useful ideas: HMPlace for
hierarchical mask-guided RL, RSPlace for rotation-aware bidirectional tree
expansion, and dynamic tree-search guided RL for MCTS-style exploration. These
are method references until code, licenses, and local replay evidence exist.

Sources:

- https://www.sciencedirect.com/science/article/pii/S1879239126001797
- https://ojs.aaai.org/index.php/AAAI/article/view/39559
- https://doi.org/10.1016/j.mejo.2026.107100

NVIDIA C3PO is a 2026 ASP-DAC placement reference for coherent concurrent
timing, routability, and wirelength optimization. It is useful as an objective
design reference for future OpenROAD/OpenLane experiments, but it is paper-only
for this repo until source, exact benchmark setup, and local E1 replay exist.

Source:

- https://research.nvidia.com/labs/electronic-design-automation/publication/lu2026aspdac/

### CommonCircuits

CommonCircuits is a new 2026 public dataset effort for normalized PCB/circuit
design data. It is not a primary ASIC placement corpus today, but it matters
for board/package/PCB optimization and future circuit foundation models.

Source: https://www.commoncircuits.org/

Track it for E1 board/package co-optimization, KiCad/PCB data extraction, and
manufacturability agents. Do not block the ASIC AI-EDA path on it.

## Source and dataset intake TODOs

### Implemented metadata spine

The first reproducibility spine is now checked in:

- `external/README.md` defines the tracked/ignored external asset policy.
- `external/SOURCES.lock.yaml` pins the first P0 AI-EDA sources as metadata
  records without downloading or vendoring payloads.
- `external/schemas/ai_eda_external_asset_manifest.v1.yaml` defines the
  required fields and fail-closed policy for asset records.
- `external/schemas/ai_eda_external_intake_manifest.v1.yaml` defines the
  per-asset reviewed metadata manifest shape for sources that have a pinned
  upstream revision or license/provenance evidence but no committed payload.
- `external/datasets/openroad-eda-corpus/manifest.yaml` pins the OpenROAD EDA
  Corpus metadata lane to upstream `main` commit
  `473daeb20677758b612e1a9e30246231c02d133c` with CC-BY-4.0 README/LICENSE
  evidence, while keeping the actual dataset payload path ignored.
- `external/datasets/chipbench-d/manifest.yaml`,
  `external/datasets/circuitnet3/manifest.yaml`,
  `external/datasets/intel-floorset/manifest.yaml`, and
  `external/repos/macro-place-challenge-2026/manifest.yaml` now add
  metadata-only intake lanes for the highest-value 2026 placement,
  floorplanning, and PD-prediction corpora without downloading payloads.
- `external/repos/tilos-macroplacement/manifest.yaml` pins the TILOS
  MacroPlacement corpus to commit
  `20eddb6b35232e86e6008b9deec8da77633a2f07` with BSD-3-Clause license
  evidence, while keeping the large payload path ignored.
- `external/SOURCES.lock.yaml` now also tracks optional backend lanes for
  RTL-MUL, LLM4DV/ml4dv, AssertLLM, and Fault DFT so their installation and
  payload status can be audited alongside ZigZag and Timeloop/Accelergy before
  any CUDA-host experiment depends on them.
- `scripts/ai_eda/check_external_asset_manifests.py` validates the lockfile.
- `scripts/ai_eda/check_external_intake_manifests.py` validates tracked
  per-asset intake manifests against `external/SOURCES.lock.yaml`.
- `scripts/ai_eda/fetch_external_asset.py` emits dry-run, verify-only, or
  execute reports into `build/ai_eda/external_assets/<run-id>/`. When a tracked
  metadata manifest exists at `external/{datasets,repos,models}/<asset>/`,
  fetched payloads go under the ignored `payload/` subdirectory so committed
  metadata cannot block a future fetch.
- `scripts/ai_eda/fetch_external_asset.py` also supports paper/method-reference
  assets in metadata-only mode. For AssertLLM this creates an ignored local
  provenance record and hash manifest without downloading a paper, importing a
  model, generating assertions, or making a verification claim.
- `scripts/ai_eda/bootstrap_ai_eda_stack.py` is the fresh-machine orchestration
  entrypoint. The `metadata` profile validates manifests and dry-runs fetches,
  `setup-check` verifies reviewed payloads and rebuilds normalized corpora/E1
  cases, `local-smoke` adds converter/training/replay-plan checks, and
  `training-handoff` adds CUDA/MPS Torch inference/training plus payload
  packaging. Readiness auditing is a post-bootstrap gate so it can reference the
  completed setup and training-handoff reports instead of auditing a run that is
  still in progress. Explicit `--asset ... --execute-fetch` is required for
  downloads.
- `scripts/ai_eda/preflight_cuda_training_stack.py` records Mac/CUDA/MPS
  readiness into `build/ai_eda/cuda_training_preflight/<run-id>/`.
- `scripts/ai_eda/preflight_ai_eda_backends.py` records optional AI/EDA backend
  readiness for ZigZag, Timeloop/Accelergy, RTL-MUL, LLM4DV, AssertLLM, and
  Fault without installing packages, cloning repositories, downloading model
  weights, or making release-use claims.
- `scripts/ai_eda/check_backend_preflight.py` validates that backend readiness
  report and keeps the blocker accounting wired into `make
  ai-eda-backend-preflight`.
- `scripts/ai_eda/build_local_eda_rag_index.py` and
  `scripts/ai_eda/check_local_eda_rag_index.py` are wired into `make
  ai-eda-local-rag-index`, creating a read-only local source manifest and
  citation smoke report before any agentic EDA/log-triage workflow can use
  project context.
- `scripts/ai_eda/package_cuda_training_payload.py` emits a metadata-only
  payload and run plan for a remote CUDA host.
- `scripts/ai_eda/check_cuda_training_payload.py` validates the CUDA payload
  report, tarball, embedded run plan, selected asset list, critical fetch
  commands, referenced scripts, expected CUDA outputs, and no-dataset/no-weight
  payload boundary.
- `scripts/ai_eda/capture_cuda_readiness_audit.py` and
  `scripts/ai_eda/check_cuda_readiness_audit.py` are wired into
  `make ai-eda-cuda-readiness-audit`, which reconciles CUDA preflight, payload,
  the dry-run execution manifest for the embedded run plan, AlphaChip
  checkpoint, current-research watchlist, setup-check/bootstrap evidence,
  training-handoff bootstrap evidence, and E1 replay-preflight reports into one
  blocked-or-ready handoff artifact without running training, inference,
  OpenLane, downloads, or signoff. The audit accepts explicit setup/handoff
  evidence run IDs when those reports are produced by separate host runs.
- `scripts/ai_eda/capture_openroad_ml_snapshot.py` and
  `scripts/ai_eda/check_openroad_ml_snapshot.py` are wired into
  `make ai-eda-openroad-ml-snapshot`, recording the latest local
  OpenLane/OpenROAD final-artifact inventory for future PD predictor labels
  while staying advisory-only and blocked until repeated deterministic runs
  and holdout splits exist.
- `scripts/ai_eda/capture_logic_synthesis_targets.py`,
  `scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py`, and
  `scripts/ai_eda/capture_netlist_equivalence_targets.py` are wired into
  `make ai-eda-verification-targets`, with
  `scripts/ai_eda/check_verification_target_captures.py` validating that these
  formal/synthesis/LEC targets remain dry-run, fail-closed capture artifacts
  until deterministic E1 proof and replay gates exist.
- `scripts/ai_eda/capture_timing_closure_targets.py`,
  `scripts/ai_eda/capture_routing_congestion_targets.py`,
  `scripts/ai_eda/capture_placement_legalization_targets.py`, and
  `scripts/ai_eda/capture_physical_verification_targets.py` are wired into
  `make ai-eda-physical-design-targets`, with
  `scripts/ai_eda/check_physical_design_target_captures.py` validating that
  timing, routing, placement/legalization, and physical-verification automation
  targets remain dry-run, fail-closed, no-tool-execution artifacts.
- `research/alpha_chip_macro_placement/01_sources/ai_eda_current_research_watchlist_2026.yaml`
  and `scripts/ai_eda/capture_current_research_watchlist.py` are wired into
  `make ai-eda-optimization-targets`, with
  `scripts/ai_eda/check_current_research_watchlist.py` validating the YAML and
  captured report. This keeps current public AI-EDA methods such as VeoPlace,
  HMPlace, RSPlace, dynamic-tree-search RL placement, C3PO, AuDoPEDA, AiEDA,
  and DreamerV3+FR PCB routing as checked metadata-only watchlist entries with
  no import, training, inference, tool, source-change, release, or E1 design
  claim.
- `scripts/ai_eda/capture_circuit_foundation_model_targets.py`,
  `scripts/ai_eda/capture_eda_tool_agent_interop_targets.py`,
  `scripts/ai_eda/capture_dfm_yield_lithography_targets.py`,
  `scripts/ai_eda/capture_low_power_intent_targets.py`,
  `scripts/ai_eda/capture_post_silicon_validation_targets.py`, and
  `scripts/ai_eda/capture_hardware_security_targets.py` are wired into
  `make ai-eda-optimization-targets`, with
  `scripts/ai_eda/check_ai_optimization_target_captures.py` validating broader
  AI optimization targets as dry-run, fail-closed artifacts with no model,
  tool, source-change, release, or signoff claims.
- `make ai-eda-all-target-captures` now refreshes every
  `scripts/ai_eda/capture_*_targets.py` report in a dependency-safe order
  before source-inventory validation. This covers 36 dry-run capture lanes:
  verification, physical design, EDA agents, circuit foundation models,
  current-research watchlist, benchmark hygiene, external-model corpus intake,
  HLS, analog/mixed-signal, clock tree, extraction/parasitics, floorplan/IO/PDN,
  memory macros,
  memory interconnect, DFT/ATPG, CDC/RDC, chiplet/3DIC/package, board/FPGA,
  compiler autotuning, CPU microarchitecture, software/BSP/firmware,
  simulator optimization, reliability/resilience, power/thermal, low-power
  intent, post-silicon validation, hardware security, and DFM/yield/lithography.
- `docs/spec-db/ai-eda/internal-dataset-schemas.yaml` defines the first
  internal normalized records: `eda.design_bundle.v1`,
  `eda.placement_case.v1`, `eda.graph_sample.v1`, `eda.flow_run.v1`, and
  `eda.e1_candidate.v1`.
- `docs/spec-db/ai-eda/internal-dataset-schemas.yaml` also defines
  `eda.text_instruction_sample.v1` for OpenROAD command-assistant, RAG, and
  log-triage training samples.
- `scripts/ai_eda/convert_current_research_watchlist_to_internal_records.py`
  converts the validated 2026 current-research watchlist into
  `eda.text_instruction_sample.v1` RAG/training records, and
  `scripts/ai_eda/check_current_research_watchlist_records.py` verifies exact
  report-to-record inventory, source hashes, metadata-only policy flags, and
  explicit replay/signoff evidence before those records enter any CUDA runbook.
- `scripts/ai_eda/build_training_corpus_manifest.py` and
  `scripts/ai_eda/check_training_corpus_manifest.py` are wired into
  `make ai-eda-training-corpus-manifest`, producing one hashed manifest across
  every normalized local training/RAG corpus so CUDA-host runs can prove which
  records, schemas, lanes, reports, and claim boundaries were available before
  training.
- `scripts/ai_eda/build_training_corpus_manifest.py` and
  `scripts/ai_eda/check_training_corpus_manifest.py` build and validate a
  single run-scoped manifest over the normalized training/RAG corpus. The
  manifest records every internal record path/hash, schema distribution,
  dataset lane, source conversion report hash, and no-payload/no-weights
  policy boundary for CUDA handoff.
- `docs/spec-db/ai-eda/examples/*.yaml` provides tiny schema fixtures for the
  E1 softmacro smoke lane.
- `scripts/ai_eda/check_internal_dataset_schemas.py` validates the schemas and
  fixtures.
- `make docs-check` now depends on `ai-eda-external-assets-check`, so source
  intake metadata and internal dataset schemas are validated with the existing
  docs gate.

Current local validation on the 128 GiB M4 host:

- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-training-corpus-docs docs-check`: PASS. This run
  validates the local RAG index, backend preflight, current-research watchlist,
  the full all-domain target-capture gate, active-run source inventory,
  external assets/intake, AlphaChip checkpoint blocker, internal schemas,
  candidate/tool-action schemas, and cocotb stimulus dry run.
- `make ai-eda-external-assets-check`: PASS for 41 locked source/model/dataset/
  paper entries after adding the broader research-code, verification, DFT, MCP,
  VLM, 3D-IC, and macro-placement benchmark metadata registry.
- `make ai-eda-external-intake-check`: PASS for 21 metadata manifests covering
  the P0 datasets/repos, research-code assets, verification/DFT references,
  and pending metadata-only sources that require payload or access review
  before conversion/training use.
- `make ai-eda-backend-preflight`: PASS_WITH_BLOCKERS_RECORDED. On the current
  Mac, ignored payload candidates are present for ZigZag and
  Timeloop/Accelergy, while RTL-MUL, LLM4DV, AssertLLM, and Fault remain
  blocked by missing local payloads/packages. The report is metadata-only and
  explicitly records no installs, clones, model-weight downloads, external API
  requirements, or release-use claims.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset assertllm --dry-run
  --run-id validation`, `--execute`, then `--verify-only`: PASS. The execute
  step writes only `external/repos/assertllm/payload/metadata.json` under an
  ignored payload path; verify-only hashes that metadata record and preserves
  the method-reference/no-generated-assertion/no-release-claim boundary.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-eda-corpus
  --dry-run --run-id intake-validation`: PASS and points the future download to
  `external/datasets/openroad-eda-corpus/payload`.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset chipbench-d --dry-run
  --run-id validation`: PASS and emits a dry-run report.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset circuitnet3
  --dry-run --run-id validation`: PASS and emits a dry-run report.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset circuitnet3
  --execute --run-id download-20260520`: PASS. The public CircuitNet 3.0
  payload is present under `external/datasets/circuitnet3/payload` with
  `circuitNetv3.zip` at 1,032,704,519 bytes. The archive contains 57,975 zip
  entries and 2,004 `dataset/Final/*/feature.json` cases in the current public
  release. This is training/pretraining data only, not E1 signoff evidence.
- `make ai-eda-circuitnet3-convert`: PASS when the reviewed local
  CircuitNet3 payload archive is present. The bounded validation sample
  converts 16 public CircuitNet3 final cases into 48 internal
  `eda.design_bundle.v1`, `eda.graph_sample.v1`, and `eda.flow_run.v1`
  records, with labels explicitly quarantined as pretraining-only and not E1
  signoff.
- `make ai-eda-circuitnet3-surrogate`: PASS. The current dependency-free
  baseline trains over those 16 converted CircuitNet3 flow-run records with a
  deterministic sorted-case split of 12 train, 2 validation, and 2 test cases.
  It writes
  `build/ai_eda/circuitnet3_surrogate/validation/training_run.json`,
  `metrics.json`, and `circuitnet3_surrogate_model.json`, then validates split
  counts, model targets, finite metrics, and the pretraining-only claim
  boundary. Current validation MAE values include `min_slack=0.9475` and
  `total_power=8.52562112`; current test MAE values include
  `min_slack=1.752` and `total_power=88.45308526`. These are smoke metrics
  only, not an E1 timing or power claim.
- `make ai-eda-chipbench-d-convert`: PASS. The bounded local sample converts 4
  restored ChiPBench-D payload cases into 12 internal placement/design/flow
  records from 20 available cases with 361 macro target placements, then
  validates exact report-to-record inventory, file hashes, floorplans, macro
  sizes, target placements, and the training-only/no-E1-signoff claim boundary.
- `make ai-eda-macro-placement-supervised-dataset`: PASS. The supervised
  macro-placement dataset now consumes internal fixtures, TILOS MacroPlacement,
  bounded ChiPBench-D, and E1 softmacro cases by default, so the restored
  ChiPBench-D macro target labels are included in train/validation/test JSONL
  preparation instead of remaining a detached conversion artifact. Current
  validation emits 2,780 samples across 22 labeled cases with split counts
  train=2,340, validation=200, and test=240; 361 train samples come from the
  bounded ChiPBench-D conversion.
- `make ai-eda-macro-placement-supervised-train`: PASS_WITH_BLOCKED_CASES. The
  dependency-free supervised mean baseline trains on the enlarged 2,780-sample
  dataset and emits 18 quarantined macro-placement candidates, including 3
  ChiPBench-D-backed candidates; 6 cases are blocked by missing macros or
  pre-replay geometry checks.
- `make ai-eda-macro-placement-supervised-replay-plan`: PASS_WITH_BLOCKED_REPLAY.
  The replay planner now resolves ChipBench-D candidate placement cases too and
  emits replay bundles/tool-action dry runs for 18 supervised candidates, with
  ready=0 and blocked=18 until deterministic OpenLane/OpenROAD replay exists.
- `make ai-eda-openabc-d-convert`: PASS. The bounded local setup sample
  converts 2 restored OpenABC-D BENCH logic networks into 6 internal
  `eda.design_bundle.v1`, `eda.graph_sample.v1`, and `eda.flow_run.v1`
  records for synthesis-policy pretraining. The records remain public
  benchmark training data only and require leakage review plus E1 equivalence
  replay before they can influence a chip change. A dedicated checker now
  validates exact report-to-record inventory, BENCH source hashes, positive
  graph gate/edge counts, flow blockers, and the training-only/no-E1-signoff
  claim boundary.
- `make ai-eda-aieda-idata-convert`: PASS when the reviewed local AiEDA/iDATA
  payload is present. The bounded local sample converts 3 public iDATA route
  demand maps into 9 internal design/graph/flow records with full aggregate
  route-demand statistics, source hashes, bounded representative graph samples,
  and fail-closed status. The CUDA payload run plan includes 64-map iDATA
  conversion and checker commands for the remote host.
- `make ai-eda-edalearn-convert`: PASS when the reviewed local EDALearn
  payload is present. The current payload exposes 68 design directories with
  configs/RTL, and the bounded local sample converts 8 public RTL/config
  designs into 24 internal `eda.design_bundle.v1`, `eda.graph_sample.v1`, and
  `eda.flow_run.v1` records with source hashes, config counts, bounded module
  graph samples, and a training-only/no-E1-signoff claim boundary
  (`AI_EDA_RUN_ID=codex-edalearn-20260521`).
- `make ai-eda-macro-placement-replay-preflight`: PASS_BLOCKED. The guarded
  preflight consumes the combined replay-plan bundle, selects a candidate,
  verifies candidate/case/bundle hashes, records missing replay prerequisites,
  and refuses execution/promotion until a replay plan is marked
  `READY_FOR_DETERMINISTIC_REPLAY` with isolated OpenLane/OpenROAD tooling.
- Verify-only payload checks now PASS for restored `chipbench-d`,
  `circuitnet3`, `aieda-idata`, `edalearn`, `chipdiffusion`, `openabc-d`, and
  `timeloop-accelergy`. `openroad-flow-scripts` is intentionally BLOCKED
  because the current local clone is incomplete and has no readable `HEAD`.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset intel-floorset
  --dry-run --run-id validation`: PASS and emits a dry-run report.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset
  macro-place-challenge-2026 --dry-run --run-id validation`: PASS and emits a
  dry-run report.
- `make ai-eda-macro-place-challenge-convert`: PASS after local payload
  restore/fetch. The converter emits 12 internal records across four public
  NG45 challenge baselines (`eda.design_bundle.v1`, `eda.graph_sample.v1`, and
  `eda.flow_run.v1` per benchmark), with processed tensor SHA256 references,
  proxy-cost labels, PPA baseline metadata, no hidden-benchmark payload, and no
  E1 signoff claim.
- `make ai-eda-mlcad-fpga-macro-convert`: PASS for the restored public MLCAD
  2023 FPGA macro-placement payload. The current local payload contains the
  global contest/spec files, clock-bucket key, UltraScalePlus site layout,
  library cell catalog, and cascade-shape instances, but not per-design
  Bookshelf/Vivado cases (`design.nodes`, `design.nets`, `sample.pl`, or
  `Design_*` directories). The converter therefore emits 12 internal records
  across 4 clock buckets covering 180 design IDs as FPGA transfer-learning
  metadata only and records `BLOCKED_MISSING_DESIGN_CASE_PAYLOAD` before any
  contest-score or E1 PPA claim (`AI_EDA_RUN_ID=codex-mlcad-20260521`).
- `make AI_EDA_RUN_ID=codex-final-validate ai-eda-openlane-flow-labels
  ai-eda-macro-place-challenge-convert ai-eda-mlcad-fpga-macro-convert
  ai-eda-research-code-assets-convert`: PASS. OpenLane label parsing currently
  records `fixture_metrics_parser_smoke_no_ppa_claim` and
  `deterministic_run_artifacts_present=false` because no local
  `pd/openlane/runs/RUN_*/final/metrics.json` exists in this checkout; the
  same gate will switch to the latest real run metrics automatically after
  deterministic replay.
- `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=codex-proxy-baselines4
  ai-eda-macro-placement-baseline`: PASS. The checked run inspects 20
  normalized placement cases, emits 133 quarantined candidates across the
  center/grid/repair plus CT/SA/Hier-RTLMP/ChipDiffusion proxy lanes, records
  one no-movable-macro blocker, validates all seven policy lanes with
  `scripts/ai_eda/check_macro_placement_baseline.py`, and leaves every
  candidate replay-blocked before any OpenLane/OpenROAD or E1 PPA claim.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-training-corpus-docs docs-check`: PASS with all AI-EDA
  domain target captures, current-research watchlist capture, source inventory
  (`entries=587`), 41 external assets, 21 intake manifests,
  candidate/tool-action checks, and docs skeleton checks.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-safety-readiness ai-eda-cuda-readiness-audit`: PASS.
  The CUDA metadata payload contains 204 files, covers 41 external assets,
  includes the current-research watchlist YAML plus capture/check/conversion
  scripts, training-corpus manifest build/check scripts, dry-run run-plan
  executor/checker scripts, the stage-selection/risky-stage safety-matrix
  checker, a generated `cuda_handoff_README.md` checked against the run-plan
  command anchors, OpenROAD ML snapshot capture/check scripts, Macro Placement
  Challenge, MLCAD FPGA macro, research-code asset, and OpenLane flow-label
  checkers. The generated execution manifest expands run-id placeholders for
  173 run-plan commands, selects 169 directly runnable commands, skips two
  generic template commands, and explicitly skips the two embedded run-plan
  orchestration commands so the executor cannot recursively invoke itself. The
  safety matrix validates 14 stage selections and 20 checks, including blocked
  execute-mode attempts for asset downloads, training, inference, replay, and
  AlphaChip stages unless their explicit allow flags are supplied. Dataset
  payloads, tensor payloads, model weights, and build outputs remain outside
  the tarball.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset <latest-asset>
  --execute/--verify-only --run-id codex-latest-ai-eda-20260521`: PASS for
  MCP4EDA, ORFS-Agent, OpenROAD Agent, OpenROAD MCP, Open3DBench, DREAMPlace,
  ChipLingo, VeoPlace, AuDoPEDA, and the 2026 3D-IC PPA surrogate paper. Git
  assets are checked out under ignored payload directories; paper assets emit
  metadata-only payload records and do not download PDFs or model weights.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset tilos-macroplacement
  --execute --run-id validation`: PASS. The reviewed MacroPlacement corpus is
  checked out under `external/repos/tilos-macroplacement/payload`.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset tilos-macroplacement
  --verify-only --run-id validation`: PASS. The verified revision is
  `20eddb6b35232e86e6008b9deec8da77633a2f07`; the payload manifest hashes
  3,765 files and 3,744,623,755 bytes.
- `python3 scripts/ai_eda/fetch_external_asset.py --all --dry-run --run-id
  codex-latest-ai-eda-20260521`: PASS across 41 locked external assets.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset
  google-circuit-training --verify-only --run-id validation`: PASS. The
  public Circuit Training checkout is retained as ignored payload under
  `external/repos/google-circuit-training/payload`, pinned at
  `c417a3a13f40867b649c719c03daaf1b39a909bc`; public checkpoint/binary access
  remains blocked separately by the AlphaChip checkpoint blocker.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-eda-corpus
  --execute --run-id validation`: PASS. The reviewed small corpus is checked
  out under `external/datasets/openroad-eda-corpus/payload`.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset openroad-eda-corpus
  --verify-only --run-id validation`: PASS. The verified revision is
  `473daeb20677758b612e1a9e30246231c02d133c`; the payload manifest hashes 25
  files and 7,929,988 bytes.
- `make ai-eda-openroad-eda-corpus-convert`: PASS. The converter emits 2,116
  normalized `eda.text_instruction_sample.v1` records with deterministic split
  counts: 1,691 train, 206 validation, and 219 test.
- `make PYTHON=/opt/miniconda3/bin/python3 AI_EDA_RUN_ID=codex-isolated-20260521
  ai-eda-cuda-preflight`:
  PASS_WITH_BLOCKERS_RECORDED under the conda Python environment. The host has
  128 GiB RAM, PyTorch 2.8.0 with MPS available, and no CUDA; missing CUDA
  tools, OpenROAD, TensorFlow, DGL, and PyG are recorded in the JSON report.
- `make PYTHON=/opt/miniconda3/bin/python3 AI_EDA_RUN_ID=codex-isolated-20260521
  ai-eda-cuda-payload`:
  PASS and emits a tarball containing manifests, scripts, and a run plan only.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-research-assets13 ai-eda-research-code-assets-convert`:
  PASS. The converter emits 26 normalized `eda.text_instruction_sample.v1`
  records across 13 fetched research-code assets: ChipDiffusion, ChiPFormer,
  CORE, MapTune, ABC-RL, abcRL, RL4LS, MCP4EDA, ORFS-Agent, OpenROAD Agent,
  OpenROAD MCP, Open3DBench, and DREAMPlace. These are structured research/RAG
  and CUDA-runbook samples only; the checker requires source hashes, exact
  report-to-record inventory, no execution/training/inference, no model-weight
  claims, and deterministic E1 replay before any optimization claim.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-current-research-records2
  ai-eda-current-research-watchlist-convert`: PASS. The converter emits 8
  normalized `eda.text_instruction_sample.v1` records from the validated 2026
  watchlist covering VeoPlace, HMPlace, dynamic-tree-search RL, RSPlace, C3PO,
  AuDoPEDA, AiEDA, and DreamerV3+FR PCB routing. The checker requires source
  hashes, one record per watchlist entry, metadata-only/no-execution policy
  flags, and explicit replay/signoff evidence in every record.
- `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=codex-openroad-corpus-manifest
  ai-eda-training-corpus-manifest`: PASS. The manifest covers 16 normalized
  record-producing datasets, including the OpenROAD EDA Corpus JSONL splits. It
  records 242 sampled/schema records and 2,342 logical training/RAG samples,
  including 2,116 OpenROAD instruction samples split as train=1,691,
  validation=206, and test=219. The checker verifies record/report hashes,
  JSONL split hashes and line counts, exact dataset inventory,
  schema-count totals, no payload/model-weight policy flags, and
  deterministic-replay-before-claim boundaries.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-openroad-ml-snapshot ai-eda-openroad-ml-snapshot`: PASS.
  The snapshot checker records `NO_OPENLANE_RUN_FOUND` in this checkout and
  validates the dry-run label report, advisory-only claim boundary, missing-run
  blocker list, and holdout policy before any PD predictor training claim.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-openroad-corpus-manifest ai-eda-training-corpus-manifest`: PASS.
  The manifest now covers 16 normalized datasets spanning schema fixtures,
  OpenROAD EDA Corpus train/validation/test JSONL, TILOS/ChipBench-D/Macro
  Placement Challenge macro placement, CircuitNet3, AiEDA/iDATA, EDALearn,
  MLCAD FPGA transfer metadata, research-code/current-research RAG records,
  OpenABC-D logic synthesis, E1 softmacro cases, E1 OpenLane conversion, and
  fixture OpenLane flow labels.
- `make PYTHON=/usr/bin/python3
  AI_EDA_RUN_ID=codex-openroad-corpus-payload2 ai-eda-cuda-run-plan-dry-run`:
  PASS with 41 asset groups, 206 included payload files, 174 run-plan commands,
  and 170 selected dry-run commands after adding OpenROAD EDA Corpus JSONL
  split outputs and run-plan safety metadata. The
  payload checker validates the generated
  report and tarball, confirms the embedded `cuda_training_run_plan.json`
  matches the reported run plan, confirms the embedded
  `cuda_handoff_README.md` matches the generated runbook and contains the
  dry-run/readiness/training/inference/replay command anchors, requires
  `capture_current_research_watchlist.py`,
  `check_current_research_watchlist.py`,
  `convert_current_research_watchlist_to_internal_records.py`,
  `check_current_research_watchlist_records.py`,
  `build_training_corpus_manifest.py`,
  `check_training_corpus_manifest.py`,
  `execute_cuda_run_plan.py`,
  `check_cuda_run_plan_execution.py`,
  `check_cuda_run_plan_safety_matrix.py`,
  `capture_openroad_ml_snapshot.py`, `check_openroad_ml_snapshot.py`, and the
  `current_research_watchlist/<run-id>/targets_report.json` plus
  `cuda_run_plan_execution/<run-id>/cuda_run_plan_execution.json`,
  `cuda_run_plan_safety_matrix/<run-id>/cuda_run_plan_safety_matrix.json`,
  `openroad_eda_corpus/<run-id>/{train,val,test}.jsonl`,
  `pd_predictor_dataset/<run-id>/{snapshot_manifest,label_report}.json` and
  `training_corpus_manifest/<run-id>/training_corpus_manifest.json` outputs,
  checks dependency order so all normalized record producers run before the
  corpus manifest, the corpus manifest runs before supervised training, train
  steps precede inference, and replay plans precede replay preflight, checks
  execution-manifest safety so dry-run remains command-free, `--execute`
  requires explicit stage selection, run-plan orchestration commands are
  skipped, and risky stages require explicit allow flags, checks
  critical fetch/verify commands for
  CircuitNet3, ChiPBench-D, OpenABC-D, AiEDA/iDATA, EDALearn, Macro Placement
  Challenge 2026, MLCAD 2023 FPGA Macro Placement, ChipDiffusion, ChiPFormer,
  CORE, MapTune, ABC-RL, abcRL, RL4LS, MCP4EDA, ORFS-Agent, OpenROAD Agent,
  OpenROAD MCP, Open3DBench, DREAMPlace, ChipLingo, VeoPlace, AuDoPEDA, the
  2026 3D-IC PPA surrogate paper, RTL-MUL, LLM4DV, AssertLLM, and Fault,
  checks referenced command scripts are present in the tarball, and rejects
  ignored payload directories, build outputs, dataset
  archives, and model-weight files.
- `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=codex-current-safety
  ai-eda-cuda-run-plan-safety-matrix`: PASS. The matrix uses the generated
  run plan to validate 14 independent stage selections and 20 safety checks,
  including execute-mode blocks for asset downloads, training, inference,
  replay, and AlphaChip stages when their explicit allow flags are absent,
  without executing commands or downloading assets.
- `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=codex-current-readiness
  ai-eda-cuda-readiness-audit`: PASS with `PASS_WITH_BLOCKERS_RECORDED`. The
  audit now depends on `ai-eda-cuda-run-plan-dry-run` and
  `ai-eda-cuda-run-plan-safety-matrix`, records both the expanded
  `cuda_run_plan_execution/<run-id>/cuda_run_plan_execution.json` manifest and
  `cuda_run_plan_safety_matrix/<run-id>/cuda_run_plan_safety_matrix.json` as
  input artifacts, and exposes `run_plan_dry_run_validated=true` plus
  `run_plan_safety_matrix_validated=true` before assessing CUDA-host readiness.
  The checked Mac run still records five hard blockers: `cuda.available=false`
  / `large_training_ready=false`, AlphaChip checkpoint access remains
  `PASS_BLOCKED_CURRENT`, setup-check bootstrap evidence is missing for this
  run ID, training-handoff bootstrap evidence is missing for this run ID, and
  E1 OpenLane/OpenROAD replay remains
  `BLOCKED_REPLAY_EXECUTION`.
- `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=codex-readiness-args
  AI_EDA_SETUP_RUN_ID=codex-cuda-ready-20260521
  AI_EDA_TRAINING_HANDOFF_RUN_ID=codex-cuda-ready-20260521-training-handoff
  ai-eda-cuda-readiness-audit`: PASS with `PASS_WITH_BLOCKERS_RECORDED`. The
  audit proves payload handoff is ready, the current-research watchlist is
  captured, and setup-check evidence is complete, while recording four hard
  blockers for full objective completion on this host: `cuda.available=false`
  / `large_training_ready=false`, AlphaChip checkpoint access remains
  `PASS_BLOCKED_CURRENT`, the training-handoff bootstrap evidence is not yet
  complete, and E1 OpenLane/OpenROAD replay remains `BLOCKED_REPLAY_EXECUTION`.
- `make ai-eda-verification-targets`: PASS. The local verification capture
  lane emits and validates dry-run target reports for logic synthesis, RTL
  rewrite equivalence, and netlist/LEC readiness. The checker enforces
  capture-only mode, no execution, no generated rewrites, no equivalence/PPA
  claims, non-empty candidate task gates, artifact hashes for present inputs,
  and explicit blocked-by lists before any formal/synthesis/signoff automation
  can consume these targets.
- `make ai-eda-physical-design-targets`: PASS. The local physical-design
  capture lane emits and validates dry-run target reports for timing closure,
  routing/congestion, placement/legalization, and physical verification. The
  checker enforces capture-only mode, all present policy flags false, no
  model/tool execution claims, no generated placement/route/ECO/DRC/LVS
  artifacts, non-empty candidate gates, artifact hashes for present inputs,
  optional-tool status accounting, and explicit blockers before any
  OpenROAD/OpenLane or signoff automation can consume these targets.
- `make ai-eda-optimization-targets`: PASS. The broad optimization capture
  lane emits and validates dry-run target reports for circuit foundation
  models, current public research watchlist, EDA tool-agent interoperability,
  DFM/yield/lithography, low-power intent, post-silicon validation, and
  hardware security. Current validation covers 7 reports and 61 candidate
  tasks while enforcing non-empty acceptance gates, blocked-by lists, optional
  backend accounting, input hashes where present, and no model/tool/source/
  release claims. The current-research watchlist checker additionally enforces
  2026 metadata scope, unique inventory-backed source IDs, HTTPS source URLs,
  reviewed public-code status enums, explicit hash plus replay/signoff evidence
  text, report source-ID parity, stale-hash detection, and false policy flags.
- `make PYTHON=/opt/homebrew/opt/python@3.13/bin/python3.13
  AI_EDA_RUN_ID=codex-current-research-20260521
  ai-eda-source-inventory-check`: PASS with 587 source entries and 50 backlog
  items after refreshing the active RAG index and all-domain target captures.
  The generated-snapshot hash checks are scoped to the active `AI_EDA_RUN_ID`
  so historical build directories do not masquerade as current evidence.
- `make ai-eda-all-target-captures`: PASS. The full domain target lane now
  regenerates 36 dry-run target reports before `check_ai_eda_source_inventory`
  runs, including report-to-report hash dependencies such as external-model
  corpus intake before benchmark-evaluation hygiene. `make docs-check` now
  depends on this target, so source inventory validation no longer relies on
  stale `build/ai_eda/**/targets_report.json` files left by earlier runs.
- `make ai-eda-internal-schemas-check`: PASS for the current internal AI-EDA
  record schemas and example fixtures.
- `make ai-eda-bootstrap-metadata`: PASS and emits
  `build/ai_eda/bootstrap/validation/bootstrap_report.json`.
- `make PYTHON=/opt/homebrew/opt/python@3.13/bin/python3.13
  AI_EDA_RUN_ID=codex-latest-setup-20260521 ai-eda-bootstrap-setup-check`:
  PASS with `complete=true`, 55 recorded steps, no failed steps, and
  `overall_returncode=0`. This is the first completed expanded setup wrapper
  evidence for the current reviewed-asset set; it covers metadata, backend
  preflight, verification/physical/optimization target captures, source
  inventory, external assets/intake, AlphaChip blocker, fixtures, OpenROAD EDA
  Corpus, TILOS MacroPlacement, CircuitNet3, ChiPBench-D, AiEDA/iDATA,
  EDALearn, Macro Placement Challenge 2026, MLCAD FPGA macro, research-code
  assets, CircuitNet3 surrogate, OpenABC-D, E1 softmacro cases, external
  fixtures, E1 OpenLane conversion, OpenLane flow-label parsing, and supervised
  macro-placement dataset generation.
- `make PYTHON=/opt/miniconda3/bin/python3
  AI_EDA_RUN_ID=codex-torch-full-20260521
  ai-eda-macro-placement-full-replay-plan`: PASS on the M4 host with PyTorch
  2.8.0 using MPS. The run trains the Torch macro-placement regressor for 25
  epochs over the 2,340/200/240 train/validation/test split, emits 18
  quarantined Torch inference candidates with 6 blocked placement cases, ranks
  169 deterministic plus supervised plus Torch candidates across 22 placement
  cases, and records every replay bundle fail-closed with ready=0 and
  blocked=169 pending deterministic OpenLane/OpenROAD replay.

### P0: Create a reproducible external asset registry

Add a repo-owned external manifest convention:

- `packages/chip/external/README.md`
- `packages/chip/external/SOURCES.lock.yaml`
- `packages/chip/external/datasets/<name>/manifest.yaml`
- `packages/chip/external/models/<name>/manifest.yaml`
- `packages/chip/external/repos/<name>/manifest.yaml`
- `packages/chip/external/cache/` ignored by git

Each manifest must record:

- source URL;
- resolved commit, tag, release, dataset revision, or exact file URL;
- license and redistribution status;
- SHA256 for every downloaded archive/file;
- expected size;
- download command;
- extraction command;
- schema version;
- local conversion command;
- train/validation/test split policy;
- contamination/overlap notes;
- responsible E1 lane;
- allowed use: metadata-only, training-only, advisory-inference-only, or
  deterministic-replay-candidate.

P0 assets to pin first:

- `google-research/circuit_training`
- `TILOS-AI-Institute/MacroPlacement`
- `MIRA-Lab/ChiPBench-D`
- `circuitnet/CircuitNet`
- `SKLP-EDA-LAB/CircuitNet3.0`
- `panjingyu/EDALearn`
- `NYU-MLDA/OpenABC`
- `OpenROAD-flow-scripts`
- `OpenROAD-Assistant/EDA-Corpus`
- `AiEDA/iDATA`
- `vint-1/chipdiffusion`
- `partcleda/macro-place-challenge-2026`
- `IntelLabs/FloorSet`
- `laiyao1/ChiPFormer`
- `yeshenpy/CORE`
- `Yu-Maryland/MapTune`
- `NYU-MLDA/ABC-RL`
- `krzhu/abcRL`
- `Gabriel-in-Toronto/RL4LS`
- `OpenROAD`, `OpenLane`, `OpenRAM`, `open_pdks`, `asap7`, SKY130, GF180,
  and IHP Open PDK references already used by PD configs.

Acceptance:

- `python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation`
  records source availability.
- `scripts/ai_eda/check_external_asset_manifests.py` rejects missing source
  URLs, license status, revision records, allowed-use policy, replay policy, and
  fetch/verify commands.
- `scripts/ai_eda/check_external_intake_manifests.py` rejects committed
  per-asset metadata that drifts from the lockfile or claims release use before
  deterministic replay.
- `make docs-check` includes the lockfile and intake manifest checkers.

### P0: Implement download-only, no-import asset fetchers

Add fetch scripts that download into ignored cache directories and emit JSON
reports without modifying source:

- `scripts/ai_eda/fetch_macroplacement.py`
- `scripts/ai_eda/fetch_chipbench_d.py`
- `scripts/ai_eda/fetch_circuitnet.py`
- `scripts/ai_eda/fetch_openabc_d.py`
- `scripts/ai_eda/fetch_edalearn.py`
- `scripts/ai_eda/fetch_openroad_eda_corpus.py`
- `scripts/ai_eda/fetch_aieda_idata.py`
- `scripts/ai_eda/fetch_placement_model_repos.py`

Each fetcher should support:

- `--manifest`;
- `--dest`;
- `--dry-run`;
- `--verify-only`;
- `--no-network`;
- `--emit build/ai_eda/external_assets/<run-id>/<asset>.json`.

Acceptance:

- Dry-run works on a fresh checkout with no network.
- Verify-only validates an already-populated cache.
- Fetcher reports are advisory until a human accepts license/provenance.

### P0: Normalize all corpora into common internal schemas

Define common schemas:

- `eda.design_bundle.v1`: RTL/netlist/LEF/DEF/LIB/SDC/PDK/tech manifest.
- `eda.placement_case.v1`: die/core, rows, macros, stdcell clusters, nets,
  pins, blockages, halos, power domains, initial placement, target placement.
- `eda.graph_sample.v1`: heterogeneous graph for instances, pins, nets,
  timing paths, physical bins, congestion, power, IR, DRC.
- `eda.flow_run.v1`: commands, tool versions, inputs, outputs, logs, metrics.
- `eda.e1_candidate.v1`: proposed change, source model, input hashes, output
  hashes, replay command, expected gates, reviewer decision.

Implemented schema foundation:

- `docs/spec-db/ai-eda/internal-dataset-schemas.yaml` defines the five internal
  record contracts above.
- `docs/spec-db/ai-eda/examples/*.yaml` contains one tiny example for each
  schema.
- `scripts/ai_eda/check_internal_dataset_schemas.py` validates the schema
  catalog and example records.
- `scripts/ai_eda/materialize_internal_dataset_fixtures.py` converts the tiny
  YAML examples into JSON fixtures under
  `build/ai_eda/internal_dataset_fixtures/<run-id>/records/`.
- `scripts/ai_eda/convert_openroad_eda_corpus.py` converts the fetched,
  reviewed OpenROAD EDA Corpus CSV files into normalized train/val/test JSONL
  files for OpenROAD QA and prompt-script training, with source file SHA256,
  row index, pinned source revision, and sample schema-validation records.
- `scripts/ai_eda/convert_tilos_macroplacement.py` converts the fetched,
  reviewed TILOS MacroPlacement corpus into normalized `eda.design_bundle.v1`,
  `eda.placement_case.v1`, and blocked `eda.flow_run.v1` records. The current
  validation converts 16 TILOS cases across NanGate45, ASAP7, and SKY130HD,
  including Ariane, BlackParrot, MemPool, and NVDLA families. Together these
  expose 2,339 placed-macro labels, with 224 components missing LEF-derived
  macro dimensions and therefore using downstream fallback sizing in proxy
  baselines. Replay remains blocked until local MacroPlacement/OpenROAD tool
  review.
- `scripts/ai_eda/materialize_e1_softmacro_cases.py` generates E1-owned
  abstract NPU softmacro placement cases for 4x4 and 8x8 tile grids. These are
  training/evaluation cases only until converted to real macro LEF/DEF and
  replayed through OpenLane/OpenROAD.
- `scripts/ai_eda/train_fixture_placement_smoke.py` runs a dependency-free CPU
  training/inference smoke over the placement fixture and emits
  `training_run.json`, `metrics.json`, `fixture_placement_model.json`, and
  `candidate_manifest.json`.
- `scripts/ai_eda/build_macro_placement_supervised_dataset.py` converts
  normalized placement cases with target labels into CUDA-host-ready supervised
  JSONL splits. Current validation emits 2,419 labeled macro samples across 18
  labeled cases: 1,979 train samples from 14 cases, 200 validation samples from
  2 cases, and 240 test samples from 2 cases. It records 224 samples with
  fallback macro sizing because the public LEF metadata did not provide a
  parsed macro size.
- `scripts/ai_eda/check_macro_placement_supervised_dataset.py` validates those
  supervised JSONL splits and report counts, including sample schema,
  claim-boundary, positive macro/floorplan dimensions, split counts, case-level
  train/validation/test leakage, skipped-case accounting, and fallback-size
  counts.
- `scripts/ai_eda/train_macro_placement_supervised_model.py` runs the first
  dependency-free supervised imitation smoke over those JSONL splits. It learns
  macro-key mean normalized placement priors from the train split, evaluates
  train/validation/test splits, and emits quarantined supervised-imitation E1
  generated-softmacro candidates. Current validation uses 1,979 train, 200
  validation, and 240 test samples; the simple mean-prior model records
  validation `mean_l1_over_core=0.2395623` and test
  `mean_l1_over_core=0.26163664`, emits 15 pre-replay-geometry-clean
  quarantined candidate manifests across TILOS, fixture, and generated E1
  softmacro cases, and blocks 5 cases: the fixed-only real E1 OpenLane case
  plus 4 supervised predictions with out-of-bounds or overlap geometry. This
  proves train/eval/infer artifacts only; it has no graph, timing, routing,
  congestion, or PPA claim.
- `scripts/ai_eda/check_macro_placement_supervised_model.py` validates the
  dependency-free supervised training report, model, metrics, dataset-link
  counts, candidate inventory, blocked-case accounting, and pre-replay geometry
  fields. It rejects unreported stale candidate files and any emitted
  supervised candidate with unknown targets, out-of-bounds placements, or macro
  overlaps.
  `make ai-eda-macro-placement-supervised-replay-plan` applies the same
  fail-closed replay planner and tool-action validation to those supervised
  candidates. Current supervised replay result: 15 candidates, 0 ready for
  replay, and 15 blocked, with blockers split across 12 external benchmark
  review requirements, 2 abstract E1 softmacro real-LEF/DEF requirements, and
  1 fixture-only smoke case.
- `scripts/ai_eda/train_macro_placement_torch_regressor.py` is the
  CUDA-capable training entrypoint over the same supervised JSONL contract. It
  trains a small PyTorch regressor for normalized macro `(x, y)` and
  orientation, writing `torch_regressor.pt`, `metrics.json`, and
  `torch_training_run.json` under
  `build/ai_eda/macro_placement_torch_regressor/<run-id>/`. It is explicitly a
  training artifact only: candidate generation still flows through the
  quarantined candidate-manifest and replay-plan contracts.
- `scripts/ai_eda/check_macro_placement_torch_regressor.py` validates those
  PyTorch-regressor artifacts without importing PyTorch: report schema,
  claim-boundary, dataset split counts, metric ranges, loss-history monotonic
  epochs, device recording (`cpu`, `cuda`, or `mps`), and non-empty serialized
  model file. This lets CUDA-host runs be verified from copied artifacts even
  on machines that do not have a matching PyTorch runtime installed.
- `scripts/ai_eda/infer_macro_placement_torch_regressor.py` is the
  CUDA-host inference lane for that trained PyTorch model. It loads
  `torch_regressor.pt`, predicts normalized macro placement and orientation for
  internal placement cases, legalizes predictions onto deterministic grid
  slots, rejects pre-replay geometry-invalid outputs, and emits quarantined
  `eda.e1_candidate.v1` manifests under
  `build/ai_eda/macro_placement_torch_inference/<run-id>/candidates/`.
- `scripts/ai_eda/check_macro_placement_torch_inference.py` validates the
  CUDA-host inference report without importing PyTorch: model-file presence,
  checkpoint claim-boundary, device recording (`cpu`, `cuda`, or `mps`),
  candidate and blocked-case counts, candidate inventory paths, zero pre-replay
  geometry errors, and continued `replayed_blocked` quarantine status.
- `scripts/ai_eda/train_macro_placement_policy.py` runs the first deterministic
  macro-placement baseline over normalized placement cases. It emits
  quarantined candidate manifests for cases with movable macros and records
  fixed-only cases as blocked instead of fabricating a placement candidate.
- `scripts/ai_eda/evaluate_macro_placement_candidates.py` validates and ranks
  quarantined macro-placement candidates by deterministic proxy score, grouped
  by placement case. It records the best candidate to replay first while
  preserving the OpenLane/OpenROAD replay and human-review barrier.
- `scripts/ai_eda/plan_macro_placement_replay.py` turns ranked quarantined
  macro-placement candidates into per-candidate replay bundles under
  `build/ai_eda/macro_placement_replay/<run-id>/bundles/`, including
  OpenLane-style `macro_placement.cfg` files, JSON override manifests, and
  checker-compatible `eda.tool_action.v1` dry-run manifests. It does not
  execute OpenLane/OpenROAD; it records exact blockers such as abstract E1
  softmacro cases, fixture-only cases, external benchmark replay review,
  out-of-bounds placements, and macro overlaps. It accepts multiple candidate
  directories so the deterministic and supervised candidate lanes can be
  replay-planned together without changing the candidate manifest contract.
- `scripts/ai_eda/check_macro_placement_replay_plan.py` validates replay-plan
  reports, candidate and placement-case hashes, override counts,
  `macro_placement.cfg` line counts, tool-action links, and fail-closed
  ready/blocked counts without executing OpenLane/OpenROAD.
- `scripts/ai_eda/replay_macro_placement_on_e1.py` is the first guarded bridge
  from replay-plan bundles toward real E1 replay. By default it is a dry-run
  preflight: it selects one replay candidate, verifies candidate/case/bundle
  artifacts and OpenLane/OpenROAD availability, records blockers, and writes
  `build/ai_eda/macro_placement_replay_preflight/<run-id>/replay_preflight_report.json`.
  Actual OpenLane execution requires `--execute`, a replay plan marked
  `READY_FOR_DETERMINISTIC_REPLAY`, present OpenLane/OpenROAD binaries, and an
  existing OpenLane config. `scripts/ai_eda/check_macro_placement_replay_preflight.py`
  validates the report and preserves the no-PPA/no-signoff/no-release claim
  boundary.
- `docs/spec-db/ai-eda/external-fixtures/` contains tiny external-shape fixtures
  for MacroPlacement/Bookshelf, ChiPBench-D, and CircuitNet.
- `scripts/ai_eda/convert_external_fixture_corpora.py` converts those fixtures
  into internal `eda.*.v1` records and revalidates them through
  `check_internal_dataset_schemas.py --records-dir`.
- `scripts/ai_eda/convert_circuitnet3_to_internal_records.py` converts a
  bounded sample directly from
  `external/datasets/circuitnet3/payload/circuitNetv3.zip` without extracting
  the full archive. Current local validation converts 16 real CircuitNet 3.0
  final cases into 48 internal records: `eda.design_bundle.v1`,
  `eda.graph_sample.v1`, and `eda.flow_run.v1` per case. The converter records
  2,004 available final cases, 57,975 zip entries, per-instance timing-arc
  features, power summaries, and explicit blockers that labels are public
  dataset labels for training/pretraining only and cannot stand in for local E1
  OpenLane/OpenROAD signoff.
- `scripts/ai_eda/train_circuitnet3_timing_power_baseline.py` and
  `scripts/ai_eda/check_circuitnet3_surrogate.py` provide the first train/eval
  path over real CircuitNet3-derived `eda.flow_run.v1` records. The baseline is
  intentionally dependency-free and mean-based so it can run on the Mac and on a
  fresh CUDA host before graph neural predictors are installed. It validates
  JSONL split counts, finite target predictions, and per-split MAE fields; the
  next real step is scaling conversion beyond the 16-case local smoke and using
  source-level split metadata before training neural timing/power predictors.
- `scripts/ai_eda/convert_chipbench_d_to_internal_records.py` converts bounded
  real ChiPBench-D payload cases into internal placement/design/flow records
  for macro-placement pretraining. `scripts/ai_eda/check_chipbench_d_conversion.py`
  validates that the conversion report exactly matches the generated record
  directory and that placement cases retain DEF/LEF-derived macro targets under
  the no-E1-signoff claim boundary.
- `scripts/ai_eda/build_macro_placement_supervised_dataset.py` and
  `scripts/ai_eda/train_macro_placement_supervised_model.py` include bounded
  ChiPBench-D placement records in their default record directories, moving the
  restored public macro-placement labels into the supervised training and
  candidate-generation spine.
- `scripts/ai_eda/convert_openabc_d_to_internal_records.py` converts bounded
  OpenABC-D BENCH logic networks into graph and flow records for
  synthesis-policy pretraining, with explicit blockers for leakage review,
  sequence-label extraction, E1 replay, and equivalence checking.
  `scripts/ai_eda/check_openabc_d_conversion.py` validates the converted graph
  inventory and public-benchmark quarantine before logic-synthesis policy work
  consumes it.
- `scripts/ai_eda/convert_e1_openlane_to_internal_records.py` converts the
  checked-in E1 SKY130 OpenLane config into real local `eda.design_bundle.v1`,
  `eda.placement_case.v1`, and blocked `eda.flow_run.v1` records. The current
  conversion captures 16 existing RTL files and one fixed SRAM macro placement,
  but records `BLOCKED_NO_OPENLANE_RUN_ARTIFACTS` until deterministic OpenLane
  reports are available.
- `docs/spec-db/ai-eda/openlane-metrics-fixtures/e1_final_metrics.clean.json`
  captures the OpenLane 2 `final/metrics.json` key shape expected by existing
  PD closure gates.
- `scripts/ai_eda/parse_openlane_metrics_to_flow_run.py` normalizes OpenLane
  timing, area, wirelength, DRC, antenna, utilization, and power metrics into an
  `eda.flow_run.v1` record. It now auto-selects the latest local
  `pd/openlane/runs/RUN_*/final/metrics.json` when deterministic run artifacts
  exist and otherwise falls back to the checked-in fixture. With the fixture
  metrics it reports `fixture_metrics_parser_smoke_no_ppa_claim`; with a real
  run it must still be reviewed for deterministic provenance and train/test
  split assignment. `scripts/ai_eda/check_openlane_flow_labels.py` validates
  the source metrics path, selection policy, deterministic-run flag, normalized
  required-label inventory, and no-signoff claim boundary.
- `scripts/ai_eda/train_pd_surrogate_smoke.py` consumes normalized
  `eda.flow_run.v1` labels and emits a dependency-free constant-mean surrogate,
  eval report, and training-run manifest. This proves the PD surrogate artifact
  path but makes no generalization, signoff, or PPA claim.
- `scripts/ai_eda/check_candidate_manifests.py` validates generated
  `eda.e1_candidate.v1` manifests and refuses accepted candidates unless every
  required gate is completed.
- `external/circuit_training/pin-manifest.json` and
  `scripts/ai_eda/check_alphachip_checkpoint_blocker.py` make the AlphaChip
  pretrained checkpoint blocker explicit and auditable. The default gate
  checks monthly audit freshness, source-lock status, and doc/pin consistency
  without downloading closed artifacts; the network gate re-probes the canonical
  GCS URLs and fails if they no longer match the documented 403 state.
- `docs/spec-db/ai-eda/internal-dataset-schemas.yaml` now also defines
  `eda.tool_action.v1` for typed EDA tool actions before any write-capable
  agent. The schema requires command argv/cwd, read scope, write scope, input
  artifacts, generated artifacts, approval, execution log pointers, and status.
- `scripts/ai_eda/check_tool_action_manifests.py` enforces the initial command
  allowlist, quarantined write paths, source-change/release-claim boundaries,
  dry-run-only semantics for proposed actions, and approval requirements for
  any future execute mode.
- `make ai-eda-internal-schemas-check` and `make ai-eda-internal-fixtures`
  provide local schema/materialization gates. `make ai-eda-fixture-placement-train`
  proves the train -> infer -> candidate-manifest plumbing locally.
  `make ai-eda-macro-placement-supervised-dataset` generates the current
  supervised macro-placement JSONL splits and validates sample counts, case
  splits, no case leakage across train/validation/test, and fallback-size
  accounting.
  `make ai-eda-macro-placement-supervised-train` trains the dependency-free
  supervised mean-prior model, writes train/validation/test metrics, and emits
  only pre-replay-geometry-clean quarantined candidates. The target also runs
  the supervised-model validator before candidate-manifest validation.
  `make ai-eda-macro-placement-torch-train` runs the PyTorch regressor when
  PyTorch is installed, using CUDA automatically on a CUDA host, MPS on a
  supported Apple Silicon host, and CPU otherwise. The target validates the
  emitted training report, metrics, model file, and dataset split counts with
  the dependency-free torch-regressor checker.
  `make ai-eda-macro-placement-torch-infer` runs the trained PyTorch model over
  normalized placement cases, validates the inference report, and validates the
  emitted quarantined candidate manifests. Current local M4 validation with
  `PYTHON=/opt/miniconda3/bin/python3` and
  `AI_EDA_RUN_ID=codex-torch-full-20260521` runs on MPS with PyTorch 2.8.0,
  trains for 25 epochs over 2,340 train samples, validates on 200 samples,
  tests on 240 samples, and emits 18 quarantined inference candidates with 6
  blocked placement cases. The training loss drops from 0.30094084 at epoch 1
  to 0.22631302 at epoch 25; final metrics record train/validation/test
  normalized mean-L1 values of 0.24657689, 0.24189173, and 0.26462516, with
  orientation accuracy of 0.35085469, 0.67500001, and 0.45416668.
  `make ai-eda-macro-placement-supervised-replay-plan` then creates replay
  bundles and dry-run tool-action manifests for those supervised candidates,
  preserving the same OpenLane/OpenROAD blocker accounting used by the
  deterministic baselines.
  `make ai-eda-macro-placement-baseline` runs the first normalized
  macro-placement baseline over the softmacro fixture, current E1 OpenLane
  conversion, the converted TILOS cases, and generated E1 4x4/8x8 softmacro
  cases. Current result with `AI_EDA_RUN_ID=codex-proxy-baselines4`: twenty
  placement cases inspected, 133 quarantined candidates emitted across seven
  policies (`center_legal_baseline`, `target_aware_grid`,
  `target_repair_search`, `circuit_training_proxy`,
  `simulated_annealing_proxy`, `hier_rtlmp_proxy`, and
  `chipdiffusion_proxy`), and one E1 OpenLane case correctly blocked because
  the current SRAM macro is fixed and there are no movable objects. The
  CT/SA/Hier-RTLMP/ChipDiffusion policies are deterministic local proxy
  adapters that exercise the candidate, ranking, and replay-plan contracts
  until the real external tools are fetched and wrapped. Large public
  benchmark cases skip expensive exact local pairwise-overlap scoring and
  remain replay-blocked, so OpenLane/OpenROAD remains the authority for any
  geometry, congestion, timing, or PPA claim. The target-aware and
  target-repair policies clamp macro-specific assignments and fall back to
  legal grid placements when a target permutation would create out-of-bounds
  or overlap geometry. This is still a proxy/schema result only, with no
  OpenROAD replay or E1 PPA claim. The target now also runs
  `scripts/ai_eda/check_macro_placement_baseline.py`, which validates the
  seven required policies, per-candidate score shape, replay-blocked decision
  status, required downstream gates, and the no-release claim boundary.
  `make ai-eda-macro-placement-candidate-eval` ranks those 133 quarantined
  candidates by placement case and writes
  `build/ai_eda/macro_placement_candidate_eval/codex-proxy-baselines4/macro_placement_candidate_eval_report.json`.
  `make ai-eda-macro-placement-combined-candidate-eval` ranks both the
  deterministic baseline candidates and the supervised mean-prior candidates
  together for local non-PyTorch validation. Current combined validation ranks
  75 candidates across 22 placement cases with no candidate-schema errors. The
  CUDA payload extends the same combined ranking and replay-plan commands with
  the PyTorch-regressor inference candidate directory after
  `infer_macro_placement_torch_regressor.py` runs on the CUDA host.
  `make ai-eda-macro-placement-replay-plan` records all fifty-seven candidates
  as blocked for deterministic replay until an OpenLane/OpenROAD handoff exists
  and validates both the replay-plan bundles and the generated replay
  tool-action manifests.
  `make ai-eda-macro-placement-combined-replay-plan` applies the same
  fail-closed replay-plan and tool-action validation to the combined
  deterministic plus supervised candidate set. Current combined replay planning
  covers all 75 ranked candidates, with 0 ready for execution and 75 blocked
  until external benchmark review, real E1 softmacro LEF/DEF/OpenLane
  integration, and fixture-only barriers are resolved.
  `make ai-eda-macro-placement-full-candidate-eval` and
  `make ai-eda-macro-placement-full-replay-plan` add the Torch-inference
  candidate directory to that queue when PyTorch is available. Current MPS
  validation with `AI_EDA_RUN_ID=codex-torch-full-20260521` ranks 169
  candidates across 22 placement cases and replay-plans all 169 candidates
  fail-closed, with 0 ready for execution. The replay-plan claim boundary is
  `macro_placement_replay_plan_only_no_openroad_execution_or_release_claim`.
  Current blocker counts in
  `build/ai_eda/macro_placement_full_replay/codex-torch-full-20260521/replay_plan.json`:
  136 external benchmark candidates require local MacroPlacement/OpenROAD tool
  review, 18 abstract E1 softmacro candidates need real LEF/DEF/OpenLane macro
  integration, 9 fixture candidates are smoke-only, and 6 candidates lack
  deterministic OpenLane/OpenROAD replay commands. Geometry blockers are
  currently zero after candidate legalization.
  `make ai-eda-e1-softmacro-cases` proves generated E1 4x4/8x8 case
  materialization and schema validation locally.
  `make ai-eda-tilos-macroplacement-convert` proves the first real fetched
  macro-placement corpus -> internal-schema conversion locally.
  `make ai-eda-openroad-eda-corpus-convert` proves the reviewed fetched
  OpenROAD EDA Corpus -> normalized instruction JSONL conversion locally.
  `make ai-eda-external-fixture-convert` proves the external-format fixture ->
  internal-schema conversion plumbing locally.
  `make ai-eda-e1-openlane-convert` proves checked-in E1 OpenLane conversion
  and schema validation locally.
  `make ai-eda-logic-synthesis-baseline` generates the first E1 Yosys/ABC
  recipe corpus and local baseline report. On this Mac, DMA passes four Yosys
  recipes, NPU passes two generic Yosys recipes, both NPU ABC mapping recipes
  time out under the interactive 20 second limit, and OpenABC-D remains
  quarantined as public benchmark pretraining data until recipe labels, leakage
  review, E1 replay, and equivalence checks exist. Current validation records 6
  passed recipes, 4 blocked recipes, and 0 failed recipes.
  `scripts/ai_eda/check_logic_synthesis_policy_baseline.py` validates the
  recipe corpus and baseline report: source-modification and equivalence
  policies, target RTL existence, recipe/blocker shape, Yosys artifact paths,
  positive cell/wire metrics for passing recipes, timeout evidence, blocked
  OpenABC-D accounting, and summary counts. The CUDA payload now carries the
  recipe generator, Yosys baseline runner, and this validator so synthesis
  policy experiments have the same reproducibility gate as placement lanes.
  `make ai-eda-openlane-flow-labels` proves OpenLane metrics parsing into
  `eda.flow_run.v1` locally using fixture metrics.
  `make ai-eda-pd-surrogate-smoke` proves normalized flow labels can feed
  model/eval artifacts locally.
  `make ai-eda-candidate-manifests-check` validates the fixture-generated
  candidate manifest.
  `make ai-eda-alphachip-checkpoint-blocker-check` keeps the AlphaChip
  checkpoint blocker doc, pin manifest, and external source lock aligned;
  `make ai-eda-alphachip-checkpoint-blocker-network-check` additionally probes
  the canonical GCS URLs.
  `make ai-eda-tool-actions-check` validates the initial dry-run
  `eda.tool_action.v1` fixture and command governance policy.
  `make ai-eda-cocotb-stimulus-dry-run` now covers five dry-run stimulus
  scopes: `e1_npu` descriptor queue, `e1_dma`, `e1_riscv_iommu`,
  `e1_linux_soc_contract` interrupt/reset edges, and `e1_npu` command-buffer
  behavior. The report contains 27 total coverage bins and 26 existing seed
  references, but still records no generated stimulus as evidence until
  deterministic cocotb regressions pass.
  `make ai-eda-local-rag-index` builds and validates the read-only local EDA
  RAG/log-triage source manifest. Current validation records 50 local sources
  and 38 citation smoke queries, with network access, embeddings, source edits,
  and uncited engineering actions disabled by policy.
  `make ai-eda-backend-preflight` validates optional backend readiness for
  ZigZag, Timeloop/Accelergy, RTL-MUL, LLM4DV, AssertLLM, and Fault. The
  preflight only inspects local Python modules, commands, and ignored payload
  paths, then records present or blocked status for each backend so CUDA-host
  setup can distinguish missing install work from validated training artifacts.
  `make ai-eda-macro-place-challenge-convert` converts the public Partcl/HRT
  Macro Placement Challenge 2026 baseline metadata into normalized internal
  records without exporting `.pt` tensor payloads into the CUDA tarball. The
  companion checker requires tensor file hashes, proxy-cost labels, PPA
  baseline accounting, no hidden-benchmark use, and deterministic replay
  blockers before any E1 claim.
  `make ai-eda-mlcad-fpga-macro-convert` converts the MLCAD 2023 FPGA macro
  placement public spec payload into normalized clock-bucket records for
  transfer-learning manifests. The checker requires non-empty FPGA site,
  library, cascade, and clock-bucket metadata while preserving the missing
  per-design Bookshelf/Vivado payload blocker and forbidding E1 signoff claims.
  `make ai-eda-verification-targets` captures logic-synthesis, RTL-rewrite
  equivalence, and netlist/LEC target reports in dry-run mode, then validates
  that the reports make no execution, generated-rewrite, equivalence, PPA,
  signoff, source-change, or release claims. The checker also requires
  non-empty candidate acceptance gates, blocked-by lists, and SHA256 evidence
  for present input artifacts before any downstream automation can consume the
  targets.
  `make ai-eda-physical-design-targets` captures timing-closure,
  routing/congestion, placement/legalization, and physical-verification target
  reports in dry-run mode, then validates that every present policy flag is
  false, no PPA/routability/DRC/LVS/signoff/release claim is allowed, candidate
  tasks have acceptance gates, optional tool status is recorded, and hashed
  input artifacts exist before downstream automation can consume the targets.
  `make ai-eda-optimization-targets` captures circuit-foundation-model,
  EDA-agent-interoperability, DFM/yield/lithography, low-power-intent,
  post-silicon-validation, and hardware-security target reports in dry-run
  mode, then validates no model/tool/source/release claims, candidate
  acceptance gates, blocked-by lists, optional backend status, and input
  artifact hashes for present files.
  `make ai-eda-all-target-captures` refreshes all 36 AI-EDA target-capture
  reports in dependency-safe order so source-inventory validation sees current
  hashes for every domain target, not stale build artifacts.
  `make docs-check` depends on the local RAG index, source, external-asset,
  intake-manifest, schema, candidate, tool-action, backend-preflight, dry-run
  stimulus, and the full all-domain target-capture gate.

Converters to add or complete:

- MacroPlacement LEF/DEF/Bookshelf to `eda.placement_case.v1`.
- ChiPBench-D to `eda.design_bundle.v1` and `eda.placement_case.v1`.
- CircuitNet to `eda.graph_sample.v1`.
- EDALearn bounded public RTL/config designs to `eda.design_bundle.v1`,
  `eda.flow_run.v1`, and `eda.graph_sample.v1` via
  `make ai-eda-edalearn-convert`.
- OpenABC-D to `eda.logic_synthesis_sample.v1`.
- E1 OpenLane runs to all relevant schemas.
- E1 `pd/openlane` configs and generated reports to `eda.flow_run.v1`.

Acceptance:

- Every converted sample has a source manifest, file hashes, schema version,
  and split ID.
- Converters can run on tiny fixtures committed under
  `packages/chip/docs/spec-db/ai-eda/examples/` and materialized into
  `build/ai_eda/internal_dataset_fixtures/<run-id>/`.
- No full external dataset is committed.

## Training stack TODOs

### P0 lane A: Macro-placement policy training

Goal: train a macro-placement candidate generator that can run on E1
soft-macro and eventual real macro placement cases.

Inputs:

- MacroPlacement Ariane133/Ariane136.
- MacroPlacement MemPool tile/group.
- MacroPlacement NVDLA and BlackParrot.
- ChiPBench-D pre-place and macro-placed cases.
- E1 softmacro 4x4, 5x5, 8x8, 16x16 cases.
- E1 future real macro cases from OpenRAM/SRAM/NPU/cache/IO/padframe
  integration.

Models/baselines:

- Circuit Training / AlphaChip from scratch.
- Circuit Training with any verified private checkpoint if legally obtained.
- Circuit Training coordinate descent and no-pretraining PPO.
- MacroPlacement simulated annealing.
- OpenROAD Hier-RTLMP.
- ChipDiffusion.
- ChiPFormer.
- CORE/evolutionary RL.
- Random/legalized and human/hand-authored baselines.

Implementation TODOs:

- Extend `scripts/ai_eda/train_macro_placement_policy.py` from deterministic
  legal-grid, target-aware-grid, and target-repair-search baselines into an
  orchestrator over CT, ChipDiffusion, ChiPFormer, CORE, and SA baselines.
- Replace the dependency-free supervised mean-prior smoke with CUDA-capable
  graph/layout models that consume
  `build/ai_eda/macro_placement_supervised_dataset/<run-id>/{train,val,test}.jsonl`
  and emit quarantined candidate manifests.
- Extend `scripts/ai_eda/evaluate_macro_placement_candidates.py` from proxy
  ranking into replay-aware ranking once deterministic OpenLane/OpenROAD replay
  reports exist.
- Extend `scripts/ai_eda/plan_macro_placement_replay.py` into an execute-capable
  replay harness only after real E1 macro LEF/DEF cases and isolated OpenLane
  run directories are available.
- Extend guarded `scripts/ai_eda/replay_macro_placement_on_e1.py` beyond
  PASS_BLOCKED preflight only after a candidate is
  `READY_FOR_DETERMINISTIC_REPLAY` and the isolated OpenLane/OpenROAD replay
  gates are present.
- Add `research/alpha_chip_macro_placement/09_runs/` for run reports and
  summaries, not model weights.

Training curriculum:

1. Parser/converter smoke on toy Bookshelf/LEF/DEF.
2. Ariane133/Ariane136 supervised imitation from known placements.
3. MacroPlacement MemPool tile/group and NVDLA imitation + RL.
4. ChiPBench-D offline imitation and downstream PPA comparison.
5. E1 softmacro curriculum, starting 4x4 and scaling to 16x16.
6. E1 real macro curriculum when SRAM/cache/NPU/IO macros are materialized.

Acceptance:

- A candidate is useful only if it passes candidate schema validation.
- A candidate affects source only after OpenLane/OpenROAD replay and reviewer
  acceptance.
- Post-route HPWL/congestion/timing/power/DRC/LVS/antenna metrics are compared
  against OpenROAD Hier-RTLMP and current E1 baseline.

### P0 lane B: Routability, timing, power, and IR-drop surrogate models

Goal: train predictors that make placement/search cheaper, not predictors that
replace signoff.

Inputs:

- CircuitNet 1.0/2.0/3.0.
- EDALearn.
- iDATA/AiEDA.
- ORFS generated runs.
- E1 OpenLane/OpenROAD repeated runs with varied seeds and knobs.
- ChiPBench-D downstream metrics.

Models:

- Graph neural networks over instance/net/path graphs.
- Layout-image CNN/ViT predictors for congestion/DRC risk.
- Heterogeneous graph transformers for timing/power.
- Lightweight gradient-boosted baselines for interpretability.
- Calibrated uncertainty models.

Implementation TODOs:

- Extend `scripts/ai_eda/capture_openroad_ml_snapshot.py` into a stable dataset
  exporter for E1 OpenLane/OpenROAD runs.
- Add label extractors for:
  - global route congestion;
  - detailed route DRC count;
  - WNS/TNS;
  - total negative slack path features;
  - post-route area;
  - switching/internal/leakage power;
  - antenna warnings;
  - OpenRCX/SPEF availability;
  - IR/PDN proxy metrics when present.
- Add `scripts/ai_eda/train_pd_surrogates.py`.
- Add `scripts/ai_eda/evaluate_pd_surrogates.py` with held-out E1 and
  non-overlap checks.

Acceptance:

- Predictions are advisory only.
- Every model report includes error bars and held-out design IDs.
- Any model-guided candidate must still run the deterministic E1 replay gates.

### P0 lane C: Logic synthesis and technology-mapping policy

Goal: improve area/timing/power before placement by learning or searching ABC,
Yosys, and mapping recipes.

Inputs:

- OpenABC-D.
- ABC-RL / abcRL / MapTune / RL4LS public code.
- E1 RTL modules and current Yosys synthesis outputs.
- E1 before/after synthesis netlists, Liberty, SDC, STA, and OpenLane context.

Models/baselines:

- Random ABC recipe search.
- Bayesian optimization / bandit over Yosys/ABC knobs.
- MapTune-style RL-guided library tuning.
- GNN policy over AIG/netlist states.
- Offline imitation from OpenABC-D recipes.

Implementation TODOs:

- Add `scripts/ai_eda/generate_e1_synthesis_recipe_corpus.py`.
- Add `scripts/ai_eda/train_logic_synthesis_policy.py`.
- Add `scripts/ai_eda/replay_logic_synthesis_candidate.sh`.
- Add equivalence checks before any netlist candidate reaches PD.

Acceptance:

- No synthesis candidate is accepted without RTL lint/elaboration, Yosys
  synthesis, formal or equivalence where applicable, and OpenLane replay if it
  changes PD-visible netlists.

### P1 lane D: EDA log triage and tool agents

Goal: make the team faster at understanding failures without giving an agent
uncontrolled write access to EDA tools.

Inputs:

- E1 logs from Yosys, OpenLane, OpenROAD, KLayout, Magic, Netgen, Verilator,
  cocotb, SymbiYosys, QEMU, Renode, Chipyard, AOSP/Cuttlefish, and benchmark
  runs.
- OpenROAD Assistant / EDA Corpus.
- Local docs and checkers.

Implementation TODOs:

- Complete `scripts/ai_eda/build_local_eda_rag_index.py` coverage for:
  `scripts/`, `pd/`, `verify/`, `docs/evidence/`, `research/`,
  OpenLane/OpenROAD logs, formal logs, and simulator logs.
- Define a `eda.tool_action.v1` schema with command allowlist, input hashes,
  output paths, stdout/stderr, timeout, environment, no-network flag, and
  reviewer disposition.
- Add a dry-run OpenROAD/Yosys agent that can propose commands but cannot run
  them until explicitly replayed through `make` or a typed wrapper.

Acceptance:

- Read-only answers cite file hashes and line locations.
- Write-capable actions remain disabled until allowlist and sandbox review.
- No generated Tcl/shell/constraint/source reaches release paths without
  deterministic replay.

### P1 lane E: Verification, formal, and stimulus optimization

Goal: use AI to find missing tests and assertions, not to weaken the proof
standard.

Inputs:

- Existing cocotb coverage bins and regression seeds.
- `verify/formal` properties.
- RTL gap work orders.
- Failure logs from formal/cocotb/verilator.
- Public SVA/assertion datasets only after license and contamination review.

Implementation TODOs:

- Replace the current `scripts/ai_eda/run_cocotb_stimulus_search.py` dry-run
  manifest validator with a real LLM4DV/CVDP-backed seed generator for the
  descriptor queue, DMA, IOMMU, interrupt, reset, and NPU command-buffer bins.
- Add a candidate assertion schema:
  module, signal scope, reset semantics, clock domain, antecedent,
  consequent, bounded depth, generated-by, reviewer, bind status.
- Add `scripts/ai_eda/replay_assertion_candidate.py` that runs only on
  quarantined copies until reviewed.
- Add failure clustering for formal traces and cocotb logs.

Acceptance:

- AI-generated stimulus counts only after cocotb regression passes.
- AI-generated assertions count only after human review and formal pass.
- No assertion is silently bound to RTL from a generated source.

### P1 lane F: Architecture/NPU/compiler optimization

Goal: optimize E1 NPU, memory hierarchy, and runtime scheduling with models,
but calibrate everything against executable E1 benchmarks.

Inputs:

- `compiler/runtime` NPU tests and stablehlo/lowering paths.
- `benchmarks/sim` NPU scale, context queue, thermal, memory/IOMMU/QoS.
- Timeloop/Accelergy, SCALE-Sim, ZigZag.
- MLPerf Tiny / MLPerf Mobile style networks where licensing allows.
- Local TFLite smoke model and future ExecuTorch/IREE workloads.

Implementation TODOs:

- [x] Add a model/workload manifest for AI benchmark lanes:
  `docs/spec-db/ai-eda/e1-ai-workload-manifest.yaml` records source, license,
  input shape, quantization, expected ops, fallback ops, runtime path, golden
  output tolerance, artifacts, and blockers for TFLite CPU/NNAPI smoke,
  NPU scale simulation, Timeloop mapping, StableHLO lowering, INT4, FP8, and
  sparse 2:4 fixtures. `scripts/ai_eda/check_ai_workload_manifest.py` validates
  the manifest, benchmark-plan references, local artifact hashes, required
  workload categories, and blocked zero-fallback lanes. `make docs-check`,
  bootstrap metadata, and the CUDA payload/run plan now carry this gate.
- Integrate Timeloop/Accelergy and ZigZag outputs into the same E1 candidate
  schema as PD models.
- Add compiler autotuning experiments for:
  - INT8 tiling;
  - INT4/AWQ/GPTQ/PTQ;
  - 2:4 sparsity;
  - FP8 E4M3;
  - attention lowering;
  - command-buffer scheduling;
  - DMA overlap;
  - memory QoS.

Acceptance:

- Any TOPS/W or performance claim requires calibrated E1 simulator, FPGA, or
  hardware evidence. Architecture estimates are clearly labeled estimates.

## E1-specific experiment backlog

### Macro placement experiments

- E1-PL-001: OpenROAD Hier-RTLMP baseline on latest E1 OpenLane run.
- E1-PL-001a: Deterministic legal-grid, target-aware-grid, and
  target-repair-search baselines on normalized fixture, TILOS Ariane133, and E1
  generated 4x4/8x8 softmacro cases.
- E1-PL-002: MacroPlacement SA baseline on E1 softmacro 4x4/5x5/8x8/16x16.
- E1-PL-003: Circuit Training scratch PPO on E1 4x4, then 8x8.
- E1-PL-004: Circuit Training imitation/bootstrap from MacroPlacement cases.
- E1-PL-005: ChipDiffusion candidate generation on E1 softmacros.
- E1-PL-006: ChiPFormer offline policy on MacroPlacement + ChiPBench-D.
- E1-PL-007: Ensemble candidate selector using surrogate risk scores.
- E1-PL-008: Post-route replay of top 10 candidates per method.
- E1-PL-009: Sensitivity to macro halos, blockages, aspect ratio, IO ring, PDN
  straps, and padframe constraints.
- E1-PL-010: Negative result archive where proxy winners fail routing/timing.

Metrics:

- HPWL;
- macro legality;
- density overflow;
- global-route congestion;
- detailed-route DRC count;
- WNS/TNS;
- power estimate;
- antenna warnings;
- runtime;
- candidate reproducibility;
- post-route PPA delta versus baseline.

### Synthesis experiments

- E1-SYN-001: ABC recipe random search on NPU, DMA, IOMMU, interconnect.
- E1-SYN-002: OpenABC-D pretrained recipe ranker, then E1 fine-tuning.
- E1-SYN-003: MapTune-style library mapping experiments for SKY130/GF180/IHP.
- E1-SYN-004: Multi-objective area/timing/power policy with OpenLane replay.
- E1-SYN-005: Equivalence-fail corpus from bad recipes for safety filters.

Metrics:

- cell area;
- logic depth;
- timing estimate;
- OpenLane routed area/timing/power;
- equivalence status;
- formal/cocotb pass/fail;
- runtime.

### Routability/timing/power predictor experiments

- E1-PRED-001: Train congestion predictor on CircuitNet + E1 run snapshots.
- E1-PRED-002: Train timing slack predictor on CircuitNet 3.0 + E1 STA paths.
- E1-PRED-003: Train power predictor on CircuitNet 3.0/iDATA + E1 power logs.
- E1-PRED-004: Train post-route failure classifier for E1 candidate pruning.
- E1-PRED-005: Uncertainty calibration and abstention policy.

Metrics:

- MAE/RMSE for continuous labels;
- rank correlation for candidate ordering;
- false negative rate for bad candidates;
- calibration error;
- held-out E1 performance;
- cross-design transfer.

### Verification and formal experiments

- E1-VERIF-001: AI-guided cocotb stimulus for NPU descriptor queues.
- E1-VERIF-002: AI-guided DMA backpressure/order/error stimulus.
- E1-VERIF-003: AI-guided IOMMU translation/fault stimulus.
- E1-VERIF-004: Assertion candidate generation for NPU/DMA/top.
- E1-VERIF-005: Formal counterexample clustering and repair suggestions.
- E1-VERIF-006: Netlist equivalence triage for synthesis candidates.

Metrics:

- new coverage bins hit;
- regression pass rate;
- unique bugs found;
- assertion proof depth;
- false assertion rate;
- human review acceptance rate.

### NPU/compiler/runtime experiments

- E1-NPU-001: Timeloop/ZigZag/SCALE-Sim triangulation for current NPU.
- E1-NPU-002: INT8/INT4/PTQ/AWQ/GPTQ/FP8/sparsity lowering comparison.
- E1-NPU-003: command-buffer scheduling and DMA overlap search.
- E1-NPU-004: unsupported-op and CPU-fallback percentage tracking.
- E1-NPU-005: thermal/power sustained workload policy search.
- E1-NPU-006: memory-bandwidth sensitivity against the 208 GB/s sustained
  target in `soc-optimized-operating-point.yaml`.

Metrics:

- operator coverage;
- CPU fallback percentage;
- simulated latency;
- memory traffic;
- scratchpad reuse;
- DMA overlap;
- power/thermal model output;
- runtime test pass/fail.

## Reproducibility layout

Implemented and recommended local layout:

```text
packages/chip/
  external/
    SOURCES.lock.yaml
    repos/
    datasets/
    models/
    cache/                 # gitignored
  build/ai_eda/
    external_assets/
    converted_datasets/
    training_runs/
    inference_runs/
    candidate_replay/
    reports/
  research/alpha_chip_macro_placement/
    09_runs/
    10_model_cards/
    11_dataset_cards/
```

Model and dataset artifacts should not be committed unless they are tiny test
fixtures or intentional metadata. Commit:

- manifests;
- scripts;
- schemas;
- hashes;
- small fixtures;
- run summaries;
- accepted evidence reports.

Do not commit:

- full external datasets;
- model weights;
- generated OpenLane run trees unless intentionally archived as release
  evidence;
- unreviewed generated RTL/Tcl/constraints;
- private checkpoint binaries;
- foundry-confidential files.

## Candidate lifecycle

Every optimization must follow this lifecycle:

1. Intake: source/model/dataset is pinned and license-reviewed.
2. Convert: input is converted into a versioned schema with hashes.
3. Train: training config, code commit, data split, seed, environment, and
   output hashes are recorded.
4. Infer: model emits an `eda.e1_candidate.v1` artifact into quarantine.
5. Replay: deterministic E1 wrapper imports the candidate and runs gates.
6. Compare: report compares against current baseline and simple baselines.
7. Review: human accepts, rejects, or requests another experiment.
8. Promote: only accepted candidates become source/config changes.
9. Archive: all artifacts needed for replay are retained by hash.

Candidate statuses:

- `generated`: model produced candidate, not replayed.
- `invalid`: schema or legality failed.
- `replayed_blocked`: tool or external dependency missing.
- `replayed_failed`: deterministic gate failed.
- `replayed_passed`: deterministic gates passed, pending review.
- `accepted`: reviewer approved source/config promotion.
- `rejected`: reviewer rejected with reason.

## Gates that must remain authoritative

AI lanes must point back to existing deterministic checks:

- `make docs-check`
- `make ai-eda-source-inventory-check`
- `make openlane-run-preflight-check`
- `make pd-signoff-manifest-check`
- `make physical-closure-work-order-check`
- `make pd-preflight-check`
- `make cocotb`
- `make formal`
- `make synth`
- `make rtl-check`
- `make npu-runtime-contract-check`
- `make npu-scale-sim-check`
- `make npu-context-queue-sim-check`
- `make memory-iommu-qos-sim-check`
- `make soc-optimization`
- `make cpu-npu-modeled-benchmark-eval`
- `make verification-maturity-matrix-check`
- `make chipyard-verilator-linux-smoke-check`
- `make aosp-linux-handoff`
- `make android-sim-boot-check`
- `make product-check`

If a new AI lane needs a new checker, add the checker first and make the lane
fail closed until the checker can classify PASS/BLOCKED/FAIL.

## Near-term implementation plan

### Week 1: Asset and schema foundation

- Add external asset manifests and checker. **Initial metadata/checker is
  implemented; per-asset checksum pinning remains blocked until downloads are
  executed and license/provenance review is accepted.**
- Add dry-run fetchers for MacroPlacement, ChiPBench-D, CircuitNet, OpenABC-D,
  EDALearn, EDA Corpus, iDATA, and placement model repos. **Generic dry-run /
  verify-only / execute wrapper is implemented for the lockfile entries.**
- Add tiny fixture datasets for converter tests.
- Define `eda.design_bundle.v1`, `eda.placement_case.v1`,
  `eda.graph_sample.v1`, `eda.flow_run.v1`, and `eda.e1_candidate.v1`.
- Convert one MacroPlacement case and one E1 softmacro case into the schema.
- Run `make docs-check`.

### Week 2: Baselines and E1 replay

- Run or refresh OpenROAD/OpenLane E1 baseline.
- Run OpenROAD Hier-RTLMP, SA, coordinate descent, and random/legalized
  baselines on E1 softmacro cases. **Initial deterministic legal-grid and
  target-aware-grid plus target-repair-search baselines are implemented and
  quarantined; replay remains blocked.**
- Emit candidate manifests for each method.
- Replay top candidates through OpenLane/OpenROAD.
- Archive proxy-vs-post-route deltas.

### Week 3: First training runs

- Train Circuit Training from scratch on a toy + Ariane + E1 4x4 curriculum.
- Train or run ChipDiffusion and ChiPFormer where licenses and dependencies
  allow.
- Generate E1 4x4/8x8 candidates from each model.
- Compare against simple baselines and OpenROAD Hier-RTLMP.
- Write model cards for every run.

### Week 4: Surrogates and synthesis policy

- Export E1 OpenROAD/OpenLane run snapshots for predictor training.
- Train a first congestion/timing risk model with CircuitNet + E1 snapshots.
- Generate E1 Yosys/ABC recipe corpus.
- Run random recipe search and OpenABC-D-inspired recipe ranking.
- Replay any synthesis candidate through equivalence/formal/synth/PD gates.

### Week 5+: Scale-out and remote compute

- Package H200/GPU training payloads with exact manifests.
- On a fresh machine, run `make ai-eda-bootstrap-metadata` first. This performs
  no downloads and proves that the repo-owned source/intake/schema metadata is
  coherent.
- To pull reviewed small assets, run
  `python3 scripts/ai_eda/bootstrap_ai_eda_stack.py --profile metadata --run-id
  fetch-reviewed --asset tilos-macroplacement --asset openroad-eda-corpus
  --asset circuitnet3 --asset chipbench-d --asset openabc-d --asset
  aieda-idata --asset edalearn --asset macro-place-challenge-2026 --asset
  mlcad-2023-fpga-macro --asset chipdiffusion --asset chipformer --asset
  core-placement --asset maptune --asset abc-rl --asset abcrl --asset rl4ls
  --asset mcp4eda --asset orfs-agent --asset openroad-agent --asset
  openroad-mcp --asset open3dbench --asset dreamplace --asset chiplingo
  --asset veoplace-vlm --asset audopeda --asset ppa-3dic-surrogate-2026
  --execute-fetch`; payloads land only in ignored `payload/` directories.
- Run `make PYTHON=/usr/bin/python3 AI_EDA_RUN_ID=<host-or-date>
  ai-eda-bootstrap-setup-check` after payload restore/fetch to rebuild
  normalized corpora, local E1 softmacro cases, OpenLane labels, and supervised
  placement dataset splits in an isolated output tree.
- Run `make ai-eda-bootstrap-local-smoke` for dependency-free placement
  training, candidate ranking, replay plans, logic-synthesis baselines, and
  cocotb/tool-action dry-run evidence.
- Run `scripts/ai_eda/preflight_cuda_training_stack.py --run-id <host>` on the
  CUDA machine before any training run; do not start large training until
  `nvidia-smi`, CUDA-compatible `torch`, `huggingface-cli`, dataset manifests,
  and asset verification reports are present.
- Generate and validate the handoff with `make ai-eda-cuda-payload`; transfer the resulting
  `build/ai_eda/cuda_training_payloads/<run-id>/cuda_training_payload.tar.gz`
  to the CUDA host, then execute the embedded `cuda_training_run_plan.json`.
- Add resumable training and artifact sync.
- Add dataset cards and model cards for every external and local run.
- Build an experiment dashboard from manifests, not hand-edited status text.
- Add active learning: replay failures become negative labels for the next
  model.

## Hardware/software blockers to respect

The AI optimization stack cannot hide the current product blockers:

- Checked-in E1 RTL is not yet a Linux/AOSP-capable phone AP.
- Generated Chipyard AP Linux smoke is still blocked at partial banner-level
  evidence.
- Android/AOSP evidence is not yet tied to a generated E1 AP simulator.
- App package/service identities and riscv64 APK assets are not normalized.
- Phone peripherals, HALs, board/package, PDN, SI/PI, DFT, and signoff are not
  complete.
- Advanced mobile-node PDKs are not public/manufacturable in the way SKY130,
  GF180, and IHP SG13G2 are. ASAP7 is research/predictive only.

Therefore early wins should be phrased as:

- "candidate improved E1 OpenLane SKY130/GF180/IHP proxy/post-route metrics";
- "candidate improved simulator-model estimate";
- "candidate increased verified coverage";
- "candidate reduced Yosys/OpenLane area/timing in replay";

not as:

- "phone SoC optimized";
- "mobile-node PPA proven";
- "Android-ready chip";
- "silicon-signoff complete";
- "AlphaChip checkpoint reproduced."

## Open questions

- Which public dataset licenses permit training internal/private models and
  publishing derived model cards?
- Is there any lawful private copy of `plc_wrapper_main` or the August 2024
  AlphaChip checkpoint with a recorded SHA256?
- Which remote GPU provider is approved for large training, and what data can
  leave local storage?
- Should E1 optimize first for SKY130/IHP/GF180 reproducibility or ASAP7
  advanced-node research relevance?
- Which E1 macro inventory is the first "real" macro case: SRAM/cache/NPU
  tiles, IO/padframe, or a generated Chipyard AP block?
- What is the minimum gate bundle for accepting a placement-only change?
- What is the minimum gate bundle for accepting a synthesis/netlist change?
- How will benchmark/train/test overlap be audited for public RTL corpora?

## Immediate TODO checklist

- [x] Add external asset manifest schema and checker.
- [x] Add per-asset external intake manifest schema/checker and pin the first
  reviewed OpenROAD EDA Corpus metadata manifest.
- [x] Add pending metadata manifests for ChiPBench-D, CircuitNet 3.0,
  FloorSet, and the Partcl/HRT Macro Placement Challenge.
- [x] Pin, fetch, and verify the reviewed TILOS MacroPlacement corpus.
- [x] Pin and verify the public Google Circuit Training checkout as ignored
  payload while keeping checkpoint/binary access separately blocked.
- [x] Add dry-run/verify-only fetchers for P0 datasets and repos.
- [x] Execute and verify the reviewed small OpenROAD EDA Corpus fetch.
- [x] Convert OpenROAD EDA Corpus into normalized text-instruction train/val/test JSONL.
- [x] Add Mac/CUDA training-stack preflight report.
- [x] Add metadata-only CUDA training payload packager.
- [x] Add fresh-machine AI-EDA bootstrap profiles for metadata validation,
  local smoke setup, explicit reviewed-asset fetch, and CUDA training handoff.
- [x] Add a bounded CircuitNet3 converter/check target for timing/power graph
  pretraining records from a restored local payload archive.
- [x] Add dependency-free CircuitNet3 timing/power surrogate train/eval/check
  path over real converted flow-run records.
- [x] Add tiny conversion fixtures.
- [x] Add common internal AI-EDA schemas.
- [x] Add dependency-free local fixture training/inference smoke.
- [x] Convert tiny MacroPlacement/Bookshelf fixture and one E1-style softmacro case.
- [x] Convert tiny ChiPBench-D-style metadata and one sample case.
- [x] Convert tiny CircuitNet-style graph sample.
- [x] Fetch and convert the first real CircuitNet 3.0 zip sample into internal
  design-bundle, graph-sample, and flow-run records.
- [x] Convert checked-in E1 OpenLane SKY130 config into internal
  `eda.design_bundle.v1`, `eda.placement_case.v1`, and blocked
  `eda.flow_run.v1` records.
- [x] Add OpenLane final metrics parser and fixture label smoke.
- [x] Train/run first deterministic macro-placement baseline on normalized
  fixture and E1 placement cases.
- [x] Build CUDA-host-ready supervised macro-placement JSONL splits from
  normalized TILOS and E1 softmacro placement labels.
- [x] Add supervised macro-placement dataset validator for JSONL sample schema,
  counts, split leakage, and fallback-size accounting.
- [x] Train/evaluate first dependency-free supervised macro-placement imitation
  model over the JSONL splits and emit quarantined E1 softmacro candidates.
- [x] Add supervised macro-placement model/report validator for metrics,
  candidate inventory, blocked cases, and pre-replay geometry.
- [x] Add CUDA-capable PyTorch macro-placement regressor entrypoint over the
  supervised JSONL splits.
- [x] Add dependency-free PyTorch-regressor artifact validator for CUDA-host
  training reports, metrics, split counts, and model-file presence.
- [x] Add PyTorch-regressor inference candidate generator for CUDA-host model
  outputs, including deterministic legalization and pre-replay geometry
  quarantine.
- [x] Add dependency-free PyTorch-regressor inference artifact validator for
  CUDA-host inference reports and quarantined candidate inventories.
- [x] Add fail-closed replay plans for supervised macro-placement candidates.
- [x] Add target-aware legal-grid comparison metrics for converted TILOS
  Ariane133 and generated E1 softmacro cases.
- [x] Add legal target-repair search candidates for converted TILOS Ariane133
  and generated E1 softmacro cases.
- [x] Add macro-placement candidate ranking/evaluation report for quarantined
  candidates.
- [x] Add combined deterministic plus supervised macro-placement replay-plan
  target with fail-closed bundle and tool-action validation.
- [x] Add full deterministic plus supervised plus Torch-inference
  macro-placement candidate ranking and replay-plan targets for CUDA/MPS hosts.
- [x] Add combined macro-placement candidate ranking across deterministic
  baseline and supervised-model candidate directories.
- [x] Add macro-placement replay-plan bundles for quarantined candidates without
  executing or promoting OpenLane/OpenROAD changes.
- [x] Add macro-placement replay-plan validator for bundle hashes, override
  counts, tool-action links, and fail-closed replay status.
- [x] Add guarded macro-placement replay preflight harness/check target that
  consumes replay bundles, records OpenLane/OpenROAD blockers, and requires an
  explicit `--execute` before any tool invocation.
- [x] Add read-only local EDA RAG/log-triage manifest and citation checker.
- [x] Add fail-closed physical-design target captures for timing closure,
  routing/congestion, placement/legalization, and physical verification.
- [x] Add fail-closed broad optimization target captures for circuit foundation
  models, EDA agents, DFM/yield/lithography, low-power intent, post-silicon
  validation, and hardware security.
- [x] Wire all 36 AI-EDA domain target-capture scripts into a single
  dependency-safe Make/CUDA/docs-check gate.
- [x] Legalize target-aware and target-repair macro-placement candidates so the
  replay planner reports zero out-of-bounds, overlap, or unknown-target
  candidates across the expanded candidate set.
- [x] Convert sixteen real MacroPlacement cases after external fetch/pin.
- [x] Validate expanded macro-placement candidate directory and replay-blocker
  plan.
- [x] Add first replay-blocked proxy adapters for CT, SA, Hier-RTLMP, and
  ChipDiffusion macro-placement lanes over normalized E1/TILOS placement cases.
- [x] Generate and convert E1 4x4/8x8 softmacro placement cases.
- [x] Convert real ChiPBench-D metadata and a bounded sample after
  license/storage review.
- [x] Convert one real CircuitNet 3.0 graph sample after local payload fetch
  and schema review.
- [x] Convert one real iDATA graph/flow sample after license/storage review.
- [x] Convert real EDALearn RTL/config samples after local payload fetch and
  schema review.
- [x] Convert public Partcl/HRT Macro Placement Challenge 2026 baseline
  metadata into internal design, graph, and flow records with a CUDA handoff
  checker while keeping `.pt` tensors out of the payload tarball.
- [x] Convert public MLCAD 2023 FPGA macro-placement spec metadata into
  internal graph/flow records while preserving the missing per-design
  Bookshelf/Vivado payload blocker.
- [x] Convert fetched ChipDiffusion, ChiPFormer, CORE, MapTune, ABC-RL, abcRL,
  RL4LS, MCP4EDA, ORFS-Agent, OpenROAD Agent, OpenROAD MCP, Open3DBench, and
  DREAMPlace research-code repos into normalized text-instruction records for
  RAG/CUDA runbook training, with no execution or optimization claim.
- [x] Add and validate the E1 AI workload/model manifest for TFLite, NPU scale,
  Timeloop, StableHLO lowering, INT4, FP8, and sparse 2:4 benchmark lanes.
- [ ] Export latest deterministic E1 OpenLane/OpenROAD run metrics into
  `eda.flow_run.v1` after replay artifacts exist.
- [ ] Replace CT/SA/Hier-RTLMP/ChipDiffusion proxy adapters with the real
  external-method inference wrappers after each payload is fetched and reviewed.
- [ ] Replay baseline candidates through OpenLane/OpenROAD.
- [x] Add model-card template for placement policies.
- [x] Add dataset-card template for converted corpora.
- [x] Add candidate manifest schema and checker.
- [x] Add logic-synthesis recipe corpus generator.
- [x] Add OpenABC-D/ABC/Yosys policy baseline.
- [x] Add logic-synthesis recipe/baseline validator and CUDA payload handoff.
- [x] Add PD surrogate training/eval smoke.
- [x] Extend cocotb stimulus search beyond NPU descriptor queue.
- [x] Define typed EDA tool-action schema before any write-capable agent.
- [x] Keep `alphachip-checkpoint-blocker.md` monthly re-audits.

## Bottom line

The realistic path is to build a reproducible AI-EDA factory around E1:
public corpora in, normalized schemas, trainable models, quarantined
candidates, deterministic replay, and evidence-backed promotion. AlphaChip is
one lane in that factory. MacroPlacement, ChiPBench-D, CircuitNet, EDALearn,
iDATA, OpenABC-D, OpenROAD-flow-scripts, and local E1 OpenLane/formal/sim data
are the substance that makes it useful without Google's unavailable TPU
checkpoint.
