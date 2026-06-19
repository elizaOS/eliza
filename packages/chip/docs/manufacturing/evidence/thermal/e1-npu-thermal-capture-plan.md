# E1-NPU Thermal Capture Plan

Status: `blocked`
Release use: `prohibited_until_measured_sustained_evidence_passes`

This plan defines the thermal evidence required before any sustained
performance, throttling, or TOPS/W claim. It is not thermal evidence.

## Required Capture

Use the workload plan in `benchmarks/power/workload-plan.yaml` and validate the
filled manifest with:

```sh
python3 benchmarks/power/scripts/check_sustained_run_evidence.py \
  benchmarks/power/manifests/e1-npu-sustained-capture.<run-id>.json
```

Minimum requirements:

- 30 minute workload window after at least 120 seconds of warmup.
- Ambient temperature, cooling state, enclosure or fixture, operator, and board
  or phone serial number recorded.
- Die/package/board temperature trace aligned to power, frequency, and workload
  transcript timestamps within 1 second.
- Throttle state recorded for the full window.
- Stop conditions documented before the run starts.

## Stop Conditions

- Any rail reaches the approved bench current limit.
- Die, package, board, or skin temperature crosses the approved lab limit.
- Thermal shutdown, clock throttling, or unexpected CPU fallback appears.
- Power, thermal, frequency, and workload traces cannot be timestamp-aligned.

## Blockers

- No measured silicon or complete-phone target is available.
- No calibrated thermal sensor or thermocouple record is archived.
- No package, board, enclosure, airflow, or skin-temperature model is approved.
- Local OpenLane power is not a thermal source model for release.
