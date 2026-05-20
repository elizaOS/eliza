#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require, require_number

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "benchmarks/results/memory-iommu-qos-sim.json"
MEMORY_SPEC = ROOT / "docs/spec-db/memory-2028-target.yaml"
SIM = ROOT / "benchmarks/sim/run_memory_iommu_qos_sim.py"

REQUIRED_FAULT_FIELDS = {
    "master_id",
    "stream_id",
    "iova",
    "translated_pa_when_available",
    "access_type",
    "permission_bits",
    "syndrome_status",
    "recovery_behavior",
}


def validate_report(data: dict[str, Any], spec: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.memory_iommu_qos_sim.v1", "schema mismatch", errors)
    require(data.get("status") == "pass", "memory IOMMU/QoS sim must pass", errors)
    boundary = str(data.get("claim_boundary", ""))
    for token in ("not RTL IOMMU", "not LPDDR", "not Android", "not silicon"):
        require(token in boundary, f"claim boundary must include {token}", errors)

    iommu = spec.get("iommu")
    qos = spec.get("qos")
    if not isinstance(iommu, dict) or not isinstance(qos, dict):
        errors.append("memory spec missing iommu or qos mapping")
        return errors
    target_streams = iommu.get("per_master_stream_ids")
    target_classes = qos.get("classes")
    if not isinstance(target_streams, list) or not isinstance(target_classes, list):
        errors.append("memory spec missing stream IDs or QoS classes")
        return errors

    config = data.get("config")
    summary = data.get("summary")
    faults = data.get("iommu_faults")
    streams = data.get("qos_streams")
    if not isinstance(config, dict) or not isinstance(summary, dict):
        errors.append("report missing config or summary")
        return errors
    if not isinstance(faults, list) or not isinstance(streams, list):
        errors.append("report missing IOMMU faults or QoS streams")
        return errors

    require(config.get("deny_by_default") is True, "IOMMU config must be deny-by-default", errors)
    require(
        require_number(config.get("stream_count"), "stream count") == len(target_streams),
        "stream count must match memory target",
        errors,
    )
    require(
        require_number(summary.get("qos_class_count"), "QoS class count") == len(target_classes),
        "QoS class count must match memory target",
        errors,
    )
    require(
        summary.get("unauthorized_accesses_blocked") is True,
        "unauthorized accesses must be blocked",
        errors,
    )
    require(
        require_number(summary.get("fault_probe_count"), "fault probe count") >= 4,
        "fault probe coverage too small",
        errors,
    )
    require(
        require_number(summary.get("deny_by_default_fault_count"), "deny-by-default faults") >= 1,
        "deny-by-default probe did not fault",
        errors,
    )
    require(summary.get("fault_fields_present") is True, "fault fields missing from spec", errors)
    for index, fault in enumerate(faults):
        if not isinstance(fault, dict):
            errors.append(f"IOMMU fault {index} must be a mapping")
            continue
        missing = sorted(REQUIRED_FAULT_FIELDS - set(fault))
        if missing:
            errors.append(f"IOMMU fault {index} missing fields: {', '.join(missing)}")

    require(
        summary.get("all_requests_completed") is True,
        "QoS model must complete all requests",
        errors,
    )
    require(
        require_number(summary.get("display_underflow_count"), "display underflows") == 0,
        "QoS model must avoid display underflow",
        errors,
    )
    require(
        require_number(summary.get("isochronous_max_service_gap_cycles"), "isochronous gap") <= 32,
        "isochronous service gap exceeds target",
        errors,
    )
    require(
        summary.get("best_effort_progress") is True, "best-effort clients must progress", errors
    )
    schedule_prefix = summary.get("schedule_prefix")
    require(
        isinstance(schedule_prefix, list) and "display" in schedule_prefix,
        "schedule prefix must include display traffic",
        errors,
    )
    stream_ids = {entry.get("stream_id") for entry in streams if isinstance(entry, dict)}
    target_ids = {entry.get("id") for entry in target_streams if isinstance(entry, dict)}
    require(stream_ids == target_ids, "QoS streams must match target stream IDs", errors)
    return errors


def main() -> None:
    result = subprocess.run(
        [sys.executable, str(SIM), "--out", str(REPORT)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
        raise SystemExit(result.returncode)
    data = load_json_object(REPORT)
    spec = load_yaml_object(MEMORY_SPEC)
    errors = validate_report(data, spec)
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
    print(f"Memory IOMMU/QoS simulator check passed: {REPORT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
