#!/usr/bin/env python3
"""Gate: production credit-flow-controlled E1X mesh router cocotb verification.

Runs the isolated cocotb sub-package under verify/cocotb/e1x_router_prod and
emits build/reports/e1x_credit_router_cocotb.json (schema eliza.gate_status.v1).
Fails closed: any missing/failed/errored cocotb testcase blocks the gate.
"""

from __future__ import annotations

import json
import os
import subprocess
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_credit_router_cocotb.json"
COCOTB_DIR = "verify/cocotb/e1x_router_prod"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "full_network_liveness_claim_allowed": False,
}

RUNS = {
    "credit_router": {
        "top": "e1x_credit_router_tb",
        "module": "test_e1x_credit_router",
        "result": ROOT / "verify/cocotb/results/e1x_credit_router_tb_test_e1x_credit_router.xml",
        "expected": {
            "route_table_programming_and_readback",
            "single_packet_routes_to_each_direction",
            "backpressure_stalls_input_without_dropping",
            "credit_exhaustion_and_recovery",
            "round_robin_fairness_under_contention",
            "port_disable_drops_only_disabled_traffic",
            "explicit_drop_route_is_reported",
        },
    },
    "credit_router_chain": {
        "top": "e1x_credit_router_chain_tb",
        "module": "test_e1x_credit_router_chain",
        "result": ROOT
        / "verify/cocotb/results/e1x_credit_router_chain_tb_test_e1x_credit_router_chain.xml",
        "expected": {
            "two_router_chain_burst_no_loss",
        },
    },
}


def run_cocotb(top: str, module: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = COCOTB_DIR
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
        return False, f"failures={failures} errors={errors} missing={','.join(missing)}", counts
    return True, f"{len(cases)} credit-router cocotb tests passed", counts


def main() -> int:
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid credit-router cocotb run table")
        command_ok, command_detail = run_cocotb(str(run["top"]), str(run["module"]))
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
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-credit-router-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "E1X input-buffered credit-flow-controlled mesh router cocotb verification only "
            "(routing, backpressure, round-robin arbitration, credit exhaustion/recovery, "
            "route-table programming, repair-drop, two-router lossless chain). Not full "
            "network-level deadlock proof, PD, DFT, package, or silicon evidence. Deadlock "
            "freedom relies on XY dimension-order route-table programming on the base mesh."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_credit_router.sv",
            "verify/cocotb/e1x_router_prod/e1x_credit_router_tb.sv",
            "verify/cocotb/e1x_router_prod/e1x_credit_router_chain_tb.sv",
            "verify/cocotb/e1x_router_prod/test_e1x_credit_router.py",
            "verify/cocotb/e1x_router_prod/test_e1x_credit_router_chain.py",
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
        print("BLOCKED: E1X credit-router cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X credit-router cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
