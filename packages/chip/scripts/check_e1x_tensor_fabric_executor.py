#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_tensor_fabric_executor.json"

PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
TENSOR_CYCLE = ROOT / "build/reports/e1x_tensor_cycle_executor.json"
REDUCTION_MERGE = ROOT / "build/reports/e1x_reduction_merge_cocotb.json"
FABRIC_REDUCTION = ROOT / "build/reports/e1x_fabric_reduction.json"

INT32_MAX = 2_147_483_647
INT32_MIN = -2_147_483_648


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def s64(value: int) -> int:
    value &= (1 << 64) - 1
    return value - (1 << 64) if value & (1 << 63) else value


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def execute_scalar_row(activations: list[int], packed_words_hex: list[str]) -> dict[str, int]:
    weights = [
        weight
        for word_hex in packed_words_hex
        for weight in unpack_signed_w4_word(int(str(word_hex), 16))
    ][: len(activations)]
    acc = 0
    for activation, weight in zip(activations, weights, strict=True):
        acc = s64(acc + s64(int(activation) * int(weight)))
    requant = max(-128, min(127, acc >> 7))
    cycles = len(activations) * 4 + 3
    return {
        "accumulator": int(acc),
        "requantized_s8": int(requant),
        "cycles": cycles,
        "mac_count": len(activations),
    }


def saturate_i32(value: int) -> tuple[int, bool]:
    if value > INT32_MAX:
        return INT32_MAX, True
    if value < INT32_MIN:
        return INT32_MIN, True
    return value, False


