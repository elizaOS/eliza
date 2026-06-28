#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, TypedDict

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_clustered_repair_stress.json"

YIELD_REPAIR = ROOT / "build/reports/e1x_yield_repair_margin.json"
NORMAL_REPAIR = ROOT / "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json"
HIGH_REPAIR = (
    ROOT / "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json"
)

FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "wafer_sort_claim_allowed": False,
    "yield_characterization_claim_allowed": False,
}


class StressCase(TypedDict):
    name: str
    failed_rows: int
    failed_cols: int
    expect_repairable: bool


STRESS_CASES: list[StressCase] = [
    {"name": "row_stripe_16", "failed_rows": 16, "failed_cols": 0, "expect_repairable": True},
    {"name": "col_stripe_16", "failed_rows": 0, "failed_cols": 16, "expect_repairable": True},
    {"name": "cross_stripe_16x16", "failed_rows": 16, "failed_cols": 16, "expect_repairable": True},
    {
        "name": "over_budget_row_stripe_17",
        "failed_rows": 17,
        "failed_cols": 0,
        "expect_repairable": False,
    },
    {
        "name": "over_budget_cross_17x16",
        "failed_rows": 17,
        "failed_cols": 16,
        "expect_repairable": False,
    },
]


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def canonical_sha256(data: object) -> str:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode()
    return sha256(encoded).hexdigest()


def analyze_case(
    name: str,
    failed_rows: int,
    failed_cols: int,
    logical_rows: int,
    logical_cols: int,
    spare_rows: int,
    spare_cols: int,
    spare_cores: int,
    expect_repairable: bool,
) -> dict[str, Any]:
    row_remaps = failed_rows * logical_cols
    col_remaps = failed_cols * logical_rows
    overlap_remaps = failed_rows * failed_cols
    remapped_cores = row_remaps + col_remaps - overlap_remaps
    structural_repairable = failed_rows <= spare_rows and failed_cols <= spare_cols
    capacity_repairable = remapped_cores <= spare_cores
    repairable = structural_repairable and capacity_repairable
    return {
        "case": name,
        "failed_rows": failed_rows,
        "failed_cols": failed_cols,
        "row_remaps": row_remaps,
        "col_remaps": col_remaps,
        "overlap_remaps": overlap_remaps,
        "remapped_core_count": remapped_cores,
        "spare_rows_used": min(failed_rows, spare_rows),
        "spare_cols_used": min(failed_cols, spare_cols),
        "spare_cores": spare_cores,
        "spare_margin": spare_cores - remapped_cores,
        "spare_utilization": remapped_cores / spare_cores if spare_cores else 0.0,
        "structural_repairable": structural_repairable,
        "capacity_repairable": capacity_repairable,
        "repairable": repairable,
        "expect_repairable": expect_repairable,
        "expectation_met": repairable is expect_repairable,
    }


