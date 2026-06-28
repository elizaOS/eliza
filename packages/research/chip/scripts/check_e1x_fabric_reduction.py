#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_fabric_reduction.json"

SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
COLOR_PRESSURE = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-pressure.json"
COLOR_TIMING = ROOT / "benchmarks/results/e1x-real-graph-fabric-color-timing.json"
SCHEDULE_EXECUTION = ROOT / "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json"
MESH_LIVENESS = ROOT / "build/reports/e1x_mesh_liveness_evidence.json"
MESH_COCOTB = ROOT / "build/reports/e1x_mesh_fabric_cocotb.json"
REDUCTION_MERGE_COCOTB = ROOT / "build/reports/e1x_reduction_merge_cocotb.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (
        SCHEDULE,
        COLOR_PRESSURE,
        COLOR_TIMING,
        SCHEDULE_EXECUTION,
        MESH_LIVENESS,
        MESH_COCOTB,
        REDUCTION_MERGE_COCOTB,
    )
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "fabric reduction inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_fabric_reduction_inputs_present", "status": status, "detail": detail})

    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    pressure = load_json(COLOR_PRESSURE) if COLOR_PRESSURE.is_file() else {}
    timing = load_json(COLOR_TIMING) if COLOR_TIMING.is_file() else {}
    schedule_execution = load_json(SCHEDULE_EXECUTION) if SCHEDULE_EXECUTION.is_file() else {}
    mesh_liveness = load_json(MESH_LIVENESS) if MESH_LIVENESS.is_file() else {}
    mesh_cocotb = load_json(MESH_COCOTB) if MESH_COCOTB.is_file() else {}
    reduction_merge = load_json(REDUCTION_MERGE_COCOTB) if REDUCTION_MERGE_COCOTB.is_file() else {}

    schema_ok = (
        schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and pressure.get("schema") == "eliza.e1x.fabric_color_pressure.v1"
        and timing.get("schema") == "eliza.e1x.fabric_color_timing.v1"
        and pressure.get("source_tensor_schedule_sha256") == schedule.get("artifact_sha256")
        and timing.get("source_color_pressure_sha256") == pressure.get("artifact_sha256")
    )
    status, detail = pass_fail(
        schema_ok,
        "schedule, color pressure, and color timing artifacts are linked by hashes",
        "schedule/pressure/timing schema or hash linkage mismatch",
    )
    checks.append({"id": "e1x_fabric_reduction_artifact_links", "status": status, "detail": detail})

    payload_bytes = max(1, int(pressure.get("fabric_payload_bits", 0)) // 8)
    by_color: dict[int, dict[str, int]] = {
        color: {
            "layer_count": 0,
            "activation_wavelets": 0,
            "reduction_wavelets": 0,
            "total_wavelets": 0,
        }
        for color in range(int(pressure.get("routing_color_capacity", 0)))
    }
    sampled_layers: list[dict[str, int | str]] = []
    for layer in schedule.get("layers", []):
        color = int(layer["routing_color"])
        activation_wavelets = ceil(int(layer["cols"]) / payload_bytes) * int(
            layer["assigned_cores"]
        )
        reduction_wavelets = ceil(int(layer["rows"]) * 4 / payload_bytes)
        by_color[color]["layer_count"] += 1
        by_color[color]["activation_wavelets"] += activation_wavelets
        by_color[color]["reduction_wavelets"] += reduction_wavelets
        by_color[color]["total_wavelets"] += activation_wavelets + reduction_wavelets
        if len(sampled_layers) < 6:
            sampled_layers.append(
                {
                    "layer_index": int(layer["layer_index"]),
                    "layer_name": str(layer["layer_name"]),
                    "routing_color": color,
                    "activation_wavelets": activation_wavelets,
                    "reduction_wavelets": reduction_wavelets,
                    "assigned_cores": int(layer["assigned_cores"]),
                }
            )

    pressure_by_color = {
        int(record["routing_color"]): record for record in pressure.get("color_records", [])
    }
    mismatched_colors = []
    for color, expected in by_color.items():
        actual = pressure_by_color.get(color, {})
        for key in ("layer_count", "activation_wavelets", "reduction_wavelets", "total_wavelets"):
            if int(actual.get(key, -1)) != int(expected[key]):
                mismatched_colors.append(f"{color}:{key}")
                break
    total_activation = sum(record["activation_wavelets"] for record in by_color.values())
    total_reduction = sum(record["reduction_wavelets"] for record in by_color.values())
    total_wavelets = sum(record["total_wavelets"] for record in by_color.values())
    recompute_ok = (
        not mismatched_colors
        and total_activation == int(pressure.get("total_activation_wavelets", -1))
        and total_reduction == int(pressure.get("total_reduction_wavelets", -1))
        and total_wavelets == int(pressure.get("total_fabric_wavelets", -1))
    )
    status, detail = pass_fail(
        recompute_ok,
        f"recomputed {total_reduction} reduction wavelets and {total_activation} activation wavelets",
        "color pressure mismatch: " + ", ".join(mismatched_colors[:8]),
    )
    checks.append(
        {"id": "e1x_fabric_reduction_recomputes_color_pressure", "status": status, "detail": detail}
    )

    timing_by_color = {
        int(record["routing_color"]): record for record in timing.get("color_timings", [])
    }
    timing_mismatches = []
    for color, expected in by_color.items():
        actual = timing_by_color.get(color, {})
        if int(actual.get("total_wavelets", -1)) != int(expected["total_wavelets"]):
            timing_mismatches.append(str(color))
    timing_ok = (
        not timing_mismatches
        and int(timing.get("total_fabric_wavelets", -1)) == total_wavelets
        and int(timing.get("peak_color_fabric_cycles", 0))
        <= int(schedule_execution.get("total_schedule_cycles", 0))
    )
    status, detail = pass_fail(
        timing_ok,
        "per-color reduction/activation wavelets match fabric timing records and schedule bound",
        "timing color mismatch: " + ", ".join(timing_mismatches[:8]),
    )
    checks.append(
        {"id": "e1x_fabric_reduction_timing_links_pressure", "status": status, "detail": detail}
    )

    mesh_ok = (
        mesh_liveness.get("status") == "PASS"
        and mesh_cocotb.get("status") == "PASS"
        and int(mesh_liveness.get("summary", {}).get("mesh_fabric_testcases", 0)) >= 4
        and int(mesh_cocotb.get("summary", {}).get("testcases", 0)) >= 4
    )
    status, detail = pass_fail(
        mesh_ok,
        "mesh fabric/liveness evidence is present for multi-hop XY delivery of reduction wavelets",
        "mesh fabric/liveness evidence missing",
    )
    checks.append(
        {
            "id": "e1x_fabric_reduction_mesh_delivery_evidence_present",
            "status": status,
            "detail": detail,
        }
    )

    reduction_merge_ok = (
        reduction_merge.get("status") == "PASS"
        and int(reduction_merge.get("summary", {}).get("testcases", 0)) >= 5
        and int(reduction_merge.get("summary", {}).get("failing_check_count", 1)) == 0
    )
    status, detail = pass_fail(
        reduction_merge_ok,
        "bounded RTL reduction-merge primitive is covered by cocotb",
        "bounded RTL reduction-merge primitive evidence missing",
    )
    checks.append(
        {
            "id": "e1x_fabric_reduction_rtl_merge_primitive_present",
            "status": status,
            "detail": detail,
        }
    )

    peak_color = (
        max(by_color.items(), key=lambda item: item[1]["total_wavelets"])[0] if by_color else -1
    )
    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "scheduled_layer_count": int(schedule.get("scheduled_layer_count", 0)),
        "routing_color_count": len(by_color),
        "used_routing_color_count": int(pressure.get("used_routing_color_count", 0)),
        "total_activation_wavelets": total_activation,
        "total_reduction_wavelets": total_reduction,
        "total_fabric_wavelets": total_wavelets,
        "peak_routing_color": int(peak_color),
        "peak_color_wavelets": int(by_color.get(peak_color, {}).get("total_wavelets", 0)),
        "peak_color_fabric_cycles": int(timing.get("peak_color_fabric_cycles", 0)),
        "reduction_merge_cocotb_testcases": int(
            reduction_merge.get("summary", {}).get("testcases", 0)
        ),
        "sampled_layers": sampled_layers,
        "residual_blocker": "vectorized_full_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-fabric-reduction",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X scheduled fabric reduction/merge accounting for the real-graph tensor "
            "schedule, including per-layer reduction wavelets, per-color aggregation, "
            "fabric timing linkage, and a bounded RTL reduction-merge primitive. This "
            "is not full vectorized tensor fabric execution, full NoC simulation, or "
            "full-output numerical proof."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-fabric-color-pressure.json",
            "benchmarks/results/e1x-real-graph-fabric-color-timing.json",
            "benchmarks/results/e1x-real-graph-schedule-execution-estimate.json",
            "build/reports/e1x_mesh_liveness_evidence.json",
            "build/reports/e1x_mesh_fabric_cocotb.json",
            "build/reports/e1x_reduction_merge_cocotb.json",
            "scripts/check_e1x_fabric_reduction.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X fabric reduction failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X fabric reduction; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
