#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_output_workplan.json"

SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_OUTPUT_COVERAGE = ROOT / "build/reports/e1x_full_output_coverage.json"
TENSOR_FABRIC = ROOT / "build/reports/e1x_tensor_fabric_executor.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def build_workplan_records(schedule: dict, placement: dict) -> tuple[list[dict], list[str]]:
    placement_by_index = {
        int(layer["index"]): layer
        for layer in placement.get("layers", [])
        if isinstance(layer, dict) and "index" in layer
    }
    records: list[dict] = []
    mismatches: list[str] = []
    for layer in schedule.get("layers", []):
        if not isinstance(layer, dict):
            mismatches.append("malformed-schedule-layer")
            continue
        layer_index = int(layer.get("layer_index", -1))
        placement_layer = placement_by_index.get(layer_index)
        if placement_layer is None:
            mismatches.append(f"missing-placement:{layer_index}")
            continue
        rows = int(layer.get("rows", 0))
        cols = int(layer.get("cols", 0))
        assigned_cores = int(layer.get("assigned_cores", 0))
        k_wave_count = int(layer.get("k_wave_count", 0))
        total_core_wave_count = int(layer.get("total_core_wave_count", 0))
        vector_word_ops = rows * ceil(cols / 8)
        macs = rows * cols
        expected_core_waves = assigned_cores * k_wave_count
        if total_core_wave_count != expected_core_waves:
            mismatches.append(f"core-waves:{layer_index}")
        if int(layer.get("row_coverage", -1)) != rows or not bool(layer.get("row_coverage_complete")):
            mismatches.append(f"row-coverage:{layer_index}")
        if not bool(layer.get("fits_core_sram")):
            mismatches.append(f"sram-fit:{layer_index}")
        for key, placement_key in (("rows", "rows"), ("cols", "cols"), ("assigned_cores", "assigned_cores")):
            if int(layer.get(key, -1)) != int(placement_layer.get(placement_key, -2)):
                mismatches.append(f"placement-{key}:{layer_index}")
        if int(layer.get("routing_color", -1)) != int(placement_layer.get("routing_color", -2)):
            mismatches.append(f"placement-color:{layer_index}")
        records.append({
            "layer_index": layer_index,
            "layer_name": str(layer.get("layer_name", "")),
            "kind": str(layer.get("kind", "")),
            "routing_color": int(layer.get("routing_color", -1)),
            "rows": rows,
            "cols": cols,
            "assigned_cores": assigned_cores,
            "rows_per_core": int(layer.get("rows_per_core", 0)),
            "k_wave_count": k_wave_count,
            "total_core_wave_count": total_core_wave_count,
            "vector_word_ops": vector_word_ops,
            "macs": macs,
            "max_core_shard_bytes": int(layer.get("max_core_shard_bytes", 0)),
            "usable_bytes_per_core": int(layer.get("usable_bytes_per_core", 0)),
        })
    return records, mismatches


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (SCHEDULE, PLACEMENT, FULL_OUTPUT_COVERAGE, TENSOR_FABRIC)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-output workplan inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_full_output_workplan_inputs_present", "status": status, "detail": detail})

    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    coverage = load_json(FULL_OUTPUT_COVERAGE) if FULL_OUTPUT_COVERAGE.is_file() else {}
    tensor_fabric = load_json(TENSOR_FABRIC) if TENSOR_FABRIC.is_file() else {}

    schema_ok = (
        schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and schedule.get("source_placement_sha256") == placement.get("artifact_sha256")
        and coverage.get("status") == "PASS"
        and tensor_fabric.get("status") == "PASS"
    )
    status, detail = pass_fail(
        schema_ok,
        "schedule, placement, coverage, and sampled fabric reports are linked and PASS",
        "input schema/link/status mismatch",
    )
    checks.append({"id": "e1x_full_output_workplan_artifact_links", "status": status, "detail": detail})

    records, mismatches = build_workplan_records(schedule, placement)
    total_rows = sum(int(record["rows"]) for record in records)
    total_macs = sum(int(record["macs"]) for record in records)
    total_vector_word_ops = sum(int(record["vector_word_ops"]) for record in records)
    total_core_waves = sum(int(record["total_core_wave_count"]) for record in records)
    routing_colors = {int(record["routing_color"]) for record in records}
    workplan_sha256 = canonical_sha256(records)

    coverage_ok = (
        not mismatches
        and len(records) == 283
        and total_rows == 2_608_640
        and total_macs == 13_015_864_320
        and total_core_waves == int(schedule.get("total_core_wave_count", -1))
        and total_core_waves == 4_187_241
        and int(schedule.get("total_k_wave_count", 0)) == 5_481
        and len(routing_colors) == 24
        and total_rows == int(coverage.get("summary", {}).get("full_output_row_count", -1))
        and total_macs == int(coverage.get("summary", {}).get("full_mac_count", -1))
    )
    status, detail = pass_fail(
        coverage_ok,
        f"full-output workplan covers {total_rows} rows, {total_macs} MACs, and {total_core_waves} core waves",
        "workplan coverage mismatch: " + ", ".join(mismatches[:8]),
    )
    checks.append({"id": "e1x_full_output_workplan_covers_all_rows", "status": status, "detail": detail})

    sram_ok = (
        bool(schedule.get("all_rows_covered"))
        and bool(schedule.get("all_shards_fit_sram"))
        and int(placement.get("cores_used", 0)) == 151_367
        and int(placement.get("usable_bytes_per_core", 0)) == 45_056
        and int(placement.get("peak_core_shard_bytes", 0)) <= int(placement.get("usable_bytes_per_core", 0))
    )
    status, detail = pass_fail(
        sram_ok,
        "workplan inherits full row coverage and per-core SRAM fit from placement/schedule",
        "workplan row coverage or SRAM fit failed",
    )
    checks.append({"id": "e1x_full_output_workplan_sram_fit", "status": status, "detail": detail})

    sampled_boundary_ok = (
        int(tensor_fabric.get("summary", {}).get("merged_partial_count", 0)) == 1_132
        and int(coverage.get("summary", {}).get("missing_output_row_count", 0)) == 2_607_508
        and int(coverage.get("summary", {}).get("missing_mac_count", 0)) == 13_015_838_140
    )
    status, detail = pass_fail(
        sampled_boundary_ok,
        "workplan is full-output coverage metadata while execution evidence remains sampled",
        "sampled/full-output boundary mismatch",
    )
    checks.append({"id": "e1x_full_output_workplan_preserves_execution_blocker", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "workplan_layer_count": len(records),
        "full_output_row_count": total_rows,
        "full_mac_count": total_macs,
        "vector_word_op_count": total_vector_word_ops,
        "core_wave_count": total_core_waves,
        "k_wave_count": int(schedule.get("total_k_wave_count", 0)),
        "routing_color_count": len(routing_colors),
        "placed_core_count": int(placement.get("cores_used", 0)),
        "usable_bytes_per_core": int(placement.get("usable_bytes_per_core", 0)),
        "peak_core_shard_bytes": int(placement.get("peak_core_shard_bytes", 0)),
        "workplan_sha256": workplan_sha256,
        "sampled_executed_partial_count": int(
            tensor_fabric.get("summary", {}).get("merged_partial_count", 0)
        ),
        "missing_output_row_count": int(coverage.get("summary", {}).get("missing_output_row_count", 0)),
        "missing_mac_count": int(coverage.get("summary", {}).get("missing_mac_count", 0)),
        "all_workplan_records": records,
        "sampled_workplan_records": records[:8],
        "residual_blocker": "full_output_vectorized_tensor_kernel_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-output-workplan",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Deterministic full-output tensor workplan for every real-graph scheduled "
            "row, MAC, K wave, core wave, and routing color. This is execution planning "
            "metadata, not proof that the vectorized PE tensor kernel executed every "
            "row or produced a full-output numerical checksum."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_full_output_coverage.json",
            "build/reports/e1x_tensor_fabric_executor.json",
            "scripts/check_e1x_full_output_workplan.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X full-output workplan failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X full-output workplan; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
