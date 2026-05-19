# AI-for-EDA Literature and Tools - 2026-05-19

This note tracks open projects and papers that could improve E1 chip creation,
verification, placement, validation, or manufacturing flows. Treat these as
candidate inputs to reproducible gates, not as standalone evidence.

## Placement and scoring targets

- AlphaChip / Circuit Training: <https://github.com/google-research/circuit_training>.
  Primary RL macro-placement path for the current E1 experiment.
- TILOS MacroPlacement: <https://github.com/TILOS-AI-Institute/MacroPlacement>.
  Methodology reference for comparing RL macro placement against strong open
  baselines.
- DREAMPlace: <https://github.com/limbo018/DREAMPlace>. GPU analytical placer
  and strong non-RL baseline.
- Xplace 3.0: <https://github.com/cuhk-eda/Xplace>. Deterministic,
  routability- and timing-aware placer worth testing if import friction is low.
- OpenROAD Hier-RTLMP:
  <https://openroad.readthedocs.io/en/latest/main/src/mpl/README.html>. Native
  hierarchy-aware macro placer for the E1 baseline set.
- AutoDMP: <https://github.com/NVlabs/AutoDMP>. DREAMPlace-based macro
  placement with Bayesian parameter tuning.
- OpenROAD AutoTuner:
  <https://openroad-flow-scripts.readthedocs.io/en/latest/user/InstructionsForAutoTuner.html>.
  Practical non-RL optimizer for OpenROAD/OpenLane flow knobs.

## Learned predictors and surrogate data

- CircuitNet: <https://github.com/circuitnet/CircuitNet> and
  <https://circuitnet.github.io/>. Open ML-for-EDA dataset for congestion, DRC,
  IR drop, timing, net-delay, and graph labels.
- RoutePlacer: <https://arxiv.org/abs/2406.02651>. GNN routability prediction
  integrated with analytical placement.
- DG-RePlAce: <https://arxiv.org/abs/2404.13049>. Dataflow-aware placement
  ideas relevant to accelerator and NPU locality constraints.

## Agent and LLM-assisted EDA

- ORFS-agent: <https://vlsicad.ucsd.edu/Publications/Conferences/417/c417.pdf>.
  Agentic OpenROAD-flow optimization reference.
- MCP4EDA: <https://arxiv.org/abs/2507.19570>. Prototype for exposing Yosys,
  OpenLane, KLayout, and OpenROAD to agent-callable interfaces.
- IICPilot: <https://arxiv.org/abs/2407.12576>. Unified backend EDA-calling
  interface for AI agents.
- ChipNeMo: <https://arxiv.org/abs/2311.00176>. Architecture reference for EDA
  RAG, script generation, and bug summarization; direct reuse is limited by
  mostly closed training data.
- MAGE:
  <https://github.com/stable-lab/MAGE-A-Multi-Agent-Engine-for-Automated-RTL-Code-Generation>.
  Candidate for small RTL/test generation experiments when gated by Verilator,
  formal checks, and review.
- VeriRAG: <https://mason.gmu.edu/~rsaravan/projects/VeriRAG/VeriRAG.html>.
  Relevant for spec-to-SVA and assertion-generation experiments.
- VerilogEval: <https://github.com/NVlabs/verilog-eval>. Useful benchmark
  before trusting any RTL-generation agent on E1 source.
- CodeV-R1: <https://arxiv.org/abs/2505.24183>. RLVR Verilog model, code, and
  dataset candidate; keep blocked until revisions, licenses, contamination,
  and held-out E1 gates exist.
- EvolVE / IC-RTL: <https://arxiv.org/abs/2601.18067>. Evolutionary Verilog
  generation and PPA optimization reference with IC-RTL benchmark code; useful
  only after benchmark overlap and local replay are reviewed.
- VeriAgent: <https://arxiv.org/abs/2603.17613>. PPA-aware multi-agent RTL
  generation method with evolving memory; method reference only until tool
  schemas, prompts, memory hashes, and deterministic gates exist.
