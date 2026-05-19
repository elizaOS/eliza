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
