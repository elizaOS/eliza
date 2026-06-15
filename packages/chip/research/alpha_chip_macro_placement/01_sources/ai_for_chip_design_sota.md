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

### Verification Planning, Debug, UVM, and Repair

- PRO-V paper: https://arxiv.org/abs/2506.12200
- PRO-V repo: https://github.com/stable-lab/Pro-V
- AutoBench paper: https://arxiv.org/abs/2407.03891
- AutoBench repo: https://github.com/AutoBench/AutoBench
- Project Ava: https://projectava.dev/
- HAVEN UVM paper: https://arxiv.org/abs/2604.27643
- HAVEN HDL benchmark:
  https://huggingface.co/datasets/mcc311/haven-hdl-benchmark
- CorrectBench: https://arxiv.org/abs/2411.08510 and
  https://github.com/AutoBench/CorrectBench
- UVLLM: https://arxiv.org/abs/2411.16238
- UVM2: https://arxiv.org/abs/2504.19959
- VerifLLMBench:
  https://dvcon-proceedings.org/document/verifllmbench-an-open-source-benchmark-for-testbenches-generated-with-large-language-models/
- VerilogCoder repo: https://github.com/NVlabs/VerilogCoder
- Saarthi paper: https://arxiv.org/abs/2502.16662
- SANGAM paper: https://arxiv.org/abs/2506.13983
- FVDebug paper: https://arxiv.org/abs/2510.15906
- AssertSolver: https://arxiv.org/abs/2503.04057,
  https://github.com/SEU-ACAL/reproduce-AssertSolver-DAC-25, and
  https://huggingface.co/1412312anonymous/AssertSolver
- SiliconMind-V1 paper: https://arxiv.org/abs/2603.08719
- SiliconMind-V1 model:
  https://huggingface.co/AS-SiliconMind/SiliconMind-V1-Qwen3-8B
- MEIC: https://arxiv.org/abs/2405.06840 and
  https://github.com/SEU-ACAL/reproduce-MEIC-ICCAD
- R3A: https://arxiv.org/abs/2511.20090
- Clover RTL Repair: https://arxiv.org/abs/2604.17288
- Surelog: https://github.com/chipsalliance/Surelog
- UHDM: https://github.com/chipsalliance/UHDM
- Verible: https://github.com/chipsalliance/verible
- sv-tests: https://github.com/chipsalliance/sv-tests
- slang: https://github.com/MikePopoloski/slang
- Use: agentic verification planning, testbench/oracle generation,
  self-correcting simulation-repair loops, UVM/testbench synthesis,
  coverage-driven UVM planning, benchmark-governed generated testbench
  evaluation, waveform tracing, formal-counterexample triage, assertion
  self-refinement, deterministic SystemVerilog frontend/lint/compliance
  hygiene for generated collateral, Verilog debug reasoning, and RTL
  repair-search governance.
- E1 fit: add only target capture for now. Generated verification plans,
  testbenches, UVM components, coverage waivers, assertions, root-cause reports,
  localizations, repair traces, and patches need local RTL/spec hashes,
  parser/lint/elaboration diagnostics, unsupported-construct reports,
  prompt/model logs, oracle-independence review, cocotb/formal logs,
  synthesis/equivalence where applicable, and human review before promotion.

### ZigZag

- Repo: https://github.com/KULeuven-MICAS/zigzag
- Timeloop / Accelergy: https://github.com/NVlabs/timeloop
- SCALE-Sim: https://github.com/scalesim-project/scale-sim-v2
- Use: DNN accelerator architecture and mapping design-space exploration with
  ONNX parsing, memory hierarchy modeling, systolic-array traffic simulation,
  and energy/latency analysis.
- E1 fit: target capture only before hardening NPU RTL. Use these to frame MAC
  array, SRAM, bandwidth, dataflow, and mapping experiments after exact
  architecture configs, workloads, SRAM/banking assumptions, output hashes, and
  calibration evidence exist.

### CircuitOps / OpenROAD Python APIs

- NVIDIA publication:
  https://research.nvidia.com/labs/electronic-design-automation/publication/chhabria2024openroad/
- Use: ML-oriented EDA representation from OpenROAD database snapshots.
- E1 fit: create project-specific graph snapshots and PPA labels from E1
  OpenROAD runs. Useful once there are enough repeated E1 PD runs to train or
  validate predictors.

### Analog and mixed-signal agents

- AnalogAgent paper: https://arxiv.org/abs/2603.23910
- AutoSizer paper: https://arxiv.org/abs/2602.02849
- EasySize paper: https://arxiv.org/abs/2508.05113
- Self-calibrating analog sizing equations:
  https://arxiv.org/abs/2604.07387
- ngspice simulator: https://ngspice.sourceforge.io/
- PySpice orchestration: https://github.com/PySpice-org/PySpice
- Xyce simulator: https://github.com/Xyce/Xyce
- OpenVAF Verilog-A compiler: https://github.com/pascalkuthe/OpenVAF
- BAG3++ / Berkeley Analog Generator:
  https://bag3-readthedocs.readthedocs.io/,
  https://github.com/bluecheetah/bag
- OpenFASOC generators: https://github.com/idea-fasoc/OpenFASOC
- laygo2 layout generator: https://github.com/niftylab/laygo2
- MAGICAL analog layout flow: https://github.com/magical-eda/MAGICAL
- EEsizer / LLM transistor sizing:
  https://github.com/eelab-dev/LLM-transistor-sizing
- AnalogMaster paper: https://arxiv.org/abs/2604.20916
- VLM-CAD paper: https://arxiv.org/abs/2601.07315
- CircuitLM paper: https://arxiv.org/abs/2601.04505
- EEschematic paper: https://arxiv.org/abs/2510.17002
- AnalogCoder-Pro paper: https://arxiv.org/abs/2508.02518
- AnalogCoder code: https://github.com/laiyao1/AnalogCoder
- AMS-Net dataset site: https://ams-net.github.io/
- Analog layout VLM dataset:
  https://huggingface.co/datasets/anonymousUser2/Analog_Dataset_VLM
- Analog SPICE Circuits on SKY130:
  https://huggingface.co/datasets/pphilip/analog-circuits-sky130
- SPICEPilot paper/code:
  https://arxiv.org/abs/2410.20553,
  https://github.com/ACADLab/SPICEPilot
- AnalogSeeker paper/model/data:
  https://arxiv.org/abs/2508.10409,
  https://huggingface.co/analogllm/analog_model,
  https://huggingface.co/datasets/analogllm/analog_data
- Use: schematic/image/netlist parsing, analog topology generation, sizing,
  deterministic SPICE replay, Python ngspice orchestration, cross-simulator
  triage, Verilog-A model compilation, deterministic generator/layout backend
  replay, SPICE/ngspice feedback loops, SPICE-generation benchmark review,
  LLM-generated design equations, VLM-grounded explainability, and analog
  schematic/netlist/layout/SPICE dataset and model governance.
- E1 fit: target capture only. Do not generate SPICE, schematics, CircuitJSON,
  analog layouts, padframe changes, foundry IP, external model inference,
  corpus imports, or reusable analog memories for E1 until exact prompts, model
  versions, memory/search snapshots, dataset snapshots, generated dimension
  quarantine, design-equation traceability, simulator/model/compiler revisions,
  generator/template/technology provenance, SPICE/testbench decks, generated
  schematic/layout hashes, raw output hashes, convergence logs, PVT/corner
  sweeps, DRC/LVS/extraction, package/SI-PI evidence, split and non-overlap
  review, and human analog review exist.

### Board, Package, and FPGA Automation

