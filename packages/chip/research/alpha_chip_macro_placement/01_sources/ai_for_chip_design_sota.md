# AI For Chip Design: Open Tools And Papers

This note is a working shortlist of open-source AI/ML projects and recent
literature that can help E1 architecture, RTL, verification, placement, timing,
power, and manufacturing preparation.

## Immediate additions

### OpenROAD AutoTuner

- Docs: https://openroad-flow-scripts.readthedocs.io/en/latest/user/InstructionsForAutoTuner.html
- Repo: https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts
- Use: tune OpenROAD-flow-scripts knobs with random/grid, PBT, HyperOpt/TPE,
  Ax, Optuna, Nevergrad, and PPA rewards.
- E1 fit: highest near-term value. Wrap E1 PD runs to sweep utilization,
  placement density, CTS, routing, and timing/power/area tradeoffs.

### LLM4DV

- Repo: https://github.com/ZixiBenZhang/ml4dv
- Paper: https://arxiv.org/abs/2310.04535
- Use: LLM-driven verification stimulus generation with cocotb testbenches and
  coverage feedback.
- E1 fit: adapt to existing cocotb tests for NPU, DMA, interconnect, interrupt,
  and CPU/AP stubs. Generated stimuli must be reviewed and kept as regression
  seeds only after deterministic gates pass.

### AssertionForge / AssertEval / OpenLLM-RTL

- AssertionForge repo: https://github.com/NVlabs/AssertionForge
- AssertionForge paper: https://arxiv.org/abs/2503.19174
- OpenLLM-RTL paper: https://arxiv.org/abs/2503.15112
- Use: draft SVA/test plans from specs and RTL.
- E1 fit: generate candidate assertions for bus handshakes, reset behavior,
  DMA/NPU completion, interrupt liveness, and no-stall properties. Feed only
  reviewed properties into the existing Yosys/SymbiYosys formal lane.

### PRO-V / Saarthi / SANGAM / FVDebug / SiliconMind-V1

- PRO-V paper: https://arxiv.org/abs/2506.12200
- PRO-V repo: https://github.com/stable-lab/Pro-V
- Saarthi paper: https://arxiv.org/abs/2502.16662
- SANGAM paper: https://arxiv.org/abs/2506.13983
- FVDebug paper: https://arxiv.org/abs/2510.15906
- SiliconMind-V1 paper: https://arxiv.org/abs/2603.08719
- SiliconMind-V1 model:
  https://huggingface.co/AS-SiliconMind/SiliconMind-V1-Qwen3-8B
- Use: agentic verification planning, testbench/oracle generation,
  formal-counterexample triage, assertion self-refinement, and Verilog
  debug-reasoning experiments.
- E1 fit: add only target capture for now. Generated verification plans,
  testbenches, assertions, root-cause reports, and patches need local RTL/spec
  hashes, cocotb/formal logs, synthesis/equivalence where applicable, and human
  review before promotion.

### ZigZag

- Repo: https://github.com/KULeuven-MICAS/zigzag
- Use: DNN accelerator architecture and mapping design-space exploration with
  ONNX parsing, memory hierarchy modeling, and energy/latency analysis.
- E1 fit: use before hardening NPU RTL to estimate MAC array, SRAM, bandwidth,
  dataflow, and mapping choices.

### CircuitOps / OpenROAD Python APIs

- NVIDIA publication:
  https://research.nvidia.com/labs/electronic-design-automation/publication/chhabria2024openroad/
- Use: ML-oriented EDA representation from OpenROAD database snapshots.
- E1 fit: create project-specific graph snapshots and PPA labels from E1
  OpenROAD runs. Useful once there are enough repeated E1 PD runs to train or
  validate predictors.

## Placement and physical design research

### AlphaChip / Circuit Training

- Repo: https://github.com/google-research/circuit_training
- Use: distributed RL macro placement.
- E1 fit: experimental macro-placement candidate generator once E1 has real hard
  SRAM/NPU/cache macros and repeated placement tasks.

### DREAMPlace / DREAM-GAN

- DREAMPlace repo: https://github.com/limbo018/DREAMPlace
- DREAMPlace paper:
  https://research.nvidia.com/publication/2019-06_dreamplace-deep-learning-toolkit-enabled-gpu-acceleration-modern-vlsi-placement
- DREAM-GAN paper:
  https://research.nvidia.com/publication/2023-03_dream-gan-advancing-dreamplace-towards-commercial-quality-using-generative
- Use: GPU-accelerated analytic placement and GAN-enhanced placement research.
- E1 fit: useful baseline/comparison; OpenROAD AutoTuner is lower-friction for
  the current repo.

### ChiPFormer

- Repo: https://github.com/laiyao1/ChiPFormer
- Paper: https://arxiv.org/abs/2306.14744
- Use: offline RL / decision transformer for transferable chip placement.
- E1 fit: research baseline for macro-placement experiments.

## Architecture exploration

### ArchGym

