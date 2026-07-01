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
- SCALE-Sim: <https://github.com/scalesim-project/scale-sim-v2>. Systolic-
  array DNN accelerator simulator for dataflow, cycle, and SRAM-traffic
  studies. E1 status: backend watch only until revision, dependency/license,
  architecture config, workload tensor, SRAM/banking assumptions, output
  hashes, calibration, and reviewer disposition exist.

## Agent and LLM-assisted EDA

- ORFS-agent: <https://vlsicad.ucsd.edu/Publications/Conferences/417/c417.pdf>.
  Agentic OpenROAD-flow optimization reference.
- MCP4EDA: <https://arxiv.org/abs/2507.19570>. Prototype for exposing Yosys,
  OpenLane, KLayout, and OpenROAD to agent-callable interfaces.
- AutoEDA: <https://arxiv.org/abs/2508.01012> and reported repository
  <https://github.com/AndyLu666/MCP-EDA-Server>. Multi-tool MCP-style EDA
  agent flow; the reported repository is currently treated as unavailable until
  it can be fetched and pinned. E1 status: metadata/reference only; any future
  Yosys, OpenROAD/OpenLane, KLayout, Magic, Netgen, simulator, DRC, or LVS
  service call needs revision, license, authentication, service allowlist,
  command schema, request/response logs, artifact hashes, deterministic replay,
  and reviewer approval.
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
- EDA-MCP Server: <https://github.com/SaeronLab/eda-mcp>. Concrete MCP server
  candidate for exposing EDA operations to AI clients. E1 status:
  code-review candidate only; do not install, start, or route E1 files through
  it until revision, dependency, authentication, command-allowlist, read/write
  scope, log-retention, artifact quarantine, rollback, and review policy exist.
- OpenROAD MCP: <https://github.com/luarss/openroad-mcp>. Open-source MCP
  server exposing interactive OpenROAD sessions, session history, metrics, and
  report images to AI clients. E1 status: code-review candidate only; do not
  install, start, or connect until revision, license, sandbox/authentication,
  command allowlist, archived tool-call logs, artifact quarantine, and rollback
  policy are accepted.
- FluxEDA: <https://arxiv.org/abs/2603.25243>. Stateful EDA-agent method using
  persistent context, skills, and MCP-style tool access. E1 status:
  orchestration-pattern reference only until memory snapshots, redaction,
  skill revisions, tool-call logs, deterministic replay, and reviewer
  disposition are defined.
- PostEDA-Bench: <https://arxiv.org/abs/2605.06936>. Benchmark direction for
  post-EDA agents that attempt physical-design repair and PPA improvement. E1
  status: benchmark-method reference only until assets, licenses, non-overlap,
  generated-output quarantine, DRC/PPA/signoff replay, and review exist.
- EDA-Schema-V2: <https://arxiv.org/abs/2605.06952>. Structured schema
  reference for EDA agent states, tasks, and artifacts. E1 status:
  schema-governance reference only until provenance, redaction, local artifact
  mapping, compatibility checks, and review exist.
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
- VeriGen: <https://arxiv.org/abs/2308.00708>,
  <https://github.com/shailja-thakur/VGen>,
  <https://huggingface.co/shailja/fine-tuned-codegen-2B-Verilog>, and
  <https://huggingface.co/datasets/shailja/Verilog_GitHub>. Verilog-specialized
  CodeGen checkpoints and corpus. E1 status: metadata-only until model,
  dataset, license, contamination, generated-output quarantine, and local
  lint/simulation/synthesis review gates exist.
- OriGen: <https://arxiv.org/abs/2407.16237>,
  <https://github.com/pku-liang/OriGen>,
  <https://huggingface.co/henryen/OriGen>, and
  <https://huggingface.co/datasets/henryen/origen_dataset_instruction>. Verilog
  LoRA generation and syntax-fix flow. E1 status: blocked until code/model/
  dataset revisions, base-model terms, GPL review, overlap checks, repair-delta
  evidence, and local gates are pinned.
- VeriReason: <https://arxiv.org/abs/2505.11849>,
  <https://github.com/NellyW8/VeriReason>, and
  <https://huggingface.co/Nellyw888/VeriReason-codeLlama-7b-RTLCoder-Verilog-GRPO-reasoning-tb>.
  Reasoning/RL Verilog model family with testbench feedback. E1 status:
  blocked until checkpoint, reward/testbench, contamination, generated-output,
  lint/simulation/synthesis/formal, and reviewer evidence exist.
- DeepV: <https://arxiv.org/abs/2510.05327> and
  <https://huggingface.co/spaces/FICS-LLM/DeepV>. Hosted RAG Verilog generation
  workflow. E1 status: hosted-space method reference only until data-handling,
  retrieval-corpus, prompt/output, replay, contamination, and review gates
  exist.
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
- iScript: <https://arxiv.org/abs/2603.04476>. Physical-design Tcl generation
  method and benchmark around a domain-adapted Qwen3-8B workflow; blocked until
  model/data/code assets, command-reference provenance, generated-script
  quarantine, syntax/semantic review, commercial-tool data handling, local
  replay logs, and signoff evidence exist.
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
- ngspice: <https://ngspice.sourceforge.io/>. Open SPICE simulator and primary
  deterministic replay candidate for future E1 analog-agent, generated-SPICE,
  pad, IO, and extracted-netlist work. E1 status: backend watch only until
  exact simulator revision, PDK/model hashes, deck hashes, command lines, raw
  outputs, convergence logs, PVT/corner manifests, and analog review exist.
- PySpice: <https://github.com/PySpice-org/PySpice>. Python orchestration layer
  for ngspice-style replay and SPICE-generation benchmarks. E1 status:
  wrapper watch only until Python environment, ngspice revision, deck hashes,
  generated-script quarantine, output hashes, and reviewer disposition exist.
- Xyce: <https://github.com/Xyce/Xyce>. Parallel electronic simulator for
  larger circuit replay and cross-simulator triage. E1 status: simulator watch
  only until model/deck compatibility, solver options, raw outputs,
  convergence logs, and analog review are captured.
- OpenVAF: <https://github.com/pascalkuthe/OpenVAF>. Open Verilog-A compiler
  for compact-model integration into open SPICE flows. E1 status: model-
  compiler watch only until model license/process authority, compiler revision,
  generated module hashes, simulator compatibility, and replay logs exist.
- BAG3++ / Berkeley Analog Generator:
  <https://bag3-readthedocs.readthedocs.io/> and
  <https://github.com/bluecheetah/bag>. Deterministic generator framework for
  parameterized schematic/layout/simulation flows. E1 status: backend watch
  only until technology plugins, PDK/model hashes, generated-output hashes,
  DRC/LVS/extraction, PVT replay, and analog review are pinned.
- OpenFASOC: <https://github.com/idea-fasoc/OpenFASOC>. Open analog/mixed-
  signal generator flow for template-based macros in open PDK/OpenROAD
  contexts. E1 status: no generated macro/netlist/GDS/model import until specs,
  revisions, PDK provenance, SPICE, DRC/LVS, extraction, package/SI-PI mapping,
  and review exist.
- laygo2: <https://github.com/niftylab/laygo2>. Analog layout-template
  generator. E1 status: blocked until technology-template provenance, source
  netlist/spec hashes, generated-layout hashes, rule decks, DRC/LVS,
  extraction, parasitic-aware SPICE replay, and layout review exist.
- MAGICAL: <https://github.com/magical-eda/MAGICAL>. Analog layout automation
  baseline for placement/routing/constraint-generation comparisons. E1 status:
  blocked until benchmark/input hashes, process/rule provenance, generated
  layout and constraint hashes, DRC/LVS/extraction, SPICE replay, and review
  exist.
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
- Analog SPICE Circuits on SKY130:
  <https://huggingface.co/datasets/pphilip/analog-circuits-sky130>. Public
  SKY130/ngspice-style analog circuit corpus; E1 status: dataset-governance
  only until exact revision, license, PDK/tool provenance, split/non-overlap
  review, and replay policy are captured.
