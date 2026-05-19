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

## Recommended order for E1

1. OpenROAD AutoTuner around the existing PD scripts.
2. LLM4DV-style coverage-directed cocotb stimulus.
3. AssertionForge/AssertEval patterns for candidate SVA, reviewed before use.
4. ZigZag for NPU architecture/mapping exploration.
5. CircuitOps/CircuitNet/OpenABC-D once there are enough local E1 run labels.