- Open-LLM-ECO: <https://github.com/YiKangOY/Open-LLM-ECO>. QoR/ECO agent
  placeholder repo for retrieve/schedule/reflect optimization; blocked until
  real code/data, license, and OpenLane replay evidence exist.
- AgenticTCAD: <https://arxiv.org/abs/2512.23742>. Multi-agent TCAD code
  generation and device optimization research. E1 status: blocked until TCAD
  decks, simulator licenses, process authority, calibration, replay logs, and
  human process-device review exist.
- TcadGPT: <https://arxiv.org/abs/2601.10128>. Domain-specific executable TCAD
  LLM research with reported code/data/model assets. E1 status: metadata-only
  until exact asset revisions, licenses, simulator executability, synthetic-data
  provenance, held-out tasks, and reviewer disposition are captured.
- AnalogAgent: <https://arxiv.org/abs/2603.23910>. Self-improving multi-agent
  analog design framework with memory and execution feedback; blocked for E1
  until prompts, model versions, memory snapshots, SPICE decks, simulator logs,
  PVT sweeps, and analog review are captured.
- AnalogMaster: <https://arxiv.org/abs/2604.20916>. End-to-end LLM analog IC
  flow from schematic image to netlist, sizing, placement, and routing; E1 use
  is blocked pending image/netlist/layout hashes, DRC/LVS/extraction, SI/PI,
  and human review.
- VLM-CAD: <https://arxiv.org/abs/2601.07315>. VLM-guided analog sizing with
  structural parsing and explainable trust-region Bayesian optimization; target
  capture only until simulator and sizing-label evidence exists.
- CircuitLM: <https://arxiv.org/abs/2601.04505>. Multi-agent schematic
  generation with CircuitJSON and deterministic ERC; code/data are reported as
  forthcoming, so E1 use is metadata-only.
- EEschematic: <https://arxiv.org/abs/2510.17002>. MLLM SPICE-to-schematic
  generation reference; blocked until symbol libraries, equivalence checks, and
  reviewer disposition exist.
- AnalogCoder-Pro: <https://arxiv.org/abs/2508.02518>. Multimodal analog
  topology generation and sizing with waveform feedback; blocked until assets,
  simulator logs, PVT/layout checks, and review exist.
- AnalogCoder: <https://github.com/laiyao1/AnalogCoder>. Code-bearing
  training-free analog generation reference; do not import or run until license,
  prompts, generated SPICE hashes, simulator logs, and review are pinned.
- AMS-Net: <https://ams-net.github.io/>. Schematic/netlist dataset for
  analog/mixed-signal circuits; dataset-governance only until exact snapshot,
  license, non-overlap review, and parser baselines exist.
- LLM4SecHW OSHD:
  <https://huggingface.co/datasets/KSU-HW-SEC/LLM4SecHW-OSHD>. Open-source
  hardware-debug dataset paired with the LLM4SecHW workflow. E1 status:
  quarantined dataset candidate only until exact revision, license,
  source-project provenance, overlap/contamination review, and generated-output
  isolation exist.
- ChipBench: <https://arxiv.org/abs/2601.21448> and
  <https://github.com/zhongkaiyu/ChipBench>. 2026 benchmark covering realistic
  Verilog generation, debugging, and Python/SystemC/CXXRTL reference-model
  generation. E1 status: benchmark-governance reference only until task
  manifests, license, overlap review, local replay, and reviewer disposition
  are captured.
- AI-assisted hardware security verification:
  <https://arxiv.org/abs/2604.01572>. Useful taxonomy for asset identification,
  threat modeling, security test planning, simulation, formal verification, and
  countermeasure reasoning; paper-only for E1 until local security evidence
  gates exist.
- SafeTune: <https://arxiv.org/abs/2604.27238>. RTL fine-tuning poisoning
  defense reference; use as a corpus-governance risk, not as an enabled
  training or filter pipeline.
- TrojanLoC: <https://arxiv.org/abs/2512.00591>. LLM-based line-level RTL
  Trojan localization reference with TrojanInS dataset claims; blocked until
  assets, labels, and local evidence are reviewed.