- SPICEPilot: <https://arxiv.org/abs/2410.20553> and
  <https://github.com/ACADLab/SPICEPilot>. Benchmark framework for LLM SPICE
  generation and simulation-oriented evaluation; E1 status: benchmark-method
  reference only until code/data license, PySpice/ngspice provenance, prompt
  logs, generated-SPICE quarantine, and reviewer disposition exist.
- AnalogSeeker: <https://arxiv.org/abs/2508.10409>,
  <https://huggingface.co/analogllm/analog_model>, and
  <https://huggingface.co/datasets/analogllm/analog_data>. Analog-domain model
  and corpus watch source; E1 status: no download, inference, or fine-tuning
  until base-model license, corpus contamination, split/overlap, evaluation,
  and reviewer evidence exist.
- OmniSch: <https://arxiv.org/abs/2604.00270>. Multimodal PCB schematic
  benchmark for structured diagram reasoning. E1 status: benchmark watch source
  only until exact dataset snapshot, license, E1 image/prompt non-overlap, and
  KiCad/package follow-up gates exist.
- Circuitron: <https://github.com/Shaurya-Sethi/circuitron>. Code-bearing
  agentic KiCad schematic/netlist/PCB generation reference with RAG. E1 status:
  code watch source only until revisions, dependencies, license, prompt/output
  quarantine, ERC/DRC/fab logs, package cross-probe, and review are pinned.
- KiCad: <https://gitlab.com/kicad/code/kicad>. Deterministic open PCB EDA
  backend for schematic, PCB, ERC/DRC, and manufacturing-output replay. E1
  status: backend watch only until exact tool revision, project/library hashes,
  ERC/DRC logs, BOM/fab output hashes, package cross-probe, and reviewer
  disposition exist.
- KiBot: <https://github.com/INTI-CMNB/KiBot>. KiCad automation backend for
  reproducible ERC/DRC/BOM/Gerber/position outputs. E1 status: export watch
  only until KiBot/KiCad revisions, config hashes, input project hashes, output
  artifact hashes, logs, fab/BOM review, and reviewer disposition exist.
- KiKit: <https://github.com/yaqwsx/KiKit>. KiCad panelization and fabrication
  automation backend. E1 status: export watch only until tool/KiCad revisions,
  panelization config hashes, generated panel/Gerber/drill/BOM/position hashes,
  manufacturer constraints, DRC/ERC logs, and review are pinned.
- InteractiveHtmlBom:
  <https://github.com/openscopeproject/InteractiveHtmlBom>. Interactive
  assembly BOM exporter. E1 status: assembly-output watch only until BOM field
  policy, placement hashes, generated HTML/BOM hashes, visual review logs, and
  manufacturing disposition exist.
- KiCad StepUp: <https://github.com/easyw/kicadStepUpMod>. ECAD/MCAD exchange
  tool for KiCad and FreeCAD. E1 status: mechanical-integration watch only
  until 3D model provenance, STEP/VRML hashes, clearance reports, package
  cross-probe evidence, and mechanical review exist.
- KiCad JLCPCB Tools: <https://github.com/Bouni/kicad-jlcpcb-tools>. Vendor
  BOM/CPL export reference. E1 status: vendor-output watch only until field
  mapping, part-number provenance, BOM/CPL hashes, placement validation,
  sourcing review, and manufacturing disposition exist.
- Circuit Weaver: <https://circuit-weaver.com/>. AI-assisted structured KiCad
  generation framework with design-IR, validation, placement, DFM, and
  manufacturing-export concepts. E1 status: code/package watch only until exact
  revisions, dependencies, model/provider manifests, prompts, generated-output
  quarantine, ERC/DRC/DFM/SI/PI evidence, and review are pinned.
- KiCad MCP Pro: <https://github.com/oaslananka/kicad-mcp-pro>. Write-capable
  KiCad MCP server reference for AI-agent inspection, editing, validation,
  simulation, DFM/SI/PI, and manufacturing-export surfaces. E1 status: no MCP
  connection or write action until tool schemas, allowlists, sandbox/auth
  policy, command logs, KiCad evidence, and human review are accepted.
- Antmicro KiCad SI Wrapper:
  <https://github.com/antmicro/kicad-si-simulation-wrapper>. Deterministic
  KiCad trace-slicing and OpenEMS/gerber2ems preprocessing reference. E1
  status: simulation-preprocessor watch only until exact revisions, stackup,
  selected-net/port manifests, generated-slice hashes, simulation logs, SI/PI
  comparison evidence, and review exist.
- openEMS: <https://github.com/thliebig/openEMS>. Open electromagnetic field
  solver candidate for board/package SI replay. E1 status: solver watch only
  until revision, stackup/material/port manifests, mesh and geometry hashes,
  solver logs, result hashes, comparison evidence, and review exist.
- gerber2ems: <https://github.com/antmicro/gerber2ems>. Gerber-to-openEMS
  preprocessing backend. E1 status: preprocessor watch only until input
  Gerber/drill/stackup hashes, generated geometry and deck hashes, openEMS
  logs, and reviewer disposition are captured.
- Open Schematics: <https://huggingface.co/datasets/rifxyz/open-schematics>.
  Multimodal KiCad/schematic dataset. E1 status: dataset-governance only until
  revision, license, split, overlap/contamination, parser-baseline, and
  generated-output quarantine reviews exist.
- GerberFormer: <https://huggingface.co/pulipakav-1/gerberformer> and
  <https://huggingface.co/datasets/pulipakav-1/gerberformer-results>. Design-
  conditioned PCB defect-detection model/data reference. E1 status: no model
  download, data import, inference, or AOI claim until model/data revisions,
  licenses, E1 Gerber/image/annotation hashes, held-out board error analysis,
  and manufacturing review exist.
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
- Verilator: <https://github.com/verilator/verilator>. Open SystemVerilog
  simulator/lint backend for deterministic RTL and cocotb replay. E1 status:
  local simulator gate reference only; generated tests, waveforms, or RTL
  changes need version pins, command logs, result hashes, formal/reference
  correlation where applicable, and review.
- Spike: <https://github.com/riscv-software-src/riscv-isa-sim>. RISC-V ISA
  simulator. E1 status: ISS watch source only until ISA/profile selection, CSR
  and memory-map policy, binary/signature/trace hashes, DUT comparison logs,
  and review exist.
- Sail RISC-V: <https://github.com/riscv/sail-riscv>. Executable formal
  RISC-V ISA model. E1 status: executable-spec reference only until selected
  ISA profile, generated emulator/proof artifacts, semantic assumptions, and
  comparison logs are pinned.
- riscv-formal: <https://github.com/SymbioticEDA/riscv-formal>. RVFI-based
  RISC-V formal verification framework. E1 status: formal watch source only
  until RVFI mapping, solver revisions, assumptions, proof logs, witnesses, and
  review exist.
- riscvISACOV: <https://github.com/riscv-verification/riscvISACOV>. Open
  RISC-V ISA functional coverage library. E1 status: coverage watch source only
  until revision, license, ISA/profile mapping, RVVI adapter hashes, coverage
  database replay, and gap review exist.
- Lyra: <https://arxiv.org/abs/2512.13686>. ISA-aware generative RISC-V
  processor fuzzing with FPGA acceleration. E1 status: method-only until code,
  model/generator assets, seeds, legality checks, FPGA bitstreams, coverage
  logs, differential failures, and replay evidence exist.
- DifuzzRTL: <https://github.com/compsec-snu/difuzz-rtl>. Code-bearing
  RISC-V differential RTL fuzzer. E1 status: fuzzer reference only until exact
  revision, license, ISA profile, DUT/reference hashes, simulator versions,
  generated program hashes, seed manifests, coverage logs, mismatch
  checkpoints, and review exist.
