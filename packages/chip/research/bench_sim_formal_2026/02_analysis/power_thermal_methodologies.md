# Power and thermal measurement methodologies

Driver requirements per `docs/spec-db/npu-2028-target.yaml`:

- `burst_npu_power_w_max: 8`
- `sustained_npu_power_w_max: 4.5`
- `sustained_perf_per_w_int8_tops_min: 18`
- `always_on_micro_npu_power_mw_max: 20`
- Required evidence list includes `power_trace` and `thermal_trace`.

`docs/benchmarks/claim-ladder.md` allows `simulator` provenance for modeled
power at L1_RTL_FULL_SOC / L2_ARCH_SIM, and requires `measured` provenance
with `power_meter` calibration evidence at L3_SILICON_BARE_METAL and above.
This document catalogs the methods that can populate each band.

## Lab-grade external power meters

| Instrument | Range | Sampling | Use |
|---|---|---|---|
| Monsoon HVPM [monsoon_hvpm] | 0.8-13.5 V, up to ~6 A | 5 kHz | Standard MLPerf Mobile reference rig. |
| Monsoon LVPM [monsoon_lvpm] | 0.8-4.5 V | 5 kHz | Lower-voltage rails (NPU + memory subsystems). |
| Joulescope JS220 [joulescope_js220] | sub-uA -> 3 A, dynamic range > 10^9 | 2 MS/s | Practical replacement; covers always-on micro-NPU 20 mW band well. |

External meters are the only acceptable instrument for `provenance:
measured` at L3 / L4 per the claim ladder.

## Software-side energy / thermal attribution

| Method | Source | What it provides | Limits |
|---|---|---|---|
| Perfetto [perfetto] | Google | Unified Android trace (CPU sched, freq, GPU, NPU, batterystats, thermal zones, syscalls). | Software-side estimate; not a rail measurement. |
| Android Energy / Battery APIs [android_energy_api] | Google | `BatteryUsageStats`, `EnergyConsumer`, per-uid attribution. | Reports vendor-attributed numbers; calibrated to PMIC fuel gauge, not lab. |
| Intel SoC Watch [intel_socwatch] | Intel (proprietary) | Per-package C-state, P-state, RC6, GPU residency. | x86 only; reference for counter design. |
| ARM Streamline [arm_streamline] | Arm (proprietary) | PMU counters + power overlay. | ARM-only; reference for counter design. |

Recommendation for E1:

- Use Perfetto as the primary on-device tracer once Linux/Android lands.
- Pair Perfetto traces with rail-level Joulescope or Monsoon data to give
  both attribution and ground truth.
- Expose NPU performance counters in `e1_npu.sv` so Perfetto can pull
  per-tile utilization. The current implemented list in
  `npu-2028-target.yaml` is `basic_performance_counters`; this needs to
  be expanded with cycle / stall / SRAM-bandwidth / DMA-bandwidth /
  thermal-throttle counters before phone-class measurement is meaningful.

## MLPerf Mobile / MLPerf Power method

[mlperf_power] specifies:

- A `PTDaemon` host process that drives the measurement instrument.
- Reference instruments include Yokogawa WT500-series and instrument
  drivers for Monsoon-class.
- Mobile submissions integrate energy over the full QPS run, not over a
  single inference, to capture warm-up plus thermal steady state.
- Accuracy validation runs are interleaved with the measured workload.

E1 should imitate the closed-loop integration window even before MLPerf
Mobile is in scope. The per-inference energy column required by
`docs/benchmarks/benchmark-matrix.md` (joules per inference) must come
from integrated energy over the measured QPS run, divided by the count
of completed inferences.

## Thermal harness

For phone-class evidence, the thermal substrate is at least as important
as the energy meter. Reference methods used by Pixel and Galaxy
engineering teams:

- Thermocouples on the SoC top, package side, board, and skin.
- Controlled ambient (25C standard; 35C for hot-skin verification).
- Forced still-air vs free convection vs ambient phone case.
- Thermal-zone reads via `/sys/class/thermal/` in Android.
- Long sustained-run profile (>= 20 minutes) to catch slow thermal decay.

E1 reports need to record:

- Cooling configuration (free convection, forced air, heatsink).
- Ambient temperature.
- Thermal zones polled and sample interval.
- Skin temperature limit applied.

## Pre-silicon power models

For L1_RTL_FULL_SOC / L2_ARCH_SIM bands the simulator stack is:

| Model | Layer | Output |
|---|---|---|
| McPAT [mcpat] | Architecture | CPU+cache+memory dynamic + leakage. Pairs with gem5. |
| Aladdin [aladdin] | Pre-RTL accelerator | NPU dynamic + leakage at the algorithm level. Inside gem5-Aladdin [gem5_aladdin]. |
| Accelergy + CACTI (within Timeloop) [timeloop_accelergy] | Tile/loop-level | Per-buffer, per-MAC, per-DMA energy. The right energy model for the NPU tile geometry. |
| AccelWattch [accelwattch] | GPU/accelerator | Reference; lower fit than Accelergy. |
| Wattch [wattch] | CPU | Legacy reference. |
| GPUWattch [gpuwattch] | GPU | Legacy reference. |
| PowerNet [powernet] | RTL ML-driven IR-drop | Future PD work; not relevant pre-RTL. |

Recommended stack for E1 pre-silicon power evidence:

1. McPAT against the gem5 CPU/memory configuration.
2. Accelergy + CACTI inside Timeloop against the NPU tile geometry.
3. Optionally Aladdin via gem5-Aladdin for cross-validation.

Every modeled power number is `provenance: simulator`. Per the claim
ladder, it must not be quoted as a silicon claim.

## E1 evidence pipeline

| Band | Source | Output field |
|---|---|---|
| L0_RTL_UNIT | RTL toggle activity (Verilator FST) | qualitative only; no power claim. |
| L1_RTL_FULL_SOC | Verilator activity + McPAT/Accelergy | Modeled dynamic + leakage per workload. |
| L2_ARCH_SIM | gem5 + McPAT + Timeloop/Accelergy | Modeled energy per inference, modeled W. |
| L3_FPGA | FireSim board rail measurement + Perfetto | Real W on FPGA fabric (not phone-class). |
| L5_PROTOTYPE_SILICON | Monsoon/Joulescope + Perfetto + thermal harness | Real per-rail W, joules-per-inference, sustained W with skin temperature. |
| L6_COMPLETE_PHONE | Same + MLPerf Power method | Closed-loop QPS + energy + accuracy. |

The reporting fields required at each band map directly to the
`report-schema.yaml` `claim_level` and `provenance` enums. The crucial
discipline: never copy a modeled W into a measured-claim field, and never
quote a single-inference burst W where the target asks for sustained W.

## Concrete additions ranked by confidence

| Action | Confidence | Notes |
|---|---|---|
| Add Accelergy + CACTI to the NPU sim flow alongside SCALE-Sim v2. | High | Produces the energy column the benchmark-matrix requires. |
| Add McPAT to the gem5 CPU model when it lands. | High | Standard practice. |
| Expand `e1_npu.sv` performance counters (cycle, stall, SRAM BW, DMA BW, thermal throttle). | High | Pre-requisite for both modeled and measured power-per-workload attribution. |
| Document a Joulescope or Monsoon LVPM rig as the official rail meter. | High | Required for the `power_meter` calibration field. |
| Add Perfetto trace requirements to the report schema once Android boot exists. | High | Closes the `power_trace` and `thermal_trace` evidence list items. |
| Pilot PowerNet for IR-drop after the first OpenLane PD run completes. | Low | PD lane, not pre-silicon. |
