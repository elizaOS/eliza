#!/usr/bin/env python3
"""E1X fabric/repair formal-proof gate.

Runs the SymbiYosys tasks for the E1X mesh router and repair store/table safety
properties and emits an ``eliza.gate_status.v1`` report. Each ``.sby`` exposes a
bounded ``bmc`` task and an unbounded ``prove`` (k-induction) task; both are
checked. The gate is PASS only when every task returns ``PASS`` from sby.
"""

from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_formal.json"
OSS_CAD_BIN = ROOT / "external/oss-cad-suite/bin"
FALSE_CLAIM_FLAGS = {
    "claim_allowed": False,
    "release_claim_allowed": False,
    "production_claim_allowed": False,
    "silicon_claim_allowed": False,
    "tapeout_claim_allowed": False,
    "phone_class_claim_allowed": False,
    "full_system_formal_claim_allowed": False,
    "liveness_claim_allowed": False,
}

# (task id, .sby path relative to ROOT, sby task name, bounded?).
TASKS: tuple[tuple[str, str, str, bool], ...] = (
    ("mesh_router_bmc", "verify/formal/e1x/e1x_mesh_router.sby", "bmc", True),
    ("mesh_router_prove", "verify/formal/e1x/e1x_mesh_router.sby", "prove", False),
    ("credit_router_bmc", "verify/formal/e1x/e1x_credit_router.sby", "bmc", True),
    ("credit_router_prove", "verify/formal/e1x/e1x_credit_router.sby", "prove", False),
    ("repair_route_table_bmc", "verify/formal/e1x/e1x_repair_route_table.sby", "bmc", True),
    ("repair_route_table_prove", "verify/formal/e1x/e1x_repair_route_table.sby", "prove", False),
    ("repair_state_bmc", "verify/formal/e1x/e1x_repair_state.sby", "bmc", True),
    ("repair_state_prove", "verify/formal/e1x/e1x_repair_state.sby", "prove", False),
)


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sby_env() -> dict[str, str]:
    env = os.environ.copy()
    if OSS_CAD_BIN.is_dir():
        env["PATH"] = f"{OSS_CAD_BIN}{os.pathsep}{env.get('PATH', '')}"
    return env


def run_task(task_id: str, sby_path: str, sby_task: str) -> tuple[bool, str]:
    spec = ROOT / sby_path
    if not spec.is_file():
        return False, f"missing sby spec {sby_path}"
    workdir = spec.parent / f"{spec.stem}_{sby_task}"
    proc = subprocess.run(
        ["sby", "-f", "-d", str(workdir), str(spec), sby_task],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=sby_env(),
        check=False,
    )
    status_file = workdir / "status"
    status = status_file.read_text(encoding="utf-8").strip() if status_file.is_file() else ""
    if proc.returncode == 0 and status.startswith("PASS"):
        return True, f"{task_id}: PASS"
    detail = status or (proc.stderr.strip() or proc.stdout.strip())[-600:]
    return False, f"{task_id}: {detail}"


def main() -> int:
    if not (OSS_CAD_BIN / "sby").is_file():
        report = {
            "schema": "eliza.gate_status.v1",
            "gate": "e1x-formal",
            "status": "BLOCKED",
            "as_of": datetime.now(UTC).isoformat(),
            "generated_utc": utc_now(),
            "subsystem": "e1x",
            "false_claim_flags": FALSE_CLAIM_FLAGS,
            "claim_boundary": (
                "E1X mesh-router and repair-store formal safety properties only; "
                "not full system formal, not silicon evidence."
            ),
            "checks": [
                {
                    "id": "sby_available",
                    "status": "fail",
                    "detail": "SymbiYosys (sby) not found under external/oss-cad-suite/bin",
                }
            ],
            "summary": {"check_count": 1, "failing_check_count": 1},
        }
        REPORT.parent.mkdir(parents=True, exist_ok=True)
        REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print("BLOCKED: E1X formal gate - sby unavailable")
        return 1

    checks = []
    for task_id, sby_path, sby_task, bounded in TASKS:
        ok, detail = run_task(task_id, sby_path, sby_task)
        checks.append(
            {
                "id": f"e1x_formal_{task_id}",
                "status": "pass" if ok else "fail",
                "mode": "bmc" if bounded else "k-induction",
                "detail": detail,
            }
        )

    failures = [c for c in checks if c["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-formal",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "false_claim_flags": FALSE_CLAIM_FLAGS,
        "claim_boundary": (
            "E1X mesh-router crossbar safety (no output contention, disabled-port "
            "isolation, no spurious drop under repair-disable, repaired-drop gating) "
            "credit-router bounded FIFO/credit, grant, repair-disable, and route-table "
            "programming/readback safety, and repair route-table / repair-state "
            "bounded-storage, overflow, and lookup-determinism safety. Router proofs are "
            "unbounded (combinational or reduced sequential parameter instances, "
            "k-induction); repair-store proofs are bounded BMC depth 20 and unbounded "
            "k-induction on reduced-capacity instances (parameter-generic logic). Not "
            "full-system formal, liveness, or silicon evidence."
        ),
        "evidence_paths": [
            "rtl/e1x/e1x_mesh_router.sv",
            "rtl/e1x/e1x_repair_route_table.sv",
            "rtl/e1x/e1x_repair_state.sv",
            "rtl/e1x/e1x_repair_rom_loader.sv",
            "verify/formal/e1x/e1x_mesh_router.sby",
            "verify/formal/e1x/e1x_mesh_router_formal.sv",
            "rtl/e1x/e1x_credit_router.sv",
            "verify/formal/e1x/e1x_credit_router.sby",
            "verify/formal/e1x/e1x_credit_router_formal.sv",
            "verify/formal/e1x/e1x_repair_route_table.sby",
            "verify/formal/e1x/e1x_repair_route_table_formal.sv",
            "verify/formal/e1x/e1x_repair_state.sby",
            "verify/formal/e1x/e1x_repair_state_formal.sv",
        ],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X formal failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X formal; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