- RFUZZ: <https://github.com/ekiwi/rfuzz>. Coverage-directed RTL fuzzing
  reference. E1 status: method reference only until instrumentation hashes,
  coverage definitions, generated input hashes, replay logs, and review exist.
- Cascade: <https://comsec.ethz.ch/research/hardware-design-security/cascade-cpu-fuzzing-via-intricate-program-generation/>
  and <https://github.com/comsec-group/cascade-artifacts>. RISC-V CPU fuzzer
  using intricate program generation. E1 status: fuzzer reference only until
  artifacts, ISA/privilege scope, generated program hashes, reducer logs,
  mismatch/nontermination evidence, coverage, and review are pinned.
- OpenXiangShan XFUZZ: <https://github.com/OpenXiangShan/xfuzz>. Coverage-guided
  RISC-V CPU fuzzer. E1 status: co-simulation fuzzer reference only until
  LibAFL/toolchain versions, coverage instrumentation, seed corpus, generated
  workloads, logs, mismatch checkpoints, and review exist.
- OpenXiangShan DiffTest: <https://github.com/OpenXiangShan/difftest>. RISC-V
  CPU co-simulation/differential-testing framework. E1 status: co-simulation
  reference only until trace schema, memory synchronization, nondeterminism
  rules, logs, mismatch artifacts, and review are pinned.
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
- SRAM22 Sky130 macros: <https://github.com/rahulk29/sram22_sky130_macros>.
  Open Sky130 SRAM macro collateral reference. E1 status: collateral review
  only until revision, license, PDK provenance, per-view hashes, wrapper
  mapping, DRC/LVS/extraction, STA, OpenLane, and review evidence exist.
- VLSIDA Sky130 SRAM macros: <https://github.com/VLSIDA/sky130_sram_macros>.
  Companion Sky130 SRAM macro collateral for OpenRAM-oriented review. E1
  status: collateral review only until exact revision, license, PDK provenance,
  macro hashes, wrapper/corner mapping, local signoff replay, and review exist.
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
- Logic BIST with MBIST/BISR:
  <https://github.com/dineshannayya/logic_bist>. Open RTL reference for memory
  BIST and repair collateral. E1 status: MBIST/BISR watch only until revision,
  license, memory-interface mapping, March/fault-model manifests, generated
  collateral hashes, simulation/formal logs, synthesis/STA/DFT replay, and
  review are captured.
- Aawo configurable MBIST and SRAM fault model:
  <https://aawo.dev/projects/mbist/> and
  <https://aawo.dev/projects/sram-fault-model/>. Project references for MBIST
  algorithms and SRAM fault taxonomy. E1 status: architecture/fault-model
  watch only until source snapshots, terms, fault taxonomy, injected-fault
  manifests, MBIST coverage comparisons, replay logs, and review exist.
- AutoMBIST: <https://pypi.org/project/autombist/>. Package watch source for
  automatic MBIST wrapper generation. E1 status: package watch only until
  package/version hashes, license, input memory manifest, generated wrapper
  hashes, RTL lint/sim/formal logs, synthesis/STA/DFT replay, and review exist.
- AutoCellGen: <https://github.com/The-OpenROAD-Project/AutoCellGen>. Open
  standard-cell layout generator reference. E1 status: generator watch only
  until PDK authority, generated GDS/LEF hashes, DRC/LVS/extraction, Liberty
  characterization, STA, OpenLane replay, and review are available.
- TOPCELL: <https://arxiv.org/abs/2604.14237>. LLM-assisted standard-cell
  topology optimization method. E1 status: method-only until prompts/model/data
  provenance, topology hashes, layout signoff, Liberty characterization,
  block-level replay, and reviewer evidence exist.
- CPCell: <https://arxiv.org/abs/2603.13665>. Constraint-programming standard-
  cell generation for gear-ratio-aware DTCO. E1 status: DTCO reference only
  until process rules, generated layout hashes, characterization, block-level
  PPA/IR replay, and review are pinned.
- CharLib: <https://pypi.org/project/charlib/> and
  <https://github.com/stineje/CharLib>. Open standard-cell characterization
  tooling. E1 status: characterization watch only until simulator, SPICE/model,
  PVT/slew/load grid, Liberty diff, STA/synthesis replay, license, and review
  evidence exist.
- LibreCell: <https://github.com/Ravenslofty/librecell>. Open standard-cell
  synthesis, layout, and characterization flow reference. E1 status: library
  flow watch only until PDK authority, generated GDS/LEF/SPICE/Liberty hashes,
  DRC/LVS/extraction, characterization, STA, synthesis/OpenLane replay, license,
  and review exist.
- xcell: <https://github.com/asyncvlsi/xcell>. Open standard-cell
  characterization reference. E1 status: characterization watch only until
  simulator/model provenance, SPICE inputs, PVT grids, Liberty hashes,
  STA/synthesis/OpenLane replay, license, and review exist.
- NVCell: <https://arxiv.org/abs/2107.07044>. RL standard-cell layout
  generation reference. E1 status: historical method-only until exact
  environment, PDK/design rules, generated layout, characterization, and
  block-level replay evidence are available.
- CircuitMind / TC-Bench: <https://arxiv.org/abs/2504.14625> and
  <https://github.com/BUAA-CLab/CircuitMind>. Multi-agent gate-level generation
  framework and benchmark using syntax locking, RAG, and dual correctness plus
  efficiency rewards. E1 status: metadata-only until repository revision,
  model/data manifests, TC-Bench license and overlap review, RAG traces,
  generated-output quarantine, local lint/sim/synth/formal replay, and review
  are captured.
- RTLFixer: <https://arxiv.org/abs/2311.16543> and
  <https://github.com/NVlabs/RTLFixer>. LLM Verilog syntax-repair framework
  using compiler/simulator feedback, ReAct-style repair, RAG, and
  VerilogEval-derived syntax/simulation datasets. E1 status: metadata-only
  until revision, license, API/privacy, dataset overlap, prompt/output,
  generated-output quarantine, compiler/simulator logs, local lint/sim/synth/
  formal replay, and review evidence are captured.
- PyHDL-Eval: <https://github.com/cornell-brg/pyhdl-eval>. MIT-licensed
  framework for evaluating LLM-generated designs across Verilog and Python
  HDL DSLs such as PyMTL, PyRTL, MyHDL, Migen, and Amaranth. E1 status:
  benchmark-reference only until dependency manifests, task hashes, DSL
  lowering assumptions, Verilog/simulator/synthesis replay, benchmark
  non-overlap, and review evidence exist.
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
- HAL: <https://github.com/emsec/hal>. Gate-level netlist analysis framework
  for structural inspection, plugins, and graph queries. E1 status:
  netlist-security watch only until revision, license, input netlist/library
  hashes, import logs, query/plugin logs, report hashes, deterministic
  follow-up checks, and security review are pinned.
- SpyDrNet: <https://github.com/byuccl/spydrnet>. Python netlist analysis
  framework. E1 status: analysis-backend watch only until revision, license,
  netlist/library mapping, parser logs, script hashes, output hashes,
  synthesis/formal cross-checks where applicable, and review exist.
- Netlist Paths: <https://github.com/dalance/netlist-paths>. Netlist path-query
  tool. E1 status: report-only watch until revision, netlist/library hashes,
  query command logs, path report hashes, RTL/spec cross-reference,
  deterministic follow-up checks, and review are captured.
- Naja: <https://github.com/najaeda/naja>. Structural netlist framework. E1
  status: netlist infrastructure watch only until revision, license, import/
  export logs, transformation hashes if any, equivalence or synthesis replay,
  and reviewer disposition exist.
- NETLAM: <https://github.com/shubhishukla10/NETLAM>. LLM-based stealthy
  hardware Trojan generation framework; dual-use watch only, with no clone, run,
  output import, or detector claim without explicit approval, sandboxing,
  no-source-import boundaries, artifact quarantine, and human review.
