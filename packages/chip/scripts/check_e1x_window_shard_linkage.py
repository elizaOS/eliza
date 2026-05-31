#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_window_shard_linkage.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
MODEL_LOAD_STREAM = ROOT / "build/reports/e1x_model_load_stream.json"
VECTOR_WINDOW_FABRIC = ROOT / "build/reports/e1x_vector_window_fabric_checksum.json"
EXECUTION_LADDER = ROOT / "build/reports/e1x_execution_coverage_ladder.json"

ROWS_PER_LAYER = 32768
WORD_BYTES = 4


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def touched_window_shards(layer: dict) -> list[dict[str, int | str]]:
    window_rows = min(ROWS_PER_LAYER, int(layer["rows"]))
    rows_per_core = int(layer["rows_per_core"])
    bytes_per_row = ceil(int(layer["cols"]) * int(layer["weight_bits"]) / 8)
    records: list[dict[str, int | str]] = []
    ordinal = 0
    covered_rows = 0
    while covered_rows < window_rows:
        row_start = ordinal * rows_per_core
        row_count = min(rows_per_core, window_rows - covered_rows)
        shard_bytes = row_count * bytes_per_row
        records.append({
            "layer_index": int(layer["index"]),
            "layer_name": str(layer["name"]),
            "logical_core_index": int(layer["core_index_start"]) + ordinal,
            "window_row_start": row_start,
            "window_row_count": row_count,
            "bytes_per_row": bytes_per_row,
            "window_shard_bytes": shard_bytes,
            "window_loader_words": ceil(shard_bytes / WORD_BYTES),
        })
        covered_rows += row_count
        ordinal += 1
    return records


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PLACEMENT, MODEL_LOAD_STREAM, VECTOR_WINDOW_FABRIC, EXECUTION_LADDER)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "window-shard linkage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_window_shard_linkage_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    model_load = load_json(MODEL_LOAD_STREAM) if MODEL_LOAD_STREAM.is_file() else {}
    vector_window = load_json(VECTOR_WINDOW_FABRIC) if VECTOR_WINDOW_FABRIC.is_file() else {}
    execution_ladder = load_json(EXECUTION_LADDER) if EXECUTION_LADDER.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and model_load.get("status") == "PASS"
        and int(model_load.get("summary", {}).get("programmed_shard_records", 0)) == 151_367
        and vector_window.get("status") == "PASS"
        and int(vector_window.get("summary", {}).get("window_rows_per_layer", 0)) == ROWS_PER_LAYER
        and execution_ladder.get("status") == "PASS"
        and int(execution_ladder.get("summary", {}).get("deterministic_window_row_count", 0))
        == int(vector_window.get("summary", {}).get("executed_row_count", -1))
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, model-load stream, vector-window fabric checksum, and coverage ladder are linked and PASS",
        "window-shard dependency report missing, stale, or failing",
    )
    checks.append({"id": "e1x_window_shard_linkage_dependencies_pass", "status": status, "detail": detail})

    touched_records: list[dict[str, int | str]] = []
    mismatches: list[str] = []
    usable_bytes = int(placement.get("usable_bytes_per_core", 0))
    logical_cores = int(placement.get("logical_cores", 0))
    for layer in placement.get("layers", []):
        if not isinstance(layer, dict):
            mismatches.append("malformed-layer")
            continue
        records = touched_window_shards(layer)
        layer_window_rows = sum(int(record["window_row_count"]) for record in records)
        if layer_window_rows != min(ROWS_PER_LAYER, int(layer.get("rows", 0))):
            mismatches.append(f"row-window:{layer.get('index')}")
        for record in records:
            if int(record["window_shard_bytes"]) > usable_bytes:
                mismatches.append(f"sram-fit:{record['layer_index']}:{record['logical_core_index']}")
            if int(record["logical_core_index"]) >= logical_cores:
                mismatches.append(f"logical-core:{record['layer_index']}:{record['logical_core_index']}")
        touched_records.extend(records)

    touched_cores = {int(record["logical_core_index"]) for record in touched_records}
    touched_rows = sum(int(record["window_row_count"]) for record in touched_records)
    touched_bytes = sum(int(record["window_shard_bytes"]) for record in touched_records)
    touched_loader_words = sum(int(record["window_loader_words"]) for record in touched_records)
    touched_record_sha256 = canonical_sha256(touched_records)
    sampled_records = touched_records[:12]
    coverage_ok = (
        not mismatches
        and int(placement.get("layer_count", 0)) == 283
        and len(touched_records) > 1_169
        and len(touched_cores) == len(touched_records)
        and touched_rows == int(vector_window.get("summary", {}).get("executed_row_count", -1))
        and touched_bytes > 44_241_984
        and touched_loader_words > 11_060_496
        and int(model_load.get("summary", {}).get("stream_loader_word_transactions", 0)) == 1_627_034_880
    )
    status, detail = pass_fail(
        coverage_ok,
        f"window execution rows map to {len(touched_records)} loaded SRAM shard records and {touched_loader_words} loader words",
        "window-shard linkage mismatch: " + ", ".join(mismatches[:8]),
    )
    checks.append({"id": "e1x_window_shard_linkage_maps_window_rows_to_loaded_shards", "status": status, "detail": detail})

    boundary_ok = (
        len(touched_records) == int(model_load.get("summary", {}).get("programmed_shard_records", 0))
        and touched_loader_words == int(model_load.get("summary", {}).get("stream_loader_word_transactions", 0))
        and vector_window.get("summary", {}).get("residual_blocker")
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    status, detail = pass_fail(
        boundary_ok,
        "window-shard linkage covers every loaded shard while preserving the synthetic-weight execution boundary",
        "window-shard claim boundary mismatch",
    )
    checks.append({"id": "e1x_window_shard_linkage_preserves_full_execution_blocker", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_rows_per_layer": ROWS_PER_LAYER,
        "placement_layer_count": int(placement.get("layer_count", 0)),
        "window_executed_row_count": touched_rows,
        "window_touched_shard_records": len(touched_records),
        "window_touched_logical_cores": len(touched_cores),
        "window_touched_shard_bytes": touched_bytes,
        "window_touched_loader_words": touched_loader_words,
        "total_programmed_shard_records": int(model_load.get("summary", {}).get("programmed_shard_records", 0)),
        "total_stream_loader_word_transactions": int(
            model_load.get("summary", {}).get("stream_loader_word_transactions", 0)
        ),
        "window_shard_record_fraction": (
            len(touched_records) / int(model_load.get("summary", {}).get("programmed_shard_records", 1))
        ),
        "window_loader_word_fraction": (
            touched_loader_words
            / int(model_load.get("summary", {}).get("stream_loader_word_transactions", 1))
        ),
        "routed_window_checksum": int(vector_window.get("summary", {}).get("routed_window_checksum", 0)),
        "touched_shard_record_sha256": touched_record_sha256,
        "sampled_touched_shard_records": sampled_records,
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-window-shard-linkage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Maps deterministic vector-window execution rows onto the real placed "
            "model's loaded SRAM shard ranges and loader-word accounting. This "
            "proves the window rows are covered by resident shard placement, but "
            "does not prove full real-weight tensor execution or silicon behavior."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_model_load_stream.json",
            "build/reports/e1x_vector_window_fabric_checksum.json",
            "build/reports/e1x_execution_coverage_ladder.json",
            "scripts/check_e1x_window_shard_linkage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X window-shard linkage failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X window-shard linkage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
