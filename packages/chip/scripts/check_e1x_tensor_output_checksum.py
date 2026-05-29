#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_tensor_output_checksum.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
TENSOR_FABRIC = ROOT / "build/reports/e1x_tensor_fabric_executor.json"
NORMAL_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json"
HIGH_TRACE = ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json"

FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1
EXPECTED_SAMPLED_OUTPUT_CHECKSUM = 14_414_877_542_268_347_137


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def recompute_row(activations: list[int], packed_words_hex: list[str]) -> tuple[int, int]:
    weights = [
        weight
        for word_hex in packed_words_hex
        for weight in unpack_signed_w4_word(int(str(word_hex), 16))
    ][: len(activations)]
    accumulator = sum(int(a) * int(w) for a, w in zip(activations, weights, strict=True))
    requantized = max(-128, min(127, accumulator >> 7))
    return accumulator, requantized


def mix64(checksum: int, value: int) -> int:
    return ((checksum ^ (value & MASK64)) * FNV64_PRIME) & MASK64


def layer_output_checksum(layer_index: int, rows: list[dict]) -> int:
    checksum = 0x9E3779B97F4A7C15 ^ layer_index
    for row in rows:
        value = (
            (int(row["output_row"]) & 0xFFFF)
            | ((int(row["requantized_s8"]) & 0xFF) << 16)
            | ((int(row["accumulator"]) & 0xFFFF_FFFF) << 24)
        )
        checksum = mix64(checksum, value)
    return checksum


def aggregate_output_checksum(layer_checksums: list[int]) -> int:
    checksum = FNV64_OFFSET
    for layer_checksum in layer_checksums:
        checksum = mix64(checksum, layer_checksum)
    return checksum


