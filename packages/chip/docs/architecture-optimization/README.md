# Architecture Optimization Research Index

The optimization backlog is organized around sustained performance per watt in
a mobile package with a large battery and explicit weight tolerance. The first
rule is Memory bandwidth and compression first: compute blocks only scale if
the memory, power, thermal, and software evidence paths scale with them.

## Required Optimization Fields

Every workstream must track scale-up path, performance, power consumption,
area/size, manufacturability, verification evidence, and release blockers.

| Area | File |
| --- | --- |
| Compute and silicon | `compute-silicon.md` |
| CPU+NPU 2028 readiness scorecard | `cpu-npu-2028-readiness-scorecard.yaml` |
| Modeled CPU+NPU operating point | `soc-optimized-operating-point.yaml` |
| Platform and product IO | `phone-platform.md` |
| Physical, power, package, thermal | `physical-power-thermal.md` |
| Software, benchmarks, CI | `software-ci.md` |

These files are work orders, not evidence of implementation.
