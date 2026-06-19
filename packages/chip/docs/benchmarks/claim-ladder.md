# Benchmark Claim Ladder

This ladder defines which claims each pre-silicon / post-silicon level of
evidence can support, and which it cannot. It is the bridge between the
benchmark harness (`benchmarks/run_benchmarks.py`), the report schema
(`docs/benchmarks/report-schema.yaml` `claim_level` enum), and product
messaging.

The rule is monotonic: a claim valid at level N is automatically valid at
N+1. A claim invalid at level N may NOT be quoted from a level-N report
even when "the numbers look reasonable." Numbers without the right
substrate are decoration, not evidence.

Use the `claim_level` field of a benchmark report to select the row.

## Levels

### L0 — Simulator dry-run (no model)

Substrate: `benchmarks/run_benchmarks.py plan` or `run` against a host
that has no benchmark binaries and no model artifact. The simulator
state (QEMU, Renode, gem5) is irrelevant at L0; the harness only proves
that the planning surface is consistent.

Maps to schema `claim_level: L0_RTL_UNIT` for RTL-unit dry-runs, or to
the `dry_run: true` provenance for harness-level dry-runs.

Can support:
- The benchmark plan is complete: every entry has a parser, a primary
  metric, required calibration assets, and a generator path for any
  artifact dependency.
- Missing dependencies and blocked artifacts are visible to CI via
  `missing_dependencies` and `blocked_assets` in the generated report.

Cannot support:
- Any performance claim. No code ran.
- Any claim about the SoC, the NPU, the memory subsystem, or the OS.
- Any claim about Android boot or CTS/VTS.

### L1 — Simulator with model (functional)

Substrate: gem5 / Verilator / QEMU running the same workload binary the
target will run, with the smoke model and parser-validated counters.
Maps to schema `claim_level: L1_RTL_FULL_SOC` for Verilator-level
substrates and `L2_ARCH_SIM` for gem5-class architecture simulators.

Result `provenance` must be `simulator`. Parser is
`simulator_metrics_v1` for counters; `tflite_benchmark_model` is allowed
only for the functional path (NPU shim returns unsupported, CPU
fallback runs).

Can support:
- Functional correctness: workload runs to completion, parser extracts
  metrics, outputs match a golden reference within stated tolerance.
- Target-cycle counts, IPC, MPKI, cache and interconnect transactions,
  modeled frequency.
- Modeled power, energy, thermal, and process-corner derates only when the
  report explicitly binds to the 14A process-effects contract and marks the
  result as modeled, not PDK or silicon signoff.
- Operator-level NPU correctness (unsupported op count, CPU fallback
  percent) when the runtime shim is exercised.
- Calibration evidence for `simulator_config` and
  `simulator_counter_export`.

Cannot support:
- Wall-clock latency or throughput on real hardware.
- Measured silicon power, energy, joules-per-inference, thermal behavior,
  sustained performance, or throttling.
- Any phone-class comparison (`forbidden_metrics`:
  `wall_clock_score`, `phone_score`, `geekbench_score`).
- AOSP boot or CTS/VTS pass status.

### L2 — FPGA bitstream

Substrate: e1_soc bitstream on a supported FPGA board (e.g. ULX3S
or FireSim-class). Maps to schema `claim_level: L3_FPGA`. Result
`provenance` must be `measured`.

Can support:
- Long-workload Linux boot evidence (init, drivers, smoke services).
- Functional STREAM / lmbench / CoreMark / fio runs on the FPGA-hosted
  CPU, with the substrate clearly labeled.
- Memory bandwidth and latency *trends* between configurations.
- NPU functional path through the runtime shim, including unsupported
  op count and CPU fallback percent.

Cannot support:
- Phone-class CPU score (FPGA frequency is 1-2 orders of magnitude
  below silicon target).
- Mobile SoC power (FPGA board power includes the FPGA fabric).
- Thermal behavior representative of a phone package.
- Vulkan / GLES conformance numbers.
- Geekbench, MLPerf Mobile, or any consumer benchmark comparison.

### L3 — Silicon bare-metal

