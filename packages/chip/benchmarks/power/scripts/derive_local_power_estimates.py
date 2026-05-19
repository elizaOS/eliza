#!/usr/bin/env python3
"""Derive local-only power cross-checks from archived PD and benchmark metrics.

The output is intentionally not a silicon power estimate. It combines the
current OpenLane post-route power number with the local NPU architecture model
only to make the blocker explicit and machine-readable.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OPENLANE_RUN = ROOT / "pd/openlane/runs/RUN_2026-05-18_05-41-42"
DEFAULT_NPU_REPORT = ROOT / "benchmarks/results/npu-arch-sim-open-2028/report.json"
DEFAULT_OUT = ROOT / "benchmarks/power/local-estimates/e1-npu-openlane-npu-estimates.json"


def resolve(path: Path) -> Path:
    return path if path.is_absolute() else ROOT / path


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{display_path(path)} must contain a JSON object")
    return data


def require_number(data: dict[str, Any], key: str, source: Path) -> float:
    value = data.get(key)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"{display_path(source)} missing numeric key {key}")
    return float(value)


def find_npu_scale_result(report: dict[str, Any], source: Path) -> dict[str, Any]:
    results = report.get("results")
    if not isinstance(results, list):
        raise ValueError(f"{display_path(source)} missing results list")
    for result in results:
        if isinstance(result, dict) and result.get("name") == "npu_arch_sim_open_2028":
            return result
    raise ValueError(f"{display_path(source)} missing npu_arch_sim_open_2028 result")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--openlane-run", type=Path, default=DEFAULT_OPENLANE_RUN)
    parser.add_argument("--npu-report", type=Path, default=DEFAULT_NPU_REPORT)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    openlane_run = resolve(args.openlane_run)
    metrics_path = openlane_run / "final/metrics.json"
    resolved_path = openlane_run / "resolved.json"
    npu_report_path = resolve(args.npu_report)
    out = resolve(args.out)

    metrics = load_json(metrics_path)
    resolved = load_json(resolved_path)
    npu_report = load_json(npu_report_path)
    npu_result = find_npu_scale_result(npu_report, npu_report_path)
    npu_metrics = npu_result.get("metrics")
    if not isinstance(npu_metrics, dict):
        raise ValueError(f"{display_path(npu_report_path)} NPU result missing metrics")

    power_w = require_number(metrics, "power__total", metrics_path)
    voltage_v = require_number(resolved, "VDD_PIN_VOLTAGE", resolved_path)
    internal_w = require_number(metrics, "power__internal__total", metrics_path)
    switching_w = require_number(metrics, "power__switching__total", metrics_path)
    leakage_w = require_number(metrics, "power__leakage__total", metrics_path)
    vpwr_drop_v = require_number(metrics, "design_powergrid__drop__worst__net:VPWR", metrics_path)
    vgnd_bounce_v = require_number(metrics, "design_powergrid__drop__worst__net:VGND", metrics_path)
    min_tops = require_number(npu_metrics, "min_observed_tops", npu_report_path)
    max_tops = require_number(npu_metrics, "max_observed_tops", npu_report_path)

    current_a = power_w / voltage_v
    payload = {
        "schema": "eliza.local_power_estimates.v1",
        "status": "local_estimate_only",
        "release_use": "prohibited",
        "claim_boundary": "not_measured_silicon_not_sustained_power_not_thermal_evidence",
        "source_artifacts": {
            "openlane_metrics": display_path(metrics_path),
            "openlane_resolved_config": display_path(resolved_path),
            "npu_architecture_benchmark_report": display_path(npu_report_path),
        },
        "openlane_post_route": {
            "selected_run": display_path(openlane_run),
            "vddcore_voltage_v": voltage_v,
            "total_power_w": power_w,
            "internal_power_w": internal_w,
            "switching_power_w": switching_w,
            "leakage_power_w": leakage_w,
            "nominal_core_current_a": current_a,
            "two_x_current_budget_a": current_a * 2.0,
            "vpwr_worst_ir_drop_v": vpwr_drop_v,
            "vgnd_worst_bounce_v": vgnd_bounce_v,
        },
        "npu_architecture_model": {
            "report_id": npu_report.get("report_id"),
            "claim_level": npu_report.get("claim_level"),
            "benchmark": npu_result.get("name"),
            "config": npu_result.get("command", [])[-1] if npu_result.get("command") else None,
            "min_observed_tops": min_tops,
            "max_observed_tops": max_tops,
            "provenance": npu_result.get("provenance"),
        },
        "cross_substrate_arithmetic": {
            "invalid_min_tops_per_w_using_openlane_power": min_tops / power_w,
            "invalid_max_tops_per_w_using_openlane_power": max_tops / power_w,
            "why_invalid": [
                "OpenLane power is for the current local RTL implementation and nominal analysis, not the 2028 architecture scale model.",
                "The NPU architecture benchmark is a deterministic model, not measured silicon or workload-calibrated post-route activity.",
                "No rail power trace, die temperature trace, frequency trace, throttle state, package model, or chamber data is present.",
            ],
        },
        "blocked_release_metrics": {
            "sustained_int8_tops": "blocked_until_measured_workload_trace",
            "average_watts": "blocked_until_calibrated_power_trace",
            "sustained_tops_per_w": "blocked_until_tops_and_watts_share_same_measured_run",
            "max_die_c": "blocked_until_calibrated_thermal_trace",
            "thermal_rise_c": "blocked_until_package_board_thermal_model_or_measurement",
        },
    }

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {display_path(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