- Paper: https://arxiv.org/abs/2306.08888
- Docs: https://oss-archgym.readthedocs.io/en/documentation/installation.html
- Use: ML-assisted architecture design-space exploration around simulators.
- E1 fit: wrap NPU/cache/interconnect parameters around existing simulator and
  benchmark scripts before committing RTL changes.

### DOSA

- Repo: https://github.com/ucb-bar/dosa
- Use: differentiable model-based accelerator search, Gemmini/FireSim oriented.
- E1 fit: useful if the Chipyard/Gemmini path becomes primary. Higher setup
  cost because it expects Gurobi and FireSim/Gemmini-style infrastructure.

### HLS DSE and Directive Agents

- HLSFactory: https://github.com/sharc-lab/HLSFactory
- HLS-Eval: https://github.com/sharc-lab/hls-eval
- LLM-DSE: https://github.com/Nozidoali/LLM-DSE
- iDSE: https://arxiv.org/abs/2505.22086
- Use: HLS design-space datasets, HLS code-generation evaluation, and
  LLM/agent-guided directive search.
- E1 fit: useful for bounded NPU kernels only after a local HLS backend,
  generated-artifact quarantine, C-sim, HLS synthesis, generated-RTL checks,
  and runtime/driver gates exist.

## RTL generation and EDA assistance

### RTL-Coder / RTLLM

- RTL-Coder repo: https://github.com/hkust-zhiyao/RTL-Coder
- Paper: https://arxiv.org/abs/2312.08617
- Use: open RTL generation model, dataset, and training flow.
- E1 fit: boilerplate RTL, register blocks, adapters, and testbench scaffolds.
  Do not trust generated architectural RTL without lint, simulation, formal,
  and synthesis gates.

### HuggingFace RTL models and corpora

- SiliconMind-V1:
  https://huggingface.co/AS-SiliconMind/SiliconMind-V1-Qwen3-8B
- VeriForge DeepSeek Coder:
  https://huggingface.co/louijiec/veriforge-deepseek-coder-1.3b-instruct
- ChipSeek: https://github.com/rong-hash/chipseek
- RTLSeek: https://arxiv.org/abs/2603.27630
- OpenRTLSet: https://huggingface.co/datasets/ESCAD/OpenRTLSet
- MG-Verilog: https://huggingface.co/datasets/GaTech-EIC/MG-Verilog
- DeepCircuitX:
  https://huggingface.co/datasets/zeju-0727/DeepCirCuitX_Dataset
- LLM-EDA OpenCores: https://huggingface.co/datasets/LLM-EDA/opencores
- Hardware VerilogEval v2:
  https://huggingface.co/datasets/AbiralArch/hardware-verilogeval-v2
- LLM_4_Verilog: https://huggingface.co/datasets/NOKHAB-Lab/LLM_4_Verilog
- Use: metadata-only candidates for RTL model evaluation, EDA-feedback RL
  post-training, future corpus curation, contamination checks, and held-out
  benchmark construction.
- E1 fit: do not download weights or datasets yet. Every external model/corpus
  or RL framework needs exact revision pins, file manifests, license review,
  quarantine paths, benchmark de-duplication, reward/prompt/output hashes,
  local lint/sim/synth/formal gates, and human disposition before any use.

### Repository-Level RTL Evolution

- CktEvo: https://arxiv.org/abs/2603.08718
- DeepCircuitX paper: https://arxiv.org/abs/2502.18297
- Use: repository-level RTL context, code understanding/completion, PPA labels,
  and closed-loop function-preserving RTL evolution with toolchain feedback.
- E1 fit: high-value direction for long-term SoC-level optimization, but every
  generated cross-file edit stays quarantined until changed-file manifests,
  equivalence, cocotb/formal, synthesis/OpenLane, CDC/RDC, PPA, and review
  evidence exist.

### ChatEDA and EDA Corpus

- ChatEDA repo: https://github.com/wuhy68/ChatEDA
- ChatEDA paper: https://wuhy68.github.io/paper/TCAD24-ChatEDA.pdf
- EDA Corpus paper: https://arxiv.org/abs/2405.06676
- EDA Corpus repo: https://github.com/OpenROAD-Assistant/EDA-Corpus
- Use: LLM agents and datasets for EDA tool interaction, especially OpenROAD
  command/script assistance.
- E1 fit: reference data for an internal assistant that explains OpenROAD logs
  and suggests reproducible Tcl/config sweeps.

### LLM-Powered EDA Log Analysis

- Berkeley technical report:
  https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-48.html
- Use: structured synthesis/place-and-route log extraction, issue clustering,
  and advisory fix triage.
- E1 fit: high-value for the existing read-only local RAG/log-triage lane,
  especially for OpenLane, synthesis, formal, and simulator failure logs. Any
  suggested HDL, SDC, Tcl, or script fix stays quarantined until deterministic
  local gates and review pass.

## Circuit foundation models and embeddings

### ChipNeMo and ChipLingo

- ChipNeMo:
  https://research.nvidia.com/publication/2023-10_chipnemo-domain-adapted-llms-chip-design