- PCBSchemaGen: https://arxiv.org/abs/2602.00510
- OmniSch: https://arxiv.org/abs/2604.00270
- Circuitron: https://github.com/Shaurya-Sethi/circuitron
- PCB-Bench: https://github.com/digailab/PCB-Bench
- KiCad: https://gitlab.com/kicad/code/kicad
- KiBot: https://github.com/INTI-CMNB/KiBot
- KiKit: https://github.com/yaqwsx/KiKit
- InteractiveHtmlBom: https://github.com/openscopeproject/InteractiveHtmlBom
- KiCad StepUp: https://github.com/easyw/kicadStepUpMod
- KiCad JLCPCB Tools: https://github.com/Bouni/kicad-jlcpcb-tools
- PCBAgent:
  https://www.cse.cuhk.edu.hk/~byu/papers/C247-ASPDAC2025-PCBAgent.pdf
- NeurPCB: https://github.com/neurpcb/neurpcb
- PCB-Migrator: https://flians.github.io/pdf/PCBMigrator.pdf
- MARS-Place: https://www.sciencedirect.com/science/article/pii/S016792602600026X
- Freerouting: https://github.com/freerouting/freerouting
- DreamerV3+FR PCB autorouting:
  https://www.sciencedirect.com/science/article/abs/pii/S0957417426003374
- 3D LineExplore: https://www.nature.com/articles/s41598-026-36925-0
- OpenPARF: https://github.com/PKU-IDEA/OpenPARF
- VTR: https://github.com/verilog-to-routing/vtr-verilog-to-routing
- OpenFPGA: https://github.com/lnis-uofu/OpenFPGA
- FABulous: https://github.com/FPGA-Research-Manchester/FABulous
- Circuit Weaver: https://circuit-weaver.com/
- KiCad MCP Pro: https://github.com/oaslananka/kicad-mcp-pro
- Antmicro KiCad SI Wrapper:
  https://github.com/antmicro/kicad-si-simulation-wrapper
- openEMS: https://github.com/thliebig/openEMS
- gerber2ems: https://github.com/antmicro/gerber2ems
- Open Schematics dataset:
  https://huggingface.co/datasets/rifxyz/open-schematics
- GerberFormer model/data:
  https://huggingface.co/pulipakav-1/gerberformer,
  https://huggingface.co/datasets/pulipakav-1/gerberformer-results
- Use: schematic generation and visual QA, KiCad generation/review, MCP-based
  agent tooling, deterministic KiCad/KiBot/KiKit/BOM/ECAD-MCAD/vendor-export
  replay, component placement, layout migration, geometric and RL autorouting,
  SI simulation preprocessing, openEMS/gerber2ems electromagnetic replay, FPGA
  placement, FPGA CAD/fabric generation, schematic corpus governance, and
  manufacturing inspection.
- E1 fit: target capture only. Do not generate schematics, PCB layouts, routes,
  Gerbers, package edits, pinout edits, MCP write actions, SI simulation
  claims, FPGA outputs, generated fabric collateral, corpus imports, model
  inference, SI simulation outputs, or fabrication claims until package/
  padframe cross-probe, KiCad/KiBot/KiKit/export-tool revisions, ERC/DRC,
  BOM/fab/panel/assembly/CPL/STEP output hashes, 3D model and mechanical
  clearance provenance, stackup/net/port/mesh manifests, solver logs, SI/PI,
  DFM, RF/regulatory blockers, sourcing review, dataset/model provenance,
  pinned device/fabric constraints, timing-clean bitstreams, FPGA bring-up, and
  human review exist.

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

### OpenROAD RTLMP, BBO placement, and macro-placement benchmarks

- OpenROAD Hier-RTLMP:
  https://openroad.readthedocs.io/en/latest/main/src/mpl/README.html
- WireMask-BBO: https://arxiv.org/abs/2306.16844 and
  https://github.com/lamda-bbo/WireMask-BBO
- BBOPlace-Bench: https://arxiv.org/abs/2510.23472 and
  https://github.com/lamda-bbo/BBOPlace-Bench
- Macro Placement Challenge 2026:
  https://github.com/partcleda/macro-place-challenge-2026
- Use: deterministic macro-placement baseline, black-box optimization methods,
  and current benchmark/scoring references for macro-placement experiments.
- E1 fit: target capture only. Do not run macro placement, import challenge or
  benchmark assets, tune BBO loops, generate placements, or claim placement QoR
  until E1 has release-ready macro manifests, halos/blockages, legalizer replay,
  routing, STA, DRC/LVS, antenna, PDN/power, package constraints, benchmark
  non-overlap review, and reviewer signoff.

## Architecture exploration

### ArchGym

- Paper: https://arxiv.org/abs/2306.08888
- Docs: https://oss-archgym.readthedocs.io/en/documentation/installation.html
- Use: ML-assisted architecture design-space exploration around simulators.
- E1 fit: wrap NPU/cache/interconnect parameters around existing simulator and
  benchmark scripts before committing RTL changes.

### Memory, Interconnect, and NoC DSE

- AI-driven NoC DSE: https://arxiv.org/abs/2512.07877
- NOCTOPUS NoC topology optimization: https://link.springer.com/article/10.1007/s00521-026-12049-4
- FlooNoC: https://github.com/pulp-platform/FlooNoC
- MICSim: https://github.com/MICSim-official/MICSim_V1.0
- AutoNoC scalable NoC design: https://doi.org/10.1109/ACCESS.2026.3650973
- Photonic-aware DRL NoC routing: https://doi.org/10.3390/ai7020065
- BookSim2: https://github.com/booksim/booksim2
- Ramulator2: https://github.com/CMU-SAFARI/ramulator2
- DRAMsim3: https://github.com/umd-memsys/DRAMsim3
- DRAMSys: https://github.com/tukl-msd/DRAMSys
- gem5: https://github.com/gem5/gem5
- Sniper: https://github.com/snipersim/snipersim
- gem5-Aladdin: https://github.com/harvard-acc/gem5-aladdin
- Gem5-AcceSys: https://arxiv.org/abs/2502.12273
- MemExplorer: https://arxiv.org/abs/2605.07183
- LUMINA: https://arxiv.org/abs/2605.15303
- DeepStack: https://arxiv.org/abs/2604.05238
- Mess: https://pm.bsc.es/gitlab/mess/mess
- Use: wrap memory/fabric knobs as simulator-backed DSE tasks; generate or
  replay NoC/DRAM datasets; evaluate CPU/cache/memory simulator configs and
  stats; evaluate inverse MLP/CVAE/diffusion/GNN NoC parameter predictors
  against BookSim; track generated NoC backends and CIM
  simulators as future review targets; study agentic NPU memory hierarchy DSE,
  LLM-guided bottleneck analysis, stacked-AI accelerator memory/interconnect
  tradeoffs, and accelerator-system memory contention.
- E1 fit: target capture only. The current E1 fabric is AXI-Lite and
  SRAM-backed, so any NoC, QoS, DRAM, coherency, generated parameter, generated
  RTL, CIM, agent-generated memory hierarchy, stacked-memory, memory-bandwidth,
  or photonic routing claim needs topology constraints, traffic traces, pinned
  simulator revisions, replay logs, benchmark evidence, RTL feasibility,
  calibration assumptions, and architecture/PD review.

### DOSA

- Repo: https://github.com/ucb-bar/dosa
- Use: differentiable model-based accelerator search, Gemmini/FireSim oriented.
- E1 fit: useful if the Chipyard/Gemmini path becomes primary. Higher setup
  cost because it expects Gurobi and FireSim/Gemmini-style infrastructure.

### Simulator Acceleration And Cocotb Ergonomics