- BugWhisperer:
  <https://huggingface.co/SiLDALab/Mistral-7B-instruct-Bug-Whisperer>.
  Fine-tuned RTL vulnerability-detection model card; model-intake watch only
  until revision, license, training-corpus provenance, E1 non-overlap, prompt
  logs, deterministic confirmation, and security review are captured.
- VeriCWEty: <https://arxiv.org/abs/2604.15375>. Embedding-enabled module and
  line-level Verilog CWE detection method; method-only until labels, embedding
  model revisions, taxonomy mapping, alert logs, false-positive review, and
  deterministic follow-up checks exist.
- LASHED: <https://arxiv.org/abs/2504.21770>. LLM plus static-analysis method
  for early RTL security bug detection; advisory reference only until analyzer
  versions, prompts, rule hashes, alert provenance, and review evidence exist.
- Qihe: <https://arxiv.org/abs/2601.11408> and
  <https://qihe.pascal-lab.net/>. General-purpose Verilog static-analysis
  framework with bug and security clients; candidate backend only until access,
  license, parser compatibility, command logs, alert hashes, and replay gates
  are pinned.
- Hardware Vulnerability Dataset:
  <https://github.com/shamstarekargho/Hardware-Vulnerability-Dataset>. Prompt
  dataset for hardware vulnerability work; dataset-governance only until exact
  revision, license, taxonomy mapping, E1 overlap scan, prompt privacy, split
  manifests, and reviewer disposition are captured.
- CorrectBench: <https://arxiv.org/abs/2411.08510> and
  <https://github.com/AutoBench/CorrectBench>. Self-validating HDL testbench
  generation framework with functional correction; target-capture only until
  code/data license, oracle independence, prompt logs, cocotb replay,
  mutation/seeded-bug sensitivity, and review are captured.
- UVLLM: <https://arxiv.org/abs/2411.16238>. LLM plus UVM framework for RTL
  verification and repair; block generated UVM collateral and patches until
  repository/license, simulator availability, prompt logs, and local
  formal/cocotb/synthesis/equivalence replay are pinned.
- UVM2: <https://arxiv.org/abs/2504.19959>. Coverage-driven LLM UVM machine;
  use as future UVM workflow context only until protocol IR, coverage reports,
  cocotb/formal correlation, and coverage-waiver disposition exist.
- VerifLLMBench:
  <https://dvcon-proceedings.org/document/verifllmbench-an-open-source-benchmark-for-testbenches-generated-with-large-language-models/>.
  UVM testbench-generation benchmark methodology; benchmark-governance only
  until assets, metrics, license, and E1 non-overlap are reviewed.
- MEIC: <https://arxiv.org/abs/2405.06840> and
  <https://github.com/SEU-ACAL/reproduce-MEIC-ICCAD>. Iterative RTL debug
  framework and bug corpus; no E1 debug loop or patch may run until taxonomy,
  prompt/output logs, patch quarantine, deterministic replay, and review exist.
- R3A: <https://arxiv.org/abs/2511.20090>. Multi-agent fault-localization and
  stochastic tree-of-thought RTL repair reference; method-only until assets,
  search traces, prompt logs, replay, and reviewer disposition are available.
- Clover RTL Repair: <https://arxiv.org/abs/2604.17288>. Neural-symbolic
  agentic RTL repair reference; high-water-mark SOTA only until symbolic-tool
  versions, search traces, generated diffs, formal/simulation/synthesis/
  equivalence replay, and human review exist.
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
- AUTODRIVER / DRIVEBENCH: <https://arxiv.org/abs/2511.18924>. LLM driver
  co-evolution benchmark and agent method for Linux kernel API changes. E1
  status: paper-assets watch only until code/data release, license, kernel and
  driver source hashes, static analysis, compile logs, QEMU/Renode transcripts,
  generated-patch quarantine, and platform-contract review exist.
- OS-R1: <https://arxiv.org/abs/2508.12551> and
  <https://github.com/LHY-24/OS-R1>. Agentic Linux kernel configuration tuning
  framework with code/assets. E1 status: code watch only until revisions,
  kernel baselines, generated `.config` quarantine, Kconfig validation,
  workload/power logs, boot transcripts, and review exist.
- AutoOS: <https://openreview.net/pdf?id=Rp8R9C0Sth>. LLM-assisted Linux kernel
  configuration method. E1 status: method-only until code/assets, kernel config
  hashes, generated-output quarantine, boot/driver checks, workload replay, and
  reviewer disposition exist.
- FIRMHIVE: <https://arxiv.org/abs/2511.18438>. LLM firmware security-analysis
  agent method. E1 status: method-only until assets, firmware corpus licenses,
  generated finding quarantine, static/dynamic confirmation, E1 non-overlap,
  and security review exist.
- ADFEmu:
  <https://www.sciencedirect.com/org/science/article/pii/S1546221825006885>.
  LLM-assisted firmware fuzzing and DMA emulation method. E1 status:
  method-only until implementation/assets, peripheral/DMA model manifests,
  seed/crash logs, emulator replay, and security reviewer disposition exist.
- P2IM: <https://github.com/RiS3-Lab/p2im>. Peripheral-model-inferred firmware
  emulation and fuzzing baseline. E1 status: backend watch only until firmware
  image hashes, memory-map/MMIO manifests, inferred model hashes, seed/corpus
  hashes, emulator command lines, crash logs, replay transcripts, and security
  review exist.
- DICE: <https://github.com/RiS3-Lab/DICE>. Interrupt-aware firmware
  re-hosting reference. E1 status: backend watch only until firmware and symbol
  hashes, interrupt/MMIO manifests, model-generation logs, emulator traces,
  crash replay, and reviewer disposition exist.
- HALucinator: <https://github.com/halucinator/halucinator>. HAL-level
  firmware re-hosting framework. E1 status: blocked until HAL/peripheral
  replacement manifests, hook hashes, firmware provenance, execution logs,
  crash replay, and security review exist.
- FirmWire: <https://github.com/FirmWire/FirmWire>. Firmware emulation and
  fuzzing platform. E1 status: security-pipeline reference only until target
  mapping, firmware licensing, emulator/model manifests, seed/corpus hashes,
  crash triage, replay evidence, and reviewer disposition exist.
- QEMU: <https://gitlab.com/qemu-project/qemu>. Full-system emulator backend
  for RISC-V Linux/OpenSBI/driver replay. E1 status: deterministic simulator
  watch only until exact revision, machine/CPU/device model configuration,
  firmware/kernel/initramfs/DTB hashes, command line, serial transcript, exit
  status, and reviewer disposition are captured.
- Renode: <https://github.com/renode/renode>. Scriptable embedded-system
  simulator for firmware and peripheral-model replay. E1 status: backend watch
  only until platform descriptions, loaded binary/DTB hashes, scripts,
  UART/peripheral logs, pass/fail criteria, and review are pinned.
- Device Tree Compiler:
  <https://git.kernel.org/pub/scm/utils/dtc/dtc.git>. Deterministic compiler
  and checker for DTS/DTSI to DTB handoff artifacts. E1 status: platform-
  contract backend only until DTC revision, source hashes, DTB hashes, warning
  logs, boot transcript, and review exist.
- Buildroot: <https://gitlab.com/buildroot.org/buildroot>. Embedded Linux
  build-system backend for rootfs/kernel/BSP smoke images. E1 status: build
  backend watch only until revision, defconfig/package/kernel hashes, toolchain
  provenance, build logs, output image hashes, boot transcript, and license
  manifest review exist.
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
- LEGOSim: <https://github.com/Lavender105/LEGOSim>. Code-bearing simulator
  reference for heterogeneous multi-chiplet systems and network-on-interposer
  modeling. E1 status: simulator watch only until revision, license, topology
  and traffic manifests, die-to-die assumptions, package stack, replay logs,
  and review are pinned.