def trace_sample_ok(trace: dict, schedule_by_index: dict[int, dict]) -> bool:
    samples = trace.get("layer_trace_sample")
    if not isinstance(samples, list) or len(samples) < 8:
        return False
    for sample in samples:
        if not isinstance(sample, dict):
            return False
        layer = schedule_by_index.get(int(sample.get("layer", -1)))
        if layer is None:
            return False
        if int(sample.get("route_color", -1)) != int(layer.get("routing_color", -2)):
            return False
        if int(sample.get("checksum", 0)) <= 0:
            return False
    return True


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PROOF, SCHEDULE, TENSOR_FABRIC, NORMAL_TRACE, HIGH_TRACE)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "tensor output-checksum inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_tensor_output_checksum_inputs_present", "status": status, "detail": detail})

    proof = load_json(PROOF) if PROOF.is_file() else {}
    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    tensor_fabric = load_json(TENSOR_FABRIC) if TENSOR_FABRIC.is_file() else {}
    normal_trace = load_json(NORMAL_TRACE) if NORMAL_TRACE.is_file() else {}
    high_trace = load_json(HIGH_TRACE) if HIGH_TRACE.is_file() else {}

    schema_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and normal_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
        and high_trace.get("schema") == "eliza.e1x.real_graph_execution_trace.v1"
        and proof.get("source_placement_sha256") == schedule.get("source_placement_sha256")
    )
    status, detail = pass_fail(
        schema_ok,
        "proof, tensor schedule, and normal/high execution trace schemas link to the same placement",
        "schema or placement-link mismatch",
    )
    checks.append({"id": "e1x_tensor_output_checksum_artifact_links", "status": status, "detail": detail})

    fabric_ok = (
        tensor_fabric.get("status") == "PASS"
        and int(tensor_fabric.get("summary", {}).get("merged_partial_count", 0)) >= 1132
        and int(tensor_fabric.get("summary", {}).get("failing_check_count", 1)) == 0
    )
    status, detail = pass_fail(
        fabric_ok,
        "sampled tensor fabric executor report is PASS",
        "sampled tensor fabric executor report missing or failing",
    )
    checks.append({"id": "e1x_tensor_output_checksum_fabric_executor_pass", "status": status, "detail": detail})

    mismatches: list[str] = []
    layer_checksums: list[int] = []
    sampled_layers: list[dict[str, int | str]] = []
    sampled_rows = 0
    for record in proof.get("records", []):
        activations = record.get("activation_s8", [])
        row_results = []
        if not isinstance(activations, list):
            mismatches.append(f"malformed-act:{record.get('layer_index')}")
            continue
        for row in record.get("row_results", []):
            accumulator, requantized = recompute_row(
                [int(value) for value in activations],
                list(row.get("packed_w4_words_hex", [])),
            )
            if accumulator != int(row.get("accumulator", 0)):
                mismatches.append(f"acc:{record.get('layer_index')}:{row.get('output_row')}")
            if requantized != int(row.get("requantized_s8", 0)):
                mismatches.append(f"out:{record.get('layer_index')}:{row.get('output_row')}")
            row_results.append({
                "output_row": int(row.get("output_row", -1)),
                "accumulator": accumulator,
                "requantized_s8": requantized,
            })
            sampled_rows += 1
        layer_checksum = layer_output_checksum(int(record.get("layer_index", -1)), row_results)
        layer_checksums.append(layer_checksum)
        if len(sampled_layers) < 8:
            sampled_layers.append({
                "layer_index": int(record.get("layer_index", -1)),
                "layer_name": str(record.get("layer_name", "")),
                "sampled_output_rows": len(row_results),
                "sampled_output_checksum": int(layer_checksum),
            })

    aggregate_checksum = aggregate_output_checksum(layer_checksums)
    checksum_ok = (
        not mismatches
        and len(layer_checksums) >= 283
        and sampled_rows >= 1132
        and aggregate_checksum == EXPECTED_SAMPLED_OUTPUT_CHECKSUM
    )
    status, detail = pass_fail(
        checksum_ok,
        f"recomputed sampled output checksum {aggregate_checksum} across {sampled_rows} rows",
        "sampled output mismatches: " + ", ".join(mismatches[:8]),
    )
    checks.append({"id": "e1x_tensor_output_checksum_recomputes_outputs", "status": status, "detail": detail})

    schedule_by_index = {
        int(layer["layer_index"]): layer
        for layer in schedule.get("layers", [])
        if isinstance(layer, dict) and "layer_index" in layer
    }
    trace_ok = (
        bool(normal_trace.get("golden_trace_match")) is True
        and bool(high_trace.get("golden_trace_match")) is True
        and int(normal_trace.get("output_checksum", 0)) > 0
        and int(high_trace.get("output_checksum", 0)) > 0
        and int(normal_trace.get("output_checksum", 0)) != int(high_trace.get("output_checksum", 0))
        and trace_sample_ok(normal_trace, schedule_by_index)
        and trace_sample_ok(high_trace, schedule_by_index)
    )
    status, detail = pass_fail(
        trace_ok,
        "normal/high execution traces expose positive scenario output checksums and route-colored sampled layers",
        "normal/high execution trace checksum or sampled-layer linkage missing",
    )
    checks.append({"id": "e1x_tensor_output_checksum_trace_links", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "proof_layer_count": len(layer_checksums),
        "sampled_output_row_count": sampled_rows,
        "sampled_output_checksum": int(aggregate_checksum),
        "normal_trace_output_checksum": int(normal_trace.get("output_checksum", 0)),
        "high_failure_trace_output_checksum": int(high_trace.get("output_checksum", 0)),
        "normal_trace_sampled_layers": len(normal_trace.get("layer_trace_sample", [])),
        "high_failure_trace_sampled_layers": len(high_trace.get("layer_trace_sample", [])),
        "tensor_fabric_executor_merged_partials": int(
            tensor_fabric.get("summary", {}).get("merged_partial_count", 0)
        ),
        "sampled_layers": sampled_layers,
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-tensor-output-checksum",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Sampled tensor output-checksum evidence after W4A8 accumulation and "
            "requantization for every proof layer, linked to the sampled tensor "
            "fabric executor and normal/high execution trace checksum sidecars. "
            "This is not a full-output numerical proof for every graph row/token "
            "and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "build/reports/e1x_tensor_fabric_executor.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_execution_trace.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_execution_trace.json",
            "scripts/check_e1x_tensor_output_checksum.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X tensor output checksum failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X tensor output checksum; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
