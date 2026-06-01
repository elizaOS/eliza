#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_mesh_liveness_evidence.json"

MESH_REPORT = ROOT / "build/reports/e1x_mesh_fabric_cocotb.json"
CREDIT_REPORT = ROOT / "build/reports/e1x_credit_router_cocotb.json"
FORMAL_REPORT = ROOT / "build/reports/e1x_formal.json"
MESH_RTL = ROOT / "rtl/e1x/e1x_mesh_fabric.sv"
CREDIT_RTL = ROOT / "rtl/e1x/e1x_credit_router.sv"
MESH_COCOTB = ROOT / "verify/cocotb/e1x/test_e1x_mesh_fabric_4x4.py"
CREDIT_FORMAL = ROOT / "verify/formal/e1x/e1x_credit_router_formal.sv"

EXPECTED_MESH_TESTS = (
    "real_pe_core_emits_wavelet_routed_across_mesh",
    "multi_hop_corner_to_corner_lossless",
    "multi_hop_row_then_column_path",
    "two_independent_colors_share_mesh",
)
MESH_ROUTE_MARKERS = (
    "e1x_credit_router",
    "e1x_pe_core",
    "out_credit",
    "in_ready",
    "strict XY",
    "dimension-order",
    "deadlock-free",
    "fail closed",
)
CREDIT_ROUTE_MARKERS = (
    "never silently drops wavelets under congestion",
    "Wavelets are NEVER dropped because of",
    "no virtual channels",
    "strict XY dimension-order routing",
    "channel-dependency graph",
    "routing-induced cycle",
)
FORMAL_SAFETY_MARKERS = (
    "fifo_cnt",
    "credit_q",
    "out_slot_free",
    "head_route_ok",
    "prog_dir_o",
    "repaired_drop_o",
)
REQUIRED_FORMAL_CHECKS = (
    "e1x_formal_credit_router_bmc",
    "e1x_formal_credit_router_prove",
)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pass_fail(condition: bool, detail: str, fail_detail: str | None = None) -> tuple[str, str]:
    return ("pass", detail) if condition else ("fail", fail_detail or detail)


def marker_check(
    check_id: str, text: str, markers: tuple[str, ...], detail: str
) -> tuple[dict[str, str], int]:
    normalized_text = " ".join(text.split())
    missing = [marker for marker in markers if " ".join(marker.split()) not in normalized_text]
    status, resolved_detail = pass_fail(
        not missing,
        detail,
        "missing markers: " + ", ".join(missing),
    )
    return {"id": check_id, "status": status, "detail": resolved_detail}, len(markers) - len(
        missing
    )