- HISIM: <https://github.com/UCSD-SEELab/HISIM>. Code-bearing heterogeneous
  integration simulator for performance, power, and area exploration. E1
  status: simulator watch only until revision, license, partition/floorplan
  manifests, package/process assumptions, workload inputs, replay logs, and
  review exist.
- MFIT: <https://github.com/peaclab/MFIT>. Multifidelity thermal modeling code
  for 2.5D/3D multi-chiplet architectures. E1 status: thermal watch only until
  package stack, power-map/activity provenance, surrogate provenance where
  used, calibration/error analysis, and reviewer disposition exist.
- 3D-ICE 4.0: <https://github.com/esl-epfl/3d-ice>. Compact thermal simulator
  reference for 2.5D/3D heterogeneous integration. E1 status: deterministic
  backend watch only until thermal stack/material manifests, power-map hashes,
  command logs, local comparison, and review are available.
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
- SystemC/TLM: <https://github.com/accellera-official/systemc>. System-level
  modeling and transaction-level simulation framework. E1 status: modeling
  backend watch only until revision, license, model source hashes,
  memory-map/interface manifests, workload hashes, traces, correlation against
  RTL/QEMU/Renode or silicon evidence where applicable, and review exist.
- SST: <https://github.com/sstsimulator/sst-core>. Parallel architecture
  simulation framework for component-level system studies. E1 status:
  architecture-simulator watch only until core/elements revisions, configs,
  topology, workload/trace hashes, stats outputs, calibration against local
  simulator evidence, and review are pinned.
- Chipyard: <https://github.com/ucb-bar/chipyard>. RISC-V SoC generator and
  simulation framework around Rocket/BOOM, TileLink, accelerators, and
  Verilator/FireSim flows. E1 status: generator/simulator reference only until
  exact repo/submodule revisions, config hashes, generated RTL/DTS/firmware
  hashes, simulator transcripts, platform-contract diffs, and review exist.
- Gemmini: <https://github.com/ucb-bar/gemmini>. Open systolic-array generator
  and software stack integrated with Chipyard. E1 status: NPU architecture
  baseline only until generator params, generated RTL, RoCC/TileLink versus E1
  MMIO/runtime mapping, workload logs, synthesis/STA where applicable, and
  review are pinned.
- FireMarshal: <https://github.com/firesim/FireMarshal>. RISC-V full-system
  workload and rootfs generation tool used with Chipyard/FireSim. E1 status:
  workload packaging reference only until workload configs, toolchain/package
  manifests, rootfs/image hashes, UART transcripts, benchmark logs, and review
  exist.
- MIDAS/FAME transforms: <https://github.com/firesim/firesim>. Underlying
  FPGA-simulation transform method for FireSim-style bit-exact simulation. E1
  status: method reference only until transform revision, input RTL hashes,
  generated-model hashes, reference-simulator correlation, workload transcripts,
  and review exist.
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
- Waveform MCP: <https://github.com/jiegec/waveform-mcp>. MCP server for VCD/FST
  waveform hierarchy, signal-value queries, metadata, event search, and
  conditional events. E1 status: waveform-context reference only until exact
  revision, waveform hashes, signal/time-window allowlists, MCP logs, prompt
  redaction, simulator replay, and review exist.
- MCP VCD: <https://github.com/SeanMcLoughlin/mcp-vcd>. Lightweight VCD MCP
  server reference for scoped signal-change context. E1 status:
  waveform-context reference only until VCD hashes, selected signals,
  timestamp policies, tool logs, prompt/output hashes, replay, and review are
  pinned.
- VaporView: <https://github.com/Lramseyer/vaporview>. Open waveform viewer for
  local human waveform review. E1 status: manual-review tooling context only
  until license, extension revision, waveform hashes, signal lists, timestamp
  annotations, and simulator command replay are captured.
- WaveEye: <https://github.com/meenalgada142/WaveEye>. Deterministic RTL/VCD
  root-cause analyzer for AXI4-Lite protocol failures. E1 status:
  waveform-RCA watchlist only until repository revision, dependency pins,
  RTL/VCD hashes, signal/time scopes, AXI-Lite assumptions, proof JSON,
  simulator replay, cocotb/formal correlation, and review are captured.
- cocotb: <https://github.com/cocotb/cocotb>. Core Python co-simulation
  framework already aligned with E1's cocotb gates. E1 status: baseline
  simulator-feedback harness only; generated tests remain non-evidence until
  version pins, seed manifests, result XML, logs, and review are archived.
- cocotb-test: <https://github.com/themperek/cocotb-test>. Pytest runner for
  cocotb simulations. E1 status: regression-harness watchlist only until
  simulator matrix, parameters, stdout/stderr, result hashes, and review are
  pinned.
- cocotb-bus: <https://github.com/cocotb/cocotb-bus>. Reusable drivers,
  monitors, and scoreboards for cocotb. E1 status: bus-functional reference
  only until bus mappings, scoreboard policy, seeds, simulator logs, and
  cocotb/formal correlation are reviewed.
- cocotb-coverage: <https://github.com/cocotb/cocotb-coverage>. Functional
  coverage and constrained-random support for cocotb tests. E1 status:
  coverage-backend reference only until bin schemas, seed manifests, simulator
  logs, merged coverage database hashes, before/after deltas, and review exist.
- pyuvm: <https://github.com/pyuvm/pyuvm>. Python UVM framework built around
  cocotb-style verification. E1 status: framework reference only until a
  protocol IR, scoreboard definitions, coverage plan, simulator logs,
  cocotb/formal correlation, and review exist.
- cocotbext-axi: <https://github.com/alexforencich/cocotbext-axi>. Cocotb AXI
  drivers, monitors, RAM models, and helpers. E1 status: AXI VIP reference only
  until exact revision, AXI-lite mapping, seed/transaction manifests,
  scoreboard policy, protocol-error reports, coverage deltas, and review exist.
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
- Google XLS: <https://github.com/google/xls>. Apache-2.0 open HLS toolchain
  for DSLX/IR simulation and Verilog/SystemVerilog generation. E1 status:
  backend watch only until revision, dependencies, DSLX/IR/source hashes,
  generated HDL quarantine, simulator logs, synthesis/formal/equivalence, QoR
  replay, and review exist.
- Dynamatic: <https://github.com/EPFL-LAP/dynamatic>. MLIR-based dynamic HLS
  compiler for elastic dataflow experiments. E1 status: backend watch only
  until revision, dependencies, input C/C++/MLIR hashes, generated IR/RTL
  quarantine, simulator/synthesis logs, equivalence/regression evidence, and
  review exist.
- AutoDSE: <https://github.com/UCLA-VAST/AutoDSE>. ML-assisted HLS
  design-space exploration baseline for pragma/search policies. E1 status:
  blocked until benchmark subset, toolchain, search manifests, generated
  artifacts, QoR replay, and reviewer disposition are pinned.
- AI4DSE: <https://arxiv.org/abs/2411.10065>. LLM plus multi-heuristic HLS DSE
  method reference. E1 status: paper-only until prompts, models, heuristics,
  tool versions, explored configurations, and local replay evidence exist.
- HLSPilot: <https://arxiv.org/abs/2408.06810> and
  <https://github.com/xcw-1010/HLSPilot>. Profiling-guided C-to-HLS
  generation and pragma DSE framework; blocked until code revision, prompts,
  profiles, generated HLS quarantine, C-sim, HLS synthesis, generated RTL
  checks, and review exist.
- DB4HLS: <https://arxiv.org/abs/2101.00587> and
  <https://www.db4hls.inf.usi.ch/>. HLS DSE database; dataset-governance only
  until exact snapshot, license, split, non-overlap, tool/version mapping, and
  QoR replay are reviewed.
