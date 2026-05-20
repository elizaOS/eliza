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
- `scripts/ai_eda/check_external_asset_manifests.py` validates the lockfile.
- `scripts/ai_eda/fetch_external_asset.py` emits dry-run, verify-only, or
  execute reports into `build/ai_eda/external_assets/<run-id>/`.
- `scripts/ai_eda/preflight_cuda_training_stack.py` records Mac/CUDA readiness
  into `build/ai_eda/cuda_training_preflight/<run-id>/`.
- `scripts/ai_eda/package_cuda_training_payload.py` emits a metadata-only
  payload and run plan for a remote CUDA host.
- `docs/spec-db/ai-eda/internal-dataset-schemas.yaml` defines the first
  internal normalized records: `eda.design_bundle.v1`,
  `eda.placement_case.v1`, `eda.graph_sample.v1`, `eda.flow_run.v1`, and
  `eda.e1_candidate.v1`.
- `docs/spec-db/ai-eda/examples/*.yaml` provides tiny schema fixtures for the
  E1 softmacro smoke lane.
- `scripts/ai_eda/check_internal_dataset_schemas.py` validates the schemas and
  fixtures.
- `make docs-check` now depends on `ai-eda-external-assets-check`, so source
  intake metadata and internal dataset schemas are validated with the existing
  docs gate.

Current local validation on the 128 GiB M4 host:

- `make docs-check`: PASS.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset chipbench-d --dry-run
  --run-id validation`: PASS and emits a dry-run report.
- `python3 scripts/ai_eda/fetch_external_asset.py --asset
  google-circuit-training --verify-only --run-id validation`: BLOCKED because
  the local external checkout is not present yet.
- `python3 scripts/ai_eda/preflight_cuda_training_stack.py --run-id validation`:
  PASS_WITH_BLOCKERS_RECORDED. The host has 128 GiB RAM and no CUDA; missing
  training/CUDA tools are recorded in the JSON report.
- `python3 scripts/ai_eda/package_cuda_training_payload.py --run-id validation`:
  PASS and emits a tarball containing manifests, scripts, and a run plan only.
- `make ai-eda-internal-schemas-check`: PASS for five record schemas and five
  example fixtures.

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
- `make docs-check` includes the manifest checker.

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
- `scripts/ai_eda/train_fixture_placement_smoke.py` runs a dependency-free CPU
  training/inference smoke over the placement fixture and emits
  `training_run.json`, `metrics.json`, `fixture_placement_model.json`, and
  `candidate_manifest.json`.
- `docs/spec-db/ai-eda/external-fixtures/` contains tiny external-shape fixtures
  for MacroPlacement/Bookshelf, ChiPBench-D, and CircuitNet.
- `scripts/ai_eda/convert_external_fixture_corpora.py` converts those fixtures
  into internal `eda.*.v1` records and revalidates them through
  `check_internal_dataset_schemas.py --records-dir`.
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
  `eda.flow_run.v1` record. With the fixture metrics it reports
  `fixture_metrics_parser_smoke_no_ppa_claim`; with a real run it must still
  be reviewed for deterministic provenance and train/test split assignment.
- `scripts/ai_eda/train_pd_surrogate_smoke.py` consumes normalized
  `eda.flow_run.v1` labels and emits a dependency-free constant-mean surrogate,
  eval report, and training-run manifest. This proves the PD surrogate artifact
  path but makes no generalization, signoff, or PPA claim.
- `scripts/ai_eda/check_candidate_manifests.py` validates generated
  `eda.e1_candidate.v1` manifests and refuses accepted candidates unless every
  required gate is completed.
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
  `make ai-eda-external-fixture-convert` proves the external-format fixture ->
  internal-schema conversion plumbing locally.
  `make ai-eda-e1-openlane-convert` proves checked-in E1 OpenLane conversion
  and schema validation locally.
  `make ai-eda-logic-synthesis-baseline` generates the first E1 Yosys/ABC
  recipe corpus and local baseline report. On this Mac, DMA passes four Yosys
  recipes, NPU passes two generic Yosys recipes, NPU generic ABC mapping times
  out under the interactive 20 second limit, and OpenABC-D remains blocked until
  external assets are fetched and reviewed.
  `make ai-eda-openlane-flow-labels` proves OpenLane metrics parsing into
  `eda.flow_run.v1` locally using fixture metrics.
  `make ai-eda-pd-surrogate-smoke` proves normalized flow labels can feed
  model/eval artifacts locally.
  `make ai-eda-candidate-manifests-check` validates the fixture-generated
  candidate manifest.
  `make ai-eda-tool-actions-check` validates the initial dry-run
  `eda.tool_action.v1` fixture and command governance policy.
  `make docs-check` depends on the schema checker.

Converters to add or complete:

- MacroPlacement LEF/DEF/Bookshelf to `eda.placement_case.v1`.
- ChiPBench-D to `eda.design_bundle.v1` and `eda.placement_case.v1`.
- CircuitNet to `eda.graph_sample.v1`.
- EDALearn to `eda.flow_run.v1` and `eda.graph_sample.v1`.
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

- Add `scripts/ai_eda/train_macro_placement_policy.py` as an orchestrator over
  CT, ChipDiffusion, ChiPFormer, CORE, and SA baselines.
- Add `scripts/ai_eda/evaluate_macro_placement_candidates.py` to emit a ranked
  candidate manifest, not source edits.
- Add `scripts/ai_eda/replay_macro_placement_on_e1.sh` to import one candidate
  into OpenLane/OpenROAD and run the chosen deterministic gates.
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

- Extend `scripts/ai_eda/run_cocotb_stimulus_search.py` to search descriptor
  queue, DMA, IOMMU, interrupt, reset, and NPU command-buffer edges.
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

- Add a model/workload manifest for every AI benchmark:
  source, license, input shape, quantization, expected ops, fallback ops,
  runtime path, and golden output tolerance.
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
  baselines on E1 softmacro cases.
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
- Run `scripts/ai_eda/preflight_cuda_training_stack.py --run-id <host>` on the
  CUDA machine before any training run; do not start large training until
  `nvidia-smi`, CUDA-compatible `torch`, `huggingface-cli`, dataset manifests,
  and asset verification reports are present.
- Generate the handoff with `make ai-eda-cuda-payload`; transfer the resulting
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
- [x] Add dry-run/verify-only fetchers for P0 datasets and repos.
- [x] Add Mac/CUDA training-stack preflight report.
- [x] Add metadata-only CUDA training payload packager.
- [x] Add tiny conversion fixtures.
- [x] Add common internal AI-EDA schemas.
- [x] Add dependency-free local fixture training/inference smoke.
- [x] Convert tiny MacroPlacement/Bookshelf fixture and one E1-style softmacro case.
- [x] Convert tiny ChiPBench-D-style metadata and one sample case.
- [x] Convert tiny CircuitNet-style graph sample.
- [x] Convert checked-in E1 OpenLane SKY130 config into internal
  `eda.design_bundle.v1`, `eda.placement_case.v1`, and blocked
  `eda.flow_run.v1` records.
- [x] Add OpenLane final metrics parser and fixture label smoke.
- [ ] Convert real MacroPlacement Ariane and one generated E1 softmacro case after external fetch/pin.
- [ ] Convert real ChiPBench-D metadata and one sample case after license/storage review.
- [ ] Convert one real CircuitNet/iDATA graph sample after license/storage review.
- [ ] Export latest deterministic E1 OpenLane/OpenROAD run metrics into
  `eda.flow_run.v1` after replay artifacts exist.
- [ ] Train/run first macro-placement baselines on E1 4x4.
- [ ] Replay baseline candidates through OpenLane/OpenROAD.
- [x] Add model-card template for placement policies.
- [x] Add dataset-card template for converted corpora.
- [x] Add candidate manifest schema and checker.
- [x] Add logic-synthesis recipe corpus generator.
- [x] Add OpenABC-D/ABC/Yosys policy baseline.
- [x] Add PD surrogate training/eval smoke.
- [ ] Extend cocotb stimulus search beyond NPU descriptor queue.
- [x] Define typed EDA tool-action schema before any write-capable agent.
- [ ] Keep `alphachip-checkpoint-blocker.md` monthly re-audits.

## Bottom line

The realistic path is to build a reproducible AI-EDA factory around E1:
public corpora in, normalized schemas, trainable models, quarantined
candidates, deterministic replay, and evidence-backed promotion. AlphaChip is
one lane in that factory. MacroPlacement, ChiPBench-D, CircuitNet, EDALearn,
iDATA, OpenABC-D, OpenROAD-flow-scripts, and local E1 OpenLane/formal/sim data
are the substance that makes it useful without Google's unavailable TPU
checkpoint.
