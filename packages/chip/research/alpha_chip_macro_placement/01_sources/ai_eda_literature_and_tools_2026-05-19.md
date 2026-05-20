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
- HWE-Bench: <https://arxiv.org/abs/2604.14709>. Repository-scale hardware bug
  repair benchmark for LLM agents across Verilog/SystemVerilog and Chisel
  projects. E1 status: benchmark-method reference only until assets, licenses,
  task hashes, container hashes, non-overlap review, generated patch
  quarantine, simulator/regression logs, and reviewer disposition exist.
- Phoenix-bench: <https://arxiv.org/abs/2605.15226>. Current hardware-agent
  benchmark emphasizing hierarchy-aware localization, EDA executable
  verification, and maintenance-style patching. E1 status: local-task
  methodology only; no task import or generated patch promotion without
  contamination checks, deterministic gates, and review.
- AuDoPEDA: <https://arxiv.org/abs/2601.06268>. Coding-agent method for
  OpenROAD QoR improvement. E1 status: method-only until OpenROAD/OpenLane
  patch hashes, build/test logs, before/after E1 replay, STA/power/DRC/antenna
  evidence, and reviewer disposition exist.
- OpenROAD MCP: <https://github.com/luarss/openroad-mcp>. Open-source MCP
  server exposing interactive OpenROAD sessions, session history, metrics, and
  report images to AI clients. E1 status: code-review candidate only; do not
  install, start, or connect until revision, license, sandbox/authentication,
  command allowlist, archived tool-call logs, artifact quarantine, and rollback
  policy are accepted.
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
- AutoSizer: <https://arxiv.org/abs/2602.02849>. LLM-agent AMS sizing method
  using an inner sizing loop and an outer reflection/search-space refinement
  loop. E1 status: method-only target capture until objectives, prompt/model
  hashes, search traces, SPICE deck/model provenance, PVT sweeps, generated
  dimension quarantine, and analog review exist.
- EasySize: <https://arxiv.org/abs/2508.05113>. LLM-guided heuristic analog
  sizing method with reported cross-node transfer. E1 status: method-only
  target capture until topology/process mapping, simulator/model hashes, search
  logs, PVT/corner sweeps, extracted-layout replay, and review are pinned.
- Self-calibrating LLM analog sizing equations:
  <https://arxiv.org/abs/2604.07387>. Method for generating topology-specific
  Python sizing equations from raw netlists. E1 status: blocked until equation
  traceability, calibration data, SPICE replay logs, sensitivity reports, PVT
  sweeps, and reviewer disposition exist.
- EEsizer / LLM transistor sizing:
  <https://github.com/eelab-dev/LLM-transistor-sizing>. Code-bearing ngspice
  agent reference for analog sizing. E1 status: code watch source only until
  repository revision, license, dependencies, prompt logs, ngspice decks,
  simulator outputs, PVT sweeps, generated dimension quarantine, and analog
  review are pinned.
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
- Analog layout VLM dataset:
  <https://huggingface.co/datasets/anonymousUser2/Analog_Dataset_VLM>. Code and
  dataset archive for analog layout visual QA and component recognition. E1
  status: dataset-governance only until exact snapshot, license, synthetic-data
  boundary review, split manifests, local label mapping, overlap checks, and
  reviewer disposition exist.
- OmniSch: <https://arxiv.org/abs/2604.00270>. Multimodal PCB schematic
  benchmark for structured diagram reasoning. E1 status: benchmark watch source
  only until exact dataset snapshot, license, E1 image/prompt non-overlap, and
  KiCad/package follow-up gates exist.
- Circuitron: <https://github.com/Shaurya-Sethi/circuitron>. Code-bearing
  agentic KiCad schematic/netlist/PCB generation reference with RAG. E1 status:
  code watch source only until revisions, dependencies, license, prompt/output
  quarantine, ERC/DRC/fab logs, package cross-probe, and review are pinned.
- MARS-Place:
  <https://www.sciencedirect.com/science/article/pii/S016792602600026X>.
  PCB placement/routing optimization method. E1 status: paper-only target
  capture until code/assets, board-rule hashes, routed output hashes, SI/PI,
  DFM, and manufacturing review exist.
