#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from itertools import cycle, islice
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_layer_shard_sweep_executor.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
MODEL_LOAD_STREAM = ROOT / "build/reports/e1x_model_load_stream.json"
MODEL_SHARD_SAMPLE = ROOT / "build/reports/e1x_model_shard_sample_executor.json"
WINDOW_SHARD_LINKAGE = ROOT / "build/reports/e1x_window_shard_linkage.json"

WORD_BYTES = 4
MASK64 = (1 << 64) - 1
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def packed_w4_layer_word(model: str, layer_index: int, logical_core_index: int, word_addr: int) -> int:
    seed = f"{model}|layer={layer_index}|core={logical_core_index}|w4|{word_addr}"
    value = int.from_bytes(blake2s(seed.encode(), digest_size=4).digest(), "big")
    word = 0
    for lane in range(8):
        word |= ((value >> (lane * 4)) & 0xF) << (lane * 4)
    return word


def unpack_signed_w4_word(word: int) -> list[int]:
    values: list[int] = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def layer_records(layer: dict) -> list[dict[str, int | str]]:
    rows = int(layer["rows"])
    cols = int(layer["cols"])
    weight_bits = int(layer["weight_bits"])
    rows_per_core = int(layer["rows_per_core"])
    assigned_cores = int(layer["assigned_cores"])
    bytes_per_row = ceil(cols * weight_bits / 8)
    records: list[dict[str, int | str]] = []
    for ordinal in range(assigned_cores):
        row_start = ordinal * rows_per_core
        if row_start >= rows:
            break
        row_count = min(rows_per_core, rows - row_start)
        shard_bytes = row_count * bytes_per_row
        records.append(
            {
                "layer_index": int(layer["index"]),
                "layer_name": str(layer["name"]),
                "kind": str(layer["kind"]),
                "logical_core_index": int(layer["core_index_start"]) + ordinal,
                "row_start": row_start,
                "row_count": row_count,
                "shard_bytes": shard_bytes,
                "loader_words": ceil(shard_bytes / WORD_BYTES),
            }
        )
    return records