- GEM GPU RTL simulator: https://github.com/NVlabs/GEM
- RTLflow: https://github.com/dian-lun-lin/RTLflow
- FireSim: https://github.com/firesim/firesim
- SystemC/TLM: https://github.com/accellera-official/systemc
- SST: https://github.com/sstsimulator/sst-core
- Chipyard: https://github.com/ucb-bar/chipyard
- Gemmini: https://github.com/ucb-bar/gemmini
- FireMarshal: https://github.com/firesim/FireMarshal
- MIDAS/FAME transforms: https://github.com/firesim/firesim
- Verilator: https://github.com/verilator/verilator
- QEMU: https://gitlab.com/qemu-project/qemu
- Renode: https://github.com/renode/renode
- gem5: https://github.com/gem5/gem5
- Sniper: https://github.com/snipersim/snipersim
- Ramulator2: https://github.com/CMU-SAFARI/ramulator2
- DRAMsim3: https://github.com/umd-memsys/DRAMsim3
- Verion EDA: https://verion-eda.com/
- Copra cocotb stubs: https://github.com/cocotb/copra
- Waveform MCP: https://github.com/jiegec/waveform-mcp
- MCP VCD: https://github.com/SeanMcLoughlin/mcp-vcd
- VaporView: https://github.com/Lramseyer/vaporview
- WaveEye: https://github.com/meenalgada142/WaveEye
- cocotb: https://github.com/cocotb/cocotb
- cocotb-test: https://github.com/themperek/cocotb-test
- cocotb-bus: https://github.com/cocotb/cocotb-bus
- cocotb-coverage: https://github.com/cocotb/cocotb-coverage
- pyuvm: https://github.com/pyuvm/pyuvm
- cocotbext-axi: https://github.com/alexforencich/cocotbext-axi
- Use: accelerate RTL regressions, batch simulator stimuli, enable full-system
  FPGA simulation, model SystemC/TLM and SST architecture scenarios, track
  Chipyard/Rocket and Gemmini generator baselines, build reproducible
  full-system workloads, cross-check with Verilator/QEMU/Renode, run
  gem5/Sniper and Ramulator/DRAMsim memory timing studies, evaluate commercial
  GPU simulation, reduce cocotb signal-name errors with generated DUT stubs,
  expose scoped waveform context to AI/debug agents, run pytest-wrapped cocotb
  regressions, reuse bus drivers/monitors/scoreboards, structure functional
  coverage, organize Python-UVM components, and harden AXI-lite
  stimulus/monitoring.
- E1 fit: backend watchlist only until supported SystemVerilog subsets,
  simulator versions, architecture and memory-simulator configs,
  generator/submodule revisions, generated RTL/DTS/firmware/workload hashes,
  generated netlist/stub hashes, waveform hashes, signal scope allowlists,
  coverage database hashes, bus-interface mappings, scoreboard policy,
  waveform and coverage correlation against local Verilator/cocotb,
  QEMU/Renode/gem5/Sniper/SST/SystemC/Ramulator/DRAMsim replay where
  applicable, speedup replay, license review, platform-contract review, and
  reviewer disposition exist.

### HLS DSE and Directive Agents

- HLSFactory: https://github.com/sharc-lab/HLSFactory
- HLS-Eval: https://github.com/sharc-lab/hls-eval
- HLStrans: https://arxiv.org/abs/2507.04315 and
  https://huggingface.co/datasets/qingyun777yes/HLStrans
- SAGE-HLS: https://arxiv.org/abs/2508.03558 and
  https://huggingface.co/datasets/mashnoor/hls-ast-sagehls
- Bench4HLS: https://arxiv.org/abs/2601.19941 and
  https://github.com/zfsadik/Bench4HLS
- LLM-DSE: https://github.com/Nozidoali/LLM-DSE
- iDSE: https://arxiv.org/abs/2505.22086
- MPM-LLM4DSE: https://arxiv.org/abs/2601.04801 and
  https://github.com/wslcccc/MPM-LLM4DSE
- ForgeHLS: https://arxiv.org/abs/2507.03255 and
  https://github.com/zedong-peng/ForgeHLS
- DiffHLS: https://arxiv.org/abs/2604.09240
- HLS-Seek: https://arxiv.org/abs/2605.13536
- TimelyHLS: https://arxiv.org/abs/2507.17962, with related benchmark/code at
  https://github.com/zfsadik/Bench4HLS
- FlexLLM HLS Library: https://arxiv.org/abs/2601.15710
- TAPA/RapidStream TAPA: https://arxiv.org/abs/2209.02663 and
  https://github.com/rapidstream-org/rapidstream-tapa
- ScaleHLS: https://github.com/hanchenye/scalehls
- Google XLS: https://github.com/google/xls
- Dynamatic: https://github.com/EPFL-LAP/dynamatic
- AutoDSE: https://github.com/UCLA-VAST/AutoDSE
- AI4DSE: https://arxiv.org/abs/2411.10065
- HLSPilot: https://arxiv.org/abs/2408.06810 and
  https://github.com/xcw-1010/HLSPilot
- DB4HLS: https://arxiv.org/abs/2101.00587 and
  https://www.db4hls.inf.usi.ch/
- DP-HLS: https://arxiv.org/abs/2411.03398 and
  https://github.com/TurakhiaLab/DP-HLS
- hls4ml: https://arxiv.org/abs/2512.01463 and
  https://github.com/fastmachinelearning/hls4ml
- FINN: https://xilinx.github.io/finn/ and https://github.com/Xilinx/finn
- AMD HLS dataflow case study:
  https://www.amd.com/en/developer/resources/technical-articles/2026/llm-aided-hls-dataflow-optimization-a-sha-256.html
- Use: HLS design-space datasets, HLS code-generation evaluation,
  C-to-HLS transformation corpora, AST-guided HLS generation, timing-aware HLS,
  differential QoR prediction, proxy-reward HLS RL, multimodal HLS QoR
  modeling, HLS LLM libraries, quantized-NN HLS compilers, MLIR HLS
  infrastructure, DSLX/dynamic-HLS backend watchlists, baseline ML/heuristic
  DSE databases/frameworks, FPGA HLS backends, and LLM/agent-guided directive
  search.
- E1 fit: useful for bounded NPU kernels only after a local HLS backend,
  generated-artifact quarantine, model/dataset/library/backend license review,
  benchmark-overlap review, C-sim, HLS synthesis, generated-RTL checks, QoR
  replay/error analysis, replay manifests, and runtime/driver gates exist.

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
- RTLFixer: https://github.com/NVlabs/RTLFixer
- PyHDL-Eval: https://github.com/cornell-brg/pyhdl-eval
- ChipSeek: https://github.com/rong-hash/chipseek
- CircuitMind / TC-Bench: https://github.com/BUAA-CLab/CircuitMind
- RTLSeek: https://arxiv.org/abs/2603.27630
- CodeV-R1: https://arxiv.org/abs/2505.24183
- QiMeng-CRUX: https://arxiv.org/abs/2511.20099
- QiMeng-CRUX code/model:
  https://github.com/Taskii-Lei/QiMeng-CRUX-V and
  https://huggingface.co/Taskii/QiMeng-CRUX-V
- QiMeng-SALV: https://arxiv.org/abs/2510.19296
- QiMeng-SALV code/model:
  https://github.com/QiMeng-IPRC/QiMeng-SALV and
  https://huggingface.co/TabCanNotTab/SALV-Qwen2.5-Coder-7B-Instruct
- EvolVE / IC-RTL: https://arxiv.org/abs/2601.18067
- VeriAgent: https://arxiv.org/abs/2603.17613
- Open-LLM-ECO: https://github.com/YiKangOY/Open-LLM-ECO
- iScript: https://arxiv.org/abs/2603.04476
- OpenRTLSet: https://huggingface.co/datasets/ESCAD/OpenRTLSet
- MG-Verilog: https://huggingface.co/datasets/GaTech-EIC/MG-Verilog
- DeepCircuitX:
  https://huggingface.co/datasets/zeju-0727/DeepCirCuitX_Dataset
- LLM-EDA OpenCores: https://huggingface.co/datasets/LLM-EDA/opencores
- Hardware VerilogEval v2:
  https://huggingface.co/datasets/AbiralArch/hardware-verilogeval-v2