- DreamerV3+FR PCB autorouting:
  <https://www.sciencedirect.com/science/article/abs/pii/S0957417426003374>.
  World-model RL around FreeRouting for PCB autorouting. E1 status: paper-only
  target capture until policy/seed manifests, FreeRouting revision, board-rule
  hashes, route reports, SI/PI, and manufacturing evidence exist.
- 3D LineExplore: <https://www.nature.com/articles/s41598-026-36925-0>.
  Multilayer PCB geometric routing method. E1 status: deterministic routing
  literature context only until route-output quarantine, ERC/DRC, SI/PI, DFM,
  and fabrication evidence exist.
- LLM4SecHW OSHD:
  <https://huggingface.co/datasets/KSU-HW-SEC/LLM4SecHW-OSHD>. Open-source
  hardware-debug dataset paired with the LLM4SecHW workflow. E1 status:
  quarantined dataset candidate only until exact revision, license,
  source-project provenance, overlap/contamination review, and generated-output
  isolation exist.
- riscvISACOV: <https://github.com/riscv-verification/riscvISACOV>. Open
  RISC-V ISA functional coverage library. E1 status: coverage watch source only
  until revision, license, ISA/profile mapping, RVVI adapter hashes, coverage
  database replay, and gap review exist.
- Lyra: <https://arxiv.org/abs/2512.13686>. ISA-aware generative RISC-V
  processor fuzzing with FPGA acceleration. E1 status: method-only until code,
  model/generator assets, seeds, legality checks, FPGA bitstreams, coverage
  logs, differential failures, and replay evidence exist.
- FERIVer: <https://arxiv.org/abs/2504.05284>. FPGA-assisted RISC-V RTL
  verification with ISS-style reference comparison. E1 status: method-only
  until implementation assets, FPGA board/bitstream hashes, DUT/ISS revisions,
  checkpoint logs, and review are available.
- Spacely: <https://arxiv.org/abs/2406.15181> and
  <https://github.com/SpacelyProject/spacely-docs>. Open lab-validation
  framework for ASIC test automation. E1 status: lab-flow watch only until
  board/silicon identity, instrument inventory, waveform-to-stimulus hashes,
  command logs, raw captures, hardware-action authorization, and review exist.
- OpenXRAM: <https://github.com/RIOSMPW/OpenXRAM>. Open memory-compiler watch
  source for SRAM plus emerging RRAM/MRAM directions. E1 status: compiler
  watch only until revision, license, PDK/device support, generated collateral,
  DRC/LVS/extraction, STA, OpenLane, and review evidence exist.
- OpenRRAM: <https://arxiv.org/abs/2111.05463> and
  <https://github.com/akashlevy/OpenRRAM>. Open RRAM compiler reference derived
  from OpenRAM. E1 status: research-only until authorized device/process models,
  generated collateral, reliability evidence, and reviewer disposition exist.
- OpenACM/OpenACMv2: <https://arxiv.org/abs/2601.11292>,
  <https://arxiv.org/abs/2603.13042>, and
  <https://github.com/ShenShan123/OpenACM>. Open SRAM approximate
  compute-in-memory compiler and accuracy-constrained co-optimization
  framework. E1 status: CIM watch only until architecture, workload accuracy,
  surrogate-model provenance, PVT/variation, generated collateral,
  OpenROAD/OpenLane replay, and review gates exist.
- OpenYield: <https://arxiv.org/abs/2508.04106> and
  <https://github.com/ShenShan123/OpenYield>. Open SRAM yield analysis and
  optimization benchmark suite. E1 status: benchmark watch only until revision,
  license, process/model compatibility, train/test split, Monte Carlo replay,
  local macro-test evidence, and review are captured.
- CircuitMind / TC-Bench: <https://arxiv.org/abs/2504.14625> and
  <https://github.com/BUAA-CLab/CircuitMind>. Multi-agent gate-level generation
  framework and benchmark using syntax locking, RAG, and dual correctness plus
  efficiency rewards. E1 status: metadata-only until repository revision,
  model/data manifests, TC-Bench license and overlap review, RAG traces,
  generated-output quarantine, local lint/sim/synth/formal replay, and review
  are captured.
