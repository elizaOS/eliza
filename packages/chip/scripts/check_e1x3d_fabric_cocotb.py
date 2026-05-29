#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x3d_fabric_cocotb.json"
RUNS = {
    "mesh_router_3d": {
        "top": "e1x3d_mesh_router_tb",
        "module": "test_e1x3d_mesh_router",
        "result": ROOT / "verify/cocotb/results/e1x3d_mesh_router_tb_test_e1x3d_mesh_router.xml",
        "expected": {
            "planar_color_route_still_forwards",
            "local_to_up_route_forwards_to_upper_tier",
            "down_to_local_route_delivers_from_lower_tier",
            "disabled_z_link_repair_drops_and_acknowledges",
            "explicit_drop_route_is_visible_under_repair",
        },
    },
}


def run_cocotb(top: str, module: str) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x3d"
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
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1400:]
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
    return True, f"{len(cases)} E1X3D fabric cocotb tests passed", counts


def main() -> int:
    checks = []
    aggregate = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        command_ok, command_detail = run_cocotb(str(run["top"]), str(run["module"]))
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid E1X3D cocotb run table")
        results_ok, results_detail, counts = (
            parse_results(result_path, expected) if command_ok else (False, "not run", {})
        )
        for key in aggregate:
            aggregate[key] += int(counts.get(key, 0))
        checks.extend(
            [
                {
                    "id": f"e1x3d_{run_id}_cocotb_command",
                    "status": "pass" if command_ok else "fail",
                    "detail": command_detail,
                },
                {
                    "id": f"e1x3d_{run_id}_cocotb_results",
                    "status": "pass" if results_ok else "fail",
                    "detail": results_detail,
                },
            ]
        )
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x3d-fabric-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "subsystem": "e1x3d",
        "claim_boundary": (
            "E1X3D fabric cocotb verification: the verified PORTS-parametric e1x_mesh_router "
            "instantiated as a 7-port 3D router, proving inter-tier UP/DOWN forwarding and "
            "Z-link repair-drop. Not full wafer-scale 3D fabric, formal deadlock proof, full "
            "RISC-V core, PD, 3D DRC/LVS, package, or silicon evidence."
        ),
        "evidence_paths": [
            "rtl/e1x3d/e1x3d_pkg.sv",
            "rtl/e1x3d/e1x3d_tile.sv",
            "rtl/e1x/e1x_mesh_router.sv",
            "verify/cocotb/e1x3d/e1x3d_mesh_router_tb.sv",
            "verify/cocotb/e1x3d/test_e1x3d_mesh_router.py",
            "verify/cocotb/results/e1x3d_mesh_router_tb_test_e1x3d_mesh_router.xml",
        ],
        "checks": checks,
        "summary": {**aggregate, "check_count": len(checks), "failing_check_count": len(failures)},
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X3D fabric cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X3D fabric cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