- LLM_4_Verilog: https://huggingface.co/datasets/NOKHAB-Lab/LLM_4_Verilog
- VeriGen: https://arxiv.org/abs/2308.00708,
  https://github.com/shailja-thakur/VGen,
  https://huggingface.co/shailja/fine-tuned-codegen-2B-Verilog, and
  https://huggingface.co/datasets/shailja/Verilog_GitHub
- OriGen: https://arxiv.org/abs/2407.16237,
  https://github.com/pku-liang/OriGen,
  https://huggingface.co/henryen/OriGen, and
  https://huggingface.co/datasets/henryen/origen_dataset_instruction
- VeriReason: https://arxiv.org/abs/2505.11849,
  https://github.com/NellyW8/VeriReason, and
  https://huggingface.co/Nellyw888/VeriReason-codeLlama-7b-RTLCoder-Verilog-GRPO-reasoning-tb
- DeepV: https://arxiv.org/abs/2510.05327 and
  https://huggingface.co/spaces/FICS-LLM/DeepV
- Use: metadata-only candidates for RTL model evaluation, EDA-feedback RL
  post-training, LoRA/model-card review, hosted RAG review, syntax-repair loop
  review, multi-HDL evaluation harnessing, syntax-locked gate-level generation,
  constrained and signal-aware Verilog generation, reasoning/RL testbench
  feedback, evolutionary RTL/PPA search, multi-agent PPA optimization, future
  corpus curation, contamination checks, and held-out benchmark construction.
- E1 fit: do not download weights or datasets yet. Every external model/corpus
  or repair/RL/evolutionary/agentic framework needs exact revision pins, file
  manifests, dependency and license review, quarantine paths, benchmark
  de-duplication, API/privacy review where applicable, model-card/base-model/
  reward/search-trace/retrieval-corpus/RAG-trace/memory-state/prompt/output
  hashes, local lint/sim/synth/formal/OpenLane gates, and human disposition
  before any use.

### Repository-Level RTL Evolution

- CktEvo: https://arxiv.org/abs/2603.08718
- HYPERHEURIST: https://arxiv.org/abs/2604.15642
- DeepCircuitX paper: https://arxiv.org/abs/2502.18297
- Use: repository-level RTL context, code understanding/completion, PPA labels,
  staged compile/sim-filtered RTL/PPA search, and closed-loop
  function-preserving RTL evolution with toolchain feedback.
- E1 fit: high-value direction for long-term SoC-level optimization, but every
  generated cross-file edit or generated RTL candidate stays quarantined until
  changed-file manifests, prompt/seed/output hashes, equivalence,
  cocotb/formal, synthesis/OpenLane, CDC/RDC, PPA, and review evidence exist.

### Hardware Security, Poisoning, and LLM Safety

- AI-assisted hardware security verification:
  https://arxiv.org/abs/2604.01572
- SecureRAG-RTL: https://arxiv.org/abs/2603.05689
- SafeTune: https://arxiv.org/abs/2604.27238
- VerilogLAVD: https://arxiv.org/abs/2508.13092
- TrojanLoC: https://arxiv.org/abs/2512.00591
- HardSecBench: https://arxiv.org/abs/2601.13864
- HarmChip: https://arxiv.org/abs/2604.17093
- Trojan explainability comparison: https://arxiv.org/abs/2601.18696
- HAL: https://github.com/emsec/hal
- SpyDrNet: https://github.com/byuccl/spydrnet
- Netlist Paths: https://github.com/dalance/netlist-paths
- Naja: https://github.com/najaeda/naja
- NETLAM: https://github.com/shubhishukla10/NETLAM
- BugWhisperer:
  https://huggingface.co/SiLDALab/Mistral-7B-instruct-Bug-Whisperer
- VeriCWEty: https://arxiv.org/abs/2604.15375
- LASHED: https://arxiv.org/abs/2504.21770
- Qihe: https://arxiv.org/abs/2601.11408 and https://qihe.pascal-lab.net/
- Hardware Vulnerability Dataset:
  https://github.com/shamstarekargho/Hardware-Vulnerability-Dataset
- Use: security target capture for threat modeling, RTL vulnerability triage,
  Verilog CWE rule-generation review, model-based line-level CWE triage,
  static-analysis fusion, deterministic gate-level netlist import/query and
  path triage, secure RTL/firmware benchmark hygiene, poisoned-corpus
  screening, line-level Trojan localization, explanation quality, dual-use
  Trojan-generation isolation, external vulnerability dataset governance, and
  domain-specific LLM safety evaluation.
- E1 fit: never run adversarial prompts, import Trojan datasets, fine-tune RTL
  models, import generated Trojan artifacts, trust generated countermeasures,
  generate or import CWE rules without false-positive review, use model-based
  or static-analysis security findings without pinned revisions and alert
  review, use netlist-query results without netlist/library hashes and
  deterministic follow-up checks, use security benchmarks as E1 evidence
  without non-overlap checks, or claim vulnerability findings without prompt
  quarantine, dual-use review, RTL/netlist hashes, formal/simulation evidence,
  no-hardware-action compliance, and human security disposition.

### ChatEDA and EDA Corpus

- ChatEDA repo: https://github.com/wuhy68/ChatEDA
- ChatEDA paper: https://wuhy68.github.io/paper/TCAD24-ChatEDA.pdf
- EDA Corpus paper: https://arxiv.org/abs/2405.06676
- EDA Corpus repo: https://github.com/OpenROAD-Assistant/EDA-Corpus
- HWE-Bench: https://arxiv.org/abs/2604.14709
- Phoenix-bench: https://arxiv.org/abs/2605.15226
- AuDoPEDA: https://arxiv.org/abs/2601.06268
- EDA-MCP Server: https://github.com/SaeronLab/eda-mcp
- OpenROAD MCP: https://github.com/luarss/openroad-mcp
- FluxEDA: https://arxiv.org/abs/2603.25243
- PostEDA-Bench: https://arxiv.org/abs/2605.06936
- EDA-Schema-V2: https://arxiv.org/abs/2605.06952
- Use: LLM agents and datasets for EDA tool interaction, especially OpenROAD
  command/script assistance, repository-scale hardware bug repair evaluation,
  stateful EDA agent memory/skills, post-layout repair benchmarks,
  schema-normalized EDA contexts, OpenROAD tool-improvement research, and MCP
  command governance.
- E1 fit: reference data for an internal assistant that explains OpenROAD logs
  and suggests reproducible Tcl/config sweeps. Repository-agent benchmarks,
  OpenROAD coding-agent patches, post-EDA repair agents, schema exports,
  stateful agent memories, and MCP sessions stay blocked until command schemas,
  sandbox/authentication policy, redaction rules, artifact quarantine,
  deterministic local replay, and review exist.

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

### ForgeEDA, GNN4CIRCUITS, and HW2VEC

- ForgeEDA: https://arxiv.org/abs/2505.02016 and
  https://huggingface.co/datasets/zshi0616/ForgeEDA_AIG
- GNN4CIRCUITS: https://github.com/DfX-NYUAD/GNN4CIRCUITS
- HW2VEC: https://cadforassurance.org/tools/design-for-trust/hw2vec/ and
  https://github.com/AICPS/hw2vec
- Use: build or study graph/AIG/RTL/gate-level representations for hardware
  learning tasks, especially corpus governance, netlist embeddings, assurance,
  and future held-out E1 graph tasks.
- E1 fit: metadata-only. Do not download corpora, run graph extraction, train
  models, generate embeddings, or classify local RTL/netlists until revisions,
  licenses, graph-schema hashes, label provenance, split manifests,
  contamination checks, deterministic replay, and review exist.

## DTCO, TCAD, DFM, yield, lithography, and OPC

### TCAD and device optimization

- AgenticTCAD paper: https://arxiv.org/abs/2512.23742
- TcadGPT paper: https://arxiv.org/abs/2601.10128
- Use: future DTCO and device/process exploration only after exact TCAD decks,
  simulator/tool identity, licenses, calibration data, generated deck hashes,
  raw logs, and human process-device review exist.