- NeMo framework: https://github.com/NVIDIA/NeMo
- ChipLingo: https://arxiv.org/abs/2604.27415
- Use: domain-adapted EDA LLMs for assistant Q&A, EDA script generation, bug
  summarization, RAG, and chip-design benchmark tasks.
- E1 fit: corpus-governance pattern only. E1 does not yet have a reviewed
  training corpus, release-safe data export policy, public ChipNeMo weights, or
  held-out local EDA tasks that can justify a model-quality claim.

### GenEDA, NetTAG, and DeepGate4

- GenEDA: https://arxiv.org/abs/2504.09485
- NetTAG: https://arxiv.org/abs/2504.09260
- DeepGate4: https://www.emergentmind.com/papers/2502.01681
- Circuit foundation model survey: https://arxiv.org/abs/2504.03711
- Use: align graph, text, RTL, netlist, layout, and AIG representations so
  models can reason about circuit function, retrieve related artifacts, or feed
  downstream predictors.
- E1 fit: target capture only. Embeddings and generated netlist-function
  summaries are not evidence until tied to local artifact hashes, held-out
  tasks, formal/synthesis checks, and human review.

## DFM, yield, lithography, and OPC

### Hotspot detection

- Litho-aware ML hotspot detection:
  https://pdxscholar.library.pdx.edu/ece_fac/529/
- DLHSD code/models: https://github.com/phdyang007/dlhsd
- LithoHoD: https://arxiv.org/abs/2409.10021
- Pegasus LPA:
  https://www.cadence.com/en_US/home/tools/digital-design-and-signoff/silicon-signoff/layout-pattern-analyzer.html
- Use: detect or localize lithography hotspot patterns before mask release,
  with production tools mixing pattern matching, ML, and implementation-flow
  integration.
- E1 fit: target capture only. Hotspot detectors need local GDS/DEF clips,
  layer maps, process decks, focus/dose windows, labels, false-positive review,
  and foundry or human DFM disposition.

### Differentiable lithography and OPC

- TorchLitho: https://github.com/TorchOPC/TorchLitho
- OpenILT: https://github.com/OpenOPC/OpenILT
- DiffOPC: https://arxiv.org/abs/2408.08969
- Use: research-grade lithography simulation, inverse lithography, and
  gradient-based OPC/mask optimization.
- E1 fit: blocked backend inventory. These flows can guide future experiments,
  but E1 has no foundry-approved process kernels, resist models, mask rules, or
  release-safe layout clips.

### Wafer and manufacturing defect models

- RadAI WM-811K wafer defect model:
  https://huggingface.co/radai-agent/radai-wm811k-defect-detection
- Use: classify wafer-map defect patterns after fabrication.
- E1 fit: post-fabrication reference only. E1 has no wafer maps, lot/die
  provenance, inspection images, or measured defect labels, so public weights
  must not be downloaded or used for yield claims.

## CPU microarchitecture AI and simulator-backed DSE

### Agentic and fast performance-model search

- Agentic Architect: https://arxiv.org/abs/2604.25083
- PerfVec: https://github.com/PerfVec/PerfVec
- Concorde:
  https://www.catalyzex.com/paper/concorde-fast-and-accurate-cpu-performance
- ChampSim: https://champsim.github.io/ChampSim/master/
- Use: automate or accelerate CPU architecture sweeps across branch predictors,
  cache replacement, prefetchers, and broader microarchitecture configurations.
- E1 fit: target capture only. Any suggested BPU/cache/prefetch policy needs
  trace provenance, simulator configs, before/after logs, RTL cost, synthesis,
  formal/cocotb, benchmark evidence, and review.

### Branch prediction

- BranchNet: https://github.com/siavashzk/BranchNet
- LLBP: https://github.com/dhschall/LLBP
- Use: neural helper prediction for hard-to-predict branches and high-capacity
  branch-predictor state backed by simulation.
- E1 fit: comparison source only. Learned branch predictors or larger BPU state
  must not enter RTL without local MPKI, timing, area, power, and BPU regression
  evidence.

### Prefetch and cache replacement

- Pythia: https://github.com/CMU-SAFARI/Pythia
- Mockingjay:
  https://par.nsf.gov/servlets/purl/10334308
- Drishti: https://www.cse.iitb.ac.in/~biswa/MICRO25.pdf
- Use: reinforcement-learning prefetching and learned/recent LLC replacement
  policies, usually evaluated in ChampSim-style trace simulation.
- E1 fit: blocked backend inventory. Cache/prefetch wins must be measured on
  approved traces and promoted through cache hierarchy, memory/UMA, RTL,
  synthesis, power, and benchmark gates.

## Compiler autotuning, RVV codegen, and profile-guided binaries

### ML-guided compiler heuristics

- LLVM MLGO: https://llvm.org/docs/MLGO.html
- Google ML Compiler Opt: https://github.com/google/ml-compiler-opt
- Use: replace compiler heuristics such as inlining or register-allocation
  choices with learned policies trained from corpora.
- E1 fit: blocked compiler infrastructure. Toolchain, corpus, model, and
  benchmark evidence must exist before ML-guided compiler decisions can affect
  any binary.

