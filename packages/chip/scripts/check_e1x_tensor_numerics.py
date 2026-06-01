#!/usr/bin/env python3
from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_tensor_numerics.json"
PROOF_PATH = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
SCHEDULE_PATH = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
PLACEMENT_PATH = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"

EXPECTED_KINDS = {
    "embedding",
    "norm",
    "attn_qkv_proj",
    "attn_out_proj",
    "mlp_gate_proj",
    "mlp_up_proj",
    "mlp_down_proj",
    "lm_head",
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_sha256_without_artifact(data: dict) -> str:
    payload = dict(data)
    payload.pop("artifact_sha256", None)
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def unpack_signed_w4_word(word: int) -> list[int]:
    values = []
    for lane in range(8):
        nibble = (word >> (lane * 4)) & 0xF
        values.append(nibble - 16 if nibble & 0x8 else nibble)
    return values


def saturating_shift7(value: int) -> int:
    return max(-128, min(127, value >> 7))


def layer_checksum(activations: list[int], accumulators: list[int]) -> int:
    checksum = 0
    for value in activations + accumulators:
        checksum = (((checksum << 5) | (checksum >> 27)) & 0xFFFF_FFFF) ^ (value & 0xFFFF_FFFF)
    return checksum & 0xFFFF_FFFF


def aggregate_checksum(records: list[dict]) -> int:
    checksum = 0
    for record in records:
        checksum = (((checksum << 7) | (checksum >> 25)) & 0xFFFF_FFFF) ^ int(record["checksum"])
    return checksum & 0xFFFF_FFFF


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def validate_microkernel_records(proof: dict) -> tuple[bool, str, dict[str, int | float]]:
    records = proof.get("records")
    if not isinstance(records, list) or not records:
        return False, "missing microkernel proof records", {}

    checked_rows = 0
    checked_macs = 0
    checked_layers = 0
    max_abs_accumulator = 0
    for record in records:
        activations = record.get("activation_s8")
        rows = record.get("row_results")
        if not isinstance(activations, list) or not isinstance(rows, list):
            return False, f"malformed record {record.get('layer_name')}", {}
        if len(activations) != int(record.get("sample_k", -1)):
            return False, f"sample_k mismatch in {record.get('layer_name')}", {}
        if len(rows) != int(record.get("sample_output_rows", -1)):
            return False, f"sample_output_rows mismatch in {record.get('layer_name')}", {}
        if any(not isinstance(value, int) or not -128 <= value <= 127 for value in activations):
            return False, f"activation outside signed int8 range in {record.get('layer_name')}", {}

        accumulators = []
        for row in rows:
            words = row.get("packed_w4_words_hex")
            if not isinstance(words, list) or not words:
                return False, f"missing packed W4 words in {record.get('layer_name')}", {}
            weights = [
                weight
                for word_hex in words
                for weight in unpack_signed_w4_word(int(str(word_hex), 16))
            ][: len(activations)]
            if len(weights) != len(activations):
                return False, f"short packed W4 row in {record.get('layer_name')}", {}
            if any(not -8 <= weight <= 7 for weight in weights):
                return False, f"weight outside signed int4 range in {record.get('layer_name')}", {}
            accumulator = sum(a * w for a, w in zip(activations, weights, strict=True))
            if accumulator != int(row.get("accumulator", 0)):
                return False, f"accumulator mismatch in {record.get('layer_name')}", {}
            if saturating_shift7(accumulator) != int(row.get("requantized_s8", 0)):
                return False, f"requantized mismatch in {record.get('layer_name')}", {}
            accumulators.append(accumulator)
            max_abs_accumulator = max(max_abs_accumulator, abs(accumulator))
            checked_rows += 1
            checked_macs += len(activations)

        if layer_checksum([int(value) for value in activations], accumulators) != int(
            record.get("checksum", -1)
        ):
            return False, f"layer checksum mismatch in {record.get('layer_name')}", {}
        checked_layers += 1

    if aggregate_checksum(records) != int(proof.get("aggregate_checksum", -1)):
        return False, "aggregate checksum mismatch", {}
    if checked_macs != int(proof.get("sample_mac_count", -1)):
        return False, "sample MAC count mismatch", {}
    return (
        True,
        f"{checked_layers} layer records and {checked_macs} sampled MACs recomputed",
        {
            "checked_layer_count": checked_layers,
            "checked_row_count": checked_rows,
            "checked_mac_count": checked_macs,
            "max_abs_accumulator": max_abs_accumulator,
        },
    )


def validate_schedule_alignment(
    proof: dict, schedule: dict, placement: dict
) -> tuple[bool, str, dict]:
    proof_records = proof.get("records")
    schedule_layers = schedule.get("layers")
    placement_layers = placement.get("layers")
    if not isinstance(proof_records, list) or not isinstance(schedule_layers, list):
        return False, "missing proof or schedule layers", {}
    if not isinstance(placement_layers, list):
        return False, "missing placement layers", {}
    if len(proof_records) != len(schedule_layers) or len(proof_records) != int(
        placement["layer_count"]
    ):
        return False, "proof, schedule, and placement layer counts differ", {}

    placement_by_index = {int(layer["index"]): layer for layer in placement_layers}
    total_rows = 0
    total_assigned_cores = 0
    max_core_shard_bytes = 0
    kind_counts: Counter[str] = Counter()
    for proof_record, schedule_record in zip(proof_records, schedule_layers, strict=True):
        layer_index = int(proof_record["layer_index"])
        placement_layer = placement_by_index.get(layer_index)
        if placement_layer is None:
            return False, f"missing placement layer {layer_index}", {}
        if layer_index != int(schedule_record["layer_index"]):
            return False, f"schedule/proof layer index mismatch at {layer_index}", {}
        for key in ("layer_name", "kind", "rows", "cols"):
            if proof_record[key] != schedule_record[key]:
                return False, f"{key} mismatch at layer {layer_index}", {}
        if str(proof_record["layer_name"]) != str(placement_layer["name"]):
            return False, f"placement name mismatch at layer {layer_index}", {}
        if int(schedule_record["row_coverage"]) != int(proof_record["rows"]):
            return False, f"row coverage mismatch at layer {layer_index}", {}
        if not bool(schedule_record.get("row_coverage_complete")):
            return False, f"incomplete row coverage at layer {layer_index}", {}
        if not bool(schedule_record.get("fits_core_sram")):
            return False, f"SRAM overflow at layer {layer_index}", {}
        total_rows += int(schedule_record["row_coverage"])
        total_assigned_cores += int(schedule_record["assigned_cores"])
        max_core_shard_bytes = max(
            max_core_shard_bytes, int(schedule_record["max_core_shard_bytes"])
        )
        kind_counts[str(proof_record["kind"])] += 1

    missing_kinds = sorted(EXPECTED_KINDS - set(kind_counts))
    if missing_kinds:
        return False, "missing layer kinds: " + ", ".join(missing_kinds), {}
    return (
        True,
        f"{len(proof_records)} proof records align with tensor schedule and placement",
        {
            "total_rows_covered": total_rows,
            "total_assigned_cores": total_assigned_cores,
            "max_core_shard_bytes": max_core_shard_bytes,
            "kind_counts": dict(sorted(kind_counts.items())),
        },
    )


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = [PROOF_PATH, SCHEDULE_PATH, PLACEMENT_PATH]
    missing_paths = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing_paths,
        "tensor numerics input artifacts present",
        "missing artifacts: " + ", ".join(missing_paths),
    )
    checks.append({"id": "e1x_tensor_numerics_inputs_present", "status": status, "detail": detail})
    proof = load_json(PROOF_PATH) if PROOF_PATH.is_file() else {}
    schedule = load_json(SCHEDULE_PATH) if SCHEDULE_PATH.is_file() else {}
    placement = load_json(PLACEMENT_PATH) if PLACEMENT_PATH.is_file() else {}

    schema_ok = (
        proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
    )
    status, detail = pass_fail(schema_ok, "proof, schedule, and placement schemas match")
    checks.append({"id": "e1x_tensor_numerics_schemas", "status": status, "detail": detail})

    hash_ok = (
        proof.get("artifact_sha256") == canonical_sha256_without_artifact(proof)
        and schedule.get("artifact_sha256") == canonical_sha256_without_artifact(schedule)
        and placement.get("artifact_sha256") == canonical_sha256_without_artifact(placement)
    )
    status, detail = pass_fail(hash_ok, "input artifact SHA fields match canonical payloads")
    checks.append({"id": "e1x_tensor_numerics_artifact_hashes", "status": status, "detail": detail})

    link_ok = (
        proof.get("source_placement_sha256") == placement.get("artifact_sha256")
        and schedule.get("source_placement_sha256") == placement.get("artifact_sha256")
        and proof.get("source_kernel_plan_sha256")
    )
    status, detail = pass_fail(link_ok, "proof and schedule link to placement/kernel artifacts")
    checks.append({"id": "e1x_tensor_numerics_artifact_links", "status": status, "detail": detail})

    numeric_ok, numeric_detail, numeric_summary = validate_microkernel_records(proof)
    checks.append(
        {
            "id": "e1x_tensor_numerics_w4a8_reference_recompute",
            "status": "pass" if numeric_ok else "fail",
            "detail": numeric_detail,
        }
    )
    align_ok, align_detail, align_summary = validate_schedule_alignment(proof, schedule, placement)
    checks.append(
        {
            "id": "e1x_tensor_numerics_schedule_alignment",
            "status": "pass" if align_ok else "fail",
            "detail": align_detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "proof_layer_count": int(proof.get("proved_layer_record_count", 0) or 0),
        "schedule_layer_count": int(schedule.get("layer_count", 0) or 0),
        "placement_layer_count": int(placement.get("layer_count", 0) or 0),
        "checked_mac_count": int(numeric_summary.get("checked_mac_count", 0)),
        "checked_row_count": int(numeric_summary.get("checked_row_count", 0)),
        "max_abs_accumulator": int(numeric_summary.get("max_abs_accumulator", 0)),
        "total_rows_covered": int(align_summary.get("total_rows_covered", 0)),
        "total_assigned_cores": int(align_summary.get("total_assigned_cores", 0)),
        "max_core_shard_bytes": int(align_summary.get("max_core_shard_bytes", 0)),
        "kind_counts": align_summary.get("kind_counts", {}),
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-tensor-numerics",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Independent sampled W4A8 tensor-numerics recompute over generated real-graph "
            "microkernel proof records and tensor schedule alignment. This is not a "
            "cycle-accurate full tensor executor or full-output numerical proof."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "scripts/check_e1x_tensor_numerics.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X tensor numerics failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X tensor numerics; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
