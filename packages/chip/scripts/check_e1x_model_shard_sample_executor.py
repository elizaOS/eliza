#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from itertools import cycle, islice
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_model_shard_sample_executor.json"

SHARD_SAMPLE = (
    ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json"
)
PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
MODEL_LOAD_STREAM = ROOT / "build/reports/e1x_model_load_stream.json"
VECTOR_WINDOW = ROOT / "build/reports/e1x_vector_kernel_window_executor.json"
CORE_COCOTB = ROOT / "build/reports/e1x_core_cocotb.json"

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


def loader_checksum(words: list[dict[str, int]]) -> int:
    checksum = 0
    for entry in words:
        checksum = (
            (((checksum << 1) | (checksum >> 31)) & 0xFFFF_FFFF)
            ^ int(entry["word"])
            ^ int(entry["word_addr"])
        )
    return checksum & 0xFFFF_FFFF


def unpack_signed_w4_word(word: int) -> list[int]:
    values: list[int] = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def execute_sample_words(words: list[dict[str, int]], activations: list[int]) -> dict[str, int]:
    acc = 0
    lane_macs = 0
    trace_checksum = FNV64_OFFSET
    activation_stream = list(islice(cycle(activations), len(words) * 8))
    for word_index, entry in enumerate(words):
        weights = unpack_signed_w4_word(int(entry["word"]))
        activation_chunk = activation_stream[word_index * 8 : word_index * 8 + 8]
        partial = sum(
            int(activation) * int(weight)
            for activation, weight in zip(activation_chunk, weights, strict=True)
        )
        acc += partial
        lane_macs += len(weights)
        trace_checksum = mix64(trace_checksum, int(entry["word_addr"]))
        trace_checksum = mix64(trace_checksum, int(entry["word"]))
        trace_checksum = mix64(trace_checksum, partial)
    requantized = max(-128, min(127, acc >> 7))
    return {
        "accumulator": acc,
        "requantized_s8": requantized,
        "lane_mac_count": lane_macs,
        "trace_checksum": trace_checksum,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (SHARD_SAMPLE, PROOF, MODEL_LOAD_STREAM, VECTOR_WINDOW, CORE_COCOTB)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "model-shard sample executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_model_shard_sample_executor_inputs_present", "status": status, "detail": detail}
    )

    shard = load_json(SHARD_SAMPLE) if SHARD_SAMPLE.is_file() else {}
    proof = load_json(PROOF) if PROOF.is_file() else {}
    model_load = load_json(MODEL_LOAD_STREAM) if MODEL_LOAD_STREAM.is_file() else {}
    vector_window = load_json(VECTOR_WINDOW) if VECTOR_WINDOW.is_file() else {}
    core_cocotb = load_json(CORE_COCOTB) if CORE_COCOTB.is_file() else {}

    deps_ok = (
        shard.get("schema") == "eliza.e1x.quantized_model_shard_sample.v1"
        and proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and model_load.get("status") == "PASS"
        and int(model_load.get("summary", {}).get("programmed_shard_records", 0)) == 151_367
        and vector_window.get("status") == "PASS"
        and int(vector_window.get("summary", {}).get("executed_row_count", 0)) == 2_608_640
        and core_cocotb.get("status") == "PASS"
        and int(core_cocotb.get("summary", {}).get("testcases", 0)) >= 22
    )
    status, detail = pass_fail(
        deps_ok,
        "model shard sample, proof activations, full deterministic window, and loader RTL cocotb are linked and PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {
            "id": "e1x_model_shard_sample_executor_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    words = [
        {"word_addr": int(entry["word_addr"]), "word": int(entry["word"])}
        for entry in shard.get("words", [])
        if isinstance(entry, dict)
    ]
    shard_word_count = int(shard.get("weight_shard_word_count", 0))
    contiguous_shard = [entry for entry in words if int(entry["word_addr"]) < shard_word_count]
    sentinel = [
        entry
        for entry in words
        if int(entry["word_addr"]) == int(shard.get("capacity_words", 0)) - 1
    ]
    checksum = loader_checksum(words)
    payload_ok = (
        shard_word_count == 9_281
        and len(words) == int(shard.get("sampled_word_count", -1)) == shard_word_count + 1
        and len(contiguous_shard) == shard_word_count
        and [int(entry["word_addr"]) for entry in contiguous_shard] == list(range(shard_word_count))
        and len(sentinel) == 1
        and int(shard.get("expected_loaded_bytes", 0))
        == len(words) * int(shard.get("word_bytes", 0))
        and checksum == int(shard.get("expected_checksum", -1))
        and all(0 <= int(entry["word"]) <= 0xFFFF_FFFF for entry in words)
    )
    status, detail = pass_fail(
        payload_ok,
        f"model-shard sample payload has {len(contiguous_shard)} contiguous shard words plus one sentinel and checksum {checksum}",
        "model-shard sample payload/checksum mismatch",
    )
    checks.append(
        {
            "id": "e1x_model_shard_sample_executor_payload_integrity",
            "status": status,
            "detail": detail,
        }
    )

    records = proof.get("records", [])
    first_record = records[0] if isinstance(records, list) and records else {}
    activations = [int(value) for value in first_record.get("activation_s8", [])]
    result = (
        execute_sample_words(words, activations)
        if words and activations
        else {
            "accumulator": 0,
            "requantized_s8": 0,
            "lane_mac_count": 0,
            "trace_checksum": 0,
        }
    )
    execution_ok = (
        len(activations) == 32
        and int(result["lane_mac_count"]) == len(words) * 8
        and -128 <= int(result["requantized_s8"]) <= 127
        and int(result["trace_checksum"]) != FNV64_OFFSET
    )
    status, detail = pass_fail(
        execution_ok,
        f"executed {len(words)} actual loaded shard-sample W4 words through W4A8 vector semantics",
        "model-shard sample vector execution mismatch",
    )
    checks.append(
        {
            "id": "e1x_model_shard_sample_executor_runs_loaded_words",
            "status": status,
            "detail": detail,
        }
    )

    total_loader_words = int(
        model_load.get("summary", {}).get("stream_loader_word_transactions", 0)
    )
    coverage_ok = (
        total_loader_words == 1_627_034_880
        and 0.0 < len(words) / total_loader_words < 0.00001
        and model_load.get("summary", {}).get("residual_blocker")
        == "cycle_accurate_full_tensor_executor_missing"
    )
    status, detail = pass_fail(
        coverage_ok,
        "sample execution is tied to loaded payload format while preserving the missing full payload executor boundary",
        "model-shard sample coverage boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_model_shard_sample_executor_preserves_full_payload_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    sampled_records = [
        {"word_addr": int(entry["word_addr"]), "word": int(entry["word"])} for entry in words[:8]
    ] + (
        [{"word_addr": int(sentinel[0]["word_addr"]), "word": int(sentinel[0]["word"])}]
        if sentinel
        else []
    )
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "sampled_word_count": len(words),
        "weight_shard_word_count": shard_word_count,
        "sampled_shard_word_count": len(contiguous_shard),
        "sentinel_word_addr": int(sentinel[0]["word_addr"]) if sentinel else -1,
        "expected_checksum": int(shard.get("expected_checksum", 0)),
        "recomputed_loader_checksum": checksum,
        "sampled_loaded_bytes": int(shard.get("expected_loaded_bytes", 0)),
        "total_loader_word_transactions": total_loader_words,
        "sample_word_coverage_fraction": len(words) / total_loader_words
        if total_loader_words
        else 0.0,
        "activation_source_layer_index": int(first_record.get("layer_index", -1)),
        "activation_value_count": len(activations),
        "executed_lane_mac_count": int(result["lane_mac_count"]),
        "sample_accumulator": int(result["accumulator"]),
        "sample_requantized_s8": int(result["requantized_s8"]),
        "sample_execution_checksum": int(result["trace_checksum"]),
        "sample_payload_sha256": canonical_sha256(words),
        "sampled_payload_records": sampled_records,
        "residual_blocker": "full_quantized_weight_payload_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-model-shard-sample-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Executes the checked quantized model-shard sample words through W4A8 "
            "vector semantics and links that payload to loader RTL/cocotb and the "
            "full scheduled-row deterministic window. This is actual shard-sample "
            "payload execution, not the full 6.5GB quantized tensor payload and not "
            "a full-output real-weight checksum."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "build/reports/e1x_model_load_stream.json",
            "build/reports/e1x_vector_kernel_window_executor.json",
            "build/reports/e1x_core_cocotb.json",
            "scripts/check_e1x_model_shard_sample_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X model-shard sample executor failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X model-shard sample executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
