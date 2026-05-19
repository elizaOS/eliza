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

## RTL generation and EDA assistance

### RTL-Coder / RTLLM

- RTL-Coder repo: https://github.com/hkust-zhiyao/RTL-Coder
- Paper: https://arxiv.org/abs/2312.08617
- Use: open RTL generation model, dataset, and training flow.
- E1 fit: boilerplate RTL, register blocks, adapters, and testbench scaffolds.
  Do not trust generated architectural RTL without lint, simulation, formal,
  and synthesis gates.

### ChatEDA and EDA Corpus

- ChatEDA repo: https://github.com/wuhy68/ChatEDA
- ChatEDA paper: https://wuhy68.github.io/paper/TCAD24-ChatEDA.pdf
- EDA Corpus paper: https://arxiv.org/abs/2405.06676
- EDA Corpus repo: https://github.com/OpenROAD-Assistant/EDA-Corpus
- Use: LLM agents and datasets for EDA tool interaction, especially OpenROAD
  command/script assistance.
- E1 fit: reference data for an internal assistant that explains OpenROAD logs
  and suggests reproducible Tcl/config sweeps.

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
- Use: ML datasets/code for congestion, DRC, IR drop, and net-delay prediction.
- E1 fit: train/evaluate risk predictors from DEF/netlist features once E1 has
  enough generated PD runs.

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
   Do not generate or promote verification plans, testbenches, SVAs, root-cause
   reports, or RTL fixes without local deterministic gates and review.
8. Post-silicon validation target capture with
   `scripts/ai_eda/capture_post_silicon_validation_targets.py --run-id validation`.
   Do not generate or promote lab scripts, test binaries, hardware actions,
   compliance claims, silicon bring-up claims, or lab-debug reports without
   local QEMU/Renode, FPGA, board/package, manufacturing, real-world, and review
   evidence.
9. Circuit foundation model target capture with
   `scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id validation`.
   Do not export training corpora, generate embeddings, train/fine-tune models,
   run inference, or make model-quality/design-decision claims without local
   provenance, held-out tasks, deterministic gates, and review.
