#!/usr/bin/env python3
"""Fail-closed gate for the E1 NPU MLPerf Inference harness (modeled).

Runs ``benchmarks/mlperf/run_mlperf_inference.py`` and validates that the
emitted ``eliza.mlperf_inference.v1`` report:

- ran both SingleStream and Offline scenarios against the real E1 NPU
  sim datapath,
- scored functional accuracy against the reference oracle,
- recorded latency percentiles (SingleStream) and throughput (Offline),
- produced a schema-valid ``energy_joules_per_inference`` block (G-7)
  with ``provenance: simulator`` and a fail-closed calibration status,
- carries the explicit modeled / pre-silicon claim boundary, and
- keeps the measured-silicon-power axis BLOCKED.

The gate fails closed: any missing field, a measured-power claim, an
official-submission claim, or sub-100%% functional accuracy is an error.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.mlperf.model import macs_per_inference  # noqa: E402

RUNNER = ROOT / "benchmarks/mlperf/run_mlperf_inference.py"

EXPECTED_SCHEMA = "eliza.mlperf_inference.v1"
EXPECTED_CLAIM_BOUNDARY = (
    "modeled_preSilicon_not_official_submission_and_not_measured_power"
)
EXPECTED_SCENARIOS = {"SingleStream", "Offline"}
EXPECTED_PERCENTILES = {"p50", "p90", "p99"}
ENERGY_REQUIRED_KEYS = {
    "value",
    "units",
    "provenance",
    "instrument",
    "sampling_rate_hz",
    "integration_window_seconds",
    "ground_truth_reference",
    "sample_count",
    "calibration",
}


def _check_energy_block(prefix: str, block: object, errors: list[str]) -> None:
    if not isinstance(block, dict):
        errors.append(f"{prefix} energy_joules_per_inference must be an object")
        return
    missing = sorted(ENERGY_REQUIRED_KEYS - set(block))
    if missing:
        errors.append(f"{prefix} energy block missing keys: {', '.join(missing)}")
    value = block.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        errors.append(f"{prefix} energy value must be positive numeric")
    if block.get("units") != "J_per_inference":
        errors.append(f"{prefix} energy units must be J_per_inference")
    if block.get("provenance") != "simulator":
        errors.append(f"{prefix} energy provenance must be simulator (modeled, not measured)")
    calibration = block.get("calibration")
    if not isinstance(calibration, dict):
        errors.append(f"{prefix} energy calibration must be an object")
    elif calibration.get("status") != "blocked-no-calibrated-assets":
        errors.append(
            f"{prefix} energy calibration must stay blocked-no-calibrated-assets pre-silicon"
        )


def main() -> int:
    errors: list[str] = []
    if not RUNNER.is_file():
        return report([f"missing harness runner: {RUNNER.relative_to(ROOT)}"])

    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--query-count", "32"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return report(["mlperf harness command failed", completed.stderr.strip()])
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return report([f"mlperf harness emitted invalid JSON: {exc}"])

    if data.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"schema must be {EXPECTED_SCHEMA}")
    if data.get("claim_boundary") != EXPECTED_CLAIM_BOUNDARY:
        errors.append("claim_boundary must record modeled/pre-silicon/not-official/not-measured")
    if data.get("provenance") != "simulator":
        errors.append("report provenance must be simulator")
    if data.get("claim_level") not in {"L0_RTL_UNIT", "L1_RTL_FULL_SOC", "L2_ARCH_SIM"}:
        errors.append("claim_level must be a simulator-compatible level (L0-L2)")

    sut = data.get("sut")
    if not isinstance(sut, dict) or sut.get("real_runtime_path") is not True:
        errors.append("sut must run the real E1 NPU runtime/sim path")

    expected_macs_per_inference = macs_per_inference()
    workload = data.get("workload")
    if not isinstance(workload, dict):
        errors.append("report must include workload block")
    elif workload.get("macs_per_inference") != expected_macs_per_inference:
        errors.append(
            f"workload.macs_per_inference must be {expected_macs_per_inference}"
        )

    fidelity = data.get("fidelity")
    if not isinstance(fidelity, dict):
        errors.append("report must declare a fidelity boundary block")
    else:
        if fidelity.get("loadgen", "").find("not_mlcommons_loadgen_binary") < 0:
            errors.append("fidelity must disclose this is not the MLCommons loadgen binary")
        if fidelity.get("submission_status") != "not_an_official_mlcommons_submission":
            errors.append("fidelity must disclose this is not an official MLCommons submission")

    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        errors.append("report must include scenario results")
        return report(errors)

    seen = set()
    for index, scenario in enumerate(scenarios):
        prefix = f"scenarios[{index}]"
        if not isinstance(scenario, dict):
            errors.append(f"{prefix} must be an object")
            continue
        name = scenario.get("scenario")
        seen.add(name)
        accuracy = scenario.get("accuracy")
        if not isinstance(accuracy, dict):
            errors.append(f"{prefix} missing accuracy block")
        elif accuracy.get("top1_accuracy") != 1.0:
            errors.append(
                f"{prefix} functional accuracy must be 1.0 (NPU sim byte-exact vs reference)"
            )
        _check_energy_block(prefix, scenario.get("energy_joules_per_inference"), errors)
        counters = scenario.get("npu_counters")
        query_count = scenario.get("query_count")
        if not isinstance(query_count, int) or query_count <= 0:
            errors.append(f"{prefix} query_count must be positive integer")
        if not isinstance(counters, dict):
            errors.append(f"{prefix} must include NPU counters")
        elif isinstance(query_count, int) and query_count > 0:
            if counters.get("inferences") != query_count:
                errors.append(f"{prefix} inference counter must match query_count")
            if counters.get("npu_commands") != query_count * 2:
                errors.append(f"{prefix} must issue exactly two NPU commands per inference")
            if counters.get("npu_macs") != query_count * expected_macs_per_inference:
                errors.append(f"{prefix} NPU MAC count must match workload contract")
            if scenario.get("observed_macs_per_inference") != float(expected_macs_per_inference):
                errors.append(f"{prefix} observed_macs_per_inference must match workload contract")
        if name == "SingleStream":
            percentiles = scenario.get("latency_percentiles_ns")
            if not isinstance(percentiles, dict):
                errors.append(f"{prefix} SingleStream must report latency percentiles")
            else:
                missing = sorted(EXPECTED_PERCENTILES - set(percentiles))
                if missing:
                    errors.append(f"{prefix} missing percentiles: {', '.join(missing)}")
                for key, value in percentiles.items():
                    if not isinstance(value, int) or value < 0:
                        errors.append(f"{prefix}.{key} must be a non-negative integer ns latency")
        elif name == "Offline":
            throughput = scenario.get("throughput_samples_per_second")
            if not isinstance(throughput, (int, float)) or throughput <= 0:
                errors.append(f"{prefix} Offline must report positive throughput")

    missing_scenarios = sorted(EXPECTED_SCENARIOS - seen)
    if missing_scenarios:
        errors.append(f"missing required scenarios: {', '.join(missing_scenarios)}")

    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("report must include a summary")
    else:
        blocked = summary.get("blocked_axes")
        if not isinstance(blocked, list):
            errors.append("summary.blocked_axes must be a list")
        else:
            blocker_ids = {
                axis.get("blocker_id") for axis in blocked if isinstance(axis, dict)
            }
            if "mlperf-power-closed" not in blocker_ids:
                errors.append(
                    "summary.blocked_axes must keep the measured-silicon-power axis BLOCKED "
                    "(blocker_id mlperf-power-closed)"
                )
        npu_macs = summary.get("npu_macs_total")
        if not isinstance(npu_macs, int) or npu_macs <= 0:
            errors.append("summary.npu_macs_total must be a positive integer NPU MAC count")
        elif isinstance(scenarios, list):
            expected_total = sum(
                scenario.get("query_count", 0) * expected_macs_per_inference
                for scenario in scenarios
                if isinstance(scenario, dict) and isinstance(scenario.get("query_count"), int)
            )
            if npu_macs != expected_total:
                errors.append(
                    f"summary.npu_macs_total must equal scenario MAC sum {expected_total}"
                )

    return report(errors)


def report(errors: list[str]) -> int:
    clean = [error for error in errors if error]
    if clean:
        print("MLPerf Inference harness check failed:")
        for error in clean:
            print(f"  - {error}")
        return 1
    print(
        "MLPerf Inference harness check passed "
        "(MODELED, pre-silicon; not an official MLCommons submission; "
        "measured silicon power stays BLOCKED)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
