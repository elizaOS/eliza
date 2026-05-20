#!/usr/bin/env python3
"""Capture dry-run simulator and benchmark optimization targets for AI/EDA DSE."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/simulator_optimization"
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
RUNTIME = ROOT / "compiler/runtime/e1_npu_runtime.py"
RUNTIME_TEST = ROOT / "compiler/runtime/test_e1_npu_runtime_sim.py"
CLAIM_BOUNDARY = "optimization_targets_only_no_benchmark_or_product_claim"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def benchmark_targets() -> list[dict[str, Any]]:
    data = load_json(BENCHMARK_PLAN)
    targets: list[dict[str, Any]] = []
    for item in data.get("benchmarks", []):
        command = item.get("command") or []
        command_text = " ".join(str(part) for part in command)
        if "run_npu_scale_sim.py" not in command_text and "benchmark_model" not in command_text:
            continue
        targets.append(
            {
                "id": item.get("id"),
                "suite": item.get("suite"),
                "provenance": item.get("provenance"),
                "command": command,
                "required_metadata": item.get("required_metadata", []),
                "optimization_use": "candidate_workload_for_dse_or_model_selection",
                "claim_boundary": "requires_executed_benchmark_log_before_claim",
            }
        )
    return targets


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_dir = (args.out_root / args.run_id).resolve()
    artifacts = [
        {
            "path": rel(path),
            "sha256": sha256_file(path),
            "role": role,
        }
        for path, role in (
            (BENCHMARK_PLAN, "benchmark_plan"),
            (RUNTIME, "npu_runtime"),
            (RUNTIME_TEST, "runtime_sim_tests"),
        )
    ]
    report = {
        "schema": "eliza.ai_eda.simulator_optimization_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "zigzag",
            "timeloop-accelergy",
            "dosa",
            "diffaxe",
            "gem-rtl-simulator",
            "rtlflow",
            "firesim",
            "verion-eda",
            "copra-cocotb",
            "autobench",
            "project-ava",
            "rtlmul",
        ],
        "input_artifacts": artifacts,
        "targets": benchmark_targets(),
        "required_followup_gates": [
            "make npu-runtime-contract-check",
            "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
            "make benchmark-sim-metrics",
        ],
        "blocked_by": [
            "no calibrated latency or energy labels",
            "no real accelerator benchmark_model transcript",
            "no executed DSE backend",
            "no pinned GPU/FPGA RTL simulator backend, supported-SystemVerilog subset, waveform correlation, or speedup replay",
            "no approved generated cocotb stub, generated testbench, mutation-test, or simulator failure-taxonomy workflow",
        ],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.simulator_optimization.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
