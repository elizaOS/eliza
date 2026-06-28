#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_model_load_stream.json"

MODEL_LOAD = ROOT / "benchmarks/results/e1x-real-graph-model-load.json"
PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
CORE_COCOTB_REPORT = ROOT / "build/reports/e1x_core_cocotb.json"
LOADER_RTL = ROOT / "rtl/e1x/e1x_local_sram_shard_loader.sv"
GENERATED_SHARD_SAMPLE = (
    ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json"
)

WORD_BYTES = 4


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def layer_stream_records(layer: dict) -> tuple[list[dict[str, int]], int, int]:
    rows = int(layer["rows"])
    cols = int(layer["cols"])
    weight_bits = int(layer["weight_bits"])
    rows_per_core = int(layer["rows_per_core"])
    assigned_cores = int(layer["assigned_cores"])
    bytes_per_row = ceil(cols * weight_bits / 8)
    records: list[dict[str, int]] = []
    covered_rows = 0
    for ordinal in range(assigned_cores):
        row_start = ordinal * rows_per_core
        if row_start >= rows:
            break
        row_count = min(rows_per_core, rows - row_start)
        shard_bytes = row_count * bytes_per_row
        records.append(
            {
                "logical_core_index": int(layer["core_index_start"]) + ordinal,
                "row_start": row_start,
                "row_count": row_count,
                "shard_bytes": shard_bytes,
                "loader_words": ceil(shard_bytes / WORD_BYTES),
            }
        )
        covered_rows += row_count
    return records, covered_rows, bytes_per_row


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = (
        MODEL_LOAD,
        PLACEMENT,
        SCHEDULE,
        CORE_COCOTB_REPORT,
        LOADER_RTL,
        GENERATED_SHARD_SAMPLE,
    )
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "model-load stream inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_model_load_stream_inputs_present", "status": status, "detail": detail}
    )

    model_load = load_json(MODEL_LOAD) if MODEL_LOAD.is_file() else {}
    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    core_cocotb = load_json(CORE_COCOTB_REPORT) if CORE_COCOTB_REPORT.is_file() else {}
    shard_sample = load_json(GENERATED_SHARD_SAMPLE) if GENERATED_SHARD_SAMPLE.is_file() else {}
    loader_rtl = LOADER_RTL.read_text(encoding="utf-8") if LOADER_RTL.is_file() else ""

    schema_ok = (
        model_load.get("schema") == "eliza.e1x.real_graph_model_load.v1"
        and placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
    )
    status, detail = pass_fail(schema_ok, "model-load, placement, and schedule schemas match")
    checks.append({"id": "e1x_model_load_stream_schemas", "status": status, "detail": detail})

    links_ok = (
        schedule.get("source_placement_sha256") == placement.get("artifact_sha256")
        and int(schedule.get("layer_count", 0)) == int(placement.get("layer_count", -1))
        and bool(schedule.get("all_shards_fit_sram")) is True
    )
    status, detail = pass_fail(
        links_ok,
        "tensor schedule links to placement and reports all shards fit SRAM",
        "schedule does not link to placement or reports shard fit failure",
    )
    checks.append(
        {"id": "e1x_model_load_stream_schedule_links_placement", "status": status, "detail": detail}
    )

    scenario_loads = model_load.get("model_load_by_scenario", {})
    scenarios_ok = (
        int(model_load.get("model_loaded_under_normal_defects", 0)) == 1
        and int(model_load.get("model_loaded_under_high_failure", 0)) == 1
        and all(bool(value.get("placement_successful")) for value in scenario_loads.values())
    )
    status, detail = pass_fail(
        scenarios_ok,
        "normal and high-failure scenarios both report resident model load success",
        "normal/high scenario model load success missing",
    )
    checks.append(
        {
            "id": "e1x_model_load_stream_normal_high_scenarios_loaded",
            "status": status,
            "detail": detail,
        }
    )

    loader_terms = (
        "module e1x_local_sram_shard_loader",
        "load_valid_i",
        "load_word_addr_i",
        "load_word_i",
        "overflow_o",
        "loaded_words_o",
        "checksum_o",
        "read_word_o",
    )
    missing_loader_terms = [term for term in loader_terms if term not in loader_rtl]
    status, detail = pass_fail(
        not missing_loader_terms,
        "local SRAM shard-loader RTL exposes load/readback/checksum contract",
        "missing loader terms: " + ", ".join(missing_loader_terms),
    )
    checks.append(
        {"id": "e1x_model_load_stream_loader_rtl_contract", "status": status, "detail": detail}
    )

    core_summary = core_cocotb.get("summary", {})
    sample_ok = (
        core_cocotb.get("status") == "PASS"
        and int(core_summary.get("testcases", 0)) >= 22
        and shard_sample.get("schema") == "eliza.e1x.quantized_model_shard_sample.v1"
        and bool(shard_sample.get("placement_successful")) is True
    )
    status, detail = pass_fail(
        sample_ok,
        "core cocotb includes generated model-shard load/readback sample",
        "generated model-shard loader cocotb evidence missing",
    )
    checks.append(
        {
            "id": "e1x_model_load_stream_generated_shard_loader_cocotb",
            "status": status,
            "detail": detail,
        }
    )

    layers = placement.get("layers", [])
    usable_bytes = int(placement.get("usable_bytes_per_core", 0))
    logical_cores = int(placement.get("logical_cores", 0))
    programmed_cores = 0
    total_stream_bytes = 0
    total_loader_words = 0
    max_shard_bytes = 0
    row_coverage_failures = []
    fit_failures = []
    core_indices = set()
    kind_counts: Counter[str] = Counter()
    sampled_records: list[dict[str, int | str]] = []

    if isinstance(layers, list):
        for layer in layers:
            kind_counts[str(layer.get("kind", ""))] += 1
            records, covered_rows, bytes_per_row = layer_stream_records(layer)
            if covered_rows != int(layer.get("rows", -1)):
                row_coverage_failures.append(str(layer.get("index")))
            programmed_cores += len(records)
            for record in records:
                total_stream_bytes += int(record["shard_bytes"])
                total_loader_words += int(record["loader_words"])
                max_shard_bytes = max(max_shard_bytes, int(record["shard_bytes"]))
                if int(record["shard_bytes"]) > usable_bytes:
                    fit_failures.append(str(layer.get("index")))
                core_indices.add(int(record["logical_core_index"]))
            if len(sampled_records) < 6 and records:
                first = records[0]
                sampled_records.append(
                    {
                        "layer_index": int(layer["index"]),
                        "layer_name": str(layer["name"]),
                        "logical_core_index": int(first["logical_core_index"]),
                        "bytes_per_row": bytes_per_row,
                        "row_count": int(first["row_count"]),
                        "loader_words": int(first["loader_words"]),
                    }
                )

    layer_count = int(placement.get("layer_count", 0))
    expected_weight_bytes = int(placement.get("total_weight_bytes", 0))
    stream_padding_bytes = total_stream_bytes - expected_weight_bytes
    coverage_ok = (
        layer_count >= 283
        and len(layers) == layer_count
        and not row_coverage_failures
        and programmed_cores == int(placement.get("cores_used", 0))
        and len(core_indices) == programmed_cores
        and max(core_indices, default=-1) < logical_cores
    )
    status, detail = pass_fail(
        coverage_ok,
        f"full load stream covers {layer_count} layers and {programmed_cores} unique logical cores",
        "coverage failures layers=" + ",".join(row_coverage_failures[:8]),
    )
    checks.append(
        {"id": "e1x_model_load_stream_full_layer_core_coverage", "status": status, "detail": detail}
    )

    fit_ok = not fit_failures and max_shard_bytes <= usable_bytes <= 48 * 1024
    status, detail = pass_fail(
        fit_ok,
        f"all programmed shards fit placement SRAM budget; max shard {max_shard_bytes} B",
        "shards exceed placement SRAM budget in layers: " + ",".join(fit_failures[:8]),
    )
    checks.append(
        {
            "id": "e1x_model_load_stream_all_shards_fit_loader_capacity",
            "status": status,
            "detail": detail,
        }
    )

    byte_accounting_ok = (
        total_stream_bytes >= expected_weight_bytes
        and stream_padding_bytes >= 0
        and stream_padding_bytes / max(1, expected_weight_bytes) < 0.001
        and total_loader_words
        >= int(model_load.get("model_load", {}).get("fabric_load_wavelets", 0))
    )
    status, detail = pass_fail(
        byte_accounting_ok,
        (
            f"loader stream accounts for {total_stream_bytes} weight bytes with "
            f"{stream_padding_bytes} B row-padding overhead"
        ),
        "loader stream byte accounting mismatch",
    )
    checks.append(
        {"id": "e1x_model_load_stream_byte_accounting", "status": status, "detail": detail}
    )

    reserve_mismatch_bytes = usable_bytes - int(
        model_load.get("model_load", {}).get("per_core_model_capacity_bytes", 0)
    )
    residual_blocker = (
        "cycle_accurate_full_tensor_executor_missing"
        if reserve_mismatch_bytes == 0
        else "cycle_accurate_full_tensor_executor_and_runtime_reserve_policy_alignment_missing"
    )
    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "layer_count": layer_count,
        "programmed_shard_records": programmed_cores,
        "unique_logical_cores": len(core_indices),
        "placement_cores_used": int(placement.get("cores_used", 0)),
        "total_weight_bytes": expected_weight_bytes,
        "total_stream_bytes": total_stream_bytes,
        "stream_padding_bytes": stream_padding_bytes,
        "stream_loader_word_transactions": total_loader_words,
        "fabric_load_wavelets": int(
            model_load.get("model_load", {}).get("fabric_load_wavelets", 0)
        ),
        "max_shard_bytes": max_shard_bytes,
        "placement_usable_bytes_per_core": usable_bytes,
        "scenario_per_core_model_capacity_bytes": int(
            model_load.get("model_load", {}).get("per_core_model_capacity_bytes", 0)
        ),
        "reserve_policy_mismatch_bytes": reserve_mismatch_bytes,
        "kind_counts": dict(sorted(kind_counts.items())),
        "sampled_stream_records": sampled_records,
        "generated_shard_sample_words": int(shard_sample.get("sampled_word_count", 0)),
        "core_cocotb_testcases": int(core_summary.get("testcases", 0)),
        "residual_blocker": residual_blocker,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-model-load-stream",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X full placed-model load-stream accounting against the real-graph "
            "placement, tensor schedule, local SRAM shard-loader RTL contract, and "
            "generated shard-loader cocotb sample. This proves deterministic loader "
            "transaction coverage and SRAM fit for every placed shard; it is not a "
            "cycle-accurate full tensor executor, fabric DMA implementation, or "
            "full-output numerical proof."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.json",
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json",
            "rtl/e1x/e1x_local_sram_shard_loader.sv",
            "build/reports/e1x_core_cocotb.json",
            "scripts/check_e1x_model_load_stream.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X model-load stream failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X model-load stream; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