- DP-HLS: <https://arxiv.org/abs/2411.03398> and
  <https://github.com/TurakhiaLab/DP-HLS>. Template HLS framework for dynamic
  programming accelerators; architecture reference only until workload fit,
  backend dependencies, generated source quarantine, and replay gates exist.
- hls4ml: <https://arxiv.org/abs/2512.01463> and
  <https://github.com/fastmachinelearning/hls4ml>. ML-model-to-HLS compiler;
  blocked until model and quantization manifests, backend revision, generated
  HLS/RTL quarantine, accuracy replay, and runtime integration evidence exist.
- FINN: <https://xilinx.github.io/finn/> and <https://github.com/Xilinx/finn>.
  Quantized neural-network dataflow compiler for FPGA; use as NPU/dataflow
  context only until Docker/dependency, model, backend, generated HLS/RTL,
  accuracy, and interface-mapping evidence are pinned.
- AMD LLM-aided HLS dataflow optimization:
  <https://www.amd.com/en/developer/resources/technical-articles/2026/llm-aided-hls-dataflow-optimization-a-sha-256.html>.
  Practitioner workflow reference for feeding HLS reports to an LLM; no E1 use
  without prompt logs, generated-code quarantine, C-sim/co-sim/synthesis logs,
  and review.
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
- AtomPower: <https://doi.org/10.1587/elex.23.20260004>. RTL-stage per-cycle
  power-modeling method using bit-level structural representations and data
  augmentation. E1 status: method-only until implementation/assets, RTL
  structure extraction, VCD/activity provenance, per-cycle labels, held-out
  local error analysis, and reviewer disposition exist.
- Commercial Thermal Map Dataset:
  <https://dl.acm.org/doi/10.1145/3670474.3685963> and
  <https://github.com/sheldonucr/commercial_thermal_map_dataset>. Measured
  CPU/GPU/TPU thermal-map corpus for runtime thermal-management research. E1
  status: dataset-governance only until exact revision, license, device and
  workload provenance, sensor/camera calibration, split review, package mapping,
  and local thermal evidence are captured.
- HotGauge: <https://sites.tufts.edu/tcal/publications/hotgauge/> and
  <https://github.com/TuftsCompArchLab/HotGauge>. Public architecture-level
  hotspot characterization framework with simulator and thermal-model
  dependencies. E1 status: framework watch only until dependency licenses,
  revisions, floorplan/power-map mapping, thermal stack assumptions, simulator
  logs, calibration, and review exist.
- McPAT: <https://github.com/HewlettPackard/mcpat>. Deterministic
  architecture-level power, area, and timing-model reference often used with
  simulator statistics. E1 status: backend watch only until revision, license,
  XML/config generation, technology assumptions, activity/stat provenance,
  local synthesis/PD/measured-label comparison, and review exist.
- HotSpot: <https://github.com/uvahotspot/HotSpot>. Deterministic compact
  thermal simulator for architecture/floorplan plus power-map experiments. E1
  status: backend watch only until revision, package/material assumptions,
  boundary conditions, floorplan and power-map hashes, sensitivity analysis,
  calibration, and reviewer disposition exist.
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
- LMM-IR: <https://arxiv.org/abs/2511.12581>. Netlist-aware multimodal static
  IR-drop prediction method using layout/image and netlist context. E1 status:
  paper-only until code/assets, feature schemas, PDNSim/signoff labels,
  split/non-overlap review, held-out E1 error analysis, and PD review exist.
- DuST-IRdrop: <https://github.com/cuhk-eda/DuST-IRdrop>. Code-bearing
  dynamic IR-drop prediction candidate using diffusion/transformer-style
  modeling. E1 status: code watch source only until revision, license,
  dependencies, data provenance, prediction quarantine, dynamic labels, and
  signoff replay are reviewed.
- Accellera CDC/RDC standard 1.0:
  <https://www.accellera.org/downloads/standards/clock-domain-crossing>.
  Current March 2026 standardization reference for vendor-neutral CDC/RDC
  intent and collateral exchange. E1 status: standards watch only until terms,
  local tool mapping, waiver policy, and deterministic report evidence exist.
- Accellera CDC/RDC draft 0.5 public review:
  <https://www.accellera.org/news/press-releases/accellera-releases-cdc-rdc-public-review-draft>.
  Historical public-review checkpoint for vendor-neutral CDC/RDC intent.
- cdc_snitch / Berkeley Lab Bedrock:
  <https://github.com/BerkeleyLab/Bedrock/tree/master/projects/common/leep/cdc_snitch>.
  Open CDC anti-pattern lint reference. E1 status: code watch only until
  Bedrock revision, license/dependency review, parser support, clock/reset
  intent, report hashes, false-positive policy, waiver disposition, formal/
  cocotb follow-up, and CDC/RDC review exist.
- Veryl clock-domain annotations:
  <https://doc.veryl-lang.org/book/05_language_reference/15_clock_domain_annotation.html>
  and <https://github.com/veryl-lang/veryl>. Code-bearing typed-HDL reference
  for explicit clock/reset and clock-domain annotations. E1 status: code watch
  only until revision, license, generated SystemVerilog quarantine,
  equivalence/formal/cocotb replay, and CDC/RDC report comparison exist.
- Arch AI-native HDL: <https://arxiv.org/abs/2604.05983>. Typed clock/reset
  and interface methodology for AI-native HDL. E1 status: method-only until an
  implementation, generated-intent quarantine, equivalence, formal/cocotb, and
  CDC/RDC report comparisons exist.
- Sparkle Lean HDL: <https://github.com/Verilean/sparkle>. Code-bearing
  proof-oriented HDL with clock and multi-clock simulation concepts. E1 status:
  code watch only until revision, license, subset mapping, translated-artifact
  quarantine, proof logs, RTL/cocotb equivalence, and CDC/RDC review exist.
- SKALP: <https://github.com/girivs82/skalp>. Experimental code-bearing HDL
  with compile-time clock-domain safety, synthesis/simulation/formal features,
  equivalence checks, and reported ML-guided pass ordering. E1 status: code
  watch only until revision, license, subset mapping, generated artifact
  quarantine, ML provenance if used, formal/synthesis replay, and CDC/RDC
  comparison exist.
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
- OpenSTA power analysis: <https://github.com/The-OpenROAD-Project/OpenSTA>.
  Open activity-annotated power analysis backend. E1 status: backend watchlist
  only until Liberty/netlist/SDC/parasitic/activity hashes, command logs,
  activity coverage, report hashes, correlation notes, and review are pinned.
- iEDA iPower: <https://ieda.oscc.cc/en/tools/ieda-tools/ipa.html> and
  <https://github.com/OSCC-Project/iEDA>. Open VCD-driven power-analysis
  backend with grouped power reports. E1 status: cross-check watch only until
  revision, input hashes, VCD top/scope mapping, report hashes, cross-tool
  comparison, and review exist.
- trace2power: <https://docs.rs/trace2power> and
  <https://github.com/antmicro/trace2power>. VCD/FST activity extraction tool
  for downstream power analysis. E1 status: trace-processing watch only until
  waveform hashes, scope/clock mapping, generated activity hashes, downstream
  OpenSTA/OpenROAD replay, and review exist.
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
- Surelog: <https://github.com/chipsalliance/Surelog>. SystemVerilog parser
  and elaborator producing UHDM. E1 status: frontend-hygiene watch only until
  revision, license, RTL/SVA hashes, parser/elaboration logs, unsupported
  construct reports, downstream formal/cocotb replay, and review exist.
- UHDM: <https://github.com/chipsalliance/UHDM>. SystemVerilog interchange data
  model used by frontend/tooling flows. E1 status: interchange watch only until
  producer/consumer revisions, serialized-object hashes if archived, consumer
  logs, source hashes, and review are pinned.
