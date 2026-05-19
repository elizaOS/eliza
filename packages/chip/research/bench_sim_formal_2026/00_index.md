# Benchmarks, simulators, formal verification — Eliza E1 research packet (2026-05-19)

Scope: catalog every cutting-edge benchmark, simulator, and verification
framework that is relevant to the L0→L5 evidence ladder defined by
`docs/benchmarks/claim-ladder.md` and the `npu-2028-target.yaml` evidence list.
This packet is research input for the chip workstreams; nothing here changes
the production gates in `benchmarks/`, `docs/benchmarks/`, or `verify/`.

Anchors in the existing repo:

- `benchmarks/run_benchmarks.py` — v0 host benchmark runner (CoreMark, STREAM,
  lmbench, fio, TFLite `benchmark_model`).
- `benchmarks/sim/run_npu_scale_sim.py` — NPU analytical perf model around
  `compiler/runtime/e1_npu_scale_model.py` and `process-14a-effects.yaml`.
- `verify/cocotb/` — cocotb 1.x testbenches against Verilator
  (`verify/cocotb/Makefile`).
- `verify/formal/*.sby` — SymbiYosys BMC scripts (`smtbmc z3`, depth 4–12).
- `docs/benchmarks/claim-ladder.md` — L0_RTL_UNIT → L6_COMPLETE_PHONE ladder.
- `docs/benchmarks/benchmark-matrix.md` — per-area pre-silicon / FPGA / phone
  gates.
- `docs/toolchain/benchmark-simulator-critical-gap-audit.md` — current honest
  status of fake-vs-real simulator paths.
- `docs/three-week-prototype-workstreams.md` Workstream A and E — open
  RTL/formal/cocotb/toolchain gaps and the explicit Bitwuzla evaluation note.
- `docs/spec-db/npu-2028-target.yaml` — required evidence list (MLPerf Mobile,
  tflite `benchmark_model`, unsupported operator report, CPU fallback report,
  power and thermal traces).

## Packet layout

```
research/bench_sim_formal_2026/
  00_index.md                        # this file
  01_sources/
    source_inventory.yaml            # >=45 entries, primary references
  02_analysis/
    mlperf_and_mobile_benchmarks.md  # MLPerf v4/v5 + Mobile + AI-Benchmark + GB-AI + Procyon
    architectural_simulators.md      # gem5, FireSim, Chipyard, Sniper, ChampSim, ZSim, MARSSx86
    npu_simulators.md                # SCALE-Sim v2, Timeloop/Accelergy, STONNE, NeuroSim,
                                     # ASTRA-sim, MAESTRO, GAMMA, dMazeRunner, Mind Mappings,
                                     # Interstellar — applied to E1 tile NPU
    formal_and_fuzz_state.md         # SymbiYosys, smtbmc, Bitwuzla, Z3, CVC5, EBMC,
                                     # RFUZZ, DifuzzRTL, TheHuzz, ProcessorFuzz, Hypothesis
    power_thermal_methodologies.md   # Monsoon, MLPerf Power, Perfetto, ARM Streamline,
                                     # SoC Watch, Android Energy API, McPAT, Aladdin,
                                     # AccelWattch, PowerNet
  03_implementation/
    verification_path_for_e1.md      # ranked recommendations tied to verify/, benchmarks/,
                                     # docs/benchmarks/, and the three-week workstream gaps
```

## Reading order

1. `01_sources/source_inventory.yaml` — every claim in the analysis files cites
   one of these entries by `id`.
2. `02_analysis/mlperf_and_mobile_benchmarks.md` — what evidence the
   `npu-2028-target.yaml` "MLPerf Mobile or equivalent closed loop" line should
   actually be backed by, and what 2026 MLPerf v5.x adds.
3. `02_analysis/architectural_simulators.md` — practical role of gem5,
   Chipyard (FireSim, Sodor, Rocket sim), Sniper, ChampSim, ZSim, and
   MARSSx86 inside the L2_ARCH_SIM band the schema already allows.
4. `02_analysis/npu_simulators.md` — how SCALE-Sim v2, Accelergy/Timeloop,
   STONNE, MAESTRO, NeuroSim, ASTRA-sim, GAMMA, dMazeRunner, Mind Mappings,
   Interstellar, and Eyexam map onto an E1 tiled-matrix-vector NPU.
5. `02_analysis/formal_and_fuzz_state.md` — concrete migration plan for the
   `smtbmc z3` SBY flow (Bitwuzla post-Boolector), property-based testing
   (Hypothesis / Hedgehog / cocotb-stims), and RTL fuzzing baselines.
6. `02_analysis/power_thermal_methodologies.md` — MLPerf Mobile power method,
   Monsoon HVPM/LVPM, Pixel/Galaxy thermal harnesses, Android `BatteryStats`
   and `Energy Aggregation`, ARM Streamline, Intel SoC Watch, plus pre-silicon
   McPAT/Aladdin/AccelWattch/PowerNet.
7. `03_implementation/verification_path_for_e1.md` — ordered, high-confidence
   recommendations that fit inside the open Workstream A and E gaps without
   inventing claims.

## Out of scope

- Closed-tool EDA (VCS, Xcelium, Modelsim, JasperGold, HAPS, Palladium) is
  only referenced as positioning; this packet does not recommend buying them
  for the open-tool L0→L3 path.
- Product-comparison benchmarking (Geekbench 6, MLPerf Client, GFXBench,
  3DMark) is referenced for the L6_COMPLETE_PHONE band only; nothing here
  upgrades current evidence past L0_RTL_UNIT.
- No fabrication. Every framework, version, repo, and paper named here is
  cited in `source_inventory.yaml` with the official URL.