Substrate: prototype silicon running bare-metal or a minimal kernel,
with calibrated clock source and external power meter. Maps to schema
`claim_level: L5_PROTOTYPE_SILICON`. Result `provenance` should be
`target-measured` for prototype/board-target transcripts or
`silicon-measured` for fabricated-silicon transcripts; legacy `measured`
is accepted only when target execution metadata still proves a real
prototype, silicon, or phone runner.
Calibration assets must include `clock_source` and `power_meter` with
real evidence, not placeholders.

Can support:
- Real clock frequency, voltage, and instantaneous power.
- CoreMark and STREAM scores on the silicon CPU, reported with the
  clock and the binary's calibration tuple.
- NPU TOPS *as measured*, but only when paired with latency, fallback
  rate, and joules-per-inference (per project reporting rule).
- DRAM and IO basic functional behavior.

Cannot support:
- Android runtime behavior (no Android booted at this level).
- CTS / VTS pass status.
- App launch, media scan, or other framework-level measurements.
- Sustained-load thermal claims unless a thermal envelope was applied
  (record cooling and ambient explicitly).

### L4 — Silicon Android

Substrate: prototype silicon booted into AOSP riscv64 with the
project's HALs in place. Maps to schema `claim_level: L6_COMPLETE_PHONE`
**only** when the substrate is a complete phone reference design;
otherwise stay at `L5_PROTOTYPE_SILICON` and qualify the claim.

Required reports MUST separate boot success from CTS/VTS compatibility
(per `report-schema.yaml` validation rule
"Android reports must separate boot success from CTS/VTS compatibility").

Can support:
- AOSP boot evidence end-to-end (the cuttlefish recipe markers, but
  on real silicon).
- CTS / VTS subset pass criteria (per
  `docs/android/cts-vts-smoke-plan.md`).
- TFLite benchmark_model on CPU and through the e1-NPU NNAPI path,
  with `unsupported_op_count` and `cpu_fallback_percent` required.
- Sustained workload behavior, app launch latency, and SQLite / fio on
  the production storage stack — when the thermal envelope and power
  rail measurements are recorded.

Cannot support:
- Product comparison against Snapdragon / Dimensity / Tensor / Exynos
  / Apple unless the substrate is a complete phone (level L6 in the
  report schema) with all reporting fields populated.
- Widevine L1, Play certification, or GMS-gated metrics — those are
  out of v0 scope (see `docs/android/riscv-bringup.md` explicit
  exclusions).

## Cross-Reference

| Ladder level | Schema claim_level | Provenance | Android allowed? |
|---|---|---|---|
| L0 dry-run | L0_RTL_UNIT | dry_run | No |
| L1 simulator-with-model | L1_RTL_FULL_SOC / L2_ARCH_SIM | simulator | No |
| L2 FPGA bitstream | L3_FPGA | measured | Linux yes, Android scaffolding only |
| L3 silicon bare-metal | L5_PROTOTYPE_SILICON | target-measured or silicon-measured | No |
| L4 silicon-Android | L5_PROTOTYPE_SILICON or L6_COMPLETE_PHONE | target-measured or silicon-measured | Yes |

## How To Use This Ladder

1. Pick the level whose substrate matches your evidence.
2. Look at "Can support" — these are the only claims you may put in
   the report's `metrics` and in any external messaging.
3. Look at "Cannot support" — explicitly mark any such claim as
   `out of scope at this level` if asked.
4. Set `claim_level` on the report accordingly. The runner validates
   that real reports include the metadata that level requires.
5. If a reviewer asks for a higher-level claim, the right answer is
   "regenerate evidence at level N+1," not "extrapolate from level N."

## References

- `docs/benchmarks/benchmark-matrix.md` — the gate matrix per area.
- `docs/benchmarks/report-schema.yaml` — schema authority.
- `docs/benchmarks/harness.md` — runner CLI.
- `docs/toolchain/benchmark-simulator-critical-gap-audit.md` — why
  simulator wall-clock cannot become phone scores.
- `docs/android/cts-vts-smoke-plan.md` — CTS/VTS subset for L4.
