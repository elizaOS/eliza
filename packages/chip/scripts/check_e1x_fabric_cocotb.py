#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_fabric_cocotb.json"
CREDIT_ROUTER_REPORT = ROOT / "build/reports/e1x_credit_router_cocotb.json"
MESH_FABRIC_REPORT = ROOT / "build/reports/e1x_mesh_fabric_cocotb.json"
RUNS = {
    "router": {
        "top": "e1x_mesh_router_tb",
        "module": "test_e1x_mesh_router",
        "result": ROOT / "verify/cocotb/results/e1x_mesh_router_tb_test_e1x_mesh_router.xml",
        "expected": {
            "color_route_forwards_payload_to_programmed_port",
            "disabled_output_link_repair_drops_and_acknowledges",
            "disabled_input_link_repair_drops_before_forwarding",
            "contention_keeps_later_input_backpressured",
            "explicit_drop_route_is_visible_under_repair",
        },
    },
    "repair_aware_router": {
        "top": "e1x_repair_aware_router_tb",
        "module": "test_e1x_repair_aware_router",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_aware_router_tb_test_e1x_repair_aware_router.xml",
        "expected": {
            "repair_route_override_steers_around_disabled_default_output",
            "repair_route_override_is_ignored_when_repair_disabled",
        },
    },
    "repair_routed_router": {
        "top": "e1x_repair_routed_router_tb",
        "module": "test_e1x_repair_routed_router",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_routed_router_tb_test_e1x_repair_routed_router.xml",
        "expected": {
            "rom_loaded_route_record_overrides_router_next_hop",
            "rom_loaded_route_record_overrides_nonzero_ingress_port",
            "packet_without_matching_rom_route_uses_base_route_table",
        },
    },
    "mesh_2x2": {
        "top": "e1x_mesh_2x2_tb",
        "module": "test_e1x_mesh_2x2",
        "result": ROOT / "verify/cocotb/results/e1x_mesh_2x2_tb_test_e1x_mesh_2x2.xml",
        "expected": {
            "two_hop_route_reaches_diagonal_tile",
            "repaired_route_uses_south_then_east_when_direct_east_path_disabled",
            "unrepaired_disabled_direct_path_reports_drop",
        },
    },
    "repair_routed_mesh_2x2": {
        "top": "e1x_repair_routed_mesh_2x2_tb",
        "module": "test_e1x_repair_routed_mesh_2x2",
        "result": ROOT
        / "verify/cocotb/results/e1x_repair_routed_mesh_2x2_tb_test_e1x_repair_routed_mesh_2x2.xml",
        "expected": {
            "rom_loaded_repair_routes_deliver_across_2x2_mesh",
            "missing_second_hop_repair_record_drops_before_destination",
        },
    },
}