def merge_group(partials: list[int]) -> dict[str, int | bool]:
    total = sum(partials)
    saturated, overflow = saturate_i32(total)
    return {
        "input_count": len(partials),
        "accumulator_sum": int(total),
        "saturated_i32": int(saturated),
        "overflow": bool(overflow),
        "merge_cycles": len(partials) + 1,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PROOF, SCHEDULE, TENSOR_CYCLE, REDUCTION_MERGE, FABRIC_REDUCTION)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "tensor fabric-executor inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_tensor_fabric_executor_inputs_present", "status": status, "detail": detail})

    proof = load_json(PROOF) if PROOF.is_file() else {}
    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    tensor_cycle = load_json(TENSOR_CYCLE) if TENSOR_CYCLE.is_file() else {}
    reduction_merge = load_json(REDUCTION_MERGE) if REDUCTION_MERGE.is_file() else {}
    fabric_reduction = load_json(FABRIC_REDUCTION) if FABRIC_REDUCTION.is_file() else {}

    schema_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and proof.get("source_placement_sha256") == schedule.get("source_placement_sha256")
    )
    status, detail = pass_fail(
        schema_ok,
        "microkernel proof and tensor schedule schemas/placement links match",
        "proof/schedule schema or placement-link mismatch",
    )
    checks.append({"id": "e1x_tensor_fabric_executor_artifact_links", "status": status, "detail": detail})

    evidence_ok = (
        tensor_cycle.get("status") == "PASS"
        and int(tensor_cycle.get("summary", {}).get("executed_row_count", 0)) >= 1132
        and reduction_merge.get("status") == "PASS"
        and int(reduction_merge.get("summary", {}).get("testcases", 0)) >= 5
        and fabric_reduction.get("status") == "PASS"
        and int(fabric_reduction.get("summary", {}).get("total_reduction_wavelets", 0)) >= 2_608_640
    )
    status, detail = pass_fail(
        evidence_ok,
        "scalar row executor, RTL merge primitive, and full fabric-reduction accounting are PASS",
        "missing PASS dependency report for scalar rows, RTL merge, or fabric reduction",
    )
    checks.append({"id": "e1x_tensor_fabric_executor_dependencies_pass", "status": status, "detail": detail})

    schedule_by_index = {
        int(layer["layer_index"]): layer
        for layer in schedule.get("layers", [])
        if isinstance(layer, dict) and "layer_index" in layer
    }
    mismatches: list[str] = []
    groups: list[dict[str, int | str | bool]] = []
    total_rows = 0
    total_macs = 0
    scalar_cycles = 0
    merge_cycles = 0
    overflow_count = 0
    for record in proof.get("records", []):
        layer_index = int(record.get("layer_index", -1))
        layer_name = str(record.get("layer_name", ""))
        schedule_layer = schedule_by_index.get(layer_index, {})
        if not schedule_layer:
            mismatches.append(f"missing-schedule:{layer_index}")
            continue
        activations = record.get("activation_s8", [])
        rows = record.get("row_results", [])
        if not isinstance(activations, list) or not isinstance(rows, list):
            mismatches.append(f"malformed:{layer_index}")
            continue
        partials: list[int] = []
        for row in rows:
            result = execute_scalar_row(activations, list(row.get("packed_w4_words_hex", [])))
            if result["accumulator"] != int(row.get("accumulator", 0)):
                mismatches.append(f"acc:{layer_index}:{row.get('output_row')}")
            if result["requantized_s8"] != int(row.get("requantized_s8", 0)):
                mismatches.append(f"rq:{layer_index}:{row.get('output_row')}")
            partials.append(int(result["accumulator"]))
            total_rows += 1
            total_macs += int(result["mac_count"])
            scalar_cycles += int(result["cycles"])
        merged = merge_group(partials)
        merge_cycles += int(merged["merge_cycles"])
        overflow_count += 1 if bool(merged["overflow"]) else 0
        if len(groups) < 8:
            groups.append({
                "layer_index": layer_index,
                "layer_name": layer_name,
                "routing_color": int(schedule_layer.get("routing_color", -1)),
                "input_count": int(merged["input_count"]),
                "accumulator_sum": int(merged["accumulator_sum"]),
                "saturated_i32": int(merged["saturated_i32"]),
                "overflow": bool(merged["overflow"]),
            })

    expected_cycles = int(tensor_cycle.get("summary", {}).get("scalar_cycle_count", -1))
    execution_ok = (
        not mismatches
        and len(proof.get("records", [])) >= 283
        and total_rows >= 1132
        and total_macs >= 26180
        and scalar_cycles == expected_cycles
        and merge_cycles == total_rows + len(proof.get("records", []))
    )
    status, detail = pass_fail(
        execution_ok,
        f"sampled tensor fabric executor merged {total_rows} scalar row partials across {len(proof.get('records', []))} groups",
        "tensor fabric executor mismatches: " + ", ".join(mismatches[:8]),
    )
    checks.append({"id": "e1x_tensor_fabric_executor_merges_sampled_rows", "status": status, "detail": detail})

    color_count = len({int(group["routing_color"]) for group in groups if int(group["routing_color"]) >= 0})
    full_color_count = int(fabric_reduction.get("summary", {}).get("used_routing_color_count", 0))
    color_ok = full_color_count == 24 and int(schedule.get("scheduled_layer_count", 0)) >= 283
    status, detail = pass_fail(
        color_ok,
        "sampled merge groups are tied to the 24-color full tensor schedule",
        f"fabric color schedule incomplete; sampled_prefix_colors={color_count}, full_colors={full_color_count}",
    )
    checks.append({"id": "e1x_tensor_fabric_executor_links_routing_colors", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "proof_layer_count": len(proof.get("records", [])) if isinstance(proof.get("records"), list) else 0,
        "merged_group_count": len(proof.get("records", [])) if isinstance(proof.get("records"), list) else 0,
        "merged_partial_count": total_rows,
        "executed_mac_count": total_macs,
        "scalar_cycle_count": scalar_cycles,
        "merge_cycle_count": merge_cycles,
        "total_sampled_fabric_executor_cycles": scalar_cycles + merge_cycles,
        "overflow_group_count": overflow_count,
        "reduction_merge_cocotb_testcases": int(reduction_merge.get("summary", {}).get("testcases", 0)),
        "fabric_reduction_total_reduction_wavelets": int(
            fabric_reduction.get("summary", {}).get("total_reduction_wavelets", 0)
        ),
        "sampled_groups": groups,
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-tensor-fabric-executor",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Sampled tensor fabric-executor evidence: scalar RV64IM W4A8 row "
            "partials from every proof layer are merged through the same one-group "
            "signed accumulation/saturation semantics covered by the RTL "
            "reduction-merge cocotb gate and tied to the 24-color fabric schedule. "
            "This is not full-output vectorized tensor execution, not full-wafer "
            "NoC execution, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "build/reports/e1x_tensor_cycle_executor.json",
            "build/reports/e1x_reduction_merge_cocotb.json",
            "build/reports/e1x_fabric_reduction.json",
            "scripts/check_e1x_tensor_fabric_executor.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X tensor fabric executor failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X tensor fabric executor; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
