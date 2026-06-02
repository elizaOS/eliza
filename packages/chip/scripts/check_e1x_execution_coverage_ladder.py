#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_execution_coverage_ladder.json"

FULL_OUTPUT_COVERAGE = ROOT / "build/reports/e1x_full_output_coverage.json"
FULL_OUTPUT_WORKPLAN = ROOT / "build/reports/e1x_full_output_workplan.json"
TENSOR_OUTPUT = ROOT / "build/reports/e1x_tensor_output_checksum.json"
VECTOR_WINDOW_FABRIC = ROOT / "build/reports/e1x_vector_window_fabric_checksum.json"

EXPECTED_SAMPLED_OUTPUT_CHECKSUM = 14_414_877_542_268_347_137

FALSE_CLAIM_FLAGS = {
    "release_claim_allowed": False,
    "silicon_claim_allowed": False,
    "production_accelerator_claim_allowed": False,
    "full_output_execution_claim_allowed": False,
    "real_model_full_output_claim_allowed": False,
    "performance_claim_allowed": False,
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (FULL_OUTPUT_COVERAGE, FULL_OUTPUT_WORKPLAN, TENSOR_OUTPUT, VECTOR_WINDOW_FABRIC)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "execution coverage-ladder inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_execution_coverage_ladder_inputs_present", "status": status, "detail": detail}
    )

    full_coverage = load_json(FULL_OUTPUT_COVERAGE) if FULL_OUTPUT_COVERAGE.is_file() else {}
    workplan = load_json(FULL_OUTPUT_WORKPLAN) if FULL_OUTPUT_WORKPLAN.is_file() else {}
    tensor_output = load_json(TENSOR_OUTPUT) if TENSOR_OUTPUT.is_file() else {}
    vector_window = load_json(VECTOR_WINDOW_FABRIC) if VECTOR_WINDOW_FABRIC.is_file() else {}

    deps_ok = (
        full_coverage.get("status") == "PASS"
        and workplan.get("status") == "PASS"
        and tensor_output.get("status") == "PASS"
        and vector_window.get("status") == "PASS"
    )
    status, detail = pass_fail(
        deps_ok,
        "full-output coverage, workplan, sampled output checksum, and vector-window fabric checksum reports are PASS",
        "coverage-ladder dependency report missing or failing",
    )
    checks.append(
        {
            "id": "e1x_execution_coverage_ladder_dependencies_pass",
            "status": status,
            "detail": detail,
        }
    )

    full_summary = full_coverage.get("summary", {})
    workplan_summary = workplan.get("summary", {})
    output_summary = tensor_output.get("summary", {})
    window_summary = vector_window.get("summary", {})

    full_rows = int(workplan_summary.get("full_output_row_count", 0))
    full_macs = int(workplan_summary.get("full_mac_count", 0))
    real_sampled_rows = int(full_summary.get("sampled_output_row_count", 0))
    real_sampled_macs = int(full_summary.get("sampled_mac_count", 0))
    window_rows = int(window_summary.get("executed_row_count", 0))
    window_lane_macs = int(window_summary.get("executed_lane_mac_count", 0))
    real_missing_rows = max(0, full_rows - real_sampled_rows)
    window_remaining_rows = max(0, full_rows - window_rows)
    real_fraction = real_sampled_rows / full_rows if full_rows else 0.0
    window_fraction = window_rows / full_rows if full_rows else 0.0
    row_coverage_gain = window_rows / real_sampled_rows if real_sampled_rows else 0.0
    lane_mac_gain = window_lane_macs / real_sampled_macs if real_sampled_macs else 0.0

    coverage_ok = (
        full_rows == 2_608_640
        and full_macs == 13_015_864_320
        and real_sampled_rows == 1_132
        and real_sampled_macs == 26_180
        and window_rows == int(window_summary.get("executed_row_count", -1))
        and window_lane_macs == int(window_summary.get("executed_lane_mac_count", -1))
        and real_missing_rows == 2_607_508
        and window_remaining_rows == full_rows - window_rows
        and row_coverage_gain >= 64.0
        and lane_mac_gain >= 64.0
    )
    status, detail = pass_fail(
        coverage_ok,
        f"coverage ladder separates {real_sampled_rows} real sampled rows from {window_rows} deterministic vector-window rows",
        "coverage-ladder arithmetic mismatch",
    )
    checks.append(
        {"id": "e1x_execution_coverage_ladder_arithmetic", "status": status, "detail": detail}
    )

    checksum_ok = (
        int(output_summary.get("sampled_output_checksum", 0)) == EXPECTED_SAMPLED_OUTPUT_CHECKSUM
        and int(window_summary.get("routed_window_checksum", 0)) != 0
        and int(window_summary.get("routing_color_count", 0)) == 24
        and int(window_summary.get("merged_group_count", 0)) == 283
    )
    status, detail = pass_fail(
        checksum_ok,
        "coverage ladder records both real sampled-output checksum and routed deterministic window checksum",
        "coverage-ladder checksum linkage mismatch",
    )
    checks.append(
        {"id": "e1x_execution_coverage_ladder_checksums", "status": status, "detail": detail}
    )

    blocker_ok = (
        0.0 < real_fraction < 0.001
        and window_fraction == 1.0
        and window_remaining_rows == 0
        and full_summary.get("residual_blocker")
        == "full_output_vectorized_tensor_fabric_executor_missing"
        and window_summary.get("residual_blocker")
        == "full_output_vectorized_tensor_fabric_executor_missing"
    )
    status, detail = pass_fail(
        blocker_ok,
        "coverage ladder improves execution coverage while preserving the full-output blocker",
        "coverage-ladder blocker boundary mismatch",
    )
    checks.append(
        {
            "id": "e1x_execution_coverage_ladder_preserves_blocker",
            "status": status,
            "detail": detail,
        }
    )

    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "full_output_row_count": full_rows,
        "full_mac_count": full_macs,
        "real_sampled_output_row_count": real_sampled_rows,
        "real_sampled_mac_count": real_sampled_macs,
        "real_sampled_row_coverage_fraction": real_fraction,
        "real_missing_output_row_count": real_missing_rows,
        "deterministic_window_row_count": window_rows,
        "deterministic_window_lane_mac_count": window_lane_macs,
        "deterministic_window_row_coverage_fraction": window_fraction,
        "deterministic_window_remaining_row_count": window_remaining_rows,
        "row_coverage_gain_vs_real_sample": row_coverage_gain,
        "lane_mac_gain_vs_real_sample": lane_mac_gain,
        "sampled_output_checksum": int(output_summary.get("sampled_output_checksum", 0)),
        "routed_window_checksum": int(window_summary.get("routed_window_checksum", 0)),
        "routing_color_count": int(window_summary.get("routing_color_count", 0)),
        "merged_group_count": int(window_summary.get("merged_group_count", 0)),
        "residual_blocker": "full_output_vectorized_tensor_fabric_executor_missing",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-execution-coverage-ladder",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "Execution coverage ladder separating real sampled model-output evidence "
            "from deterministic vector-window fabric execution evidence. This report "
            "shows progress toward full-output execution without counting synthetic "
            "window rows as real-model output rows and without claiming silicon evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_full_output_coverage.json",
            "build/reports/e1x_full_output_workplan.json",
            "build/reports/e1x_tensor_output_checksum.json",
            "build/reports/e1x_vector_window_fabric_checksum.json",
            "scripts/check_e1x_execution_coverage_ladder.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    report.update(FALSE_CLAIM_FLAGS)
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X execution coverage ladder failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X execution coverage ladder; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