- Verible: <https://github.com/chipsalliance/verible>. SystemVerilog parser,
  formatter, and lint tooling. E1 status: assertion/testbench hygiene watch
  only until revision, rule configuration, waiver manifest, input/output
  hashes, diagnostics, formal/cocotb replay where applicable, and review exist.
- sv-tests: <https://github.com/chipsalliance/sv-tests>. SystemVerilog
  frontend compliance suite. E1 status: tool-qualification watch only until
  revision, selected test manifest, frontend/tool matrix, pass/fail logs,
  unsupported-construct mapping, and review are captured.
- slang: <https://github.com/MikePopoloski/slang>. Independent SystemVerilog
  compiler frontend. E1 status: cross-check watch only until revision, license,
  RTL/SVA hashes, diagnostic logs, comparison against another frontend where
  practical, downstream replay, and review are pinned.
- VeriDebug: <https://arxiv.org/abs/2504.19099>,
  <https://github.com/CatIIIIIIII/VeriDebug>,
  <https://huggingface.co/LLM-EDA/VeriDebug>, and
  <https://huggingface.co/datasets/LLM-EDA/BuggyVerilog>. Code/model/dataset
  candidate for Verilog buggy-line retrieval, bug-type classification, and
  guided repair. E1 status: debug-model watch source only until exact
  revisions, licenses, base-model review, overlap scan, prompt/embedding logs,
  patch quarantine, deterministic lint/simulation/formal/synthesis/equivalence
  replay, and reviewer disposition are pinned.
- AssertSolver: <https://arxiv.org/abs/2503.04057>,
  <https://github.com/SEU-ACAL/reproduce-AssertSolver-DAC-25>, and
  <https://huggingface.co/1412312anonymous/AssertSolver>. Code/model candidate
  for repairing RTL bugs exposed by assertion failures. E1 status:
  assertion-repair watch source only until model access, exact revisions,
  license/base-model review, assertion/testbench overlap scan, prompt/output
  logs, patch quarantine, deterministic simulation/formal/synthesis/equivalence
  replay, and reviewer disposition are pinned.
- ForgeEDA: <https://arxiv.org/abs/2505.02016> and
  <https://huggingface.co/datasets/zshi0616/ForgeEDA_AIG>. Multimodal AIG
  dataset for circuit foundation model work. E1 status: metadata-only corpus
  reference until dataset revision, license, split, label, contamination, and
  held-out E1 task reviews are complete.
- GNN4CIRCUITS: <https://github.com/DfX-NYUAD/GNN4CIRCUITS>. Code-bearing
  graph-learning toolkit for hardware netlists. E1 status: toolkit reference
  only until dependency, graph-schema, label, replay, and reviewer evidence are
  pinned.
- HW2VEC: <https://cadforassurance.org/tools/design-for-trust/hw2vec/> and
  <https://github.com/AICPS/hw2vec>. RTL/gate-level graph embedding tool for
  hardware assurance workflows. E1 status: graph-extraction reference only
  until source revisions, extraction logs, labels, held-out splits, formal or
  synthesis cross-checks, and review exist.
- OpenROAD Hier-RTLMP:
  <https://openroad.readthedocs.io/en/latest/main/src/mpl/README.html>. Local
  deterministic macro-placement baseline. E1 status: target capture only until
  macro manifests, halos, blockages, routing, STA, DRC/LVS, antenna, PDN/power,
  package, and reviewer evidence are available.
- WireMask-BBO: <https://arxiv.org/abs/2306.16844> and
  <https://github.com/lamda-bbo/WireMask-BBO>. Code-bearing black-box macro
  placement optimizer. E1 status: code reference only until revision, license,
  benchmark, generated-placement quarantine, and downstream signoff replay are
  pinned.
- BBOPlace-Bench: <https://arxiv.org/abs/2510.23472> and
  <https://github.com/lamda-bbo/BBOPlace-Bench>. Benchmark framework for black-
  box chip placement optimization. E1 status: benchmark reference only until
  asset manifests, splits, non-overlap review, replay logs, and local
  OpenROAD/OpenLane correlation exist.
- Macro Placement Challenge 2026:
  <https://github.com/partcleda/macro-place-challenge-2026>. Current OpenROAD-
  oriented macro-placement challenge scaffold. E1 status: challenge reference
  only until terms, revisions, split policy, generated-output quarantine, and
  benchmark non-overlap review are complete.
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

## Reliability and workload fault injection

- HDFIT: <https://intellabs.github.io/HDFIT/>. Hardware-design fault-injection
  toolkit for studying application-level impact from hardware faults. E1
  status: campaign-backend reference only until exact revision, license,
  netlist/workload hashes, fault-site and fault-model manifests, simulator
  versions, seeds, output classifiers, replay logs, and review exist.
- LLFI: <https://github.com/DependableSystemsLab/LLFI>. LLVM IR fault-injection
  tool. E1 status: software/compiler fault-injection reference only until LLVM
  version, binary/IR hashes, campaign configs, seeds, QEMU/Renode/native logs,
  signatures, and review are pinned.
- LLTFI: <https://github.com/DependableSystemsLab/LLTFI>. LLVM/MLIR fault
  injection framework with ONNX-MLIR oriented workflows. E1 status: MLIR/LLVM
  reference only until ONNX/MLIR/LLVM/runtime/model/input hashes, generated IR,
  campaign configs, output comparators, replay logs, and review exist.
- PyTorchFI: <https://github.com/pytorchfi/pytorchfi>. PyTorch DNN
  fault-injection framework. E1 status: workload-level reference only until
  model/input/runtime hashes, fault-site policy, seeds, output comparators, and
  simulator or hardware correlation evidence exist.
- PyTorchALFI: <https://github.com/IntelLabs/PyTorchALFI>. Application-level
  PyTorch fault-injection campaign framework. E1 status: unmaintained reference
  only until fork/revision, dependency review, dataset/model/input hashes,
  campaign configs, metrics, and E1-runtime correlation are pinned.
- MRFI: <https://github.com/fffasttime/MRFI>. Multi-resolution neural-network
  fault-injection framework. E1 status: workload-level reference only until
  injection-resolution manifests, model/runtime/input hashes, seeds, output
  classifiers, benchmark replay, and review exist.

## Register and IP contract generation

- PeakRDL Regblock: <https://github.com/SystemRDL/PeakRDL-regblock>.
  SystemRDL-to-SystemVerilog register block generator. E1 status: RTL-generator
  reference only until source RDL hashes, generated RTL hashes, reset/access
  diffs, platform/Linux/header diffs, cocotb/formal tests, synthesis logs, and
  review exist.
- PeakRDL HTML: <https://github.com/SystemRDL/PeakRDL-html>. SystemRDL register
  documentation generator. E1 status: docs-generator reference only until
  generated doc hashes, register-map diffs, platform-contract checks, docs
  checks, and review are pinned.
- PeakRDL C Header: <https://github.com/SystemRDL/PeakRDL-cheader>. SystemRDL
  C-header generator. E1 status: software-contract reference only until
  generated header hashes, ABI diffs, boot/runtime/Linux contract checks,
  compile logs, and review exist.
- PeakRDL UVM: <https://github.com/SystemRDL/PeakRDL-uvm>. SystemRDL UVM
  register-model generator. E1 status: verification-collateral reference only
  until generated UVM hashes, simulator logs, cocotb/formal correlation,
  register-access coverage, and review exist.
- hdl-registers: <https://github.com/hdl-registers/hdl-registers>. Structured
  register-code generation tool for HDL, documentation, headers, and
  verification-facing collateral. E1 status: alternate backend reference only
  until generated collateral hashes, cross-language ABI checks, local RTL and
  software gates, and review exist.

## FPGA prototyping and fabric automation

- OpenPARF: <https://github.com/PKU-IDEA/OpenPARF>. Code-bearing parallel FPGA
  placement framework. E1 status: placement-backend reference only until exact
  revision, license, target device, architecture files, netlist and constraint
  hashes, downstream route/timing logs, bitstream hashes, and hardware bring-up
  evidence exist.
