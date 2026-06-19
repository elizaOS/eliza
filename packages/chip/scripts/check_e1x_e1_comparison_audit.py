#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from compiler.runtime.e1x_wafer_model import e1_baseline_summary, scaled_8gb_config  # noqa: E402

REPORT = ROOT / "build/reports/e1x_e1_comparison_audit.json"
BENCHMARK_REPORT = ROOT / "build/reports/e1x_benchmark.json"
REPAIRED_RUN_REPORT = ROOT / "build/reports/e1x_full_payload_repaired_run.json"
POWER_THERMAL_REPORT = ROOT / "build/reports/e1x_power_thermal.json"
SOURCE_PATHS = (
    BENCHMARK_REPORT,
    REPAIRED_RUN_REPORT,
    POWER_THERMAL_REPORT,
    ROOT / "compiler/runtime/e1x_wafer_model.py",
    ROOT / "scripts/check_e1x_e1_comparison_audit.py",
)
RESIDUAL_BLOCKER = "comparison_is_architecture_model_not_silicon_benchmark"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "e1_silicon_benchmark_claim_allowed": False,
    "e1x_silicon_benchmark_claim_allowed": False,
    "package_claim_allowed": False,
    "pd_signoff_claim_allowed": False,
    "foundry_dft_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_report(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def stable_sha256(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return sha256(encoded).hexdigest()