### Tensor-kernel schedule search

- TVM MetaSchedule:
  https://tvm.apache.org/docs/deep_dive/tensor_ir/tutorials/meta_schedule.html
- Ansor: https://arxiv.org/abs/2006.06762
- Use: search schedules for tensor kernels and operator implementations.
- E1 fit: target capture only. E1 needs a real target, workload corpus,
  simulator/runtime logs, and before/after benchmarks before schedule search
  can tune CPU/RVV fallback or NPU host kernels.

### Profile-guided and post-link optimization

- AutoFDO: https://github.com/google/autofdo
- LLVM Propeller: https://github.com/google/llvm-propeller
- BOLT:
  https://github.com/llvm/llvm-project/tree/main/bolt
- Use: use sampled profiles or binary instrumentation to reorder code, improve
  locality, and optimize hot paths.
- E1 fit: blocked until profile capture, compiler stage 2, binary hashes,
  benchmark metadata, and rollback evidence exist.

### RVV and SIMD generation

- IntrinTrans: https://arxiv.org/abs/2510.10119
- VecIntrinBench: https://arxiv.org/abs/2511.18867
- SimdBench: https://arxiv.org/abs/2507.15224
- xDSL RVV lowering: https://arxiv.org/abs/2603.17800
- Use: generate, migrate, or lower SIMD/RVV intrinsic code and benchmark model
  quality on vector tasks.
- E1 fit: quarantined-code workflow only. Generated intrinsics or lowerings must
  pass compile, disassembly, simulator correctness, runtime-contract, and
  benchmark gates before review.

### Agentic compiler optimization

- Agentic Code Optimization:
  https://arxiv.org/abs/2604.04238
- HINTPILOT:
  https://openreview.net/pdf/1dad91bc6d5c443a15d5e88f1504a5532cfde1b0.pdf
- LLM-VeriOpt: https://samainsworth.github.io/LLM-VeriOpt-CGO2026.pdf
- Use: LLM/agent loops that use compiler diagnostics, tests, verification, or
  hints to rewrite code or guide compiler decisions.
- E1 fit: target capture only. Generated source, hints, and profiles need local
  semantic tests, compile logs, performance logs, and human disposition.

## Reliability, aging, EM, and resilience

### Aging and electromigration

- PROTON: https://doi.org/10.1109/SMACD58065.2023.10192229
- EMspice 2.0: https://par.nsf.gov/servlets/purl/10542838
- NBTI/HCI aging models: https://zenodo.org/records/2558154
- Use: assess BTI/HCI aging, electromigration, thermomigration, IR drop, and
  lifetime risks from process, PDN, thermal, activity, and mission-profile
  inputs.
- E1 fit: target capture only. E1 lacks process-qualified aging/EM models,
  routed current-density evidence, calibrated activity, mission profiles, and
  signoff decks, so these methods cannot support lifetime or reliability
  claims yet.

### Soft-error and fault-injection campaigns

- SOFIA:
  https://www.sciencedirect.com/science/article/pii/S1383762122002028
- Arm Ethos-U55 soft-error study: https://arxiv.org/abs/2404.09317
- Ibex SEU formal evaluation: https://arxiv.org/abs/2405.12089
- Hamartia:
  https://research.nvidia.com/publication/2018-06_hamartia-fast-and-accurate-error-injection-framework
- FIES: https://github.com/ahoeller/fies
- Use: run or structure RTL, formal, simulator, QEMU, and workload-level fault
  campaigns; rank vulnerable state and compare mitigations.
- E1 fit: blocked from execution until there is an E1 fault-library schema,
  fault-site manifest, seed policy, pass/fail taxonomy, deterministic logs, and
  review path.

### Compiler and workload reliability

- BEC: https://arxiv.org/abs/2401.05753
- TensorFI: https://github.com/DependableSystemsLab/TensorFI
- Ares: https://alugupta.github.io/ares/
- Use: prune fault campaigns, transform software for soft-error resilience, or
  inject faults into ML workloads to assess output sensitivity.
- E1 fit: useful future bridge between compiler, runtime, and NPU evidence, but
  it needs exact source/model/input/runtime hashes and simulator or hardware
  correlation.

### ECC and error-handling references

- Caliptra error injection and SRAM ECC requirements:
  https://github.com/chipsalliance/caliptra-rtl/blob/main/docs/CaliptraIntegrationSpecification.md
- Use: learn from an open security IP's distinction between intrusive and
  non-intrusive error injection, ECC, error logging, and firmware-visible
  error-handling requirements.
- E1 fit: requirements inspiration only. ECC, TMR, replay, redundancy, or
  selective-hardening proposals must pass RTL/spec, cocotb/formal, synthesis,
  firmware contract, and review gates before source changes.

## Synthesis, timing, power, and routability predictors

### OpenABC-D

- Repo: https://github.com/NYU-MLDA/OpenABC
- Paper: https://arxiv.org/abs/2110.11292
- Use: ML dataset from Yosys/ABC synthesis recipes with AIGs, area, delay, and
  recipe labels.