- E1 fit: metadata-only target capture. Do not generate TCAD decks, process
  assumptions, leakage/self-heating assumptions, reliability corners, or
  power/thermal inputs for E1 release without foundry-authorized collateral and
  deterministic replay evidence.

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
- gem5: https://github.com/gem5/gem5
- Sniper: https://github.com/snipersim/snipersim
- ChampSim: https://champsim.github.io/ChampSim/master/
- Use: automate or accelerate CPU architecture sweeps across branch predictors,
  cache replacement, prefetchers, CPU/cache/memory simulator configurations,
  and broader microarchitecture configurations.
- E1 fit: target capture only. Any suggested BPU/cache/prefetch policy needs
  trace provenance, pinned simulator configs, workload and stats hashes,
  before/after logs, calibration against local baselines, RTL cost, synthesis,
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

- IREE: https://github.com/iree-org/iree
- LLVM/MLIR: https://github.com/llvm/llvm-project
- Apache TVM: https://github.com/apache/tvm
- TVM MetaSchedule:
  https://tvm.apache.org/docs/deep_dive/tensor_ir/tutorials/meta_schedule.html
- Ansor: https://arxiv.org/abs/2006.06762
- Use: lower tensor programs through open compiler stacks and search schedules
  for tensor kernels and operator implementations.
- E1 fit: target capture only. E1 needs a real target, generated MLIR/VMFB or
  schedule artifacts, workload corpus, simulator/runtime logs, unsupported-op
  and fallback accounting, and before/after benchmarks before schedule search or
  an IREE/TVM backend can tune CPU/RVV fallback or NPU host kernels.

### Edge runtime frontends and fallback kernels

- ExecuTorch: https://github.com/pytorch/executorch
- LiteRT: https://github.com/google-ai-edge/LiteRT
- XNNPACK: https://github.com/google/XNNPACK
- Use: feed PyTorch/TFLite-style mobile models into backend delegates and cover
  CPU fallback kernels for unsupported operators.
- E1 fit: blocked runtime integration. PyTorch export, LiteRT benchmark_model,
  XNNPACK fallback, and elizanpu delegate claims require pinned revisions,
  generated PTE/model/artifact hashes, unsupported-op reports, fallback
  accounting, runtime logs, Android or target evidence where applicable, and
  review.

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
- Autocomp: https://arxiv.org/abs/2505.18574 and
  https://github.com/ucb-bar/autocomp
- AccelOpt: https://arxiv.org/abs/2511.15915 and
  https://github.com/zhang677/AccelOpt
- Use: LLM/agent loops that use compiler diagnostics, tests, verification, or
  hints to rewrite code, generate accelerator kernels, or guide compiler
  decisions.
- E1 fit: target capture only. Generated source, hints, profiles, optimization
  memories, and accelerator kernels need local semantic tests, compile logs,
  simulator/runtime replay, performance logs, and human disposition.

### RISC-V runtime kernels and formal semantics

- V-Seek: https://arxiv.org/abs/2503.17422 with upstream runtime reference
  https://github.com/ggml-org/llama.cpp
- Interaction Tree Semantics for RISC-V:
  https://arxiv.org/abs/2605.04933
- Use: optimize RISC-V inference kernels and provide formal semantics for
  compiler/hardware/software contract reasoning.
- E1 fit: blocked proof and benchmark evidence. Runtime kernel changes require
  target ISA profiles, compiler flags, binary hashes, simulator or hardware
  logs, workload hashes, calibrated metrics, and review; formal semantics
  require pinned formalization assets, theorem/proof logs, source/generated
  hashes, and declared RISC-V subset coverage before any equivalence claim.

### Software BSP, Firmware, and OS Tuning

- LLM firmware validation:
  https://arxiv.org/abs/2509.09970,
  https://github.com/MoeinAbtahi/Securing-LLM-Generated-Embedded-Firmware-through-Iterative-Testing-and-Patching
- AUTODRIVER / DRIVEBENCH: https://arxiv.org/abs/2511.18924
- OS-R1: https://arxiv.org/abs/2508.12551,
  https://github.com/LHY-24/OS-R1
- AutoOS: https://openreview.net/pdf?id=Rp8R9C0Sth
- FIRMHIVE: https://arxiv.org/abs/2511.18438
- ADFEmu:
  https://www.sciencedirect.com/org/science/article/pii/S1546221825006885
- P2IM: https://github.com/RiS3-Lab/p2im
- DICE: https://github.com/RiS3-Lab/DICE
- HALucinator: https://github.com/halucinator/halucinator
- FirmWire: https://github.com/FirmWire/FirmWire
- QEMU: https://gitlab.com/qemu-project/qemu
- Renode: https://github.com/renode/renode
- Device Tree Compiler: https://git.kernel.org/pub/scm/utils/dtc/dtc.git
- Buildroot: https://gitlab.com/buildroot.org/buildroot
- OpenSBI: https://github.com/riscv-software-src/opensbi
- U-Boot: https://github.com/u-boot/u-boot
- Use: firmware patch validation, Linux driver co-evolution, kernel
  configuration tuning, firmware security triage, firmware fuzzing,
  deterministic emulator/device-tree/rootfs replay, firmware re-hosting with
  peripheral, interrupt, HAL, and target-model manifests, bootloader/BSP
  evidence capture, and simulator-guided boot debugging.
- E1 fit: target capture only. Do not apply firmware, DTS, driver, bootloader,
  kernel config, fuzzing harness, or generated patches until source hashes,
  artifact hashes, static analysis, platform-contract checks, DTC warnings,
  Buildroot build logs, firmware-image provenance, HAL/peripheral/interrupt/DMA
  model hashes, QEMU/Renode transcripts, workload logs, crash replay, security
  replay, and reviewer disposition exist.

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
- HDFIT: https://intellabs.github.io/HDFIT/
- Hamartia:
  https://research.nvidia.com/publication/2018-06_hamartia-fast-and-accurate-error-injection-framework
- FIES: https://github.com/ahoeller/fies
- LLFI: https://github.com/DependableSystemsLab/LLFI
- LLTFI: https://github.com/DependableSystemsLab/LLTFI
- Use: run or structure netlist, RTL, formal, simulator, QEMU, LLVM/MLIR, and
  workload-level fault campaigns; rank vulnerable state and compare
  mitigations.
- E1 fit: blocked from execution until there is an E1 fault-library schema,
  fault-site manifest, seed policy, output classifier, pass/fail taxonomy,
  deterministic logs, and review path.

### Compiler and workload reliability

- BEC: https://arxiv.org/abs/2401.05753
- TensorFI: https://github.com/DependableSystemsLab/TensorFI
- PyTorchFI: https://github.com/pytorchfi/pytorchfi
- PyTorchALFI: https://github.com/IntelLabs/PyTorchALFI
- MRFI: https://github.com/fffasttime/MRFI
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

- Self-Evolved ABC: https://arxiv.org/abs/2604.15082
- Repo: https://github.com/NYU-MLDA/OpenABC
- Paper: https://arxiv.org/abs/2110.11292
- Use: ML dataset from Yosys/ABC synthesis recipes with AIGs, area, delay, and
  recipe labels, plus current agentic ABC tool-evolution context.
- E1 fit: early predictor/sweep policy for Yosys/ABC recipes before full PD;
  evolved ABC code or binaries remain blocked until exact revisions, compile
  logs, correctness logs, equivalence, before/after QoR replay, Yosys/OpenLane
  integration evidence, and review exist.

### SAT Tuning And Circuit-SAT Preprocessing

- DynamicSAT: https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.CP.2025.34
  and https://github.com/cure-lab/DynamicSAT
