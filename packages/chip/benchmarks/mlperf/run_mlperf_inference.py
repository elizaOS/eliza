#!/usr/bin/env python3
"""E1 NPU MLPerf Inference harness runner (modeled, pre-silicon).

Drives a LoadGen-style scheduler (SingleStream + Offline) against the E1
NPU behavioral simulator running a tiny INT8 MLP, scores accuracy
against the reference model, records latency percentiles / throughput,
and threads the modeled ``energy_joules_per_inference`` (G-7) end to end.

CLAIM BOUNDARY (honest, fail-closed)
------------------------------------
This is ``modeled_preSilicon_not_official_submission_and_not_measured_power``:

- Functional accuracy is real (byte-exact NPU sim vs reference oracle).
- Latency / throughput are HOST wall-clock of the Python sim, NOT silicon
  query latency; they describe the harness, not the chip. Silicon latency
  needs RTL/FPGA/silicon timing.
- ``energy_joules_per_inference`` is MODELED from the architecture scale
  model, NOT measured. Real power needs a Joulescope/Monsoon rail
  integration on fabricated silicon (BLOCKED).
- This is NOT an official MLCommons submission (no MLCommons loadgen
  binary, no submission checker, no reference model checkpoint).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import socket
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from benchmarks.mlperf.energy import SCALE_CONFIGS, energy_block  # noqa: E402
from benchmarks.mlperf.loadgen import (  # noqa: E402
    LoadGenConfig,
    LoadGenResult,
    Scenario,
    run_loadgen,
)
from benchmarks.mlperf.model import build_dataset, macs_per_inference  # noqa: E402
from benchmarks.mlperf.sut import E1NpuSut  # noqa: E402

SCHEMA = "eliza.mlperf_inference.v1"
CLAIM_BOUNDARY = "modeled_preSilicon_not_official_submission_and_not_measured_power"

FIDELITY = {
    "loadgen": "reimplemented_python_scheduler_not_mlcommons_loadgen_binary",
    "implemented_scenarios": ["SingleStream", "Offline"],
    "unimplemented_scenarios": ["Server", "MultiStream"],
    "single_stream_metric": "p90_query_latency_nearest_rank",
    "offline_metric": "throughput_samples_per_second",
    "latency_source": "host_wall_clock_of_python_npu_sim_not_silicon_query_latency",
    "early_stopping": "fixed_query_count_not_loadgen_statistical_convergence",
    "accuracy_mode": "single_pass_accuracy_and_latency_not_separate_loadgen_modes",
    "submission_status": "not_an_official_mlcommons_submission",
}


def _source_tree_sha() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"
    sha = completed.stdout.strip()
    return sha or "unknown"


def _accuracy(result: LoadGenResult, dataset) -> dict[str, Any]:
    correct = sum(
        1 for response in result.responses if response.prediction == dataset[response.index].label
    )
    total = len(result.responses)
    mismatches = [
        {
            "index": response.index,
            "expected": dataset[response.index].label,
            "actual": response.prediction,
        }
        for response in result.responses
        if response.prediction != dataset[response.index].label
    ]
    return {
        "correct": correct,
        "total": total,
        "top1_accuracy": correct / total if total else 0.0,
        "mismatches": mismatches,
        "reference": "benchmarks/mlperf/model.py reference_predict (NPU sim vs oracle)",
    }


def _scenario_block(
    sut: E1NpuSut,
    dataset,
    scenario: Scenario,
    query_count: int,
    config_name: str,
) -> dict[str, Any]:
    cfg = LoadGenConfig(scenario=scenario, query_count=query_count)
    result = run_loadgen(sut, cfg)
    accuracy = _accuracy(result, dataset)
    scale_config = SCALE_CONFIGS[config_name]
    integration_window_seconds = result.wall_time_ns / 1e9
    expected_macs = macs_per_inference()
    observed_macs_per_inference = (
        sut.counters.npu_macs / sut.counters.inferences if sut.counters.inferences else 0.0
    )
    block: dict[str, Any] = {
        "scenario": scenario.value,
        "query_count": query_count,
        "accuracy": accuracy,
        "wall_time_seconds": integration_window_seconds,
        "macs_per_inference": expected_macs,
        "npu_counters": {
            "inferences": sut.counters.inferences,
            "npu_commands": sut.counters.npu_commands,
            "npu_cycles": sut.counters.npu_cycles,
            "npu_macs": sut.counters.npu_macs,
        },
        "observed_macs_per_inference": observed_macs_per_inference,
        "macs_contract_ok": observed_macs_per_inference == expected_macs,
        "energy_joules_per_inference": energy_block(
            scale_config,
            integration_window_seconds=integration_window_seconds,
            sample_count=query_count,
        ),
    }
    if scenario is Scenario.SINGLE_STREAM:
        block["latency_percentiles_ns"] = result.latency_percentiles_ns
        block["primary_metric"] = "p90"
        block["primary_metric_value_ns"] = result.latency_percentiles_ns.get("p90")
    else:
        block["throughput_samples_per_second"] = result.throughput_samples_per_second
        block["primary_metric"] = "throughput_samples_per_second"
        block["primary_metric_value"] = result.throughput_samples_per_second
    return block


def _dataset_sha256(dataset) -> str:
    records = [{"features": list(s.features), "label": s.label} for s in dataset]
    encoded = json.dumps(records, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def build_report(query_count: int, config_name: str) -> dict[str, Any]:
    dataset = build_dataset(query_count)
    scenarios = [
        _scenario_block(E1NpuSut(dataset=dataset), dataset, scenario, query_count, config_name)
        for scenario in (Scenario.SINGLE_STREAM, Scenario.OFFLINE)
    ]
    npu_commands_total = sum(s["npu_counters"]["npu_commands"] for s in scenarios)
    npu_cycles_total = sum(s["npu_counters"]["npu_cycles"] for s in scenarios)
    npu_macs_total = sum(s["npu_counters"]["npu_macs"] for s in scenarios)
    status = (
        "pass"
        if all(s["accuracy"]["top1_accuracy"] == 1.0 and s["macs_contract_ok"] for s in scenarios)
        else "fail"
    )
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "claim_level": "L2_ARCH_SIM",
        "provenance": "simulator",
        "date_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platform": {
            "name": "e1_npu_mmio_sim",
            "host": socket.gethostname(),
            "host_system": platform.platform(),
            "source_tree_sha": _source_tree_sha(),
        },
        "sut": {
            "name": "e1_npu_mmio_sim",
            "datapath": "E1NpuRuntime.gemm_s8 over E1NpuMmioSim MMIO scratchpad",
            "real_runtime_path": True,
            "npu_commands_per_inference": 2,
        },
        "workload": {
            "name": "tiny_int8_mlp_2layer",
            "precision": "int8",
            "topology": "3->relu->3 two-layer MLP (two M=1 GEMM_S8 tiles + host bias/relu/argmax)",
            "macs_per_inference": macs_per_inference(),
            "model_class": "modeled_representative_small_classifier_not_mlperf_mobile_model",
            "reference": "benchmarks/mlperf/model.py",
        },
        "dataset": {
            "count": query_count,
            "sha256": _dataset_sha256(dataset),
            "labels": "reference_predict ground truth (NPU sim scored against own oracle)",
        },
        "scale_model_config": config_name,
        "fidelity": FIDELITY,
        "scenarios": scenarios,
        "summary": {
            "scenario_count": len(scenarios),
            "min_top1_accuracy": min(s["accuracy"]["top1_accuracy"] for s in scenarios),
            "npu_commands_total": npu_commands_total,
            "npu_cycles_total": npu_cycles_total,
            "npu_macs_total": npu_macs_total,
            "energy_joules_per_inference": scenarios[0]["energy_joules_per_inference"]["value"],
            "blocked_axes": [
                {
                    "axis": "measured_silicon_power",
                    "blocker_id": "mlperf-power-closed",
                    "reason": (
                        "Power-per-inference requires a Joulescope/Monsoon rail "
                        "integration on fabricated silicon; pre-silicon impossible."
                    ),
                    "resolution": "Measure on E1 dev-board/silicon post-tapeout.",
                    "release_blocking": False,
                },
                {
                    "axis": "official_mlcommons_submission",
                    "blocker_id": "mlperf-official-submission",
                    "reason": (
                        "No MLCommons loadgen binary, submission checker, or "
                        "reference model checkpoint vendored; harness is modeled."
                    ),
                    "resolution": (
                        "Link MLCommons loadgen + reference models for an "
                        "auditable submission once silicon/FPGA targets exist."
                    ),
                    "release_blocking": False,
                },
            ],
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", choices=sorted(SCALE_CONFIGS), default="open_2028_first_50tops")
    parser.add_argument("--query-count", type=int, default=64)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    if args.query_count <= 0:
        parser.error("--query-count must be positive")

    report = build_report(args.query_count, args.config)
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.out:
        output = args.out if args.out.is_absolute() else ROOT / args.out
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