- HarmChip: <https://arxiv.org/abs/2604.17093>. Hardware-security LLM jailbreak
  benchmark; dual-use prompts must stay quarantined and out of release
  evidence.
- Trojan explainability comparison: <https://arxiv.org/abs/2601.18696>.
  Useful criteria for reviewable security findings, especially circuit-aware
  features versus opaque attribution scores.
- PostEDA-Bench: <https://arxiv.org/abs/2605.06936>. Cautionary benchmark for
  post-route EDA agents.
- Autocomp: <https://arxiv.org/abs/2505.18574> and
  <https://github.com/ucb-bar/autocomp>. LLM-driven tensor-accelerator kernel
  optimization reference. E1 status: compiler-kernel method reference only
  until target adapters, prompts, model revisions, generated source hashes,
  compiler/simulator logs, correctness tests, benchmark replay, and review are
  captured.
- AccelOpt: <https://arxiv.org/abs/2511.15915> and
  <https://github.com/zhang677/AccelOpt>. Self-improving LLM agent for
  accelerator-kernel optimization with model/dataset assets. E1 status:
  benchmark-governance reference only until code, model, dataset, optimization
  memory, contamination, replay, and license reviews are complete.
- V-Seek: <https://arxiv.org/abs/2503.17422>. RISC-V LLM inference kernel
  optimization reference using the llama.cpp runtime lineage
  <https://github.com/ggml-org/llama.cpp>. E1 status: blocked from runtime use
  until target ISA profiles, compiler flags, binary hashes, simulator/hardware
  logs, workload hashes, calibrated metrics, and reviewer disposition exist.
- Interaction Tree Semantics for RISC-V:
  <https://arxiv.org/abs/2605.04933>. Formal semantics reference for RISC-V
  compiler/hardware/software contract reasoning. E1 status: paper-assets review
  only until formalization assets, theorem logs, subset coverage, generated
  source hashes, and review are pinned.
- RapidChiplet: <https://arxiv.org/abs/2311.06081> and
  <https://github.com/spcl/rapidchiplet>. Chiplet architecture and package
  design-space exploration code candidate. E1 status: citation/code candidate
  only until revision, license, package stack, objective function, input/output
  hashes, cost/yield assumptions, local replay, and review exist.
- PlaceIT: <https://arxiv.org/abs/2502.01449>. Placement-aware inter-chiplet
  interconnect topology synthesis method. E1 status: method reference only
  until code/assets, topology constraints, package/bump maps, PHY assumptions,
  traffic manifests, simulator logs, SI/PI review, and architecture review
  exist.
- DiffChip: <https://arxiv.org/abs/2502.16633>. Differentiable thermal-aware
  chiplet placement method. E1 status: paper-only target capture until
  implementation assets, package stack, power maps, thermal solver logs, SI/PI
  constraints, and reviewer disposition are pinned.
- TDPNavigator-Placer: <https://arxiv.org/abs/2602.11187>. Current
  multi-agent RL method for 2.5D chiplet placement that balances wirelength and
  thermal objectives. E1 status: paper-only target capture until code/assets,
  reward definitions, seeds, package stack, power maps, thermal/wirelength logs,
  and reviewer disposition are pinned.
- Rule2DRC: <https://arxiv.org/abs/2605.15669> and
  <https://github.com/snu-mllab/Rule2DRC>. Current code-bearing benchmark for
  LLM DRC-script synthesis with execution-guided test generation. E1 status:
  generated-deck quarantine only until rule-source hashes, generated script
  hashes, test-layout coverage, tool correlation, false-positive/false-negative
  review, and signoff disposition exist.
- DRC-Coder: <https://arxiv.org/abs/2412.05311>. Multi-agent/VLM method for
  DRC checker generation from rule text, images, layouts, and reports. E1
  status: method reference only until data rights, prompts/models, generated
  code, layout/report hashes, tool correlation, and review are pinned.
- Structural Verification for EDA Code Generation:
  <https://arxiv.org/abs/2604.18834>. Guardrail method for generated EDA code
  using dependency contracts before tool execution. E1 status: guardrail
  reference only until local command schemas, prerequisites, artifact hashes,
  dry-run diagnostics, and reviewer disposition exist.