- QiMeng-CRUX: <https://arxiv.org/abs/2511.20099>,
  <https://github.com/Taskii-Lei/QiMeng-CRUX-V>, and
  <https://huggingface.co/Taskii/QiMeng-CRUX-V>. Constrained
  natural-language-to-Verilog model path through a core refined representation.
  E1 status: metadata-only until exact code/model revisions, model-card terms,
  base-model license, prompt/output hashes, benchmark overlap, local
  lint/sim/synth/formal replay, generated-output quarantine, and review are
  captured.
- QiMeng-SALV: <https://arxiv.org/abs/2510.19296>,
  <https://github.com/QiMeng-IPRC/QiMeng-SALV>, and
  <https://huggingface.co/TabCanNotTab/SALV-Qwen2.5-Coder-7B-Instruct>.
  Signal-aware Verilog generation using verification feedback and
  partial-correctness segments. E1 status: metadata-only until exact code/model
  revisions, model-card and base-model license, reward definitions,
  prompt/output hashes, benchmark overlap, local lint/sim/synth/formal replay,
  generated-output quarantine, and review are captured.
- HYPERHEURIST: <https://arxiv.org/abs/2604.15642>. Simulated-annealing
  controller for LLM-generated RTL candidates that filters candidates through
  compilation, structural checks, and simulation before PPA optimization. E1
  status: paper-only until assets, prompts, seeds, candidate hashes,
  compile/simulation logs, equivalence, before/after PPA replay, and review are
  captured.
- Multi-Agent Self-Evolved ABC: <https://arxiv.org/abs/2604.15082>. Current
  agentic logic-synthesis direction that evolves ABC source under compile,
  correctness, and QoR feedback. E1 status: paper-only until evolved-code
  assets, base ABC revision, benchmark hashes, correctness/equivalence logs,
  Yosys/OpenLane integration evidence, QoR replay, and review are captured.
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
- VerilogLAVD: <https://arxiv.org/abs/2508.13092>. LLM-aided Verilog CWE rule
  generation reference; method-only for E1 until rule hashes, taxonomy mapping,
  parser versions, alert logs, false-positive review, deterministic
  formal/simulation follow-up, and human security signoff exist.
- TrojanLoC: <https://arxiv.org/abs/2512.00591>. LLM-based line-level RTL
  Trojan localization reference with TrojanInS dataset claims; blocked until
  assets, labels, and local evidence are reviewed.
- HardSecBench: <https://arxiv.org/abs/2601.13864>. Secure hardware/firmware
  generation benchmark reference; blocked until code/data release, licenses,
  task hashes, E1 non-overlap, CWE mapping, generated artifact quarantine,
  deterministic checks, and reviewer disposition exist.
- HarmChip: <https://arxiv.org/abs/2604.17093>. Hardware-security LLM jailbreak
  benchmark; dual-use prompts must stay quarantined and out of release
  evidence.
- Trojan explainability comparison: <https://arxiv.org/abs/2601.18696>.
  Useful criteria for reviewable security findings, especially circuit-aware
  features versus opaque attribution scores.
- NETLAM: <https://github.com/shubhishukla10/NETLAM>. LLM-based stealthy
  hardware Trojan generation framework; dual-use watch only, with no clone, run,
  output import, or detector claim without explicit approval, sandboxing,
  no-source-import boundaries, artifact quarantine, and human review.
- Hardware Vulnerability Dataset:
  <https://github.com/shamstarekargho/Hardware-Vulnerability-Dataset>. Prompt
  dataset for hardware vulnerability work; dataset-governance only until exact
  revision, license, taxonomy mapping, E1 overlap scan, prompt privacy, split
  manifests, and reviewer disposition are captured.
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
- CapBench: <https://arxiv.org/abs/2604.11202> and
  <https://github.com/THU-numbda/CapBench>. Current code/data benchmark for
  ML-based post-layout capacitance extraction across ASAP7, NanGate45, and
  Sky130HD. E1 status: dataset/code-review reference only until revision,
  license, cache quarantine, E1 non-overlap, local extracted-label splits,
  error reports, STA impact replay, and reviewer disposition exist.
- DeepRWCap: <https://arxiv.org/abs/2511.06831>. Neural-guided random-walk
  capacitance solver method. E1 status: method reference only until code/model
  assets, process-stack inputs, local OpenRCX/Magic/field-solver labels,
  coupling/total capacitance error reports, and STA/SI replay are pinned.
