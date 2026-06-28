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
| CPU+NPU 2028 manual review | `cpu-npu-2028-manual-review.yaml` |
| CPU+NPU 2028 readiness scorecard | `cpu-npu-2028-readiness-scorecard.yaml` |
| CPU+NPU design-space frontier | `../../benchmarks/results/cpu-npu-2028-design-space-frontier.json` |
| CPU+NPU modeled benchmark eval | `../../benchmarks/results/cpu-npu-2028-modeled-eval.json` |
| CPU+NPU burst/sustained policy | `../../benchmarks/results/cpu-npu-2028-burst-sustained-policy.json` |
| CPU+NPU burst thermal transient | `../../benchmarks/results/cpu-npu-2028-burst-thermal-transient.json` |
| CPU+NPU AOSP governor trace | `../../benchmarks/results/cpu-npu-2028-aosp-governor-trace.json` |
| CPU+NPU 14A process eval | `../../benchmarks/results/cpu-npu-2028-14a-process-eval.json` |
| CPU+NPU competitive envelope | `../../benchmarks/results/cpu-npu-2028-competitive-envelope.json` |
| CPU+NPU tapeout readiness audit | `../../benchmarks/results/cpu-npu-2028-tapeout-readiness-audit.json` |
| Modeled CPU+NPU operating point | `soc-optimized-operating-point.yaml` |
| Platform and product IO | `phone-platform.md` |
| Physical, power, package, thermal | `physical-power-thermal.md` |
| Software, benchmarks, CI | `software-ci.md` |
| 2028 SOTA integrated report | `2028-sota-integrated-report.md` |
| 2028 SOTA sub-reports | `sota-2028/` (8 per-domain artifacts) |

These files are work orders, not evidence of implementation.

## 2028 SOTA Research

The `2028-sota-integrated-report.md` synthesizes cross-domain SOTA research into
target envelopes, risks, IP walls, and a prioritized P0-P3 work order. Per-domain
sub-reports under `sota-2028/` carry full citations and detail:

- [Branch predictors](sota-2028/branch-predictors.md)
- [Cache hierarchies](sota-2028/cache-hierarchies.md)
- [Memory subsystem](sota-2028/memory-subsystem.md)
- [OoO execution](sota-2028/ooo-execution.md)
- [Process nodes](sota-2028/process-nodes.md)
- [Power delivery](sota-2028/power-delivery.md)
- [Physical design](sota-2028/physical-design.md)
- [Compiler tuning](sota-2028/compiler-tuning.md)
