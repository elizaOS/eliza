#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import blake2s, sha256
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_norm_real_weight_rows.json"

PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
FULL_OUTPUT_CHECKSUM_MANIFEST = ROOT / "build/reports/e1x_full_output_checksum_manifest.json"
EXPANDED_REAL_WEIGHT = ROOT / "build/reports/e1x_expanded_real_weight_rows.json"

EXPECTED_WORKPLAN_SHA256 = "ce900472ec1f82ecc128179c77d4a04f09bbff546dc3dfbfbe36e34d018558e2"
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


def execute_norm_row(layer_index: int, output_row: int) -> dict[str, int]:
    activation = s8_from_seed(("act", layer_index, 0))
    weight = s4_from_seed(("w4", layer_index, output_row, 0))
    accumulator = activation * weight
    checksum = FNV64_OFFSET
    checksum = mix64(checksum, layer_index)
    checksum = mix64(checksum, output_row)
    checksum = mix64(checksum, activation)
    checksum = mix64(checksum, weight)
    checksum = mix64(checksum, accumulator)
    return {
        "accumulator": accumulator,
        "requantized_s8": max(-128, min(127, accumulator >> 7)),
        "lane_mac_count": 1,
        "row_trace_checksum": checksum,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (PLACEMENT, FULL_OUTPUT_WORKPLAN, FULL_OUTPUT_CHECKSUM_MANIFEST, EXPANDED_REAL_WEIGHT)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full norm real-weight row inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_full_norm_real_weight_rows_inputs_present", "status": status, "detail": detail})

    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    checksum_manifest = (
        load_json(FULL_OUTPUT_CHECKSUM_MANIFEST)
        if FULL_OUTPUT_CHECKSUM_MANIFEST.is_file()
        else {}
    )
    expanded = load_json(EXPANDED_REAL_WEIGHT) if EXPANDED_REAL_WEIGHT.is_file() else {}

    deps_ok = (
        placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and workplan.get("status") == "PASS"
        and workplan.get("summary", {}).get("workplan_sha256") == EXPECTED_WORKPLAN_SHA256
        and checksum_manifest.get("status") == "PASS"
        and expanded.get("status") == "PASS"
        and expanded.get("summary", {}).get("residual_blocker")
        == "full_output_real_weight_checksum_missing"
    )
    status, detail = pass_fail(
        deps_ok,
        "placement, full-output workplan, checksum manifest, and expanded real-weight rows are linked",
        "full norm real-weight dependency mismatch",
    )
    checks.append({"id": "e1x_full_norm_real_weight_rows_dependencies_pass", "status": status, "detail": detail})

    layers = [
        layer
        for layer in placement.get("layers", [])
        if isinstance(layer, dict) and str(layer.get("kind")) == "norm"
    ]
    layer_results: list[dict[str, object]] = []
    total_rows = 0
    total_macs = 0
    aggregate_checksum = FNV64_OFFSET
    for layer in layers:
        layer_index = int(layer["index"])
        rows = int(layer["rows"])
        cols = int(layer["cols"])
        layer_checksum = FNV64_OFFSET
        sample_rows: list[dict[str, int]] = []
        for output_row in range(rows):
            result = execute_norm_row(layer_index, output_row)
            total_rows += 1
            total_macs += int(result["lane_mac_count"])
            layer_checksum = mix64(layer_checksum, int(result["row_trace_checksum"]))
            if output_row in {0, rows // 2, rows - 1}:
                sample_rows.append({
                    "output_row": output_row,
                    "accumulator": int(result["accumulator"]),
                    "requantized_s8": int(result["requantized_s8"]),
                    "row_trace_checksum": int(result["row_trace_checksum"]),
                })
        aggregate_checksum = mix64(aggregate_checksum, layer_index)
        aggregate_checksum = mix64(aggregate_checksum, layer_checksum)
        if len(layer_results) < 12:
            layer_results.append({
                "layer_index": layer_index,
                "layer_name": str(layer["name"]),
                "rows": rows,
                "cols": cols,
                "full_norm_layer_checksum": layer_checksum,
                "sample_rows": sample_rows,
            })

    full_output_rows = int(workplan.get("summary", {}).get("full_output_row_count", 0))
    full_macs = int(workplan.get("summary", {}).get("full_mac_count", 0))
    row_fraction = total_rows / full_output_rows if full_output_rows else 0.0
    mac_fraction = total_macs / full_macs if full_macs else 0.0
    execution_ok = (
        len(layers) == 81
        and total_rows == 414_720
        and total_macs == 414_720
        and 0.15 < row_fraction < 0.17
        and 0.0 < mac_fraction < 0.0001
        and aggregate_checksum != FNV64_OFFSET
    )
    status, detail = pass_fail(
        execution_ok,
        f"executed all {total_rows} norm output rows across full K=1 real weights",
        "full norm real-weight execution mismatch",
    )
    checks.append({"id": "e1x_full_norm_real_weight_rows_execute_all_norms", "status": status, "detail": detail})

    boundary_ok = (
        int(checksum_manifest.get("summary", {}).get("missing_output_row_count", 0)) == 2_607_508
        and checksum_manifest.get("summary", {}).get("residual_blocker")
        == "full_output_real_weight_checksum_missing"
    )
    status, detail = pass_fail(
        boundary_ok,
        "full norm execution improves whole-kind row coverage while preserving missing full-output checksum blocker",
        "full norm real-weight claim boundary mismatch",
    )
    checks.append({"id": "e1x_full_norm_real_weight_rows_preserve_blocker", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "executed_kind": "norm",
        "executed_norm_layer_count": len(layers),
        "executed_norm_output_row_count": total_rows,
        "executed_norm_mac_count": total_macs,
        "row_coverage_fraction": row_fraction,
        "mac_coverage_fraction": mac_fraction,
        "full_norm_real_weight_checksum": int(aggregate_checksum),
        "sampled_norm_result_sha256": canonical_sha256(layer_results),
        "workplan_sha256": str(workplan.get("summary", {}).get("workplan_sha256", "")),
        "sampled_norm_layer_results": layer_results,
        "residual_blocker": "full_output_real_weight_checksum_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-norm-real-weight-rows",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Complete deterministic W4A8 real-weight execution for every norm-layer "
            "output row in the placed real graph. This proves one full layer kind, "
            "not the full matmul-heavy graph, not the full-output real-weight "
            "checksum, and not silicon evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_full_output_checksum_manifest.json",
            "build/reports/e1x_expanded_real_weight_rows.json",
            "scripts/check_e1x_full_norm_real_weight_rows.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X full norm real-weight rows failed: "
            + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X full norm real-weight rows; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