def selected_layer_records(layers: list[dict]) -> list[dict[str, int | str]]:
    selected: list[dict[str, int | str]] = []
    for layer in layers:
        records = layer_records(layer)
        if not records:
            continue
        for index in sorted({0, len(records) // 2, len(records) - 1}):
            selected.append(records[index])
    return selected


def execute_record(model: str, record: dict[str, int | str], activations: list[int]) -> dict[str, int]:
    acc = 0
    lane_macs = 0
    checksum = FNV64_OFFSET
    word_count = int(record["loader_words"])
    activation_stream = list(islice(cycle(activations), word_count * 8))
    for word_addr in range(word_count):
        word = packed_w4_layer_word(
            model,
            int(record["layer_index"]),
            int(record["logical_core_index"]),
            word_addr,
        )
        weights = unpack_signed_w4_word(word)
        activation_chunk = activation_stream[word_addr * 8 : word_addr * 8 + 8]
        partial = sum(
            int(activation) * int(weight)
            for activation, weight in zip(activation_chunk, weights, strict=True)
        )
        acc += partial
        lane_macs += len(weights)
        checksum = mix64(checksum, int(record["layer_index"]))
        checksum = mix64(checksum, int(record["logical_core_index"]))
        checksum = mix64(checksum, word_addr)
        checksum = mix64(checksum, word)
        checksum = mix64(checksum, partial)
    return {
        "accumulator": acc,
        "requantized_s8": max(-128, min(127, acc >> 7)),
        "lane_mac_count": lane_macs,
        "trace_checksum": checksum,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    input_paths = (PLACEMENT, PROOF, MODEL_LOAD_STREAM, MODEL_SHARD_SAMPLE, WINDOW_SHARD_LINKAGE)
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "layer-shard sweep executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_layer_shard_sweep_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    proof = load_json(PROOF) if PROOF.is_file() else {}
    model_load = load_json(MODEL_LOAD_STREAM) if MODEL_LOAD_STREAM.is_file() else {}
    shard_sample = load_json(MODEL_SHARD_SAMPLE) if MODEL_SHARD_SAMPLE.is_file() else {}
    window_shard = load_json(WINDOW_SHARD_LINKAGE) if WINDOW_SHARD_LINKAGE.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and model_load.get("status") == "PASS"
        and int(model_load.get("summary", {}).get("programmed_shard_records", 0)) == 151_367
        and shard_sample.get("status") == "PASS"
        and int(shard_sample.get("summary", {}).get("sampled_shard_word_count", 0)) == 9_281
        and window_shard.get("status") == "PASS"
        and int(window_shard.get("summary", {}).get("window_touched_shard_records", 0)) == 151_367
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, full model-load stream, full-shard sample, and window-shard linkage are PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append({"id": "e1x_layer_shard_sweep_dependencies_pass", "status": status, "detail": detail})

    layers = placement.get("layers", [])
    records = selected_layer_records(layers if isinstance(layers, list) else [])
    records_by_kind = sorted({str(record["kind"]) for record in records})
    layer_indices = sorted({int(record["layer_index"]) for record in records})
    selection_ok = (
        len(layer_indices) == int(placement.get("layer_count", 0)) == 283
        and len(records) == 687
        and len(records_by_kind) == 8
        and max(int(record["loader_words"]) for record in records) <= 10_880
        and sum(int(record["loader_words"]) for record in records) == 5_064_960
    )
    status, detail = pass_fail(
        selection_ok,
        f"selected {len(records)} first/mid/last shard records across {len(layer_indices)} layers and {len(records_by_kind)} layer kinds",
        "layer-shard record selection mismatch",
    )
    checks.append({"id": "e1x_layer_shard_sweep_selection_covers_graph", "status": status, "detail": detail})

    proof_records = proof.get("records", [])
    first_record = proof_records[0] if isinstance(proof_records, list) and proof_records else {}
    activations = [int(value) for value in first_record.get("activation_s8", [])]
    model_name = str(placement.get("model", "e1x_llm_13b_w4a8_static_graph"))
    total_lane_macs = 0
    total_words = 0
    aggregate_checksum = FNV64_OFFSET
    sampled_results: list[dict[str, int | str]] = []
    for record in records:
        result = execute_record(model_name, record, activations) if activations else {
            "accumulator": 0,
            "requantized_s8": 0,
            "lane_mac_count": 0,
            "trace_checksum": 0,
        }
        total_lane_macs += int(result["lane_mac_count"])
        total_words += int(record["loader_words"])
        aggregate_checksum = mix64(aggregate_checksum, int(record["layer_index"]))
        aggregate_checksum = mix64(aggregate_checksum, int(record["logical_core_index"]))
        aggregate_checksum = mix64(aggregate_checksum, int(result["trace_checksum"]))
        if len(sampled_results) < 8:
            sampled_results.append(
                {
                    "layer_index": int(record["layer_index"]),
                    "layer_name": str(record["layer_name"]),
                    "kind": str(record["kind"]),
                    "logical_core_index": int(record["logical_core_index"]),
                    "loader_words": int(record["loader_words"]),
                    "lane_macs": int(result["lane_mac_count"]),
                    "trace_checksum": int(result["trace_checksum"]),
                    "requantized_s8": int(result["requantized_s8"]),
                }
            )
    execution_ok = (
        len(activations) == 32
        and total_words == 5_064_960
        and total_lane_macs == 40_519_680
        and aggregate_checksum != FNV64_OFFSET
    )
    status, detail = pass_fail(
        execution_ok,
        f"executed {total_words} generated W4 layer-shard words through W4A8 semantics",
        "layer-shard W4A8 execution mismatch",
    )
    checks.append({"id": "e1x_layer_shard_sweep_executes_generated_payload", "status": status, "detail": detail})

    total_loader_words = int(model_load.get("summary", {}).get("stream_loader_word_transactions", 0))
    coverage_ok = (
        total_loader_words == 1_627_034_880
        and 0.001 < total_words / total_loader_words < 0.01
        and model_load.get("summary", {}).get("residual_blocker")
        == "cycle_accurate_full_tensor_executor_missing"
    )
    status, detail = pass_fail(
        coverage_ok,
        "layer-shard sweep expands generated payload execution while preserving full 6.5GB payload blocker",
        "layer-shard sweep coverage boundary mismatch",
    )
    checks.append({"id": "e1x_layer_shard_sweep_preserves_full_payload_blocker", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "placement_layer_count": int(placement.get("layer_count", 0)),
        "covered_layer_count": len(layer_indices),
        "covered_kind_count": len(records_by_kind),
        "covered_kinds": records_by_kind,
        "sampled_shard_record_count": len(records),
        "executed_loader_word_count": total_words,
        "executed_lane_mac_count": total_lane_macs,
        "total_loader_word_transactions": total_loader_words,
        "loader_word_coverage_fraction": total_words / total_loader_words if total_loader_words else 0.0,
        "activation_source_layer_index": int(first_record.get("layer_index", -1)),
        "activation_value_count": len(activations),
        "aggregate_execution_checksum": aggregate_checksum,
        "sampled_result_sha256": canonical_sha256(sampled_results),
        "sampled_results": sampled_results,
        "residual_blocker": "full_quantized_weight_payload_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-layer-shard-sweep-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Executes deterministic generated W4 payloads for first/mid/last shard records "
            "from every placed real-graph layer through W4A8 semantics and links the sweep "
            "to full model-load and window-shard evidence. This is layer-spanning sampled "
            "payload execution, not execution of every word in the 6.5GB quantized tensor "
            "payload and not a full-output real-weight checksum."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "build/reports/e1x_model_load_stream.json",
            "build/reports/e1x_model_shard_sample_executor.json",
            "build/reports/e1x_window_shard_linkage.json",
            "scripts/check_e1x_layer_shard_sweep_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X layer-shard sweep executor failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X layer-shard sweep executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
