# Architectural simulators for the E1 L2_ARCH_SIM band

The schema in `docs/benchmarks/report-schema.yaml` admits `L2_ARCH_SIM` as a
distinct claim level. Today the only simulator wired into the harness is
`benchmarks/sim/run_npu_scale_sim.py` (NPU analytical) plus QEMU (functional,
not timing). This file catalogs the open simulators that can fill the
L2_ARCH_SIM band for the CPU / memory / interconnect side.

## gem5 (canonical L2 CPU simulator)

[gem5] is the only credible open candidate for L2_ARCH_SIM CPU + memory
modeling. Relevant capabilities for E1:

- **ISA**: RISC-V (RV64GC, partial V, partial H), with full-system Linux
  boot.
- **CPU models**: `MinorCPU` (in-order, matches Rocket-class), `O3CPU`
  (out-of-order, matches BOOM-class).
- **Memory**: `Ruby` MOESI/MESI cache coherence, `Garnet2.0` NoC,
  `DRAMSim3` / built-in DRAMCtrl with LPDDR4 / LPDDR5 profiles.
- **Power**: `gem5-Aladdin` [gem5_aladdin] gives pre-RTL accelerator
  perf+power, and McPAT [mcpat] integration covers CPU+cache+memory.
- **Recent releases**: gem5 24.x rolling minor releases through 2024-2025
  include the standard library API used by the Chipyard integration path.

Practical role for E1:

1. Build a gem5 model matched to the selected Chipyard Rocket
   configuration (Workstream B). Use `MinorCPU` calibrated to the Rocket
   single-issue, in-order pipeline.
2. Add an LPDDR5 controller and a coarse interconnect for the e1 AXI-Lite
   path; this is the right substrate for STREAM and lmbench *target-cycle*
   estimates ahead of FPGA bring-up.
3. Couple gem5-Aladdin to the `tile_matrix_vector_npu` perf model so that
   end-to-end inferences (compiler -> tile schedule -> CPU + DMA + NPU
   timing) can be evaluated without booting Linux on FPGA.

L2_ARCH_SIM claims supported by gem5:

- IPC, MPKI, branch-mispredict rate.
- Cache-line transactions, memory-bandwidth utilization, NoC contention.
- Modeled energy when McPAT or Aladdin is wired in, marked `simulator` not
  `measured` per `docs/benchmarks/claim-ladder.md`.

## Chipyard + FireSim (L3 lift)

[chipyard] and [chipyard_firesim] are already named as the selected Linux-
capable AP path in `docs/three-week-prototype-workstreams.md`. Roles:

- **Chipyard local Verilator / VCS simulation**: the existing `make cocotb`
  surface today; the same Verilator path is used for L1_RTL_FULL_SOC.
- **FireSim on AWS F1/F2**: lift the Chipyard build to cycle-exact FPGA
  emulation for Linux-boot evidence at L3_FPGA. The migration from F1
  (Xilinx UltraScale+) to F2 (AMD Versal) is the relevant 2024-2025
  upstream activity tracked in the FireSim repo.
- **Gemmini** [gemmini]: the closest open analogue to the E1 tile NPU.
  Worth integrating into the L2_ARCH_SIM lane to compare scheduler
  output against the E1 NPU scale model.

Constraint: FireSim does not produce phone-class power numbers. Per the
claim ladder, FireSim evidence is L3_FPGA only.

## Other simulators surveyed

| Simulator | Maturity | RISC-V support | Fit for E1 |
|---|---|---|---|
| Sniper [sniper] | Active, interval-simulation | x86 strong, RISC-V community | Reference for interval-simulation technique; not a primary L2 candidate. |
| ChampSim [champsim] | Active in academic contests | Trace-driven, ISA-agnostic | Useful for cache/prefetcher what-ifs once traces exist. |
| zsim [zsim] | Effectively legacy (2018 last major) | x86 only | Reference only. |
| MARSSx86 [marssx86] | Inactive | x86 only | Reference only. |
| QFlex [qflex] | Active | Server-class | Reference for server systems; not relevant to a phone AP. |

## Sodor (educational RV cores) [chipyard_sodor]

Useful only as a teaching reference; the tiny CPU stub already in
`rtl/cpu/e1_cpu_subsystem_stub.sv` is closer to a Sodor 1-stage core than
Rocket. Sodor is *not* the production CPU/AP path.

## Recommended pre-silicon architectural sim plan

| Phase | Simulator | Purpose | Claim level |
|---|---|---|---|
| Now | Verilator (cocotb) | RTL functional + protocol coverage | L0_RTL_UNIT / L1_RTL_FULL_SOC |
| Phase A | gem5 (MinorCPU + LPDDR5 + classic memory) | CPU + memory target-cycle, MPKI, BW utilization | L2_ARCH_SIM |
| Phase A | SCALE-Sim v2 + Timeloop/Accelergy | NPU tile-geometry sweep (see `npu_simulators.md`) | L2_ARCH_SIM |
| Phase A | gem5-Aladdin or Accelergy/Timeloop -> gem5 NPU model | NPU pre-RTL power | L2_ARCH_SIM |
| Phase B | Chipyard Verilator at SoC scale | Multi-tile + memory + NPU integration sanity | L1_RTL_FULL_SOC |
| Phase B | Chipyard + FireSim on AWS F2 | Linux boot + smoke benchmarks at FPGA speed | L3_FPGA |

Every phase must keep the calibration tuple required by the schema:
clock source, power meter (modeled vs measured), substrate name, and run
protocol.

## Things to avoid

- Quoting QEMU wall-clock as an E1 score (see
  `docs/toolchain/benchmark-simulator-critical-gap-audit.md`).
- Mixing gem5 modeled energy with Aladdin energy without disclosing the
  composition; both are modeled, and the report must say so.
- Treating Chipyard FireSim Linux boot as silicon-class performance.
  Per the claim ladder, FireSim is L3 evidence at most.