- NAS-Cap: <https://arxiv.org/abs/2408.13195>. Neural architecture search
  approach for 3D capacitance extraction models. E1 status: paper-only target
  capture until architecture/search-space hashes, data provenance, seeds,
  held-out E1 labels, runtime/error analysis, and signoff review exist.
- Capacitance extraction via ML for interconnect geometry exploration:
  <https://gtcad.gatech.edu/www/papers/Tsai-ICCAD25.pdf>. ICCAD 2025 method
  for encoding ITF/process-parameter variation into ML capacitance models. E1
  status: DTCO research context only until authorized process-stack inputs,
  pattern extraction hashes, before/after extraction and STA replay, and
  foundry/process review exist.
- GEM GPU RTL simulator: <https://github.com/NVlabs/GEM> and
  <https://yibolin.com/publications/papers/SIM_DAC2025_Guo.pdf>. Open CUDA
  RTL logic simulator and DAC 2025 method for emulator-inspired acceleration.
  E1 status: backend watchlist only until revision, license, CUDA/GPU version,
  supported SystemVerilog subset, generated netlist hashes, waveform/coverage
  correlation against local Verilator/cocotb, speedup replay, and review are
  captured.
- RTLflow: <https://github.com/dian-lun-lin/RTLflow> and
  <https://tsung-wei-huang.github.io/papers/icpp22-rtlflow.pdf>. GPU flow for
  RTL simulation with batch stimulus. E1 status: method reference only until
  revision, license, Verilator/CUDA versions, batch-stimulus manifest,
  waveform/result equivalence, speedup replay, and review exist.
- FireSim: <https://github.com/firesim/firesim>. FPGA-accelerated full-system
  hardware simulation platform. E1 status: backend watchlist only until target
  FPGA inventory, generated collateral hashes, workload transcripts, RTL/source
  equivalence plan, and review exist.
- Verion EDA: <https://verion-eda.com/>. Commercial GPU RTL simulation platform
  positioned for fast agentic feedback loops with waveforms, coverage, and
  debug traces. E1 status: commercial watchlist only until terms, data-handling,
  exact tool version, local replay, waveform/coverage comparison, and review
  exist.
- Copra cocotb stubs: <https://github.com/cocotb/copra> and
  <https://www.cocotb.org/2025/09/09/introducing-copra.html>. Cocotb DUT type
  stub generation for IDE/static checking. E1 status: optional verification
  ergonomics only until cocotb version, generated stub hashes, type-check logs,
  source-control policy, and review are captured.
- AutoBench: <https://arxiv.org/abs/2407.03891> and
  <https://github.com/AutoBench/AutoBench>. LLM HDL testbench generation
  baseline. E1 status: method reference only until prompt/model logs, generated
  testbench quarantine, simulator logs, mutation/coverage evidence, and review
  exist.
- Project Ava: <https://projectava.dev/>. Current cocotb-agent pattern for
  cocotb 2.0 repair, structured simulator failure taxonomy, and mutation
  testing. E1 status: method reference only until repository/license,
  generated-test quarantine, mutation manifests, local replay, and review exist.
- HAVEN UVM: <https://arxiv.org/abs/2604.27643> and
  <https://huggingface.co/datasets/mcc311/haven-hdl-benchmark>. Recent
  LLM-assisted UVM testbench synthesis method and open-IP benchmark. E1 status:
  benchmark/method reference only until exact assets, license, simulator
  availability, coverage logs, cocotb/formal correlation, and review exist.
- VerilogCoder: <https://github.com/NVlabs/VerilogCoder>. Autonomous Verilog
  agent with graph planning and AST-based waveform tracing. E1 status: blocked
  debug/rewrite context only until prompt/model logs, waveform parser hashes,
  generated RTL quarantine, simulator logs, equivalence/formal/synthesis gates,
  and review exist.
- MPM-LLM4DSE: <https://arxiv.org/abs/2601.04801> and
  <https://github.com/wslcccc/MPM-LLM4DSE>. Multimodal model and LLM-guided
  HLS DSE candidate with code/model/data assets. E1 status: metadata-only
  until exact revisions, licenses, model manifests, dataset provenance,
  benchmark overlap, replay logs, and reviewer disposition are pinned.