def main() -> int:
    checks: list[dict[str, str]] = []
    missing = [str(path.relative_to(ROOT)) for path in SOURCE_PATHS if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "comparison audit inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_e1_comparison_inputs_present", "status": status, "detail": detail})

    benchmark = load_report(BENCHMARK_REPORT) if BENCHMARK_REPORT.is_file() else {}
    repaired_run = load_report(REPAIRED_RUN_REPORT) if REPAIRED_RUN_REPORT.is_file() else {}
    power_thermal = load_report(POWER_THERMAL_REPORT) if POWER_THERMAL_REPORT.is_file() else {}
    benchmark_summary = benchmark.get("summary", {})
    repaired_summary = repaired_run.get("summary", {})
    power_summary = power_thermal.get("summary", {})
    if not isinstance(benchmark_summary, dict):
        benchmark_summary = {}
    if not isinstance(repaired_summary, dict):
        repaired_summary = {}
    if not isinstance(power_summary, dict):
        power_summary = {}

    dependency_pass = (
        benchmark.get("status") == "PASS"
        and repaired_run.get("status") == "PASS"
        and power_thermal.get("status") == "PASS"
    )
    status, detail = pass_fail(
        dependency_pass,
        "benchmark, repaired-run, and power/thermal reports are PASS",
        "one or more comparison dependencies are not PASS",
    )
    checks.append({"id": "e1x_e1_comparison_dependencies_pass", "status": status, "detail": detail})

    e1_baseline = e1_baseline_summary()
    e1x_config = scaled_8gb_config()
    e1_sram_mib = float(e1_baseline["local_sram_mib"])
    e1_peak_tops = float(e1_baseline["dense_int8_peak_tops"])
    e1x_sram_mib = float(e1x_config.local_sram_mib)
    e1x_peak_tops = float(e1x_config.dense_int8_peak_tops)
    e1x_vs_e1_sram_ratio = e1x_sram_mib / e1_sram_mib
    e1x_vs_e1_peak_tops_ratio = e1x_peak_tops / e1_peak_tops
    model_required_mib = float(benchmark_summary.get("real_graph_model_required_mib", 0.0))
    model_required_vs_e1_sram = model_required_mib / e1_sram_mib
    model_required_vs_e1x_sram = model_required_mib / e1x_sram_mib

    baseline_ok = (
        e1_baseline["basis"] == "open_2028_sota_160tops"
        and e1_sram_mib == 64.0
        and e1_peak_tops > 160.0
        and benchmark_summary.get("real_graph_e1_comparison_basis") == e1_baseline["basis"]
        and float(benchmark_summary.get("scaled_local_sram_mib", 0.0)) == e1x_sram_mib
        and float(benchmark_summary.get("scaled_dense_int8_peak_tops", 0.0)) == e1x_peak_tops
    )
    status, detail = pass_fail(
        baseline_ok,
        "canonical E1 baseline and scaled E1X architecture summary match benchmark report",
    )
    checks.append(
        {"id": "e1x_e1_comparison_canonical_baseline", "status": status, "detail": detail}
    )

    residency_ok = (
        model_required_mib == float(benchmark_summary.get("real_graph_model_required_mib", -1.0))
        and model_required_vs_e1_sram
        == float(benchmark_summary.get("real_graph_model_required_vs_e1_sram", -1.0))
        and model_required_vs_e1x_sram
        == float(benchmark_summary.get("real_graph_model_required_vs_e1x_sram", -1.0))
        and model_required_vs_e1_sram > 100.0
        and 0.86 < model_required_vs_e1x_sram < 0.87
        and e1x_vs_e1_sram_ratio == 128.25
    )
    status, detail = pass_fail(
        residency_ok,
        "resident real graph is over 100x E1 SRAM and fits E1X local SRAM",
    )
    checks.append({"id": "e1x_e1_comparison_model_residency", "status": status, "detail": detail})

    normal_cycles = int(repaired_summary.get("normal_total_cycles", 0))
    high_cycles = int(repaired_summary.get("high_failure_total_cycles", 0))
    normal_decode_tps = float(repaired_summary.get("normal_decode_tokens_per_second", 0.0))
    high_decode_tps = float(repaired_summary.get("high_failure_decode_tokens_per_second", 0.0))
    high_vs_normal_cycle_ratio = high_cycles / max(1, normal_cycles)
    high_vs_normal_decode_tps_ratio = high_decode_tps / max(normal_decode_tps, 1e-12)
    repaired_trace_ok = (
        normal_cycles == int(benchmark_summary.get("real_graph_normal_execution_trace_cycles", 0))
        and high_cycles
        == int(benchmark_summary.get("real_graph_high_failure_execution_trace_cycles", 0))
        and high_vs_normal_cycle_ratio
        == float(benchmark_summary.get("real_graph_high_vs_normal_trace_cycle_ratio", 0.0))
        and high_vs_normal_cycle_ratio > 1.3
        and 0.75 < high_vs_normal_decode_tps_ratio < 0.76
        and int(repaired_summary.get("normal_output_checksum", 0)) > 0
        and int(repaired_summary.get("high_failure_output_checksum", 0)) > 0
    )
    status, detail = pass_fail(
        repaired_trace_ok,
        "normal/high repaired execution traces match benchmark cycles and slowdown envelope",
    )
    checks.append(
        {"id": "e1x_e1_comparison_repaired_trace_linkage", "status": status, "detail": detail}
    )

    peak_package_power_w = float(power_summary.get("peak_package_power_w", 0.0))
    peak_power_density_w_per_mm2 = float(power_summary.get("peak_power_density_w_per_mm2", 0.0))
    schedule_average_power_w = float(power_summary.get("schedule_average_power_w", 0.0))
    schedule_power_density_w_per_mm2 = float(
        power_summary.get("schedule_power_density_w_per_mm2", 0.0)
    )
    thermal_ok = (
        float(power_summary.get("local_sram_mib", 0.0)) == e1x_sram_mib
        and float(power_summary.get("model_required_vs_sram", 0.0)) == model_required_vs_e1x_sram
        and float(power_summary.get("peak_int8_tops", 0.0)) == e1x_peak_tops
        and peak_package_power_w < 23_000.0
        and peak_power_density_w_per_mm2 < 0.1
        and 0.0 < schedule_average_power_w < peak_package_power_w
        and 0.0 < schedule_power_density_w_per_mm2 < 0.001
    )
    status, detail = pass_fail(
        thermal_ok,
        "planning power/thermal report matches E1X comparison dimensions and bounded density",
    )
    checks.append(
        {"id": "e1x_e1_comparison_power_thermal_linkage", "status": status, "detail": detail}
    )

    comparison_tuple = {
        "basis": e1_baseline["basis"],
        "e1_local_sram_mib": e1_sram_mib,
        "e1_peak_tops": e1_peak_tops,
        "e1x_local_sram_mib": e1x_sram_mib,
        "e1x_peak_tops": e1x_peak_tops,
        "model_required_mib": model_required_mib,
        "model_required_vs_e1_sram": model_required_vs_e1_sram,
        "model_required_vs_e1x_sram": model_required_vs_e1x_sram,
        "normal_total_cycles": normal_cycles,
        "high_failure_total_cycles": high_cycles,
        "high_vs_normal_cycle_ratio": high_vs_normal_cycle_ratio,
        "normal_decode_tokens_per_second": normal_decode_tps,
        "high_failure_decode_tokens_per_second": high_decode_tps,
        "high_vs_normal_decode_tps_ratio": high_vs_normal_decode_tps_ratio,
        "peak_package_power_w": peak_package_power_w,
        "peak_power_density_w_per_mm2": peak_power_density_w_per_mm2,
        "schedule_average_power_w": schedule_average_power_w,
        "schedule_power_density_w_per_mm2": schedule_power_density_w_per_mm2,
    }
    comparison_tuple_sha256 = stable_sha256(comparison_tuple)

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "e1_comparison_basis": str(e1_baseline["basis"]),
        "e1_baseline_local_sram_mib": e1_sram_mib,
        "e1_baseline_peak_tops": e1_peak_tops,
        "e1x_local_sram_mib": e1x_sram_mib,
        "e1x_peak_tops": e1x_peak_tops,
        "e1x_vs_e1_sram_ratio": e1x_vs_e1_sram_ratio,
        "e1x_vs_e1_peak_tops_ratio": e1x_vs_e1_peak_tops_ratio,
        "real_graph_model_required_mib": model_required_mib,
        "model_required_vs_e1_sram": model_required_vs_e1_sram,
        "model_required_vs_e1x_sram": model_required_vs_e1x_sram,
        "normal_total_cycles": normal_cycles,
        "high_failure_total_cycles": high_cycles,
        "high_vs_normal_cycle_ratio": high_vs_normal_cycle_ratio,
        "normal_decode_tokens_per_second": normal_decode_tps,
        "high_failure_decode_tokens_per_second": high_decode_tps,
        "high_vs_normal_decode_tps_ratio": high_vs_normal_decode_tps_ratio,
        "peak_package_power_w": peak_package_power_w,
        "peak_power_density_w_per_mm2": peak_power_density_w_per_mm2,
        "schedule_average_power_w": schedule_average_power_w,
        "schedule_power_density_w_per_mm2": schedule_power_density_w_per_mm2,
        "comparison_tuple_sha256": comparison_tuple_sha256,
        "residual_blocker": RESIDUAL_BLOCKER,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-e1-comparison-audit",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Architecture-model comparison between the canonical open E1 baseline and "
            "the scaled E1X WSE mesh, cross-linked to repaired-run and planning "
            "power/thermal reports. This is not measured E1 or E1X silicon benchmark "
            "evidence, package evidence, PD signoff, foundry DFT, or tapeout evidence."
        ),
        "evidence_paths": [str(path.relative_to(ROOT)) for path in SOURCE_PATHS],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X/E1 comparison audit failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X/E1 comparison audit; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