- Verilog-to-Routing: <https://github.com/verilog-to-routing/vtr-verilog-to-routing>.
  Open FPGA CAD flow for architecture, placement, and routing experiments. E1
  status: deterministic backend reference only until architecture assumptions,
  command logs, seeds, route/timing reports, implementation handoff, and review
  are pinned.
- OpenFPGA: <https://github.com/lnis-uofu/OpenFPGA>. FPGA fabric-generation
  framework. E1 status: fabric-generation reference only; generated fabrics,
  wrappers, bitstreams, and verification collateral stay quarantined until
  generated-file hashes, synthesis/verification logs, programming-flow
  evidence, timing/area reports, and human review exist.
- FABulous: <https://github.com/FPGA-Research-Manchester/FABulous>. Embedded
  FPGA framework. E1 status: eFPGA/fabric context only until architecture
  manifests, generated collateral hashes, place-route/timing logs, programming
  evidence, and ASIC/FPGA assumption review are available.

## SAT solver and circuit-SAT preprocessing

- DynamicSAT: <https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.CP.2025.34>
  and <https://github.com/cure-lab/DynamicSAT>. Code-bearing dynamic
  SAT-solver parameter tuning method. E1 status: solver-runtime watch source
  only until solver revisions, CNF/SMT/miter/fault-list hashes, option
  manifests, baseline and tuned logs, witness/counterexample replay, timeout
  policy, and review are pinned.
- Logic Optimization Meets SAT: <https://arxiv.org/abs/2403.19446>. Research
  direction using logic optimization and RL-guided LUT mapping as circuit-SAT
  preprocessing. E1 status: paper-level CSAT preprocessing context only until
  code/assets, transformed-instance hashes, solver replay, witness mapping,
  benchmark-overlap review, and reviewer disposition exist.

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
9. Use physical-verification target capture for AutoEDA/MCP-style service
   boundaries, Rule2DRC, DRC-Coder, structural EDA-code verification, OpenDRC,
   and PostEDA-Bench. Do not generate decks, start service tools, run
   DRC/LVS/antenna tools, apply repairs, issue waivers, or claim signoff
   without pinned server/tool/rule/layout/netlist hashes, command schemas,
   generated-output quarantine, request/response logs, before/after tool logs,
   tool correlation, and review.
10. Use HLS/accelerator target capture for MPM-LLM4DSE, HLStrans, SAGE-HLS,
    Bench4HLS, ForgeHLS, DiffHLS, HLS-Seek, TimelyHLS, FlexLLM,
    TAPA/RapidStream, HLSFactory, HLS-Eval, LLM-DSE, iDSE, SECDA-DSE,
    ScaleHLS, Google XLS, Dynamatic, AutoDSE, and AI4DSE. Do not import
    models, datasets, HLS libraries, compiler infrastructure, DSE frameworks,
    open HLS backends, FPGA backends,
    generated directives, generated HLS, generated IR, or generated RTL without
    pinned revisions, license review, manifests, benchmark-overlap review,
    C-simulation, HLS synthesis, RTL simulation, equivalence where applicable,
    QoR replay/error analysis, and review.
11. Use compiler/runtime target capture for LLVM/MLIR, IREE, Apache TVM,
    ExecuTorch, LiteRT, and XNNPACK. Do not claim an E1 compiler backend,
    PyTorch/TFLite model path, delegate, CPU fallback path, generated VMFB/PTE
    artifact, Android acceleration, or NPU performance without pinned upstream
    and local revisions, build logs, generated artifact hashes, unsupported-op
    reports, fallback accounting, runtime/simulator or target logs, benchmark
    calibration, and review.
12. Use power/thermal and low-power target capture for ArchPower, AutoPower,
    AtomPower, PowerNet, MAVIREC, PDNNet, DuST-IRdrop, Lighter, RTL-OPT,
    Yosys clock gating, OpenROAD UPF, OpenROAD clock gating, CODMAS/RTLOPT,
    Prompting for Power, POET, RTL PPA SOG, SymRTLO, PowerGear, and UPF
    references. Do not import power datasets, train models, run clock-gating
    plugins, import benchmark tasks, generate UPF, generate IR-drop maps,
    generate RTL rewrites, import HLS power labels, or claim power savings
    without pinned revisions, license review, feature maps, vector/activity
    provenance, dynamic-label replay, calibration labels, equivalence/formal
    evidence, synthesis, STA, CDC/RDC, DFT, power reports, held-out error
    analysis, and review.
13. Use memory/interconnect target capture for AI-driven NoC DSE, NOCTOPUS,
    FlooNoC, MICSim, AutoNoC, photonic-aware DRL routing, ArchGym, BookSim2,
    Ramulator2, DRAMsim3, DRAMSys, gem5, Sniper, gem5-Aladdin,
    Gem5-AcceSys, MemExplorer, LUMINA, DeepStack, and Mess. Do not train NoC
    inverse models, generate fabric parameters or RTL, run external
    simulators, change memory maps, model CIM, accept agent-generated memory
    hierarchies, or claim bandwidth/latency/QoS/routing improvements without
    pinned simulator revisions, topology constraints, traffic traces,
    workload/config/stats hashes, replay logs, local memory-contract gates,
    RTL feasibility, calibration assumptions, and review.
- Use post-silicon and hardware-security target capture for GoldenFuzz,
    MABFuzz, and Fuzzilicon-style processor fuzzing. Do not run fuzzers,
    generate or import programs, claim coverage, disclose vulnerabilities, or
    perform hardware actions without pinned generator/fuzzer revisions, DUT and
    reference hashes, ISA/profile scope, generated-program hashes, coverage and
    mismatch logs, lab authorization where applicable, disclosure handling, and
    reviewer disposition.
14. Use DFT/ATPG target capture for Fault DFT, OpenROAD DFT, Atalanta,
    Fault hardware testing, VeriRAG/LLM4DFT, DeepTPI, HighTPI, explainable
    GNN TPI, X-source GNN testability, DEFT, InF-ATPG, LITE scan
    instrumentation, DRL ATPG, ATPG Toolkit, FAN_ATPG, Quaigh, and
    NN-for-ATPG, plus MBIST/BISR and SRAM fault-model references. Do not insert
    scan, rank or insert test points, repair RTL testability, generate MBIST
    wrappers or memory-repair collateral, run deterministic or AI ATPG, train
    hierarchical, explainable, X-source, or RL/GNN policies, generate patterns,
    issue fault waivers, or claim coverage without pinned backends, netlist,
    memory-interface, SRAM fault-model, March-test, and fault-list hashes, scan
    policy, masked-I/O and X-source manifests, feature manifests, saliency
    artifacts where applicable, pattern and memory-test replay, manufacturing
    gates, signoff, and review.
15. Use board/package/FPGA target capture for OpenPARF, VTR, OpenFPGA,
    FABulous, DREAMPlaceFPGA, RapidWright, PCB agents, autorouters, KiCad
    tooling, SI preprocessors, and AOI models. Do not generate board,
    package, pinout, FPGA, bitstream, fabric, Gerber, manufacturing, or
    inspection outputs without pinned revisions, device/fabric constraints,
    generated-output quarantine, route/timing/bitstream evidence,
    package-board cross-probe, KiCad/manufacturing gates, hardware bring-up,
    and review.
16. Use reliability/resilience target capture for HDFIT, LLFI, LLTFI,
    Hamartia, FIES, TensorFI, PyTorchFI, PyTorchALFI, MRFI, Ares, aging/EM
    methods, and SEU formal methods. Do not run campaigns, instrument RTL or
    netlists, import workloads, generate mitigations, or claim FIT/SER/safety
    closure without process models, fault manifests, output classifiers,
    deterministic simulator/formal logs, workload/runtime hashes,
    before/after PPA, signoff evidence, and review.