- Logic Optimization Meets SAT: https://arxiv.org/abs/2403.19446
- Use: tune SAT-solver parameters dynamically and use logic-optimization/RL
  preprocessing for circuit-SAT instances that resemble formal, LEC, CEC, or
  ATPG obligations.
- E1 fit: solver/preprocessing watchlist only. Runtime or SAT-result claims
  need exact solver revisions, miter/CNF/SMT/fault-list hashes, transformed
  instance hashes, baseline and tuned logs, witness or counterexample replay,
  timeout policy, and review.

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

### Architecture-level power models

- ArchPower: https://arxiv.org/abs/2512.06854,
  https://github.com/hkust-zhiyao/ArchPower, and
  https://huggingface.co/datasets/zqj23333/ArchPower
- AutoPower: https://arxiv.org/abs/2508.12294 and
  https://github.com/hkust-zhiyao/AutoPower
- AtomPower: https://doi.org/10.1587/elex.23.20260004
- Use: early CPU/AP/RTL power estimation from architecture, event, RTL
  structure, activity, fine-grained component/power-group labels, per-cycle
  labels, and few-shot calibration methods before a full implementation loop is
  affordable.
- E1 fit: target capture only. These can inform future simulator power models
  after E1 has CPU/AP/RTL feature-schema mapping, workload manifests,
  VCD/activity provenance, local calibration labels, train/test split
  manifests, and error analysis. External datasets or trained models must not
  become E1 power evidence by themselves.

### Thermal Datasets and Hotspot Characterization

- Commercial Thermal Map Dataset:
  https://dl.acm.org/doi/10.1145/3670474.3685963,
  https://github.com/sheldonucr/commercial_thermal_map_dataset
- HotGauge: https://sites.tufts.edu/tcal/publications/hotgauge/,
  https://github.com/TuftsCompArchLab/HotGauge
- McPAT: https://github.com/HewlettPackard/mcpat
- HotSpot: https://github.com/uvahotspot/HotSpot
- Use: measured commercial thermal-map corpus governance, runtime thermal
  management methodology review, deterministic architecture power/thermal
  backend watchlists, and simulator-linked hotspot characterization.
- E1 fit: target capture only. Do not import thermal datasets, run hotspot
  frameworks, run McPAT/HotSpot, or claim thermal validity until exact
  revisions, licenses, technology/config manifests, package/floorplan mappings,
  workload/activity manifests, power-map hashes, sensor/camera calibration,
  deterministic thermal evidence, sensitivity analysis, and reviewer
  disposition exist.

### IR-Drop and PDN Prediction

- LMM-IR: https://arxiv.org/abs/2511.12581
- PowerNet: https://arxiv.org/abs/2004.04026
- MAVIREC: https://arxiv.org/abs/2212.09129
- PDNNet: https://arxiv.org/abs/2403.18570
- DuST-IRdrop: https://github.com/cuhk-eda/DuST-IRdrop
- Use: static and dynamic IR-drop prediction, vectorless droop estimation,
  multimodal netlist/layout features, PDN-aware graph features,
  diffusion/transformer predictors, and PDN-risk screening after local labels
  exist.
- E1 fit: target capture only. Dynamic droop models need vector/activity
  provenance; static and multimodal models need netlist/layout feature schemas;
  all variants need PDN graph extraction where applicable, held-out E1
  PDNSim/signoff labels, split/non-overlap review, temporal or spatial error
  analysis, generated-prediction quarantine, and PD review before they can
  influence PDN, floorplan, power, timing, or signoff decisions.

### CDC/RDC and Typed Clock Intent

- Accellera CDC/RDC standard:
  https://www.accellera.org/downloads/standards/clock-domain-crossing
- Accellera CDC/RDC draft 0.5 public review:
  https://www.accellera.org/news/press-releases/accellera-releases-cdc-rdc-public-review-draft
- cdc_snitch / Bedrock:
  https://github.com/BerkeleyLab/Bedrock/tree/master/projects/common/leep/cdc_snitch
- Formal CDC metastability-injection methodology:
  https://arxiv.org/abs/2406.06533
- Veryl clock-domain annotations:
  https://doc.veryl-lang.org/book/05_language_reference/15_clock_domain_annotation.html
  and https://github.com/veryl-lang/veryl
- Arch AI-native HDL: https://arxiv.org/abs/2604.05983
- Sparkle Lean HDL: https://github.com/Verilean/sparkle
- SKALP: https://github.com/girivs82/skalp
- Use: CDC/RDC intent standardization, typed clock/reset/interface capture,
  metastability modeling, proof-oriented HDL experiments, compile-time
  clock-domain safety, open CDC anti-pattern lint, and advisory CDC/RDC finding
  triage.
- E1 fit: target capture only. Generated constraints, waivers, typed-intent
  translations, generated SystemVerilog/netlists, ML pass-ordering outputs,
  proof logs, CDC/RDC classifications, and signoff claims need local
  clock/reset intent, RTL/SDC hashes, deterministic CDC/RDC reports,
  false-positive triage, equivalence/formal/cocotb replay, reset-domain
  regressions, and review.

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
- DeepRWCap: https://arxiv.org/abs/2511.06831
- NAS-Cap: https://arxiv.org/abs/2408.13195
- ML capacitance extraction for interconnect geometry exploration:
  https://gtcad.gatech.edu/www/papers/Tsai-ICCAD25.pdf
- Use: SPEF/RCX log capture, Magic extracted SPICE capture, SDF and
  timing-corner manifest capture, parasitic-feature label construction,
  capacitance-extraction benchmark tracking, neural-guided solver and NAS model
  watchlists, process-parameter sensitivity research, and future SI/crosstalk
  triage.
- E1 fit: target capture only. The local lane may hash OpenRCX SPEFs, RCX logs,
  Magic SPICE output, SDF files, multi-corner STA evidence, timing-corner
  manifests, and signoff references, but generated SPEF, SDF, SPICE, extraction
  rules, SI waivers, RC predictions, process-stack/ITF assumptions, dataset
  imports, model runs, and timing/signoff claims stay blocked until
  before/after extraction, STA, DRC/LVS, antenna, route, power, and signoff
  evidence exists.

## Low-power intent, DVFS, and clock gating

### IEEE 1801 UPF

- Standard: https://standards.ieee.org/ieee/1801/11890/
- Open examples: https://opensource.ieee.org/upf
- OpenROAD UPF backend:
  https://openroad.readthedocs.io/en/latest/main/src/upf/README.html
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

### OpenROAD clock gating

- Docs: https://openroad.readthedocs.io/en/latest/main/src/cgt/README.html
- Repo: https://github.com/The-OpenROAD-Project/OpenROAD/tree/master/src/cgt
- Use: ABC-backed flip-flop clock-gating insertion in an open physical-design
  tool flow.
- E1 fit: backend watchlist only. OpenROAD/ABC revisions, ICG library-cell
  manifests, before/after netlists, equivalence, scan/DFT, CDC/RDC, STA, and
  power reports are required before any generated gated-clock artifact can be
  trusted.

### Lighter

- Repo: https://github.com/AUCOHL/Lighter
- Paper:
  https://woset-workshop.github.io/PDFs/2024/15_Lighter_An_Open_Source_Auto.pdf
- Use: Yosys-plugin and library-map flow for automatic register clock gating
  against open Sky130 and GF180 standard-cell libraries.
- E1 fit: backend watchlist only. Lighter is attractive because E1 already has
  open-flow ambitions, but plugin outputs need pinned revisions, library-map
  hashes, ICG-cell policy, scan enable, CDC/RDC, equivalence, STA, synthesis,
  and before/after power evidence before any generated gated-clock netlist is
  promoted.

### CODMAS / RTLOPT

- Paper: https://arxiv.org/abs/2603.17204
- Use: multi-agent RTL optimization with deterministic syntax, functional, and
  PPA evaluation. RTLOPT includes pipelining and clock-gating optimization
  triples.
