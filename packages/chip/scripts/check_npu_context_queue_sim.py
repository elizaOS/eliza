#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
SIM = ROOT / "benchmarks/sim/run_npu_context_queue_sim.py"
TARGET = ROOT / "docs/spec-db/npu-2028-target.yaml"
OUT = ROOT / "benchmarks/results/npu-context-queue-sim.json"


def main() -> int:
    errors: list[str] = []
    if not SIM.is_file():
        return report([f"missing simulator: {SIM.relative_to(ROOT)}"])
    target = yaml.safe_load(TARGET.read_text(encoding="utf-8"))
    numeric = target.get("numeric_targets", {})
    context_target = int(numeric.get("concurrent_contexts_min", 0))
    queue_depth_target = int(numeric.get("command_queue_depth_min", 0))

    completed = subprocess.run(
        [
            sys.executable,
            str(SIM),
            "--config",
            "open_2028_sota_160tops",
            "--out",
            str(OUT.relative_to(ROOT)),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return report(["context queue simulator command failed", completed.stderr.strip()])
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        return report([f"context queue simulator emitted invalid JSON: {exc}"])

    errors.extend(validate_report(data, context_target, queue_depth_target))
    return report(errors)


def validate_report(
    data: dict,
    context_target: int,
    queue_depth_target: int,
) -> list[str]:
    errors: list[str] = []
    if data.get("schema") != "eliza.npu_context_queue_sim.v1":
        errors.append("context queue simulator schema mismatch")
    if data.get("status") != "pass":
        errors.append("context queue simulator status must pass")
    if "not RTL scheduler" not in str(data.get("claim_boundary", "")):
        errors.append("context queue simulator must block RTL scheduler claims")
    config = data.get("config")
    summary = data.get("summary")
    contexts = data.get("contexts")
    if not isinstance(config, dict):
        errors.append("config must be an object")
    else:
        if int(config.get("concurrent_contexts", 0)) < context_target:
            errors.append("modeled concurrent contexts below target")
        if int(config.get("descriptor_queue_depth", 0)) < queue_depth_target:
            errors.append("modeled descriptor queue depth below target")
        if int(config.get("descriptors_per_context", 0)) <= 0:
            errors.append("descriptors_per_context must be positive")
    if not isinstance(contexts, list) or len(contexts) < context_target:
        errors.append("contexts must cover target concurrent contexts")
    else:
        seen = set()
        for index, context in enumerate(contexts):
            if not isinstance(context, dict):
                errors.append(f"contexts[{index}] must be an object")
                continue
            seen.add(context.get("context_id"))
            for field in (
                "weight",
                "descriptors_requested",
                "descriptors_served",
                "dma_beats_served",
            ):
                value = context.get(field)
                if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                    errors.append(f"contexts[{index}].{field} must be a positive integer")
            if context.get("descriptors_requested") != context.get("descriptors_served"):
                errors.append(f"contexts[{index}] did not complete all descriptors")
        if seen != set(range(len(contexts))):
            errors.append("context ids must be dense from zero")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
    else:
        if summary.get("all_contexts_completed") is not True:
            errors.append("all contexts must complete")
        if int(summary.get("context_count", 0)) < context_target:
            errors.append("summary context_count below target")
        if int(summary.get("total_descriptors_served", 0)) <= 0:
            errors.append("total_descriptors_served must be positive")
        if int(summary.get("total_dma_beats_served", 0)) <= 0:
            errors.append("total_dma_beats_served must be positive")
        if int(summary.get("max_service_gap_cycles", 0)) > 32:
            errors.append("max service gap exceeds modeled no-starvation bound")
        fairness = summary.get("jain_fairness_index")
        if not isinstance(fairness, (int, float)) or isinstance(fairness, bool) or fairness < 0.99:
            errors.append("Jain fairness index must be >= 0.99 for equal-request contexts")
        schedule_prefix = summary.get("schedule_prefix")
        if not isinstance(schedule_prefix, list) or len(set(schedule_prefix)) < context_target:
            errors.append("schedule prefix must show all modeled contexts receiving service")
    return errors


def report(errors: list[str]) -> int:
    clean = [error for error in errors if error]
    if clean:
        print("NPU context queue simulator check failed:")
        for error in clean:
            print(f"  - {error}")
        return 1
    print(f"NPU context queue simulator check passed: {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