- E1 fit: early predictor/sweep policy for Yosys/ABC recipes before full PD.

### CircuitNet

- Repo: https://github.com/circuitnet/CircuitNet
- Site: https://circuitnet.github.io/
- CircuitNet 2.0 paper: https://openreview.net/forum?id=nMFSUjxMIl
- CircuitNet 3.0 dataset:
  https://huggingface.co/datasets/SKLP-EDA-LAB/CircuitNet3.0
- MetRex dataset: https://huggingface.co/datasets/scale-lab/MetRex
- MetRex paper: https://arxiv.org/abs/2411.03471
- Use: ML datasets/code for congestion, DRC, IR drop, and net-delay prediction.
- E1 fit: train/evaluate risk predictors from DEF/netlist features once E1 has
  enough generated PD runs.

### Timing Closure and ECO

- TimingPredict: https://github.com/PKU-IDEA/TimingPredict
- E2ESlack: https://arxiv.org/abs/2501.07564
- TimingLLM: https://arxiv.org/abs/2604.23602
- FluxEDA: https://arxiv.org/abs/2603.25243
- AstroTune: https://doi.org/10.1145/3764386.3779579
- OpenROAD Resizer:
  https://openroad.readthedocs.io/en/latest/main/src/rsz/README.html
- OpenPhySyn: https://github.com/scale-lab/OpenPhySyn
- Learning-driven gate sizing: https://arxiv.org/abs/2403.08193
- FusionSizer:
  https://yibolin.com/publications/papers/OPT_ICCAD2024_Du.pdf
- 2024 ICCAD gate-sizing benchmark:
  https://github.com/ASU-VDA-Lab/2024_ICCAD_Contest_Gate_Sizing_Benchmark
- IR-aware ECO RL: https://dl.acm.org/doi/10.1145/3670474.3685945
- Use: predict timing risk, triage STA reports, study AST/retrieval-assisted
  cross-stage parameter tuning, and study gate-sizing, buffer-insertion,
  pin-swapping, gate-cloning, and localized ECO search.
- E1 fit: advisory capture only. The local lane hashes SDC, OpenLane metrics,
  STA/resizer reports, PD signoff manifests, and known blockers, while every
  write-capable config, Tcl, or ECO remains blocked until before/after netlist,
  DEF/ODB, timing, power, DRC, antenna, manufacturing, and signoff evidence
  exists.

### Routing, Congestion, and DRC

- OpenROAD FastRoute:
  https://openroad.readthedocs.io/en/latest/main/src/grt/README.html
- OpenROAD TritonRoute:
  https://openroad.readthedocs.io/en/latest/main/src/drt/README.html
- CU-GR: https://github.com/cuhk-eda/cu-gr
- Dr.CU: https://github.com/cuhk-eda/dr-cu
- RoutePlacer / RouteGNN: https://arxiv.org/abs/2406.02651
- CircuitNet and CircuitNet 2.0:
  https://github.com/circuitnet/CircuitNet
- Use: global-routing and detailed-routing evidence capture, routability risk
  prediction, congestion/overflow/DRC triage, wirelength/via/antenna label
  capture, and future router-parameter search.
- E1 fit: target capture only. The local lane may hash route logs, route
  guides, routed DEF/ODB references, DRC reports, antenna reports, wirelength
  reports, PD configs, and signoff manifests, but no route guide, DEF, ODB,
  GDS, Tcl, DRC fix, router parameter, or predictor output can enter source or
  release evidence without before/after OpenLane/OpenROAD, DRC, antenna, STA,
  power, manufacturing, and signoff gates.

### Clock Tree and Clock Network

- OpenROAD CTS:
  https://openroad.readthedocs.io/en/latest/main/src/cts/README.html
- TritonCTS: https://github.com/The-OpenROAD-Project/TritonCTS
- GAN-CTS: https://gtcad.gatech.edu/www/papers/08942063.pdf
- CTS-Bench: https://arxiv.org/abs/2602.19330
- OpenROAD two-phase clocking conversion: https://arxiv.org/abs/2605.05374
- Use: CTS report capture, skew/latency/clock-buffer label capture, post-CTS
  hold-risk triage, useful-skew candidate review, CTS benchmark/task design,
  and research-only clocking-conversion tracking.
- E1 fit: target capture only. The local lane may hash CTS reports, clock and
  skew reports, post-CTS timing repair logs, DEF/ODB snapshots, SDC inputs, and
  signoff manifests, but generated clock trees, clock constraints, Tcl, useful
  skew, clock-buffer edits, latch/two-phase conversion, model predictions, and
  signoff claims remain blocked until before/after STA, DFT, CDC/RDC, power,
  routing, manufacturing, and PD signoff evidence exists.

### Extraction, SPEF, and Parasitics

- OpenROAD OpenRCX:
  https://openroad.readthedocs.io/en/latest/main/src/rcx/README.html
- OpenLane timing-corner flow:
  https://openlane2.readthedocs.io/en/latest/usage/timing_corners.html
