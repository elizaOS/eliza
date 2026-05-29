#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_full_output_coverage.json"

SCHEDULE = ROOT / "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json"
PROOF = ROOT / "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json"
PLACEMENT = ROOT / "benchmarks/results/e1x-real-graph-model-load.placement.json"
TENSOR_OUTPUT = ROOT / "build/reports/e1x_tensor_output_checksum.json"
TENSOR_FABRIC = ROOT / "build/reports/e1x_tensor_fabric_executor.json"


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (SCHEDULE, PROOF, PLACEMENT, TENSOR_OUTPUT, TENSOR_FABRIC)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "full-output coverage inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_full_output_coverage_inputs_present", "status": status, "detail": detail})

    schedule = load_json(SCHEDULE) if SCHEDULE.is_file() else {}
    proof = load_json(PROOF) if PROOF.is_file() else {}
    placement = load_json(PLACEMENT) if PLACEMENT.is_file() else {}
    tensor_output = load_json(TENSOR_OUTPUT) if TENSOR_OUTPUT.is_file() else {}
    tensor_fabric = load_json(TENSOR_FABRIC) if TENSOR_FABRIC.is_file() else {}

    schema_ok = (
        schedule.get("schema") == "eliza.e1x.tensor_tile_schedule.v1"
        and proof.get("schema") == "eliza.e1x.w4a8_microkernel_proof.v1"
        and placement.get("schema") == "eliza.e1x.graph_mesh_placement.v1"
        and schedule.get("source_placement_sha256") == placement.get("artifact_sha256")
        and proof.get("source_placement_sha256") == placement.get("artifact_sha256")
    )
    status, detail = pass_fail(
        schema_ok,
        "schedule, proof, and placement artifacts are schema-valid and placement-linked",
        "schedule/proof/placement schema or hash linkage mismatch",
    )
    checks.append({"id": "e1x_full_output_coverage_artifact_links", "status": status, "detail": detail})

    output_ok = (
        tensor_output.get("status") == "PASS"
        and int(tensor_output.get("summary", {}).get("sampled_output_row_count", 0)) >= 1132
        and tensor_fabric.get("status") == "PASS"
        and int(tensor_fabric.get("summary", {}).get("merged_partial_count", 0)) >= 1132
    )
    status, detail = pass_fail(
        output_ok,
        "sampled tensor output and sampled tensor fabric executor reports are PASS",
        "sampled tensor output or fabric executor report missing/failing",
    )
    checks.append({"id": "e1x_full_output_coverage_sampled_evidence_present", "status": status, "detail": detail})

    layers = schedule.get("layers", [])
    records = proof.get("records", [])
    full_output_rows = sum(int(layer.get("rows", 0)) for layer in layers if isinstance(layer, dict))
    full_macs = sum(
        int(layer.get("rows", 0)) * int(layer.get("cols", 0))
        for layer in layers
        if isinstance(layer, dict)
    )
    sampled_output_rows = sum(
        len(record.get("row_results", [])) for record in records if isinstance(record, dict)
    )
    sampled_macs = int(proof.get("sample_mac_count", 0))
    missing_output_rows = max(0, full_output_rows - sampled_output_rows)
    missing_macs = max(0, full_macs - sampled_macs)
    output_row_coverage = sampled_output_rows / full_output_rows if full_output_rows else 0.0
    mac_coverage = sampled_macs / full_macs if full_macs else 0.0

    coverage_math_ok = (
        int(schedule.get("scheduled_layer_count", 0)) >= 283
        and len(records) >= 283
        and full_output_rows == 2_608_640
        and sampled_output_rows == int(tensor_output.get("summary", {}).get("sampled_output_row_count", -1))
        and sampled_macs == int(tensor_fabric.get("summary", {}).get("executed_mac_count", -1))
        and full_macs == 13_015_864_320
        and missing_output_rows == 2_607_508
    )
    status, detail = pass_fail(
        coverage_math_ok,
        (
            f"sampled {sampled_output_rows}/{full_output_rows} output rows and "
            f"{sampled_macs}/{full_macs} MACs"
        ),
        "full-output coverage arithmetic mismatch",
    )
    checks.append({"id": "e1x_full_output_coverage_quantifies_gap", "status": status, "detail": detail})

    gap_boundary_ok = (
        0.0 < output_row_coverage < 0.001
        and 0.0 < mac_coverage < 0.001
        and missing_output_rows > 2_600_000
        and missing_macs > 13_000_000_000
    )
    status, detail = pass_fail(
        gap_boundary_ok,
        "coverage gate preserves the full-output blocker instead of overclaiming sampled evidence",
        "coverage ratios do not preserve the full-output blocker",
    )
    checks.append({"id": "e1x_full_output_coverage_preserves_blocker", "status": status, "detail": detail})

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "scheduled_layer_count": int(schedule.get("scheduled_layer_count", 0)),
        "full_output_row_count": full_output_rows,
        "sampled_output_row_count": sampled_output_rows,
        "missing_output_row_count": missing_output_rows,
        "output_row_coverage_fraction": output_row_coverage,
        "full_mac_count": full_macs,
        "sampled_mac_count": sampled_macs,
        "missing_mac_count": missing_macs,
        "mac_coverage_fraction": mac_coverage,
        "placed_core_count": int(placement.get("cores_used", 0)),
        "model_weight_bytes": int(placement.get("total_weight_bytes", 0)),
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-full-output-coverage",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Quantified full-output coverage gap for the E1X real graph. This gate "
            "measures sampled tensor output evidence against all scheduled output "
            "rows and MACs; it deliberately preserves the full-output vectorized "
            "tensor fabric executor blocker and is not completion evidence."
        ),
        "evidence_paths": [
            "benchmarks/results/e1x-real-graph-tensor-tile-schedule.json",
            "benchmarks/results/e1x-real-graph-w4a8-microkernel-proof.json",
            "benchmarks/results/e1x-real-graph-model-load.placement.json",
            "build/reports/e1x_tensor_output_checksum.json",
            "build/reports/e1x_tensor_fabric_executor.json",
            "scripts/check_e1x_full_output_coverage.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X full-output coverage failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X full-output coverage; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
