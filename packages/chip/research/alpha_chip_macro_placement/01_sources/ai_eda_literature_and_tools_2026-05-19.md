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
- PostEDA-Bench: <https://arxiv.org/abs/2605.06936>. Cautionary benchmark for
  post-route EDA agents.

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