- Magic extraction: http://opencircuitdesign.com/magic/
- CapBench: https://github.com/THU-numbda/CapBench
- Use: SPEF/RCX log capture, Magic extracted SPICE capture, SDF and
  timing-corner manifest capture, parasitic-feature label construction,
  capacitance-extraction benchmark tracking, and future SI/crosstalk triage.
- E1 fit: target capture only. The local lane may hash OpenRCX SPEFs, RCX logs,
  Magic SPICE output, SDF files, multi-corner STA evidence, timing-corner
  manifests, and signoff references, but generated SPEF, SDF, SPICE, extraction
  rules, SI waivers, RC predictions, model runs, and timing/signoff claims stay
  blocked until before/after extraction, STA, DRC/LVS, antenna, route, power,
  and signoff evidence exists.

## Low-power intent, DVFS, and clock gating

### IEEE 1801 UPF

- Standard: https://standards.ieee.org/ieee/1801/11890/
- Open examples: https://opensource.ieee.org/upf
- Use: express power intent for power domains, supply sets, power states,
  isolation, retention, level shifting, and power-aware verification.
- E1 fit: required before any real low-power/power-domain claim. Current E1
  work should only capture target tasks because the repo does not yet have a
  power-state table, always-on partition, supply-set map, UPF source,
  power-aware simulation, or formal low-power verification backend.

### Yosys `clockgate`

- Docs: https://yosyshq.readthedocs.io/projects/yosys/en/0.46/cmd/clockgate.html
- Repo: https://github.com/YosysHQ/yosys
- Use: transform groups of flip-flops with shared clock enables into integrated
  clock-gating cells for ASIC-oriented power reduction.
- E1 fit: future backend candidate only. Gated clocks can break scan, reset,
  CDC/RDC, glitch, enable-polarity, and timing assumptions, so any output needs
  equivalence, RTL checks, formal, synthesis, DFT, CDC/RDC, STA, and measured or
  signoff power evidence before promotion.

### CODMAS / RTLOPT

- Paper: https://arxiv.org/abs/2603.17204
- Use: multi-agent RTL optimization with deterministic syntax, functional, and
  PPA evaluation. RTLOPT includes pipelining and clock-gating optimization
  triples.
- E1 fit: useful benchmark pattern for future low-power RTL edits, but
  generated clock-gating remains outside source until local equivalence,
  timing, scan, and power gates exist.

### Prompting for Power

- Paper: https://openreview.net/pdf?id=mcWpM985ej
- Use: benchmark LLMs for low-power RTL generation with clock gating, operand
  isolation, and logic restructuring prompt templates.
- E1 fit: prompt/evaluation context only. Low-power idioms generated by an LLM
  cannot be evidence without functional, synthesis, power, and review gates.

### POET

- Paper: https://arxiv.org/abs/2603.19333
- Use: power-first LLM-based RTL PPA search using deterministic simulation as an
  oracle and Pareto ranking toward lower power.
- E1 fit: future search method only after E1 has deterministic oracle tests,
  before/after power labels, synthesis/timing evidence, and artifact isolation.

### Simple Operator Graph RTL PPA estimation

- Paper: https://arxiv.org/abs/2502.16203
- Use: pre-synthesis RTL power, performance, and area estimation from HDL and
  library-derived features.
- E1 fit: complementary to RTL PPA advisory work, but blocked until E1 has a
  held-out synthesis and power-label corpus.

### OpenROAD two-phase clocking conversion

- Paper: https://arxiv.org/abs/2605.05374
- Repo: https://github.com/The-OpenROAD-Project/OpenROAD-flow-scripts
- Use: automated flip-flop to two-phase latch-based conversion using Yosys, ABC,
  dual clock-tree synthesis, correctness validation, and RTL-to-GDS flow.
- E1 fit: research-only for now. Latch/two-phase conversion is far beyond the
  current scaffold until baseline timing, CTS, equivalence, scan, and signoff
  evidence are clean.

## DFT and manufacturing test

### Fault / OpenROAD DFT

- Fault repo: https://github.com/AUCOHL/Fault
- WOSET paper: https://woset-workshop.github.io/PDFs/2019/a13.pdf
- OpenROAD DFT docs: https://openroad.readthedocs.io/en/latest/main/src/dft/README.html
- Use: scan insertion, scan-chain stitching, ATPG, and open DFT infrastructure.
- E1 fit: add a future DFT evidence lane after synthesis/placement maturity.

### ML ATPG

- InF-ATPG: https://arxiv.org/abs/2512.00079
- AI ATPG survey:
  https://blog.wangxm.com/wp-content/uploads/2024/12/ATPG_via_AI__A_Survey_for_Machine_Learning_in_Test_Generation.pdf
- Use: RL/ML approaches for ATPG search.
- E1 fit: roadmap item after conventional DFT artifacts exist.

## Post-silicon validation, bring-up, and lab debug

### Symbolic QED and SoC trace debug

- Symbolic QED: https://theory.stanford.edu/~barrett/pubs/LSB+15-abstract.html
- SoC protocol trace debug: https://arxiv.org/abs/2005.02550
- Use: shorten post-silicon bug-detection latency and reconstruct protocol
  behavior from partial traces.
