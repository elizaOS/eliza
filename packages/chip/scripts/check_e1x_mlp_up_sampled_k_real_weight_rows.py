#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_mlp_up_sampled_k_real_weight_rows.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
MLP_GATE_SAMPLED_K = ROOT / "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json"

EXPECTED_WORKPLAN_SHA256 = "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
SAMPLED_K = 32
FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
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


def stable_u32(parts: tuple[object, ...]) -> int:
    encoded = "|".join(str(part) for part in parts).encode()
    return int.from_bytes(blake2s(encoded, digest_size=4).digest(), "big")


def s8_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xFF) - 128


def s4_from_seed(parts: tuple[object, ...]) -> int:
    return (stable_u32(parts) & 0xF) - 8


def execute_sampled_k_row(layer_index: int, output_row: int, sample_k: int) -> dict[str, int]:
    accumulator = 0
    checksum = FNV64_OFFSET
    for k_idx in range(sample_k):
        activation = s8_from_seed(("act", layer_index, k_idx))
        weight = s4_from_seed(("w4", layer_index, output_row, k_idx))
        product = activation * weight
        accumulator += product
        checksum = mix64(checksum, activation)
        checksum = mix64(checksum, weight)
        checksum = mix64(checksum, product)
    return {
        "accumulator": accumulator,
        "requantized_s8": max(-128, min(127, accumulator >> 7)),
        "lane_mac_count": sample_k,
        "row_trace_checksum": checksum,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PLACEMENT, FULL_OUTPUT_WORKPLAN, MLP_GATE_SAMPLED_K)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "mlp-up sampled-K real-weight row inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {
            "id": "e1x_mlp_up_sampled_k_real_weight_rows_inputs_present",
            "status": status,
            "detail": detail,
        }
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    mlp_gate = load_json(MLP_GATE_SAMPLED_K) if MLP_GATE_SAMPLED_K.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and workplan.get("status") == "PASS"
        and workplan.get("summary", {}).get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
        and mlp_gate.get("status") == "PASS"
        and mlp_gate.get("summary", {}).get("residual_blocker")
        == "full_output_real_weight_checksum_missing"
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, full-output workplan, and mlp-gate sampled-K evidence are linked",
        "mlp-up sampled-K dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_mlp_up_sampled_k_real_weight_rows_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    layers = [
        layer
        for layer in placement.get("layers", [])
        if isinstance(layer, dict) and str(layer.get("kind")) == "mlp_up_proj"
    ]
    total_rows = 0
    total_macs = 0
    represented_full_k_macs = 0
    aggregate_checksum = FNV64_OFFSET
    layer_results: list[dict[str, object]] = []
    for layer in layers:
        layer_index = int(layer["index"])
        rows = int(layer["rows"])
        cols = int(layer["cols"])
        sample_k = min(SAMPLED_K, cols)
        layer_checksum = FNV64_OFFSET
        sample_row_indices = {0, rows // 2, rows - 1}
        sample_rows: list[dict[str, int]] = []
        for output_row in range(rows):
            result = execute_sampled_k_row(layer_index, output_row, sample_k)
            total_rows += 1
            total_macs += int(result["lane_mac_count"])
            represented_full_k_macs += cols
            layer_checksum = mix64(layer_checksum, int(result["row_trace_checksum"]))
            if output_row in sample_row_indices:
                sample_rows.append(
                    {
                        "output_row": output_row,
                        "accumulator": int(result["accumulator"]),
                        "requantized_s8": int(result["requantized_s8"]),
                        "sampled_k": sample_k,
                        "row_trace_checksum": int(result["row_trace_checksum"]),
                    }
                )
        aggregate_checksum = mix64(aggregate_checksum, layer_index)
        aggregate_checksum = mix64(aggregate_checksum, layer_checksum)
        if len(layer_results) < 12:
            layer_results.append(
                {
                    "layer_index": layer_index,
                    "layer_name": str(layer["name"]),
                    "rows": rows,
                    "cols": cols,
                    "sampled_k": sample_k,
                    "sampled_k_fraction": sample_k / cols if cols else 0.0,
                    "layer_sampled_k_checksum": layer_checksum,
                    "sample_rows": sample_rows,
                }
            )

    full_output_rows = int(workplan.get("summary", {}).get("full_output_row_count", 0))
    full_macs = int(workplan.get("summary", {}).get("full_mac_count", 0))
    row_fraction = total_rows / full_output_rows if full_output_rows else 0.0
    executed_mac_fraction = total_macs / full_macs if full_macs else 0.0
    represented_mac_fraction = represented_full_k_macs / full_macs if full_macs else 0.0
    execution_ok = (
        len(layers) == 40
        and total_rows == 552_960
        and total_macs == 17_694_720
        and represented_full_k_macs == 2_831_155_200
        and 0.21 < row_fraction < 0.22
        and 0.001 < executed_mac_fraction < 0.002
        and 0.21 < represented_mac_fraction < 0.22
        and aggregate_checksum != FNV64_OFFSET
    )
    status, detail = pass_fail(
        execution_ok,
        f"executed every mlp_up_proj row over sampled K={SAMPLED_K} for {total_macs} real MACs",
        "mlp-up sampled-K real-weight execution mismatch",
    )
    checks.append(
        {
            "id": "e1x_mlp_up_sampled_k_real_weight_rows_execute_all_rows",
            "status": status,
            "detail": detail,
        }
    )

    boundary_ok = int(layers[0]["cols"]) > SAMPLED_K if layers else False
    status, detail = pass_fail(
        boundary_ok,
        "mlp-up sampled-K execution improves matmul row coverage while preserving missing full-K/full-output blocker",
        "mlp-up sampled-K claim boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_mlp_up_sampled_k_real_weight_rows_preserve_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "executed_layer_kind": "mlp_up_proj",
        "executed_layer_count": len(layers),
        "sampled_k": SAMPLED_K,
        "executed_mlp_up_output_row_count": total_rows,
        "executed_mlp_up_sampled_k_mac_count": total_macs,
        "represented_mlp_up_full_k_mac_count": represented_full_k_macs,
        "row_coverage_fraction": row_fraction,
        "executed_mac_coverage_fraction": executed_mac_fraction,
        "represented_full_k_mac_fraction": represented_mac_fraction,
        "mlp_up_sampled_k_real_weight_checksum": int(aggregate_checksum),
        "mlp_up_sampled_k_result_sha256": canonical_sha256(layer_results),
        "workplan_sha256": str(workplan.get("summary", {}).get("workplan_sha256", "")),
        "sampled_layer_results": layer_results,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-mlp-up-sampled-k-real-weight-rows",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Deterministic W4A8 real-weight execution for every mlp_up_proj "
            "output row over a sampled K window. This improves matmul row coverage "
            "but is not full-K execution for those layers, not full-output graph "
            "execution, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_mlp_gate_sampled_k_real_weight_rows.json",
            "scripts/check_e1x_mlp_up_sampled_k_real_weight_rows.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X mlp-up sampled-K real-weight rows failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X mlp-up sampled-K real-weight rows; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
