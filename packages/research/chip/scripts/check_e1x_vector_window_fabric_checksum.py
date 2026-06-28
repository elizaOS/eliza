#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from math import ceil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_vector_window_fabric_checksum.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
VECTOR_WINDOW = ROOT / "build/reports/e1x_vector_kernel_window_executor.json"
FABRIC_REDUCTION = ROOT / "build/reports/e1x_fabric_reduction.json"
REDUCTION_MERGE = ROOT / "build/reports/e1x_reduction_merge_cocotb.json"

ROWS_PER_LAYER = 32768
INT32_MAX = 2_147_483_647
INT32_MIN = -2_147_483_648
MASK64 = (1 << 64) - 1
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
    "full_graph_checksum_claim_allowed": False,
}


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


def execute_window_row(
    layer_index: int, output_row: int, activations: list[int]
) -> tuple[int, int, int, int]:
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
    return acc, requantized, vector_ops, lane_macs


def saturate_i32(value: int) -> tuple[int, bool]:
    if value > INT32_MAX:
        return INT32_MAX, True
    if value < INT32_MIN:
        return INT32_MIN, True
    return value, False


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PROOF, SCHEDULE, VECTOR_WINDOW, FABRIC_REDUCTION, REDUCTION_MERGE)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "vector-window fabric-checksum inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_vector_window_fabric_checksum_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    proof = load_json(PROOF) if PROOF.is_file() else {}
    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    vector_window = load_json(VECTOR_WINDOW) if VECTOR_WINDOW.is_file() else {}
    fabric_reduction = load_json(FABRIC_REDUCTION) if FABRIC_REDUCTION.is_file() else {}
    reduction_merge = load_json(REDUCTION_MERGE) if REDUCTION_MERGE.is_file() else {}

    deps_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and proof.get("source_placement_sha256") == schedule.get("source_placement_sha256")
        and vector_window.get("status") == "PASS"
        and int(vector_window.get("summary", {}).get("window_rows_per_layer", 0)) == ROWS_PER_LAYER
        and fabric_reduction.get("status") == "PASS"
        and int(fabric_reduction.get("summary", {}).get("used_routing_color_count", 0)) == 24
        and reduction_merge.get("status") == "PASS"
        and int(reduction_merge.get("summary", {}).get("testcases", 0)) >= 5
    )
    status, detail = pass_fail(
        deps_ok,
        "proof, schedule, vector-window executor, fabric reduction, and RTL merge evidence are linked and PASS",
        "dependency report missing, stale, or failing",
    )
    checks.append(
        {
            "id": "e1x_vector_window_fabric_checksum_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    schedule_by_index = {
        int(layer["layer_index"]): layer
        for layer in schedule.get("layers", [])
        if isinstance(layer, dict) and "layer_index" in layer
    }
    color_checksums = {color: FNV64_OFFSET ^ color for color in range(24)}
    layer_records: list[dict[str, int | str | bool]] = []
    mismatches: list[str] = []
    routed_checksum = FNV64_OFFSET
    executed_rows = 0
    vector_word_ops = 0
    lane_macs = 0
    merge_cycles = 0
    overflow_groups = 0
    for record in proof.get("records", []):
        if not isinstance(record, dict):
            mismatches.append("malformed-proof-record")
            continue
        layer_index = int(record.get("layer_index", -1))
        schedule_layer = schedule_by_index.get(layer_index)
        if schedule_layer is None:
            mismatches.append(f"missing-schedule:{layer_index}")
            continue
        routing_color = int(schedule_layer.get("routing_color", -1))
        activations = [int(value) for value in record.get("activation_s8", [])]
        layer_rows = min(ROWS_PER_LAYER, int(record.get("rows", 0)))
        layer_sum = 0
        layer_checksum = FNV64_OFFSET ^ layer_index
        layer_vector_ops = 0
        for output_row in range(layer_rows):
            acc, requantized, row_vector_ops, row_lane_macs = execute_window_row(
                layer_index,
                output_row,
                activations,
            )
            executed_rows += 1
            vector_word_ops += row_vector_ops
            lane_macs += row_lane_macs
            layer_vector_ops += row_vector_ops
            layer_sum += acc
            value = (
                (output_row & 0xFFFF) | ((requantized & 0xFF) << 16) | ((acc & 0xFFFF_FFFF) << 24)
            )
            layer_checksum = mix64(layer_checksum, value)
            color_checksums[routing_color] = mix64(color_checksums[routing_color], value)
        saturated, overflow = saturate_i32(layer_sum)
        merge_cycles += layer_rows + 1
        overflow_groups += 1 if overflow else 0
        routed_checksum = mix64(routed_checksum, routing_color)
        routed_checksum = mix64(routed_checksum, saturated)
        routed_checksum = mix64(routed_checksum, layer_checksum)
        if len(layer_records) < 8:
            layer_records.append(
                {
                    "layer_index": layer_index,
                    "layer_name": str(record.get("layer_name", "")),
                    "routing_color": routing_color,
                    "window_rows": layer_rows,
                    "window_vector_word_ops": layer_vector_ops,
                    "merged_accumulator_sum": int(layer_sum),
                    "saturated_i32": int(saturated),
                    "overflow": bool(overflow),
                    "layer_window_checksum": int(layer_checksum),
                }
            )

    color_records = [
        {"routing_color": color, "window_color_checksum": int(color_checksums[color])}
        for color in sorted(color_checksums)
    ]
    color_record_sha256 = canonical_sha256(color_records)
    coverage_ok = (
        not mismatches
        and len(proof.get("records", [])) == 283
        and executed_rows == int(vector_window.get("summary", {}).get("executed_row_count", -1))
        and vector_word_ops
        == int(vector_window.get("summary", {}).get("executed_vector_word_op_count", -1))
        and lane_macs == int(vector_window.get("summary", {}).get("executed_lane_mac_count", -1))
        and merge_cycles == executed_rows + len(proof.get("records", []))
        and len(color_records) == 24
    )
    status, detail = pass_fail(
        coverage_ok,
        f"routed vector-window checksum covers {executed_rows} rows, {vector_word_ops} vector ops, and 24 colors",
        "vector-window routed checksum mismatch: " + ", ".join(mismatches[:8]),
    )
    checks.append(
        {
            "id": "e1x_vector_window_fabric_checksum_covers_window",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    full_rows = int(vector_window.get("summary", {}).get("full_output_row_count", 0))
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "window_rows_per_layer": ROWS_PER_LAYER,
        "proof_layer_count": len(proof.get("records", []))
        if isinstance(proof.get("records"), list)
        else 0,
        "executed_row_count": executed_rows,
        "executed_vector_word_op_count": vector_word_ops,
        "executed_lane_mac_count": lane_macs,
        "merged_group_count": len(proof.get("records", []))
        if isinstance(proof.get("records"), list)
        else 0,
        "window_merge_cycle_count": merge_cycles,
        "overflow_group_count": overflow_groups,
        "routing_color_count": len(color_records),
        "full_output_row_count": full_rows,
        "window_row_coverage_fraction": executed_rows / full_rows if full_rows else 0.0,
        "routed_window_checksum": int(routed_checksum),
        "color_record_sha256": color_record_sha256,
        "vector_window_checksum": int(
            vector_window.get("summary", {}).get("window_output_checksum", 0)
        ),
        "reduction_merge_cocotb_testcases": int(
            reduction_merge.get("summary", {}).get("testcases", 0)
        ),
        "fabric_reduction_total_reduction_wavelets": int(
            fabric_reduction.get("summary", {}).get("total_reduction_wavelets", 0)
        ),
        "sampled_layer_records": layer_records,
        "sampled_color_records": color_records[:8],
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report: dict[str, object] = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-vector-window-fabric-checksum",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Routed checksum for the deterministic vector-kernel execution window, "
            "grouped by scheduled layer and routing color and reduced with the same "
            "signed accumulation/saturation boundary covered by RTL merge evidence. "
            "This is not full-output real-weight tensor-fabric execution, not a "
            "full graph checksum, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "build/reports/e1x_vector_kernel_window_executor.json",
            "build/reports/e1x_fabric_reduction.json",
            "build/reports/e1x_reduction_merge_cocotb.json",
            "scripts/check_e1x_vector_window_fabric_checksum.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X vector-window fabric checksum failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X vector-window fabric checksum; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
