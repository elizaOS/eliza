#!/usr/bin/env python3
"""Run the modeled E1 NPU MLPerf-style inference harness."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.mlperf.loadgen import LoadGenConfig, Scenario, run_loadgen  # noqa: E402
from benchmarks.mlperf.model import (  # noqa: E402
    NUM_CLASSES,
    NUM_FEATURES,
    build_dataset,
    macs_per_inference,
)
from benchmarks.mlperf.sut import E1NpuSut  # noqa: E402

DEFAULT_OUT = ROOT / "benchmarks/results/e1-npu-mlperf-modeled.json"
CLAIM_BOUNDARY = (
    "modeled_presilicon_loadgen_subset_not_official_mlcommons_not_linux_target_"
    "not_silicon_performance_or_power"
)
FIDELITY = {
    "implemented": [
        "SingleStream one-query-at-a-time scheduling",
        "Offline all-samples-at-once scheduling",
        "nearest-rank latency percentiles",
        "accuracy checked against deterministic reference labels",
        "E1 NPU GEMM_S8 commands issued through E1NpuRuntime/E1NpuMmioSim",
    ],
    "not_implemented": [
        "official MLCommons C++ LoadGen",
        "Server scenario",
        "MultiStream scenario",
        "min-duration/min-query-count convergence",
        "separate MLPerf accuracy and performance modes",
        "Linux /dev/e1-npu target execution",
        "silicon power or latency measurement",
    ],
}


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _scenario_from_cli(value: str) -> Scenario:
    normalized = value.replace("-", "_").lower()
    if normalized in {"singlestream", "single_stream"}:
        return Scenario.SINGLE_STREAM
    if normalized == "offline":
        return Scenario.OFFLINE
    raise argparse.ArgumentTypeError(f"unsupported scenario: {value}")


def _score(dataset: list[Any], responses: list[Any]) -> dict[str, Any]:
    correct = sum(
        1 for response in responses if response.prediction == dataset[response.index].label
    )
    total = len(responses)
    return {
        "correct": correct,
        "total": total,
        "top1_accuracy": correct / total if total else 0.0,
        "mismatches": [
            {
                "index": response.index,
                "expected": dataset[response.index].label,
                "actual": response.prediction,
            }
            for response in responses
            if response.prediction != dataset[response.index].label
        ],
    }


def run_scenario(scenario: Scenario, dataset_count: int) -> dict[str, Any]:
    dataset = build_dataset(dataset_count)
    sut = E1NpuSut(dataset)
    result = run_loadgen(sut, LoadGenConfig(scenario=scenario, query_count=dataset_count))
    accuracy = _score(dataset, result.responses)
    counters = asdict(sut.counters)
    entry: dict[str, Any] = {
        "scenario": scenario.value,
        "query_count": result.query_count,
        "wall_time_ns": result.wall_time_ns,
        "accuracy": accuracy,
        "npu_counters": counters,
        "expected_macs_per_inference": macs_per_inference(),
        "observed_macs_per_inference": (
            counters["npu_macs"] / counters["inferences"] if counters["inferences"] else 0.0
        ),
        "npu_commands_per_inference": (
            counters["npu_commands"] / counters["inferences"] if counters["inferences"] else 0.0
        ),
    }
    if result.latency_percentiles_ns:
        entry["latency_percentiles_ns"] = result.latency_percentiles_ns
    if result.throughput_samples_per_second is not None:
        entry["throughput_samples_per_second"] = result.throughput_samples_per_second
    return entry


def build_report(scenarios: list[Scenario], dataset_count: int) -> dict[str, Any]:
    dataset = build_dataset(dataset_count)
    dataset_records = [asdict(sample) for sample in dataset]
    scenario_results = [run_scenario(scenario, dataset_count) for scenario in scenarios]
    problems: list[str] = []
    for result in scenario_results:
        if result["accuracy"]["top1_accuracy"] != 1.0:
            problems.append(f"{result['scenario']} accuracy below 1.0")
        if result["npu_counters"]["npu_commands"] != dataset_count * 2:
            problems.append(f"{result['scenario']} did not issue two NPU GEMM commands per query")
        if result["npu_counters"]["npu_macs"] != dataset_count * macs_per_inference():
            problems.append(f"{result['scenario']} NPU MAC count drifted from model contract")
        if result["npu_counters"].get("unsupported_ops", 0):
            problems.append(f"{result['scenario']} reported unsupported NPU ops")

    return {
        "schema": "eliza.e1_npu_mlperf_modeled.v1",
        "status": "fail" if problems else "pass",
        "generated_at_utc": datetime.now(UTC).isoformat(),
        "claim_boundary": CLAIM_BOUNDARY,
        "fidelity": FIDELITY,
        "workload": {
            "name": "e1_npu_tiny_int8_mlp",
            "input_features": NUM_FEATURES,
            "classes": NUM_CLASSES,
            "precision": "int8",
            "npu_ops_per_inference": ["GEMM_S8", "GEMM_S8"],
            "host_ops_per_inference": ["bias_add", "int8_saturating_relu", "argmax"],
            "macs_per_inference": macs_per_inference(),
        },
        "dataset": {
            "count": dataset_count,
            "sha256": _sha256_json(dataset_records),
        },
        "scenarios": scenario_results,
        "problems": problems,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument(
        "--scenario",
        action="append",
        type=_scenario_from_cli,
        help="scenario to run; defaults to SingleStream and Offline",
    )
    args = parser.parse_args(argv)
    if args.samples <= 0:
        parser.error("--samples must be positive")

    scenarios = args.scenario or [Scenario.SINGLE_STREAM, Scenario.OFFLINE]
    report = build_report(scenarios, args.samples)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    tmp.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(args.out)
    print(f"STATUS: {report['status'].upper()} e1_npu_mlperf_modeled")
    print(f"  report: {args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out}")
    for problem in report["problems"]:
        print(f"  - {problem}")
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