- E1 fit: useful benchmark pattern for future low-power RTL edits, but
  generated clock-gating remains outside source until local equivalence,
  timing, scan, and power gates exist.

### RTL-OPT

- Paper: https://arxiv.org/abs/2601.01765
- Use: benchmark RTL optimization quality with functional correctness and PPA
  metrics instead of syntax-only Verilog generation.
- E1 fit: evaluation-method context only. Any benchmark task or result needs
  exact assets, license review, non-overlap checks, synthesis setup hashes,
  functional/equivalence logs, and before/after PPA evidence before it can
  inform E1 low-power RTL changes.

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

### SymRTLO for power-aware RTL rewrites

- Paper: https://arxiv.org/abs/2504.10369
- Use: symbolic reasoning plus LLM-driven RTL code optimization toward PPA,
  including power-sensitive objectives.
- E1 fit: advisory only in this lane. Any generated rewrite needs artifact
  isolation, equivalence, synthesis, timing, activity provenance, power reports,
  and review before it can become source.

### PowerGear

- Paper: https://arxiv.org/abs/2201.10114
- Use: early-stage HLS power estimation and design-space exploration context.
- E1 fit: useful as a method reference for accelerator/HLS power estimation,
  but blocked until E1 has exact assets, feature provenance, HLS/RTL synthesis
  replay, activity or vector provenance, held-out error analysis, and
  before/after power evidence.

### Activity-annotated power analysis backends

- OpenSTA: https://github.com/The-OpenROAD-Project/OpenSTA
- iEDA iPower: https://ieda.oscc.cc/en/tools/ieda-tools/ipa.html and
  https://github.com/OSCC-Project/iEDA
- trace2power: https://docs.rs/trace2power and
  https://github.com/antmicro/trace2power
- Use: convert reviewed Liberty/netlist/SDC/parasitic and VCD/FST/SAIF
  activity into power reports or activity TCL so low-power RTL, clock-gating,
  DVFS, and HLS-power ideas can be checked against reproducible switching data.
- E1 fit: measurement backend watchlist only. Do not run power analysis,
  process E1 waveforms, or claim power savings until exact tool revisions,
  input hashes, hierarchy/top-scope mapping, activity coverage, report hashes,
  cross-tool correlation, workload provenance, and reviewer disposition exist.

### Architecture-level power priors for DVFS triage

- ArchPower: https://arxiv.org/abs/2512.06854,
  https://github.com/hkust-zhiyao/ArchPower, and
  https://huggingface.co/datasets/zqj23333/ArchPower
- AutoPower: https://arxiv.org/abs/2508.12294 and
  https://github.com/hkust-zhiyao/AutoPower
- AtomPower: https://doi.org/10.1587/elex.23.20260004
- Use: CPU/AP and RTL power priors for future DVFS, idle-state, and
  low-power triage once local feature extraction and calibration evidence
  exists.
- E1 fit: advisory target capture only. These sources must not create DVFS
  policy, imported datasets, trained models, power labels, or power-saving
  claims until E1 has pinned revisions, license review, CPU/AP/RTL feature
  mapping, VCD/activity provenance, workload manifests, calibration labels,
  split review, held-out error analysis, and power/thermal reviewer approval.

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
- Logic BIST MBIST/BISR reference: https://github.com/dineshannayya/logic_bist
- Aawo configurable MBIST: https://aawo.dev/projects/mbist/
- Aawo SRAM fault model: https://aawo.dev/projects/sram-fault-model/
- AutoMBIST package: https://pypi.org/project/autombist/
- Use: scan insertion, scan-chain stitching, ATPG, MBIST/BISR controller and
  repair-policy review, SRAM fault-model taxonomy, wrapper generation, and open
  DFT infrastructure.
- E1 fit: add a future DFT evidence lane after synthesis/placement maturity.
  Do not insert scan, generate MBIST wrappers, add memory repair collateral, or
  generate patterns until E1 has a scan architecture, memory-interface
  manifest, March-test and SRAM fault-model policy, test IO policy, ATPG/MBIST
  backend, tester format, and before/after timing/power/area gates.

### Deterministic ATPG and test harness baselines

- Atalanta: https://github.com/hsluoyz/Atalanta
- Fault hardware testing framework: https://github.com/leonardt/fault
- FAN_ATPG: https://github.com/NTU-LaDS-II/FAN_ATPG
- Quaigh: https://github.com/Coloquinte/quaigh
- Use: deterministic stuck-at ATPG/fault-simulation baselines, simulation test
  harnesses, and equivalence/fault-analysis primitives for judging AI ATPG
  claims.
- E1 fit: watchlist only until exact revisions, licenses, supported netlist
  subsets, fault-model manifests, pattern hashes, replay logs, and reviewer
  disposition exist. These tools do not authorize scan insertion, generated
  patterns, or fault-coverage claims by themselves.

### ML ATPG

- HighTPI: https://doi.org/10.1109/VTS65138.2025.11022820
- Explainable GNN TPI:
  https://past.date-conference.com/proceedings-archive/2026/DATA/431.pdf
- X-source GNN testability prediction:
  https://doi.org/10.1145/3658617.3697753
- InF-ATPG: https://arxiv.org/abs/2512.00079
- AI ATPG survey:
  https://blog.wangxm.com/wp-content/uploads/2024/12/ATPG_via_AI__A_Survey_for_Machine_Learning_in_Test_Generation.pdf
- Use: RL/ML approaches for ATPG search and test-point insertion, including
  HighTPI-style hierarchical FFR/hypergraph candidate selection, explainable
  GNN saliency for constrained I/O test-point ranking, X-source-aware
  testability prediction, and InF-ATPG-style fanout-free-region partitioning
  with ATPG-specific circuit features for QGNN/RL policy guidance.
- E1 fit: tracked requirement after conventional DFT artifacts exist; no training,
  inserted test points, generated patterns, fault waivers, backtrack-reduction
  claims, or fault-coverage claims until netlist and fault-list hashes,
  masked-I/O and X-source manifests, FFR/graph feature manifests,
  model-training logs, selected test-point or pattern hashes, deterministic
  replay, baseline ATPG comparison, signoff deltas, and DFT review exist.

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

- Verilator: https://github.com/verilator/verilator
- Spike: https://github.com/riscv-software-src/riscv-isa-sim
- Sail RISC-V: https://github.com/riscv/sail-riscv
- riscv-formal: https://github.com/SymbioticEDA/riscv-formal
- RISC-V DV: https://github.com/chipsalliance/riscv-dv
- RISCOF docs: https://riscof.readthedocs.io/en/doc-dependency-fix/intro.html
- RISC-V architectural tests: https://github.com/riscv/riscv-arch-test
- riscvISACOV: https://github.com/riscv-verification/riscvISACOV
- Lyra: https://arxiv.org/abs/2512.13686
- DifuzzRTL: https://github.com/compsec-snu/difuzz-rtl
- RFUZZ: https://github.com/ekiwi/rfuzz
- Cascade: https://github.com/comsec-group/cascade-artifacts
- GoldenFuzz: https://arxiv.org/abs/2512.21524
- MABFuzz: https://arxiv.org/abs/2311.14594
- Fuzzilicon: https://arxiv.org/abs/2512.23438 and
  https://zenodo.org/records/17012972
- OpenXiangShan XFUZZ: https://github.com/OpenXiangShan/xfuzz
- OpenXiangShan DiffTest: https://github.com/OpenXiangShan/difftest
- FERIVer: https://arxiv.org/abs/2504.05284
- Use: deterministic RTL simulation, ISA reference execution, formal ISA
  semantics, RVFI-based checks, random instruction generation, RISC-V
  compatibility testing, ISS comparison, ISA coverage, generative RISC-V
  fuzzing, golden-reference fuzzing, bandit-guided fuzzer scheduling,
  coverage-guided RTL fuzzing, CPU co-simulation, post-silicon fuzzing,
  FPGA-assisted differential checking, and compliance-oriented evidence.