- HLStrans: <https://arxiv.org/abs/2507.04315> and
  <https://huggingface.co/datasets/qingyun777yes/HLStrans>. Large paired
  C/HLS transformation dataset with testbench and synthesis-label context. E1
  status: metadata-only until exact dataset snapshot, license, source-program
  provenance, split, benchmark-overlap review, HLS tool mapping, replay logs,
  and reviewer disposition are pinned.
- SAGE-HLS: <https://arxiv.org/abs/2508.03558> and
  <https://huggingface.co/datasets/mashnoor/hls-ast-sagehls>. AST-guided HLS
  code-generation method/dataset built around Verilog-to-C/C++ porting and
  HLS evaluation. E1 status: metadata-only until model/dataset revisions,
  base-model and license review, AST prompt/output hashes, benchmark-overlap
  review, generated HLS quarantine, and local HLS replay gates exist.
- Bench4HLS: <https://arxiv.org/abs/2601.19941> and
  <https://github.com/zfsadik/Bench4HLS>. End-to-end LLM HLS benchmark covering
  compilation, functional simulation, HLS synthesis feasibility, and PPA hooks.
  E1 status: benchmark reference only until exact tasks, license, tool versions,
  prompt/output logs, overlap review, replay logs, and review are captured.
- ForgeHLS: <https://arxiv.org/abs/2507.03255> and
  <https://github.com/zedong-peng/ForgeHLS>. Large open HLS dataset for QoR
  prediction and automated pragma exploration. E1 status: metadata-only until
  snapshot, splits, license, feature extraction, local calibration labels, and
  QoR error analysis are reviewed.
- DiffHLS: <https://arxiv.org/abs/2604.09240>. Differential HLS QoR prediction
  using kernel/design IR graphs plus pretrained code embeddings. E1 status:
  paper-only until implementation, embedding-model license, training data,
  feature extraction, held-out E1 calibration labels, synthesis replay, and
  review exist.
- HLS-Seek: <https://arxiv.org/abs/2605.13536>. Very recent QoR-aware
  NL-to-HLS generation method using comparative proxy rewards and selective
  real HLS synthesis for low-confidence candidates. E1 status: paper-only until
  code/model/reward assets, proxy uncertainty policy, prompt/output hashes,
  synthesis-switch logs, generated HLS quarantine, replay, and review exist.
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
- ScaleHLS: <https://github.com/hanchenye/scalehls>. MLIR/CIRCT-style HLS
  compiler infrastructure for dataflow and accelerator transforms. E1 status:
  infrastructure watchlist only until revision, license, backend, generated-IR
  quarantine, C-sim, HLS synthesis, RTL checks, QoR replay, and review exist.
- AutoDSE: <https://github.com/UCLA-VAST/AutoDSE>. ML-assisted HLS
  design-space exploration baseline for pragma/search policies. E1 status:
  blocked until benchmark subset, toolchain, search manifests, generated
  artifacts, QoR replay, and reviewer disposition are pinned.
- AI4DSE: <https://arxiv.org/abs/2411.10065>. LLM plus multi-heuristic HLS DSE
  method reference. E1 status: paper-only until prompts, models, heuristics,
  tool versions, explored configurations, and local replay evidence exist.
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
- PowerNet: <https://arxiv.org/abs/2004.04026>. Transferable dynamic IR-drop
  prediction method. E1 status: method-only until vector/activity provenance,
  dynamic signoff labels, held-out E1 transfer/error analysis, and review
  exist.
- MAVIREC: <https://arxiv.org/abs/2212.09129>. Vectorless dynamic IR-drop
  prediction method. E1 status: method-only until vectorless assumptions,
  dynamic-label replay, temporal uncertainty, and signoff review are captured.
- PDNNet: <https://arxiv.org/abs/2403.18570>. PDN-aware dynamic IR-drop
  prediction method using graph and layout context. E1 status: method-only
  until PDN graph extraction, dynamic labels, held-out error analysis, and PD
  review exist.
- DuST-IRdrop: <https://github.com/cuhk-eda/DuST-IRdrop>. Code-bearing
  dynamic IR-drop prediction candidate using diffusion/transformer-style
  modeling. E1 status: code watch source only until revision, license,
  dependencies, data provenance, prediction quarantine, dynamic labels, and
  signoff replay are reviewed.
