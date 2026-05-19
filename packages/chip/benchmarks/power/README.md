# Power And Thermal Evidence

This directory is the local gate for e1-NPU sustained power and thermal
evidence. It keeps three things separate:

- local OpenLane power/current arithmetic
- modeled NPU architecture throughput
- measured sustained power/thermal evidence from silicon or a complete phone

Only the third class can support sustained TOPS/W, thermal, throttling, or
phone power claims.

## Local Estimate

Generate the current local cross-check:

```sh
python3 benchmarks/power/scripts/derive_local_power_estimates.py
```

The output is
`benchmarks/power/local-estimates/e1-npu-openlane-npu-estimates.json`.
It deliberately marks the combined TOPS/W arithmetic as invalid because the
OpenLane power and architecture-model TOPS do not come from the same measured
substrate or workload window.

## Sustained Evidence Gate

Validate a sustained evidence manifest:

```sh
python3 benchmarks/power/scripts/check_sustained_run_evidence.py \
  benchmarks/power/manifests/e1-npu-sustained-capture.template.json
```

Blocked or draft manifests return `2` by default. Use `--allow-blocked` only
for CI/readiness checks that are expected to prove the blocker shape, not release
readiness.

Measured release evidence must use
`schema: eliza.sustained_power_thermal_evidence.v1`, list calibrated power,
thermal, frequency, workload, and calibration artifacts, and pass the checker
with `status: complete_measured_evidence`.