def run_subgate(script: str, report_path: Path, label: str) -> tuple[bool, str, dict[str, int]]:
    proc = subprocess.run(
        [sys.executable, script],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    detail = (proc.stdout.strip() or proc.stderr.strip() or f"{label} gate produced no output")[
        -1200:
    ]
    if proc.returncode != 0:
        return False, detail, {}
    if not report_path.is_file():
        return False, f"missing {label} report {report_path.relative_to(ROOT)}", {}
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("status") != "PASS":
        return False, f"{label} report status={report.get('status')}", {}
    summary = report.get("summary")
    if not isinstance(summary, dict):
        return False, f"{label} report missing summary", {}
    counts = {
        "testcases": int(summary.get("testcases", 0)),
        "failures": int(summary.get("failures", 0)),
        "errors": int(summary.get("errors", 0)),
        "missing_expected_tests": int(summary.get("missing_expected_tests", 0)),
    }
    if counts["failures"] or counts["errors"] or counts["missing_expected_tests"]:
        return False, f"{label} summary has failures: {counts}", counts
    return True, detail, counts


def run_credit_router_gate() -> tuple[bool, str, dict[str, int]]:
    return run_subgate(
        "scripts/check_e1x_credit_router_cocotb.py", CREDIT_ROUTER_REPORT, "credit-router"
    )


def run_mesh_fabric_gate() -> tuple[bool, str, dict[str, int]]:
    return run_subgate("scripts/check_e1x_mesh_fabric_cocotb.py", MESH_FABRIC_REPORT, "mesh-fabric")


def run_cocotb(top: str, module: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x"
    env["COCOTB_TOPLEVEL"] = top
    env["COCOTB_MODULE"] = module
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:]
    return True, "cocotb command completed"


def parse_results(result_xml: Path, expected_tests: set[str]) -> tuple[bool, str, dict[str, int]]:
    if not result_xml.is_file():
        return False, f"missing cocotb result {result_xml.relative_to(ROOT)}", {}
    root = ET.fromstring(result_xml.read_text(encoding="utf-8", errors="ignore"))
    cases = list(root.iter("testcase"))
    names = {case.attrib.get("name", "") for case in cases}
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    missing = sorted(expected_tests - names)
    counts = {
        "testcases": len(cases),
        "failures": failures,
        "errors": errors,
        "missing_expected_tests": len(missing),
    }
    if failures or errors or missing:
        detail = f"failures={failures} errors={errors} missing={','.join(missing)}"
        return False, detail, counts
    return True, f"{len(cases)} E1X fabric cocotb tests passed", counts


def main() -> int:
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        command_ok, command_detail = run_cocotb(str(run["top"]), str(run["module"]))
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid E1X cocotb run table")
        results_ok, results_detail, counts = (
            parse_results(result_path, expected) if command_ok else (False, "not run", {})
        )
        for key in aggregate_counts:
            aggregate_counts[key] += int(counts.get(key, 0))
        checks.extend(
            [
                {
                    "id": f"e1x_{run_id}_cocotb_command",
                    "status": "pass" if command_ok else "fail",
                    "detail": command_detail,
                },
                {
                    "id": f"e1x_{run_id}_cocotb_results",
                    "status": "pass" if results_ok else "fail",
                    "detail": results_detail,
                },
            ]
        )
    credit_ok, credit_detail, credit_counts = run_credit_router_gate()
    for key in aggregate_counts:
        aggregate_counts[key] += int(credit_counts.get(key, 0))
    checks.append(
        {
            "id": "e1x_credit_router_cocotb_gate",
            "status": "pass" if credit_ok else "fail",
            "detail": credit_detail,
        }
    )
    mesh_ok, mesh_detail, mesh_counts = run_mesh_fabric_gate()
    for key in aggregate_counts:
        aggregate_counts[key] += int(mesh_counts.get(key, 0))
    checks.append(
        {
            "id": "e1x_mesh_fabric_cocotb_gate",
            "status": "pass" if mesh_ok else "fail",
            "detail": mesh_detail,
        }
    )
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-fabric-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "claim_boundary": (
            "E1X fabric cocotb verification: legacy combinational mesh router, repair-aware "
            "router, ROM-routed router/2x2 mesh, production input-buffered credit router "
            "with two-router lossless-chain proof, and the full RxC (default 4x4) credit-router "
            "mesh fabric top with real RV64IM PE-core nodes and multi-hop lossless delivery. Not "
            "a formal network-level deadlock proof, full RISC-V compliance, PD, DFT, package, or "
            "silicon evidence."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_mesh_router.sv",
            "rtl/e1x/e1x_credit_router.sv",
            "rtl/e1x/e1x_mesh_fabric.sv",
            "rtl/e1x/e1x_repair_aware_router.sv",
            "rtl/e1x/e1x_repair_routed_router.sv",
            "scripts/check_e1x_credit_router_cocotb.py",
            "scripts/check_e1x_mesh_fabric_cocotb.py",
            "verify/cocotb/e1x/e1x_mesh_fabric_4x4_tb.sv",
            "verify/cocotb/e1x/test_e1x_mesh_fabric_4x4.py",
            "verify/cocotb/results/e1x_mesh_fabric_4x4_tb_test_e1x_mesh_fabric_4x4.xml",
            "verify/cocotb/e1x/e1x_mesh_router_tb.sv",
            "verify/cocotb/e1x/e1x_repair_aware_router_tb.sv",
            "verify/cocotb/e1x/e1x_repair_routed_router_tb.sv",
            "verify/cocotb/e1x/e1x_repair_routed_mesh_2x2_tb.sv",
            "verify/cocotb/e1x_router_prod/e1x_credit_router_tb.sv",
            "verify/cocotb/e1x_router_prod/e1x_credit_router_chain_tb.sv",
            "verify/cocotb/e1x/test_e1x_mesh_router.py",
            "verify/cocotb/e1x/test_e1x_repair_aware_router.py",
            "verify/cocotb/e1x/test_e1x_repair_routed_router.py",
            "verify/cocotb/e1x/test_e1x_repair_routed_mesh_2x2.py",
            "verify/cocotb/e1x_router_prod/test_e1x_credit_router.py",
            "verify/cocotb/e1x_router_prod/test_e1x_credit_router_chain.py",
            "verify/cocotb/e1x/e1x_mesh_2x2_tb.sv",
            "verify/cocotb/e1x/test_e1x_mesh_2x2.py",
            "verify/cocotb/results/e1x_mesh_router_tb_test_e1x_mesh_router.xml",
            "verify/cocotb/results/e1x_repair_aware_router_tb_test_e1x_repair_aware_router.xml",
            "verify/cocotb/results/e1x_repair_routed_router_tb_test_e1x_repair_routed_router.xml",
            "verify/cocotb/results/e1x_repair_routed_mesh_2x2_tb_test_e1x_repair_routed_mesh_2x2.xml",
            "verify/cocotb/results/e1x_mesh_2x2_tb_test_e1x_mesh_2x2.xml",
            "verify/cocotb/results/e1x_credit_router_tb_test_e1x_credit_router.xml",
            "verify/cocotb/results/e1x_credit_router_chain_tb_test_e1x_credit_router_chain.xml",
        ],
        "checks": checks,
        "summary": {
            **aggregate_counts,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X fabric cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X fabric cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