- Accellera CDC/RDC draft 0.5 public review:
  <https://www.accellera.org/news/press-releases/accellera-releases-cdc-rdc-public-review-draft>.
  Current standardization checkpoint for vendor-neutral CDC/RDC intent. E1
  status: standards watch only until final revision, terms, local tool mapping,
  waiver policy, and deterministic report evidence exist.
- Arch AI-native HDL: <https://arxiv.org/abs/2604.05983>. Typed clock/reset
  and interface methodology for AI-native HDL. E1 status: method-only until an
  implementation, generated-intent quarantine, equivalence, formal/cocotb, and
  CDC/RDC report comparisons exist.
- Sparkle Lean HDL: <https://github.com/Verilean/sparkle>. Code-bearing
  proof-oriented HDL with clock and multi-clock simulation concepts. E1 status:
  code watch only until revision, license, subset mapping, translated-artifact
  quarantine, proof logs, RTL/cocotb equivalence, and CDC/RDC review exist.
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
- Spec2RTL-Agent: <https://arxiv.org/abs/2506.13905>. Multi-agent method for
  complex specification understanding, staged code generation, and reflection,
  using synthesizable C++/HLS rather than direct one-shot RTL. E1 status:
  methodology-only target capture until prompt quarantine, HLS backend
  revisions, generated C++/RTL quarantine, C-sim, HLS synthesis, RTL
  simulation, synthesis/equivalence, and review are available.
- RTLocating / EvoRTL-Bench: <https://arxiv.org/abs/2603.00434>. Current
  intent-aware RTL localization method and benchmark for mapping natural
  language change requests to affected RTL blocks. E1 status: paper-only target
  capture until assets, license and contamination review, E1 RTL block indexes,
  dependency graphs, localization confidence reports, non-regression evidence,
  and architecture review are available.
- VERT: <https://github.com/AnandMenon12/VERT> and
  <https://arxiv.org/abs/2503.08923>. Code-bearing SystemVerilog assertion
  dataset for LLM-assisted SVA generation. E1 status: dataset watch source only
  until exact revision, license, file manifest, overlap scan, generated
  assertion quarantine, vacuity review, formal/simulation logs, and human
  disposition are pinned.
- STELLAR: <https://arxiv.org/abs/2601.19903>. Structure-guided assertion
  retrieval and generation method using RTL structural fingerprints and
  relevant RTL/SVA pairs. E1 status: method-only target capture until AST
  parser/fingerprint hashes, retrieval-corpus provenance, prompt/output logs,
  generated SVA quarantine, formal/simulation logs, vacuity review, and human
  disposition exist.
- ProofLoop: <https://arxiv.org/abs/2604.23100>. Tool-augmented ReAct agent for
  natural-language-to-SVA generation with retrieval and solver feedback. E1
  status: method-only target capture until formal-tool licensing, query logs,
  proof/counterexample replay, generated SVA quarantine, vacuity and
  over-constraint checks, and review exist.
- VeriDebug: <https://arxiv.org/abs/2504.19099>,
  <https://github.com/CatIIIIIIII/VeriDebug>,
  <https://huggingface.co/LLM-EDA/VeriDebug>, and
  <https://huggingface.co/datasets/LLM-EDA/BuggyVerilog>. Code/model/dataset
  candidate for Verilog buggy-line retrieval, bug-type classification, and
  guided repair. E1 status: debug-model watch source only until exact
  revisions, licenses, base-model review, overlap scan, prompt/embedding logs,
  patch quarantine, deterministic lint/simulation/formal/synthesis/equivalence
  replay, and reviewer disposition are pinned.
- AI-driven NoC DSE: <https://arxiv.org/abs/2512.07877>. Current inverse-ML
  NoC design-space exploration method using BookSim-generated data and MLP,
  CVAE, and conditional-diffusion models for topology/parameter prediction.
  E1 status: paper-only target capture until code/assets, dataset-generation
  manifests, topology constraints, traffic traces, BookSim replay logs,
  train/test splits, and architecture/PD review are available.