def main() -> int:
    checks: list[dict[str, str]] = []
    paths = (YIELD_REPAIR, NORMAL_REPAIR, HIGH_REPAIR)
    missing = [str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    status, detail = pass_fail(
        not missing,
        "clustered repair stress inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append(
        {"id": "e1x_clustered_repair_stress_inputs_present", "status": status, "detail": detail}
    )

    yield_report = load_json(YIELD_REPAIR) if YIELD_REPAIR.is_file() else {}
    normal = load_json(NORMAL_REPAIR) if NORMAL_REPAIR.is_file() else {}
    high = load_json(HIGH_REPAIR) if HIGH_REPAIR.is_file() else {}
    logical_rows = int(high.get("logical_rows", 0))
    logical_cols = int(high.get("logical_cols", 0))
    physical_rows = int(high.get("physical_rows", 0))
    physical_cols = int(high.get("physical_cols", 0))
    spare_rows = physical_rows - logical_rows
    spare_cols = physical_cols - logical_cols
    spare_cores = int(high.get("spare_cores", 0))
    deps_ok = (
        yield_report.get("status") == "PASS"
        and normal.get("schema") == "eliza.e1x.repair_manifest.v1"
        and high.get("schema") == "eliza.e1x.repair_manifest.v1"
        and logical_rows == 512
        and logical_cols == 342
        and spare_rows == 16
        and spare_cols == 16
        and spare_cores == 13_920
        and int(yield_report.get("summary", {}).get("high_failure_remapped_cores", 0)) == 3_510
    )
    status, detail = pass_fail(
        deps_ok,
        "clustered stress uses the generated 512x342 logical mesh and 16x16 spare envelope",
        "clustered repair stress dependency mismatch",
    )
    checks.append(
        {"id": "e1x_clustered_repair_stress_dependencies_pass", "status": status, "detail": detail}
    )

    cases = [
        analyze_case(
            logical_rows=logical_rows,
            logical_cols=logical_cols,
            spare_rows=spare_rows,
            spare_cols=spare_cols,
            spare_cores=spare_cores,
            **case,
        )
        for case in STRESS_CASES
    ]
    all_expectations_met = all(bool(case["expectation_met"]) for case in cases)
    status, detail = pass_fail(
        all_expectations_met,
        "clustered stress cases match repairability expectations",
        "clustered repair stress expectation mismatch",
    )
    checks.append(
        {"id": "e1x_clustered_repair_stress_expectations", "status": status, "detail": detail}
    )

    cross = next(case for case in cases if case["case"] == "cross_stripe_16x16")
    high_remaps = int(yield_report.get("summary", {}).get("high_failure_remapped_cores", 0))
    stress_ok = (
        bool(cross["repairable"])
        and int(cross["remapped_core_count"]) == 13_408
        and int(cross["spare_margin"]) == 512
        and float(cross["spare_utilization"]) > 0.96
        and int(cross["remapped_core_count"]) > high_remaps * 3
    )
    status, detail = pass_fail(
        stress_ok,
        "16x16 cross-stripe stress is repairable while using most spare capacity",
        "cross-stripe clustered repair stress mismatch",
    )
    checks.append(
        {
            "id": "e1x_clustered_repair_stress_cross_stripe_margin",
            "status": status,
            "detail": detail,
        }
    )

    overloads_detected = all(
        (not bool(case["repairable"])) and bool(case["expectation_met"])
        for case in cases
        if str(case["case"]).startswith("over_budget")
    )
    status, detail = pass_fail(
        overloads_detected,
        "over-budget clustered cases are detected instead of counted as repairable",
        "clustered repair overload detection mismatch",
    )
    checks.append(
        {"id": "e1x_clustered_repair_stress_overload_detected", "status": status, "detail": detail}
    )

    failures = [check for check in checks if check["status"] != "pass"]
    repairable_cases = [case for case in cases if case["repairable"]]
    overload_cases = [case for case in cases if not case["repairable"]]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "logical_rows": logical_rows,
        "logical_cols": logical_cols,
        "spare_rows": spare_rows,
        "spare_cols": spare_cols,
        "spare_cores": spare_cores,
        "case_count": len(cases),
        "repairable_case_count": len(repairable_cases),
        "overload_case_count": len(overload_cases),
        "cross_stripe_remapped_cores": int(cross["remapped_core_count"]),
        "cross_stripe_spare_margin": int(cross["spare_margin"]),
        "cross_stripe_spare_utilization": float(cross["spare_utilization"]),
        "cross_stripe_vs_high_failure_remap_ratio": int(cross["remapped_core_count"])
        / max(1, high_remaps),
        "high_failure_remapped_cores": high_remaps,
        "stress_case_sha256": canonical_sha256(cases),
        "cases": cases,
        "residual_blocker": "clustered_stress_is_architecture_model_not_foundry_yield",
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-clustered-repair-stress",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "Architecture-level clustered spare-envelope stress over the generated "
            "E1X logical mesh and spare-row/column budget. This proves deterministic "
            "repair-budget headroom for row/column stripe failures and detects "
            "over-budget cases, but is not foundry wafer-sort, silicon yield, or "
            "production binning evidence."
        ),
        "evidence_paths": [
            "build/reports/e1x_yield_repair_margin.json",
            "benchmarks/results/e1x-real-graph-model-load.normal_repair_manifest.json",
            "benchmarks/results/e1x-real-graph-model-load.high_failure_repair_manifest.json",
            "scripts/check_e1x_clustered_repair_stress.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print(
            "BLOCKED: E1X clustered repair stress failed: " + ", ".join(c["id"] for c in failures)
        )
        return 1
    print(f"PASS: E1X clustered repair stress; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
