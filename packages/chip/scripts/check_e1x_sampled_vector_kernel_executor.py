#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_sampled_vector_kernel_executor.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
PER_LAYER_CODEGEN = ROOT / "build/reports/e1x_per_layer_vector_codegen.json"
TENSOR_CYCLE = ROOT / "build/reports/e1x_tensor_cycle_executor.json"
PE_COCOTB_REPORT = ROOT / "build/reports/e1x_pe_core_cocotb.json"

EXPECTED_PROOF_CHECKSUM = 32_681_797
EXPECTED_CODEGEN_SHA256 = "3815c04bfb38c664d3215e0b268e6ed8d801a7a075a1dab6ab1174d4e4635956"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def execute_vector_row(activations: list[int], packed_words_hex: list[str]) -> dict[str, object]:
    acc = 0
    vector_ops = 0
    lane_macs = 0
    trace_prefix: list[dict[str, object]] = []
    for word_index, word_hex in enumerate(packed_words_hex):
        weights = unpack_signed_w4_word(int(str(word_hex), 16))
        activation_chunk = activations[word_index * 8 : word_index * 8 + 8]
        products = [
            int(activation) * int(weight)
            for activation, weight in zip(activation_chunk, weights, strict=False)
        ]
        vector_sum = sum(products)
        acc += vector_sum
        vector_ops += 1
        lane_macs += len(products)
        if len(trace_prefix) < 2:
            trace_prefix.append({
                "word_index": word_index,
                "packed_w4_word_hex": str(word_hex),
                "activation_count": len(activation_chunk),
                "lane_products": products,
                "vector_sum": vector_sum,
            })
    requantized = max(-128, min(127, acc >> 7))
    return {
        "accumulator": acc,
        "requantized_s8": requantized,
        "vector_word_ops": vector_ops,
        "lane_mac_count": lane_macs,
        "trace_prefix": trace_prefix,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PROOF, PER_LAYER_CODEGEN, TENSOR_CYCLE, PE_COCOTB_REPORT)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "sampled vector-kernel executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_sampled_vector_kernel_executor_inputs_present", "status": status, "detail": detail})

    proof = load_json(PROOF) if PROOF.is_file() else {}
    per_layer_codegen = load_json(PER_LAYER_CODEGEN) if PER_LAYER_CODEGEN.is_file() else {}
    tensor_cycle = load_json(TENSOR_CYCLE) if TENSOR_CYCLE.is_file() else {}
    pe_cocotb = load_json(PE_COCOTB_REPORT) if PE_COCOTB_REPORT.is_file() else {}

    schema_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and proof.get("aggregate_checksum") == EXPECTED_PROOF_CHECKSUM
        and per_layer_codegen.get("status") == "PASS"
        and per_layer_codegen.get("summary", {}).get("per_layer_codegen_sha256") == EXPECTED_CODEGEN_SHA256
    )
    status, detail = pass_fail(
        schema_ok,
        "microkernel proof links to the current per-layer vector-codegen artifact",
        "proof schema/checksum or per-layer vector-codegen link mismatch",
    )
    checks.append({"id": "e1x_sampled_vector_kernel_executor_artifact_links", "status": status, "detail": detail})

    deps_ok = (
        tensor_cycle.get("status") == "PASS"
        and int(tensor_cycle.get("summary", {}).get("executed_row_count", 0)) >= 1_132
        and pe_cocotb.get("status") == "PASS"
        and int(pe_cocotb.get("summary", {}).get("testcases", 0)) >= 16
    )
    status, detail = pass_fail(
        deps_ok,
        "scalar cycle executor and PE-core RTL cocotb reports are PASS",
        "sampled vector-kernel dependencies missing or failing",
    )
    checks.append({"id": "e1x_sampled_vector_kernel_executor_dependencies_pass", "status": status, "detail": detail})

    mismatches: list[str] = []
    executed_rows = 0
    vector_word_ops = 0
    lane_macs = 0
    vector_records: list[dict[str, object]] = []
    for record in proof.get("records", []):
        if not isinstance(record, dict):
            mismatches.append("malformed-record")
            continue
        activations = [int(value) for value in record.get("activation_s8", [])]
        layer_index = int(record.get("layer_index", -1))
        layer_rows = []
        for row in record.get("row_results", []):
            result = execute_vector_row(activations, list(row.get("packed_w4_words_hex", [])))
            output_row = int(row.get("output_row", -1))
            if int(result["accumulator"]) != int(row.get("accumulator", 0)):
                mismatches.append(f"acc:{layer_index}:{output_row}")
            if int(result["requantized_s8"]) != int(row.get("requantized_s8", 0)):
                mismatches.append(f"rq:{layer_index}:{output_row}")
            executed_rows += 1
            vector_word_ops += int(result["vector_word_ops"])
            lane_macs += int(result["lane_mac_count"])
            if len(layer_rows) < 2:
                layer_rows.append({
                    "output_row": output_row,
                    "accumulator": int(result["accumulator"]),
                    "requantized_s8": int(result["requantized_s8"]),
                    "vector_word_ops": int(result["vector_word_ops"]),
                    "lane_mac_count": int(result["lane_mac_count"]),
                    "trace_prefix": result["trace_prefix"],
                })
        if len(vector_records) < 8:
            vector_records.append({
                "layer_index": layer_index,
                "layer_name": str(record.get("layer_name", "")),
                "kind": str(record.get("kind", "")),
                "sample_k": int(record.get("sample_k", 0)),
                "sampled_rows": len(record.get("row_results", [])),
                "sampled_vector_rows": layer_rows,
            })

    sampled_vector_sha256 = canonical_sha256(vector_records)
    execution_ok = (
        not mismatches
        and len(proof.get("records", [])) == 283
        and executed_rows == 1_132
        and lane_macs == 26_180
        and vector_word_ops == 3_556
    )
    status, detail = pass_fail(
        execution_ok,
        f"sampled vector-kernel executor ran {vector_word_ops} packed vector-word ops across {executed_rows} rows",
        "sampled vector-kernel execution mismatch: " + ", ".join(mismatches[:8]),
    )
    checks.append({"id": "e1x_sampled_vector_kernel_executor_replays_sampled_rows", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "proof_layer_count": len(proof.get("records", [])) if isinstance(proof.get("records"), list) else 0,
        "executed_row_count": executed_rows,
        "executed_vector_word_op_count": vector_word_ops,
        "executed_lane_mac_count": lane_macs,
        "sampled_vector_trace_sha256": sampled_vector_sha256,
        "proof_aggregate_checksum": int(proof.get("aggregate_checksum", 0)),
        "per_layer_codegen_sha256": str(
            per_layer_codegen.get("summary", {}).get("per_layer_codegen_sha256", "")
        ),
        "pe_cocotb_testcases": int(pe_cocotb.get("summary", {}).get("testcases", 0)),
        "sampled_vector_records": vector_records,
        "residual_blocker": "full_output_vector_kernel_execution_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-sampled-vector-kernel-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Sampled vector-kernel executor evidence for packed int4 vector-word "
            "operations from every real-graph proof layer, linked to the per-layer "
            "vector-codegen artifact and PE-core RTL cocotb evidence. This is not "
            "full-output execution of every generated vector instruction, not full "
            "tensor-fabric execution, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "build/reports/e1x_per_layer_vector_codegen.json",
            "build/reports/e1x_tensor_cycle_executor.json",
            "build/reports/e1x_pe_core_cocotb.json",
            "scripts/check_e1x_sampled_vector_kernel_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X sampled vector-kernel executor failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X sampled vector-kernel executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