- OpenDRC: <https://github.com/opendrc/opendrc>. Open-source GPU-accelerated
  DRC engine reference. E1 status: backend watchlist only until revision,
  license, build, rule mapping, layout hashes, report correlation, and review
  are complete.
- MPM-LLM4DSE: <https://arxiv.org/abs/2601.04801> and
  <https://github.com/wslcccc/MPM-LLM4DSE>. Multimodal model and LLM-guided
  HLS DSE candidate with code/model/data assets. E1 status: metadata-only
  until exact revisions, licenses, model manifests, dataset provenance,
  benchmark overlap, replay logs, and reviewer disposition are pinned.
- TimelyHLS: <https://arxiv.org/abs/2507.17962> with related Bench4HLS assets
  at <https://github.com/zfsadik/Bench4HLS>. Timing-aware HLS reference and
  benchmark candidate. E1 status: blocked until benchmark snapshots, licenses,
  timing-label provenance, local replay, and generated-artifact quarantine are
  reviewed.
- FlexLLM HLS Library: <https://arxiv.org/abs/2601.15710>. HLS LLM accelerator
  library method reference. E1 status: paper-only until any implementation,
  library revision, synthesis logs, generated artifacts, and review evidence
  are available.
- TAPA/RapidStream TAPA: <https://arxiv.org/abs/2209.02663> and
  <https://github.com/rapidstream-org/rapidstream-tapa>. Task-parallel HLS
  framework and FPGA backend candidate. E1 status: backend watchlist only until
  revisions, licenses, supported devices, build logs, HLS synthesis, RTL
  simulation, and review are complete.
- ArchPower: <https://arxiv.org/abs/2512.06854>,
  <https://github.com/hkust-zhiyao/ArchPower>, and
  <https://huggingface.co/datasets/zqj23333/ArchPower>. Architecture-level
  CPU power dataset and code candidate with feature and fine-grained simulated
  power labels. E1 status: metadata-only until revisions, licenses, feature
  mapping, workload overlap, local calibration labels, train/test splits, and
  reviewer disposition are captured.
- AutoPower: <https://arxiv.org/abs/2508.12294> and
  <https://github.com/hkust-zhiyao/AutoPower>. Few-shot architecture-level
  power-model method using power-group decoupling. E1 status: target-capture
  context only until code revision, license, E1 CPU/AP feature extraction,
  calibration samples, error analysis, and review evidence exist.
- Lighter: <https://github.com/AUCOHL/Lighter> and
  <https://woset-workshop.github.io/PDFs/2024/15_Lighter_An_Open_Source_Auto.pdf>.
  Open-source Yosys-plugin clock-gating backend for dynamic-power reduction.
  E1 status: backend watchlist only until plugin revision, library-map hashes,
  ICG/scan policy, equivalence, STA, CDC/RDC, synthesis, power reports, and
  review are complete.
- RTL-OPT: <https://arxiv.org/abs/2601.01765>. Benchmark for evaluating RTL
  optimization quality with functional correctness and PPA metrics. E1 status:
  evaluation-method reference only until exact assets, license, benchmark
  non-overlap, synthesis setup hashes, before/after PPA logs, and reviewer
  disposition are pinned.
- AI-driven NoC DSE: <https://arxiv.org/abs/2512.07877>. Current inverse-ML
  NoC design-space exploration method using BookSim-generated data and MLP,
  CVAE, and conditional-diffusion models for topology/parameter prediction.
  E1 status: paper-only target capture until code/assets, dataset-generation
  manifests, topology constraints, traffic traces, BookSim replay logs,
  train/test splits, and architecture/PD review are available.
- InF-ATPG: <https://arxiv.org/abs/2512.00079>. Current RL/GNN ATPG method
  using fanout-free-region partitioning and ATPG-specific circuit features to
  guide test-pattern generation. E1 status: paper-only target capture until
  implementation/assets, fault models, feature manifests, training logs,
  generated-pattern hashes, deterministic fault-simulation replay, and DFT
  review are available.

