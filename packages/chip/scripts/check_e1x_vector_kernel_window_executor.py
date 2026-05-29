#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_vector_kernel_window_executor.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
PER_LAYER_CODEGEN = ROOT / "build/reports/e1x_per_layer_vector_codegen.json"
SAMPLED_VECTOR = ROOT / "build/reports/e1x_sampled_vector_kernel_executor.json"

ROWS_PER_LAYER = 64
EXPECTED_CODEGEN_SHA256 = "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"
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


def deterministic_w4_word(layer_index: int, output_row: int, word_index: int) -> int:
    state = (
        (int(layer_index) + 1) * 0x9E3779B1
        ^ (int(output_row) + 1) * 0x85EBCA77
        ^ (int(word_index) + 1) * 0xC2B2AE3D
    ) & 0xFFFF_FFFF
    state ^= state >> 16
    state = (state * 0x7FEB352D) & 0xFFFF_FFFF
    state ^= state >> 15
    state = (state * 0x846CA68B) & 0xFFFF_FFFF
    state ^= state >> 16
    return state & 0xFFFF_FFFF


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def execute_window_row(layer_index: int, output_row: int, activations: list[int]) -> dict[str, int]:
    acc = 0
    vector_ops = 0
    lane_macs = 0
    for word_index in range(ceil(len(activations) / 8)):
        word = deterministic_w4_word(layer_index, output_row, word_index)
        weights = unpack_signed_w4_word(word)
        activation_chunk = activations[word_index * 8 : word_index * 8 + 8]
        acc += sum(
            int(activation) * int(weight)
            for activation, weight in zip(activation_chunk, weights, strict=False)
        )
        vector_ops += 1
        lane_macs += len(activation_chunk)
    requantized = max(-128, min(127, acc >> 7))
    return {
        "accumulator": acc,
        "requantized_s8": requantized,
        "vector_word_ops": vector_ops,
        "lane_mac_count": lane_macs,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PROOF, WORKPLAN, PER_LAYER_CODEGEN, SAMPLED_VECTOR)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "vector-kernel window executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_vector_kernel_window_executor_inputs_present", "status": status, "detail": detail})

    proof = load_json(PROOF) if PROOF.is_file() else {}
    workplan = load_json(WORKPLAN) if WORKPLAN.is_file() else {}
    per_layer_codegen = load_json(PER_LAYER_CODEGEN) if PER_LAYER_CODEGEN.is_file() else {}
    sampled_vector = load_json(SAMPLED_VECTOR) if SAMPLED_VECTOR.is_file() else {}

    deps_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and workplan.get("status") == "PASS"
        and int(workplan.get("summary", {}).get("workplan_layer_count", 0)) == 283
        and per_layer_codegen.get("status") == "PASS"
        and per_layer_codegen.get("summary", {}).get("per_layer_codegen_sha256") == EXPECTED_CODEGEN_SHA256
        and sampled_vector.get("status") == "PASS"
        and int(sampled_vector.get("summary", {}).get("executed_vector_word_op_count", 0)) == 3_556
    )
    status, detail = pass_fail(
        deps_ok,
        "proof, full-output workplan, per-layer codegen, and sampled vector executor reports are linked and PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append({"id": "e1x_vector_kernel_window_executor_dependencies_pass", "status": status, "detail": detail})

    window_records: list[dict[str, int | str]] = []
    checksum = FNV64_OFFSET
    executed_rows = 0
    vector_word_ops = 0
    lane_macs = 0
    for record in proof.get("records", []):
        if not isinstance(record, dict):
            continue
        layer_index = int(record.get("layer_index", -1))
        activations = [int(value) for value in record.get("activation_s8", [])]
        layer_rows = min(ROWS_PER_LAYER, int(record.get("rows", 0)))
        layer_acc_checksum = FNV64_OFFSET ^ layer_index
        layer_vector_ops = 0
        layer_lane_macs = 0
        for output_row in range(layer_rows):
            row = execute_window_row(layer_index, output_row, activations)
            executed_rows += 1
            vector_word_ops += int(row["vector_word_ops"])
            lane_macs += int(row["lane_mac_count"])
            layer_vector_ops += int(row["vector_word_ops"])
            layer_lane_macs += int(row["lane_mac_count"])
            checksum = mix64(checksum, layer_index)
            checksum = mix64(checksum, output_row)
            checksum = mix64(checksum, int(row["accumulator"]))
            checksum = mix64(checksum, int(row["requantized_s8"]) & 0xFF)
            layer_acc_checksum = mix64(layer_acc_checksum, int(row["accumulator"]))
        if len(window_records) < 8:
            window_records.append({
                "layer_index": layer_index,
                "layer_name": str(record.get("layer_name", "")),
                "kind": str(record.get("kind", "")),
                "window_rows": layer_rows,
                "window_vector_word_ops": layer_vector_ops,
                "window_lane_macs": layer_lane_macs,
                "window_accumulator_checksum": int(layer_acc_checksum),
            })

    window_record_sha256 = canonical_sha256(window_records)
    full_rows = int(workplan.get("summary", {}).get("full_output_row_count", 0))
    full_vector_ops = int(workplan.get("summary", {}).get("vector_word_op_count", 0))
    coverage_ok = (
        len(proof.get("records", [])) == 283
        and executed_rows == 18_112
        and vector_word_ops == 56_896
        and lane_macs == 418_880
        and full_rows == 2_608_640
        and full_vector_ops == 1_627_345_920
    )
    status, detail = pass_fail(
        coverage_ok,
        f"vector-kernel window executor ran {executed_rows} rows and {vector_word_ops} packed vector-word ops",
        "vector-kernel window coverage mismatch",
    )
    checks.append({"id": "e1x_vector_kernel_window_executor_covers_window", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_rows_per_layer": ROWS_PER_LAYER,
        "proof_layer_count": len(proof.get("records", [])) if isinstance(proof.get("records"), list) else 0,
        "executed_row_count": executed_rows,
        "executed_vector_word_op_count": vector_word_ops,
        "executed_lane_mac_count": lane_macs,
        "full_output_row_count": full_rows,
        "full_output_vector_word_op_count": full_vector_ops,
        "window_row_coverage_fraction": executed_rows / full_rows if full_rows else 0.0,
        "window_vector_word_op_coverage_fraction": vector_word_ops / full_vector_ops if full_vector_ops else 0.0,
        "window_output_checksum": int(checksum),
        "window_record_sha256": window_record_sha256,
        "sampled_vector_trace_sha256": str(
            sampled_vector.get("summary", {}).get("sampled_vector_trace_sha256", "")
        ),
        "per_layer_codegen_sha256": str(
            per_layer_codegen.get("summary", {}).get("per_layer_codegen_sha256", "")
        ),
        "sampled_window_records": window_records,
        "residual_blocker": "full_output_vector_kernel_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-vector-kernel-window-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Expanded deterministic vector-kernel window execution using proof "
            "activations and deterministic W4A8 packed weights across a fixed "
            "row window in every real-graph layer. This exercises more generated "
            "vector-kernel rows than the proof sample and links to full-output "
            "workplan/codegen accounting, but it is not full real-model weight "
            "execution, not full-output tensor-fabric execution, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_per_layer_vector_codegen.json",
            "build/reports/e1x_sampled_vector_kernel_executor.json",
            "scripts/check_e1x_vector_kernel_window_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X vector-kernel window executor failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X vector-kernel window executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
