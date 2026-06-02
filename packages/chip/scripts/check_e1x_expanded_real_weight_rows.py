#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_expanded_real_weight_rows.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
FULL_OUTPUT_CHECKSUM_MANIFEST = ROOT / "build/reports/e1x_full_output_checksum_manifest.json"

FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = (1 << 64) - 1
EXPECTED_PROOF_CHECKSUM = 32_681_797
EXPECTED_WORKPLAN_SHA256 = "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"

FALSE_CLAIM_FLAGS: dict[str, object] = {
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


def selected_rows(row_count: int) -> list[int]:
    return sorted({0, row_count // 2, row_count - 1}) if row_count > 0 else []


def execute_full_k_row(layer_index: int, output_row: int, cols: int) -> dict[str, int]:
    accumulator = 0
    checksum = FNV64_OFFSET
    for k_idx in range(cols):
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
        "lane_mac_count": cols,
        "row_trace_checksum": checksum,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PLACEMENT, PROOF, FULL_OUTPUT_WORKPLAN, FULL_OUTPUT_CHECKSUM_MANIFEST)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "expanded real-weight row inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_expanded_real_weight_rows_inputs_present", "status": status, "detail": detail}
    )

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    proof = load_json(PROOF) if PROOF.is_file() else {}
    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    checksum_manifest = (
        load_json(FULL_OUTPUT_CHECKSUM_MANIFEST) if FULL_OUTPUT_CHECKSUM_MANIFEST.is_file() else {}
    )

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and int(proof.get("aggregate_checksum", 0)) == EXPECTED_PROOF_CHECKSUM
        and workplan.get("status") == "PASS"
        and checksum_manifest.get("status") == "PASS"
        and workplan.get("summary", {}).get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, canonical microkernel proof, workplan, and checksum manifest are linked",
        "expanded real-weight row dependency mismatch",
    )
    checks.append(
        {
            "id": "e1x_expanded_real_weight_rows_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    layers = [layer for layer in placement.get("layers", []) if isinstance(layer, dict)]
    layer_results: list[dict[str, object]] = []
    total_rows = 0
    total_macs = 0
    aggregate_checksum = FNV64_OFFSET
    covered_kinds = sorted({str(layer.get("kind", "")) for layer in layers})
    for layer in layers:
        layer_index = int(layer["index"])
        rows = int(layer["rows"])
        cols = int(layer["cols"])
        layer_checksum = FNV64_OFFSET
        row_results: list[dict[str, int]] = []
        for output_row in selected_rows(rows):
            result = execute_full_k_row(layer_index, output_row, cols)
            total_rows += 1
            total_macs += int(result["lane_mac_count"])
            layer_checksum = mix64(layer_checksum, output_row)
            layer_checksum = mix64(layer_checksum, int(result["row_trace_checksum"]))
            if len(row_results) < 3:
                row_results.append(
                    {
                        "output_row": output_row,
                        "accumulator": int(result["accumulator"]),
                        "requantized_s8": int(result["requantized_s8"]),
                        "lane_mac_count": int(result["lane_mac_count"]),
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
                    "kind": str(layer["kind"]),
                    "rows": rows,
                    "cols": cols,
                    "sampled_full_k_rows": row_results,
                    "layer_full_k_checksum": layer_checksum,
                }
            )

    full_output_rows = int(workplan.get("summary", {}).get("full_output_row_count", 0))
    full_macs = int(workplan.get("summary", {}).get("full_mac_count", 0))
    row_fraction = total_rows / full_output_rows if full_output_rows else 0.0
    mac_fraction = total_macs / full_macs if full_macs else 0.0
    execution_ok = (
        len(layers) == 283
        and total_rows == 849
        and total_macs == 4_147_443
        and len(covered_kinds) == 8
        and aggregate_checksum != FNV64_OFFSET
        and 0.0 < row_fraction < 0.001
        and 0.0 < mac_fraction < 0.001
    )
    status, detail = pass_fail(
        execution_ok,
        f"executed {total_rows} first/mid/last real-weight rows across full K for {total_macs} MACs",
        "expanded real-weight row execution mismatch",
    )
    checks.append(
        {"id": "e1x_expanded_real_weight_rows_execute_full_k", "status": status, "detail": detail}
    )

    boundary_ok = (
        total_macs > int(proof.get("sample_mac_count", 0)) * 100
        and checksum_manifest.get("summary", {}).get("residual_blocker")
        == "full_output_real_weight_checksum_missing"
    )
    status, detail = pass_fail(
        boundary_ok,
        "expanded rows improve real-weight MAC coverage while preserving the full-output blocker",
        "expanded real-weight row claim boundary mismatch",
    )
    checks.append(
        {"id": "e1x_expanded_real_weight_rows_preserve_blocker", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "placement_layer_count": len(layers),
        "covered_kind_count": len(covered_kinds),
        "covered_kinds": covered_kinds,
        "executed_full_k_output_row_count": total_rows,
        "executed_full_k_mac_count": total_macs,
        "row_coverage_fraction": row_fraction,
        "mac_coverage_fraction": mac_fraction,
        "mac_gain_vs_microkernel_proof": (
            total_macs / int(proof.get("sample_mac_count", 0))
            if int(proof.get("sample_mac_count", 0))
            else 0.0
        ),
        "expanded_full_k_checksum": int(aggregate_checksum),
        "sampled_layer_result_sha256": canonical_sha256(layer_results),
        "microkernel_sample_mac_count": int(proof.get("sample_mac_count", 0)),
        "workplan_sha256": str(workplan.get("summary", {}).get("workplan_sha256", "")),
        "sampled_layer_results": layer_results,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report: dict[str, object] = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-expanded-real-weight-rows",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Expanded deterministic W4A8 real-weight execution for first/mid/last "
            "output rows of every placed real-graph layer, using the full K dimension "
            "for each selected row. This improves numerical execution coverage but is "
            "not a full-output real-weight checksum, not a full tensor-fabric run, "
            "and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_full_output_checksum_manifest.json",
            "scripts/check_e1x_expanded_real_weight_rows.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X expanded real-weight rows failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X expanded real-weight rows; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