## E1 integration ranking

1. Continue Circuit Training plus OpenROAD validation as the active AlphaChip
   loop.
2. Add TILOS MacroPlacement methodology and benchmarks to the evaluation
   discipline.
3. Add OpenROAD Hier-RTLMP, DREAMPlace, Xplace, and AutoDMP as practical
   placement baselines.
4. Add OpenROAD AutoTuner as a baseline optimizer for the conventional flow.
5. Use CircuitNet-derived models for congestion, timing, IR, and DRC triage
   only after the direct placement loop is stable.
6. Use LLM/agent EDA as orchestration around existing gates. All generated RTL,
   Tcl, placements, and reports must pass the same lint, simulation, formal,
   STA, DRC, and routed-PPA evidence requirements as hand-written work.
7. Use compiler-autotuning target capture for Autocomp, AccelOpt, V-Seek, and
   formal RISC-V semantics. Do not import generated kernels, reuse optimization
   memories, run models, change binaries, or make kernel/proof claims without
   target adapters, pinned revisions, semantic-equivalence evidence,
   simulator/runtime logs, benchmark replay, and review.
8. Use chiplet/3DIC/package target capture for RapidChiplet, PlaceIT, DiffChip,
   and TDPNavigator-style DSE. Do not generate package topology, placement,
   interposer, bump-map, thermal/SI/PI, simulator, or cost/yield outputs
   without pinned revisions/assets, package stack, power maps, traffic
   manifests, PHY assumptions, reward definitions where applicable, output
   hashes, deterministic replay, and review.
9. Use physical-verification target capture for Rule2DRC, DRC-Coder,
   structural EDA-code verification, OpenDRC, and PostEDA-Bench. Do not
   generate decks, run DRC/LVS/antenna tools, apply repairs, issue waivers, or
   claim signoff without pinned rule/layout/netlist hashes, command schemas,
   generated-output quarantine, before/after tool logs, tool correlation, and
   review.
10. Use HLS/accelerator target capture for MPM-LLM4DSE, TimelyHLS,
    FlexLLM, TAPA/RapidStream, HLSFactory, HLS-Eval, LLM-DSE, iDSE, and
    SECDA-DSE. Do not import models, datasets, HLS libraries, FPGA backends,
    generated directives, generated HLS, or generated RTL without pinned
    revisions, license review, manifests, C-simulation, HLS synthesis, RTL
    simulation, equivalence where applicable, replay, and review.
11. Use power/thermal and low-power target capture for ArchPower, AutoPower,
    Lighter, RTL-OPT, Yosys clock gating, CODMAS/RTLOPT, Prompting for Power,
    POET, RTL PPA SOG, and UPF references. Do not import power datasets,
    train models, run clock-gating plugins, import benchmark tasks, generate
    UPF, or claim power savings without pinned revisions, license review,
    feature maps, calibration labels, equivalence/formal evidence, synthesis,
    STA, CDC/RDC, DFT, power reports, and review.
12. Use memory/interconnect target capture for AI-driven NoC DSE, ArchGym,
    BookSim2, Ramulator2, DRAMsim3, DRAMSys, gem5-Aladdin, and Gem5-AcceSys.
    Do not train NoC inverse models, generate fabric parameters, run external
    simulators, change memory maps, or claim bandwidth/latency/QoS improvements
    without pinned simulator revisions, topology constraints, traffic traces,
    replay logs, local memory-contract gates, RTL feasibility, and review.
13. Use DFT/ATPG target capture for Fault DFT, VeriRAG/LLM4DFT, DeepTPI,
    DEFT, InF-ATPG, LITE scan instrumentation, DRL ATPG, ATPG Toolkit, and
    NN-for-ATPG. Do not insert scan, rank or insert test points, repair RTL
    testability, train RL/GNN ATPG policies, generate patterns, or claim
    coverage without pinned backends, netlist and fault-list hashes, scan
    policy, feature manifests, pattern replay, manufacturing gates, signoff,
    and review.