- NOCTOPUS: <https://link.springer.com/article/10.1007/s00521-026-12049-4>.
  Current GNN and human-in-the-loop NoC topology optimization method using
  simulator-generated SoC/NoC metrics. E1 status: paper-only target capture
  until topology constraints, traffic traces, simulator replay logs, training
  manifests, and architecture/PD review are available.
- FlooNoC: <https://github.com/pulp-platform/FlooNoC>. Open-source AXI-oriented
  NoC IP and generator reference. E1 status: code-bearing watch source only
  until revision/license review, generated-RTL quarantine, config hashes,
  memory-map/coherency/QoS contracts, replay, formal/cocotb, synthesis, and PD
  review exist.
- MICSim: <https://github.com/MICSim-official/MICSim_V1.0>. Open-source
  mixed-signal compute-in-memory simulator for AI accelerator studies. E1
  status: simulator watch source only until workload/model hashes, array/cell
  assumptions, quantization, calibration, power/thermal evidence, and
  architecture review are pinned.
- AutoNoC: <https://doi.org/10.1109/ACCESS.2026.3650973>. Paper-level automated
  NoC generation framework for FPGA-oriented Verilog fabrics. E1 status:
  literature target capture until code/assets, FPGA-to-ASIC assumption split,
  generated-RTL quarantine, simulator replay, and fabric review exist.
- Photonic-aware DRL NoC routing: <https://doi.org/10.3390/ai7020065>.
  Paper-level decentralized DRL routing method for hybrid electronic/photonic
  NoCs. E1 status: long-horizon literature context only until photonic device,
  package, thermal, optical-link availability, route-safety, and replay models
  exist.
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
10. Use HLS/accelerator target capture for MPM-LLM4DSE, HLStrans, SAGE-HLS,
    Bench4HLS, ForgeHLS, DiffHLS, HLS-Seek, TimelyHLS, FlexLLM,
    TAPA/RapidStream, HLSFactory, HLS-Eval, LLM-DSE, iDSE, SECDA-DSE,
    ScaleHLS, AutoDSE, and AI4DSE. Do not import models, datasets, HLS
    libraries, compiler infrastructure, DSE frameworks, FPGA backends,
    generated directives, generated HLS, generated IR, or generated RTL without
    pinned revisions, license review, manifests, benchmark-overlap review,
    C-simulation, HLS synthesis, RTL simulation, equivalence where applicable,
    QoR replay/error analysis, and review.
11. Use power/thermal and low-power target capture for ArchPower, AutoPower,
    PowerNet, MAVIREC, PDNNet, DuST-IRdrop, Lighter, RTL-OPT, Yosys clock
    gating, CODMAS/RTLOPT, Prompting for Power, POET, RTL PPA SOG, SymRTLO,
    PowerGear, and UPF references. Do not import power datasets, train models,
    run clock-gating plugins, import benchmark tasks, generate UPF, generate
    IR-drop maps, generate RTL rewrites, import HLS power labels, or claim
    power savings without pinned revisions, license review, feature maps,
    vector/activity provenance, dynamic-label replay, calibration labels,
    equivalence/formal evidence, synthesis, STA, CDC/RDC, DFT, power reports,
    held-out error analysis, and review.
12. Use memory/interconnect target capture for AI-driven NoC DSE, NOCTOPUS,
    FlooNoC, MICSim, AutoNoC, photonic-aware DRL routing, ArchGym, BookSim2,
    Ramulator2, DRAMsim3, DRAMSys, gem5-Aladdin, and Gem5-AcceSys. Do not train
    NoC inverse models, generate fabric parameters or RTL, run external
    simulators, change memory maps, model CIM, or claim
    bandwidth/latency/QoS/routing improvements without pinned simulator
    revisions, topology constraints, traffic traces, replay logs, local
    memory-contract gates, RTL feasibility, calibration assumptions, and review.
13. Use DFT/ATPG target capture for Fault DFT, VeriRAG/LLM4DFT, DeepTPI,
    DEFT, InF-ATPG, LITE scan instrumentation, DRL ATPG, ATPG Toolkit, and
    NN-for-ATPG. Do not insert scan, rank or insert test points, repair RTL
    testability, train RL/GNN ATPG policies, generate patterns, or claim
    coverage without pinned backends, netlist and fault-list hashes, scan
    policy, feature manifests, pattern replay, manufacturing gates, signoff,
    and review.