- E1 fit: future FPGA/silicon debug methodology only. Current E1 lacks hardware
  traces, JTAG/UART/power logs, protocol-observation points, and a lab trace
  schema.

### RISC-V DV, RISCOF, and architectural tests

- RISC-V DV: https://github.com/chipsalliance/riscv-dv
- RISCOF docs: https://riscof.readthedocs.io/en/doc-dependency-fix/intro.html
- RISC-V architectural tests: https://github.com/riscv/riscv-arch-test
- Use: random instruction generation, RISC-V compatibility testing, ISS
  comparison, and compliance-oriented evidence.
- E1 fit: required for future CPU/AP validation, but blocked until E1 has a
  buildable RISC-V DUT wrapper, pinned external suite revisions, ISS setup, and
  executed logs/signatures.

### Cross-target chip tests and ML boot debug

- OpenTitan chip tests:
  https://opentitan.org/book/sw/device/tests/index.html
- ML/XAI boot-failure debug:
  https://rei.iteso.mx/items/d449d907-2591-4969-b402-1f32bee002ab
- LLM4SecHW: https://arxiv.org/abs/2401.16448
- Use: structure tests that can run across simulation, FPGA, and silicon; learn
  from labeled boot-failure telemetry; triage hardware defects with LLMs.
- E1 fit: target capture only. Generated lab scripts, test binaries, root-cause
  reports, or fixes require local target IDs, logs, traces, deterministic gates,
  and human review.

## Recommended order for E1

1. OpenROAD AutoTuner around the existing PD scripts.
2. LLM4DV-style coverage-directed cocotb stimulus.
3. AssertionForge/AssertEval patterns for candidate SVA, reviewed before use.
4. ZigZag for NPU architecture/mapping exploration.
5. CircuitOps/CircuitNet/OpenABC-D once there are enough local E1 run labels.
6. Low-power target capture with
   `scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation`.
   Do not generate UPF, gated clocks, DVFS policy, retention/isolation logic, or
   power-domain artifacts until deterministic low-power evidence gates exist.
7. Verification-debug target capture with
   `scripts/ai_eda/capture_verification_debug_targets.py --run-id validation`.
   Do not generate or promote verification plans, testbenches, UVM collateral,
   SVAs, coverage claims, root-cause reports, or RTL fixes without local
   deterministic gates and review.
8. Post-silicon validation target capture with
   `scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id validation`.
   Do not generate or promote lab scripts, test binaries, hardware actions,
   compliance claims, RISC-V debug claims, silicon bring-up claims, or
   lab-debug reports without local QEMU/Renode, FPGA, board/package, OpenOCD
   transcripts, sigrok raw-capture hashes, manufacturing, real-world, and
   review evidence.
9. Circuit foundation model target capture with
   `scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id validation`.
   Do not export training corpora, generate embeddings, train/fine-tune models,
   run inference, or make model-quality/design-decision claims without local
   provenance, held-out tasks, deterministic gates, and review.
10. DFM/yield/lithography target capture with
    `scripts/ai_eda/capture_dfm_yield_lithography_targets.py --run-id validation`.
    Do not run hotspot detectors, lithography simulation, OPC/ILT, wafer-defect
    models, or make DFM/yield/mask claims without foundry/process collateral,
    local layout labels, deterministic signoff gates, and review.
11. CPU microarchitecture AI target capture with
    `scripts/ai_eda/capture_cpu_microarchitecture_targets.py --run-id validation`.
    Do not generate BPU/cache/prefetch RTL, run unreviewed simulators/models, or
    claim IPC/MPKI/product gains without local traces, deterministic RTL and
    benchmark gates, and review.
12. Compiler autotuning target capture with
    `scripts/ai_eda/capture_compiler_autotuning_targets.py --run-id validation`.
    Do not generate RVV intrinsics, tune schedules, embed MLGO models, apply
    AutoFDO/Propeller/BOLT profiles, or claim binary/kernel speedups without
    pinned toolchains, correctness tests, simulator/runtime logs, benchmark
    evidence, and review.
13. Reliability and resilience target capture with
    `scripts/ai_eda/capture_reliability_resilience_targets.py --run-id validation`.
    Do not run fault injection, aging/EM analysis, or generated mitigations, and
    do not claim reliability, lifetime, SER, EM/IR, or safety closure without
    process models, mission profiles, fault manifests, simulator/formal logs,
    PD/signoff evidence, before/after PPA, and review.
14. External model/corpus intake target capture with
    `scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation`.
    Do not download HuggingFace/GitHub models or datasets, export local corpora,
    train, fine-tune, run inference, run evaluation, or promote generated source
    without exact revisions, license review, file manifests, contamination
    checks, quarantine paths, deterministic local gates, and review.
15. Benchmark contamination and evaluation hygiene target capture with
    `scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation`.
    Do not import public HDL benchmarks, export held-out E1 prompts, run models,
    run contamination detectors, generate RTL, or make benchmark score claims
    without exact revisions, task hashes, license review, non-overlap reports,
    near-duplicate checks, deterministic local gates, and review.
