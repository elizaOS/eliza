#!/usr/bin/env python3
"""Validate the modeled E1 NPU MLPerf-style harness report."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "benchmarks/results/e1-npu-mlperf-modeled.json"
RUNNER = ROOT / "benchmarks/mlperf/run_e1_npu_mlperf.py"
SCHEMA = "eliza.e1_npu_mlperf_modeled.v1"
CLAIM_BOUNDARY = (
    "modeled_presilicon_loadgen_subset_not_official_mlcommons_not_linux_target_"
    "not_silicon_performance_or_power"
)
MACS_PER_INFERENCE = 18


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"_invalid_json": str(exc)}
    return data if isinstance(data, dict) else {"_invalid_json": "root is not an object"}


def validate(report: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    if not report:
        return [f"missing report: {rel(REPORT)}"]
    if "_invalid_json" in report:
        return [f"invalid JSON report: {report['_invalid_json']}"]
    if report.get("schema") != SCHEMA:
        problems.append(f"schema mismatch: {report.get('schema')!r}")
    if report.get("status") != "pass":
        problems.append(f"report status is not pass: {report.get('status')!r}")
    if report.get("claim_boundary") != CLAIM_BOUNDARY:
        problems.append("claim_boundary missing or drifted")

    fidelity = report.get("fidelity")
    if not isinstance(fidelity, dict):
        problems.append("missing fidelity block")
    else:
        not_implemented = fidelity.get("not_implemented")
        if not isinstance(not_implemented, list) or "official MLCommons C++ LoadGen" not in not_implemented:
            problems.append("fidelity block must explicitly reject official MLCommons claims")
        if "Linux /dev/e1-npu target execution" not in not_implemented:
            problems.append("fidelity block must separate modeled harness from Linux target proof")

    workload = report.get("workload")
    if not isinstance(workload, dict):
        problems.append("missing workload block")
    else:
        if workload.get("npu_ops_per_inference") != ["GEMM_S8", "GEMM_S8"]:
            problems.append("workload must issue two GEMM_S8 NPU ops per inference")
        if workload.get("macs_per_inference") != MACS_PER_INFERENCE:
            problems.append(
                f"workload macs_per_inference must stay pinned at {MACS_PER_INFERENCE}"
            )

    dataset = report.get("dataset")
    if not isinstance(dataset, dict):
        problems.append("missing dataset block")
    else:
        if not isinstance(dataset.get("count"), int) or dataset["count"] <= 0:
            problems.append("dataset.count must be positive")
        if not isinstance(dataset.get("sha256"), str) or len(dataset["sha256"]) != 64:
            problems.append("dataset.sha256 must be a hex64 digest")

    scenarios = report.get("scenarios")
    if not isinstance(scenarios, list) or not scenarios:
        problems.append("missing scenario results")
    else:
        seen = {item.get("scenario") for item in scenarios if isinstance(item, dict)}
        if not {"SingleStream", "Offline"}.issubset(seen):
            problems.append("report must include SingleStream and Offline scenarios")
        for item in scenarios:
            if not isinstance(item, dict):
                problems.append("scenario result is not an object")
                continue
            scenario = item.get("scenario", "<unknown>")
            accuracy = item.get("accuracy")
            counters = item.get("npu_counters")
            if not isinstance(accuracy, dict) or accuracy.get("top1_accuracy") != 1.0:
                problems.append(f"{scenario} accuracy must be exactly 1.0")
            if not isinstance(counters, dict):
                problems.append(f"{scenario} missing NPU counters")
                continue
            query_count = item.get("query_count")
            if not isinstance(query_count, int) or query_count <= 0:
                problems.append(f"{scenario} query_count must be positive")
                continue
            if counters.get("inferences") != query_count:
                problems.append(f"{scenario} inference counter does not match query count")
            if counters.get("npu_commands") != query_count * 2:
                problems.append(f"{scenario} must issue two NPU commands per inference")
            if counters.get("npu_macs") != query_count * MACS_PER_INFERENCE:
                problems.append(f"{scenario} MAC counter does not match workload contract")
            if item.get("observed_macs_per_inference") != float(MACS_PER_INFERENCE):
                problems.append(
                    f"{scenario} observed_macs_per_inference must be {float(MACS_PER_INFERENCE)}"
                )
            if item.get("npu_commands_per_inference") != 2.0:
                problems.append(f"{scenario} npu_commands_per_inference must be 2.0")
            if scenario == "SingleStream" and "latency_percentiles_ns" not in item:
                problems.append("SingleStream must report latency percentiles")
            if scenario == "Offline" and "throughput_samples_per_second" not in item:
                problems.append("Offline must report throughput")

    embedded_problems = report.get("problems")
    if embedded_problems:
        problems.append(f"report problems are non-empty: {embedded_problems}")
    return problems


def run_harness(samples: int, out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), "--samples", str(samples), "--out", str(out)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="regenerate the report before checking")
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--report", type=Path, default=REPORT)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    runner_stdout = ""
    runner_returncode: int | None = None
    if args.run:
        completed = run_harness(args.samples, args.report)
        runner_stdout = completed.stdout
        runner_returncode = completed.returncode

    report = load_json(args.report)
    problems = validate(report)
    if runner_returncode not in (None, 0):
        problems.append(f"runner exited {runner_returncode}")
    output = {
        "schema": "eliza.e1_npu_mlperf_modeled_check.v1",
        "status": "fail" if problems else "pass",
        "report": rel(args.report),
        "runner": rel(RUNNER),
        "runner_returncode": runner_returncode,
        "runner_stdout": runner_stdout,
        "problems": problems,
    }
    if args.json:
        print(json.dumps(output, indent=2, sort_keys=True))
    else:
        print(f"STATUS: {output['status'].upper()} e1_npu_mlperf_modeled")
        print(f"  report: {output['report']}")
        for problem in problems:
            print(f"  - {problem}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