def main() -> int:
    input_paths = (
        MESH_REPORT,
        CREDIT_REPORT,
        FORMAL_REPORT,
        MESH_RTL,
        CREDIT_RTL,
        MESH_COCOTB,
        CREDIT_FORMAL,
    )
    missing = [str(path.relative_to(ROOT)) for path in input_paths if not path.is_file()]
    checks: list[dict[str, str]] = []
    status, detail = pass_fail(
        not missing,
        "mesh liveness-evidence inputs present",
        "missing inputs: " + ", ".join(missing),
    )
    checks.append({"id": "e1x_mesh_liveness_inputs_present", "status": status, "detail": detail})

    mesh_report = load_json(MESH_REPORT) if MESH_REPORT.is_file() else {}
    credit_report = load_json(CREDIT_REPORT) if CREDIT_REPORT.is_file() else {}
    formal_report = load_json(FORMAL_REPORT) if FORMAL_REPORT.is_file() else {}
    mesh_summary = mesh_report.get("summary", {})
    credit_summary = credit_report.get("summary", {})
    formal_summary = formal_report.get("summary", {})

    report_requirements = (
        (
            "e1x_mesh_liveness_mesh_fabric_report_pass",
            mesh_report.get("status") == "PASS"
            and int(mesh_summary.get("testcases", 0)) >= 4
            and int(mesh_summary.get("missing_expected_tests", 1)) == 0
            and int(mesh_summary.get("failing_check_count", 1)) == 0,
            "mesh-fabric cocotb report covers expected 4x4 multi-hop tests",
        ),
        (
            "e1x_mesh_liveness_credit_router_report_pass",
            credit_report.get("status") == "PASS"
            and int(credit_summary.get("testcases", 0)) >= 8
            and int(credit_summary.get("missing_expected_tests", 1)) == 0
            and int(credit_summary.get("failing_check_count", 1)) == 0,
            "credit-router cocotb report covers routing, backpressure, repair-drop, and chain tests",
        ),
        (
            "e1x_mesh_liveness_formal_report_pass",
            formal_report.get("status") == "PASS"
            and int(formal_summary.get("check_count", 0)) >= 8
            and int(formal_summary.get("failing_check_count", 1)) == 0,
            "formal report passes local router and repair safety checks",
        ),
    )
    for check_id, condition, check_detail in report_requirements:
        status, detail = pass_fail(condition, check_detail)
        checks.append({"id": check_id, "status": status, "detail": detail})

    formal_ids = {str(check.get("id")) for check in formal_report.get("checks", [])}
    missing_formal = [check_id for check_id in REQUIRED_FORMAL_CHECKS if check_id not in formal_ids]
    status, detail = pass_fail(
        not missing_formal,
        "formal report includes credit-router BMC and induction checks",
        "missing formal checks: " + ", ".join(missing_formal),
    )
    checks.append(
        {
            "id": "e1x_mesh_liveness_credit_router_formal_checks_present",
            "status": status,
            "detail": detail,
        }
    )

    mesh_text = MESH_RTL.read_text(encoding="utf-8") if MESH_RTL.is_file() else ""
    credit_text = CREDIT_RTL.read_text(encoding="utf-8") if CREDIT_RTL.is_file() else ""
    cocotb_text = MESH_COCOTB.read_text(encoding="utf-8") if MESH_COCOTB.is_file() else ""
    formal_text = CREDIT_FORMAL.read_text(encoding="utf-8") if CREDIT_FORMAL.is_file() else ""

    check, mesh_marker_count = marker_check(
        "e1x_mesh_liveness_mesh_rtl_route_discipline_markers",
        mesh_text,
        MESH_ROUTE_MARKERS,
        "mesh RTL documents credit-returned links, PE integration, XY routing, and fail-closed boundary behavior",
    )
    checks.append(check)
    check, credit_marker_count = marker_check(
        "e1x_mesh_liveness_credit_router_route_discipline_markers",
        credit_text,
        CREDIT_ROUTE_MARKERS,
        "credit-router RTL documents congestion behavior and XY route-discipline boundary",
    )
    checks.append(check)
    check, formal_marker_count = marker_check(
        "e1x_mesh_liveness_credit_router_formal_safety_markers",
        formal_text,
        FORMAL_SAFETY_MARKERS,
        "credit-router formal harness checks FIFO, credit, grant, route-table, and repair-drop safety",
    )
    checks.append(check)

    missing_tests = [name for name in EXPECTED_MESH_TESTS if f"async def {name}" not in cocotb_text]
    status, detail = pass_fail(
        not missing_tests and "xy_path_nodes" in cocotb_text and "xy_out_dir" in cocotb_text,
        "mesh cocotb contains expected PE, corner-to-corner, X-then-Y, and independent-color tests",
        "missing mesh tests/helpers: " + ", ".join(missing_tests),
    )
    checks.append(
        {"id": "e1x_mesh_liveness_expected_mesh_tests_present", "status": status, "detail": detail}
    )

    residual_blocker = "full_formal_network_liveness_proof_missing"
    failures = [check for check in checks if check["status"] != "pass"]
    summary = {
        "check_count": len(checks),
        "failing_check_count": len(failures),
        "mesh_fabric_testcases": int(mesh_summary.get("testcases", 0)),
        "credit_router_testcases": int(credit_summary.get("testcases", 0)),
        "formal_check_count": int(formal_summary.get("check_count", 0)),
        "expected_mesh_test_count": len(EXPECTED_MESH_TESTS),
        "mesh_route_marker_count": mesh_marker_count,
        "credit_route_marker_count": credit_marker_count,
        "formal_safety_marker_count": formal_marker_count,
        "residual_blocker": residual_blocker,
    }
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-mesh-liveness-evidence",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X mesh route-discipline and liveness evidence aggregation: validates "
            "strict XY route-discipline documentation, production mesh/credit-router "
            "cocotb coverage, and local credit-router formal safety coverage. This is "
            "not a full network-level formal liveness/deadlock proof for every "
            "full-wafer route-table state."
        ),
        "evidence_paths": [
            "build/reports/e1x_mesh_fabric_cocotb.json",
            "build/reports/e1x_credit_router_cocotb.json",
            "build/reports/e1x_formal.json",
            "rtl/e1x/e1x_mesh_fabric.sv",
            "rtl/e1x/e1x_credit_router.sv",
            "verify/cocotb/e1x/test_e1x_mesh_fabric_4x4.py",
            "verify/formal/e1x/e1x_credit_router_formal.sv",
            "scripts/check_e1x_mesh_liveness_evidence.py",
        ],
        "checks": checks,
        "summary": summary,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X mesh liveness evidence failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X mesh liveness evidence; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