16. EDA tool-agent interoperability target capture with
    `scripts/ai_eda/capture_eda_tool_agent_interop_targets.py --run-id validation`.
    Do not start MCP servers, call commercial copilots, invoke EDA tools,
    generate Tcl/shell/constraints/waivers/source, or claim productivity, PPA,
    signoff, or release readiness without typed command schemas, explicit
    read/write scopes, license and data-handling review, local replay
    manifests, deterministic gates, and review.
17. Spec-to-RTL traceability target capture with
    `scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation`.
    Do not change requirements, specs, RTL, assertions, or testbenches, and do
    not generate trace matrices, SVAs, patches, or requirement-coverage claims
    without stable requirement IDs, source hashes, non-overlap review, vacuity
    checks, deterministic local gates, and review.
18. IP/register/platform-contract target capture with
    `scripts/ai_eda/capture_ip_register_contract_targets.py --run-id validation`.
    Do not import external IP, run register generators or EDA flows, edit
    memory maps, headers, device trees, drivers, or RTL, or claim register/ABI
    correctness without pinned revisions, license review, generated output
    hashes, ABI diffs, deterministic local gates, and review.
19. Memory macro/library target capture with
    `scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation`.
    Do not download PDKs or macros, import external memory collateral, run
    OpenRAM/DFFRAM/CACTI/DESTINY/NVSim/NeuroSim or AI estimators, edit RTL, PD
    configs, Liberty, LEF, or GDS, or claim SRAM area, timing, power, Vmin,
    yield, signoff, or release readiness without pinned revisions, generated
    artifact hashes, DRC/LVS/extraction, STA, OpenLane evidence, deterministic
    local gates, and review.
20. Chiplet/2.5D/3DIC/package co-design target capture with
    `scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id validation`.
    Do not generate chiplet partitions, interposer layouts, die-to-die
    interfaces, package or bump maps, SI/PI/thermal models, architecture edits,
    RTL edits, PD configs, board/package edits, simulator outputs, or
    cost/yield/performance/signoff claims without exact revisions,
    source/license review, package and architecture constraints, deterministic
    local gates, and review.
21. Logic synthesis and technology-mapping target capture with
    `scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation`.
    Do not generate or apply ABC/Yosys recipes, technology mappings,
    constraints, netlists, or gate-level rewrites, and do not claim area,
    timing, power, equivalence, signoff, or release improvement without exact
    tool/model revisions, source/script hashes, output hashes, formal or
    equivalence evidence, deterministic synthesis/STA/OpenLane/power gates, and
    review.
22. Netlist equivalence and LEC target capture with
    `scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation`.
    Do not run EQY, Yosys equivalence commands, ABC CEC, CIRCT LEC, or
    generated LEC harnesses, and do not generate miters, waivers, proof logs,
    RTL, netlists, scripts, or optimization patches without exact tool/solver
    revisions, input/output hashes, black-box, memory, reset, x-propagation,
    hierarchy, and clock assumptions, deterministic formal/simulation/
    synthesis/STA/OpenLane/power gates, and review.
23. Physical verification, DRC/LVS, and antenna target capture with
    `scripts/ai_eda/capture_physical_verification_targets.py --run-id validation`.
    Do not run KLayout, Magic, Netgen, OpenROAD/OpenLane signoff steps, DRC,
    LVS, XOR, antenna checks, generated DRC decks, layout fixes, waivers, Tcl,
    or patches, and do not claim DRC, LVS, antenna, physical signoff, or release
    readiness without pinned tool and rule-deck revisions, layout/netlist
    hashes, before/after deterministic logs, extraction/STA/power/
    manufacturing/commercial-EDA gates where applicable, and review.
24. Placement, legalization, density, and generative placement target capture
    with
    `scripts/ai_eda/capture_placement_legalization_targets.py --run-id validation`.
    Do not run OpenROAD/OpenLane placement, external placers, diffusion or
    flow-matching models, benchmark imports, density/padding edits, legalizer
    changes, filler placement, Tcl, or patches, and do not claim placement QoR,
    timing, routability, signoff, or release readiness without pinned tool,
    model, data, config, DEF/ODB, legalizer, route, STA, physical-verification,
    power, and reviewer evidence.
25. Floorplan, IO placement, tapcell, and PDN target capture with
    `scripts/ai_eda/capture_floorplan_io_pdn_targets.py --run-id validation`.
    Do not run OpenROAD/OpenLane floorplanning, generated floorplans,
    pin-assignment optimizers, tap/endcap changes, PDN generation, NL-to-GDS
    agents, benchmark imports, Tcl, or patches, and do not claim floorplan,
    pinout, PDN, signoff, or release readiness without pinned tool/data/config
    revisions, package and padframe cross-probe, SI/PI, route, STA,
    DRC/LVS/antenna, power, manufacturing, commercial-EDA where applicable, and
    reviewer evidence.
