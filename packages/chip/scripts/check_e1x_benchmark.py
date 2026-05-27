#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_benchmark.json"
BENCH_REPORT = ROOT / "benchmarks/results/e1x-wafer-mesh-defect-gate/report.json"


def run_command(cmd: list[str]) -> tuple[bool, str]:
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:]
    return True, (proc.stdout.strip() or "command completed")[-1200:]


def inspect_benchmark_report() -> tuple[bool, str, dict[str, int | float | str]]:
    if not BENCH_REPORT.is_file():
        return False, f"missing benchmark report {BENCH_REPORT.relative_to(ROOT)}", {}
    report = json.loads(BENCH_REPORT.read_text(encoding="utf-8"))
    results = report.get("results")
    if not isinstance(results, list) or len(results) != 1:
        return False, "expected exactly one E1X benchmark result", {}
    result = results[0]
    metrics = result.get("metrics")
    if not isinstance(metrics, dict):
        return False, "E1X benchmark result missing simulator metrics", {}
    comparison = metrics.get("comparison")
    defect = metrics.get("defect_testing")
    benches = metrics.get("benchmarks")
    if not isinstance(comparison, dict) or not isinstance(defect, dict) or not isinstance(benches, dict):
        return False, "E1X benchmark result missing comparison, defect, or workload metrics", {}
    if result.get("status") != "passed" or report.get("status") != "passed":
        return False, "E1X benchmark did not pass", {}
    if comparison.get("e1", {}).get("basis") != "open_2028_sota_160tops":
        return False, "E1 comparison basis changed or is missing", {}
    if defect.get("repaired_logical_mesh") is not True:
        return False, "E1X repaired logical mesh check did not pass", {}
    summary = {
        "claim_level": str(report.get("claim_level")),
        "logical_cores": int(metrics["architecture"]["logical_cores"]),
        "min_observed_tops": float(benches["min_observed_tops"]),
        "e1_dense_int8_peak_tops": float(comparison["e1"]["dense_int8_peak_tops"]),
        "e1x_dense_int8_peak_tops": float(comparison["e1x"]["dense_int8_peak_tops"]),
        "logical_neighbor_paths_checked": int(defect["logical_neighbor_paths_checked"]),
        "max_repaired_neighbor_hops": int(defect["max_repaired_neighbor_hops"]),
    }
    return True, "E1X benchmark passed with E1 comparison and repaired mesh evidence", summary


def main() -> int:
    run_ok, run_detail = run_command(
        [
            sys.executable,
            "benchmarks/run_benchmarks.py",
            "run",
            "--bench",
            "e1x_wafer_mesh_defect_sim",
            "--report-id",
            "e1x-wafer-mesh-defect-gate",
        ]
    )
    validate_ok, validate_detail = (
        run_command(
            [
                sys.executable,
                "benchmarks/run_benchmarks.py",
                "validate-report",
                str(BENCH_REPORT.relative_to(ROOT)),
            ]
        )
        if run_ok
        else (False, "not run")
    )
    inspect_ok, inspect_detail, metrics = inspect_benchmark_report() if validate_ok else (False, "not run", {})
    checks = [
        {
            "id": "e1x_benchmark_run",
            "status": "pass" if run_ok else "fail",
            "detail": run_detail,
        },
        {
            "id": "e1x_benchmark_report_schema",
            "status": "pass" if validate_ok else "fail",
            "detail": validate_detail,
        },
        {
            "id": "e1x_benchmark_e1_comparison_and_repair_metrics",
            "status": "pass" if inspect_ok else "fail",
            "detail": inspect_detail,
        },
    ]
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-benchmark",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": "E1X L2 architecture-simulator benchmark only; not silicon, FPGA, board, PD, DFT, package, or full-wafer RTL benchmark evidence.",
        "evidence_paths": [
            "benchmarks/configs/benchmark_plan.json",
            "benchmarks/results/e1x-wafer-mesh-defect-gate/report.json",
            "benchmarks/results/e1x-wafer-mesh-defect-gate/e1x_wafer_mesh_defect_sim.log",
        ],
        "checks": checks,
        "summary": {
            **metrics,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X benchmark failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X benchmark; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