- E1 fit: required for future CPU/AP validation, but blocked until E1 has a
  buildable RISC-V DUT wrapper, pinned external suite revisions, ISS setup,
  ISA/profile and CSR policy, coverage/RVVI adapter evidence, DUT/reference
  traces, seed and generated program manifests, FPGA bitstream/replay evidence
  or lab authorization where used, executed logs/signatures, vulnerability
  replay, disclosure handling, and reviewer disposition.

### Cross-target chip tests and ML boot debug

- OpenTitan chip tests:
  https://opentitan.org/book/sw/device/tests/index.html
- Spacely: https://arxiv.org/abs/2406.15181 and
  https://github.com/SpacelyProject/spacely-docs
- ML/XAI boot-failure debug:
  https://rei.iteso.mx/items/d449d907-2591-4969-b402-1f32bee002ab
- LLM4SecHW: https://arxiv.org/abs/2401.16448
- LLM4SecHW OSHD dataset:
  https://huggingface.co/datasets/KSU-HW-SEC/LLM4SecHW-OSHD
- ChipBench paper: https://arxiv.org/abs/2601.21448
- ChipBench code: https://github.com/zhongkaiyu/ChipBench
- Use: structure tests that can run across simulation, FPGA, and silicon; learn
  from reusable lab-validation harnesses and labeled boot-failure telemetry;
  triage hardware defects with LLMs; and evaluate whether LLMs can handle
  realistic Verilog debugging and reference-model generation tasks before
  trusting them near E1.
- E1 fit: target capture only. Generated lab scripts, test binaries, root-cause
  reports, fixes, benchmark imports, or debug-corpus use require local target
  IDs, logs, traces, deterministic gates, dataset provenance, contamination
  review, and human review.

## Recommended order for E1

1. OpenROAD AutoTuner around the existing PD scripts.
2. LLM4DV-style coverage-directed cocotb stimulus.
3. AssertionForge/AssertEval patterns for candidate SVA, reviewed before use.
4. ZigZag for NPU architecture/mapping exploration.
5. CircuitOps/CircuitNet/OpenABC-D once there are enough local E1 run labels.
6. Low-power target capture with
   `scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation`.
   Do not generate UPF, gated clocks, DVFS policy, retention/isolation logic, or
   power-domain artifacts, and do not import OpenROAD/ABC clock-gating outputs,
   UPF round-trip outputs, clock-gating plugin outputs, or low-power RTL
   benchmark tasks, until deterministic low-power evidence gates exist.
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
   run inference, import public graph corpora, run graph extraction, or make
   model-quality/design-decision claims without local provenance, graph-schema
   hashes, held-out tasks, deterministic gates, and review.
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
    process models, mission profiles, fault manifests, output classifiers,
    simulator/formal logs, PD/signoff evidence, before/after PPA, and review.
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
    signoff, or release readiness without fetchable pinned revisions, typed
    command schemas, explicit read/write scopes, license and data-handling
    review, local replay manifests, deterministic gates, and review.
17. Spec-to-RTL traceability target capture with
    `scripts/ai_eda/capture_spec_traceability_targets.py --run-id validation`.
    Track IncreRTL, Spec2RTL-Agent, RTLocating/EvoRTL-Bench, VERT,
    Spec2Assertion, STELLAR, ProofLoop, CoverAssert, CodeV-SVA, and related
    methods only as gated targets. Do not change requirements, specs, RTL, HLS, assertions, or
    testbenches, and do not generate trace matrices, C++/HLS/RTL, SVAs,
    patches, localization scopes, or requirement-coverage claims without stable
    requirement IDs, source hashes, non-overlap review, vacuity checks,
    localization impact review, deterministic local gates, and review.
18. IP/register/platform-contract target capture with
    `scripts/ai_eda/capture_ip_register_contract_targets.py --run-id validation`.
    Do not import external IP, run register generators or EDA flows, edit
    memory maps, headers, device trees, drivers, UVM/RAL collateral, or RTL, or
    claim register/ABI correctness without pinned revisions, license review,
    generated output hashes, ABI diffs, deterministic local gates, and review.
19. Memory macro/library target capture with
    `scripts/ai_eda/capture_memory_macro_library_targets.py --run-id validation`.
    Do not download PDKs or macros, import external memory collateral, run
    OpenRAM/DFFRAM/OpenXRAM/OpenRRAM/CACTI/DESTINY/NVSim/NeuroSim/OpenACM or
    OpenYield/AI estimators, import SRAM22/VLSIDA Sky130 macro collateral, run
    AutoCellGen/TOPCELL/CPCell/CharLib/LibreCell/xcell/NVCell standard-cell
    flows, generate MBIST/BISR or SRAM fault-model collateral, edit RTL, PD
    configs, Liberty, LEF, GDS, or SPICE, or claim SRAM/CIM/standard-cell area,
    timing, power, accuracy, Vmin, yield, MBIST, repair, signoff, or release
    readiness without pinned revisions, generated/imported artifact hashes,
    DRC/LVS/extraction, characterization, STA, OpenLane evidence, workload and
    memory-test replay, deterministic local gates, and review.
20. Chiplet/2.5D/3DIC/package co-design target capture with
    `scripts/ai_eda/capture_chiplet_3dic_package_targets.py --run-id validation`.
    Do not generate chiplet partitions, interposer layouts, die-to-die
    interfaces, RapidChiplet/PlaceIT/DiffChip/TDPNavigator-style topology or
    placement outputs, LEGOSim/HISIM/MFIT/3D-ICE simulator outputs, package or
    bump maps, SI/PI/thermal models, architecture edits, RTL edits, PD configs,
    board/package edits, simulator outputs, or cost/yield/performance/signoff
    claims without exact revisions,
    source/license review, package and architecture constraints, deterministic
    local gates, and review.
21. Logic synthesis and technology-mapping target capture with
    `scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation`.
    Do not generate or apply ABC/Yosys recipes, evolved ABC patches/binaries,
    technology mappings, constraints, netlists, SAT/circuit preprocessing
    outputs, or gate-level rewrites, and do not claim area, timing, power,
    solver runtime, equivalence, signoff, or release improvement
    without exact tool/model revisions, source/script hashes, output hashes,
    formal or equivalence evidence, deterministic synthesis/STA/OpenLane/power gates, and
    review.
22. Netlist equivalence and LEC target capture with
    `scripts/ai_eda/capture_netlist_equivalence_targets.py --run-id validation`.
    Do not run EQY, Yosys equivalence commands, SymbiYosys/yosys-smtbmc,
    solver backends, SAT-tuning/preprocessing backends, ABC CEC, CIRCT LEC, or generated LEC/proof harnesses, and
    do not generate miters, waivers, proof logs, RTL, netlists, scripts, or
    optimization patches without exact tool/solver revisions, input/output
    hashes, SMT input hashes where emitted, black-box, memory, reset,
    x-propagation, hierarchy, clock assumptions, bound/depth settings,
    witnesses, counterexample triage, deterministic formal/simulation/
    synthesis/STA/OpenLane/power gates, and review.
23. Physical verification, DRC/LVS, and antenna target capture with
    `scripts/ai_eda/capture_physical_verification_targets.py --run-id validation`.
    Do not run KLayout, Magic, Netgen, OpenROAD/OpenLane signoff steps, DRC,
    LVS, XOR, antenna checks, generated DRC decks, layout fixes, waivers, Tcl,
    patches, MCP-served physical-verification actions, structural-verifier
    approvals, or OpenDRC reports, and do not claim DRC, LVS, antenna, physical
    signoff, or release readiness without pinned tool/server and rule-deck
    revisions, layout/netlist hashes, request/response logs, before/after
    deterministic logs, extraction/STA/power/manufacturing/commercial-EDA gates
    where applicable, open-tool correlation where applicable, and review.
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
