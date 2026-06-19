#!/usr/bin/env python3
"""Fail-closed bring-up harness/plan for open ATPG on the E1 scan netlist.

Probes for an open ATPG backend (Fault / Atalanta / Quaigh), checks the
scan-ready netlist and scan-chain contract, and writes a bring-up plan into
the DFT ATPG quarantine root. Vendoring the external ATPG tool is BLOCKED;
this harness NEVER runs ATPG and NEVER asserts a coverage number. It exits
non-zero (fail-closed) whenever a prerequisite is missing, so the gate cannot
be mistaken for a passing signoff.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_yaml_object

ROOT = Path(__file__).resolve().parents[1]
QUARANTINE_ROOT = ROOT / "build/ai_eda/dft_atpg"
FAULT_MODEL_SCHEMA = ROOT / "pd/dft/fault_model.schema.yaml"
FAULT_CONFIG = ROOT / "pd/dft/fault_atpg.config.yaml"

# Candidate open ATPG/fault-sim executables. None are vendored; presence here
# is detected, never assumed.
ATPG_BACKENDS = ("fault", "atalanta", "quaigh", "fan_atpg", "podem")


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-id",
        default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
    )
    parser.add_argument("--top", default="e1_chip_top")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fault_config = load_yaml_object(FAULT_CONFIG)
    required_inputs = fault_config.get("required_inputs", {})
    scan_netlist = ROOT / str(required_inputs.get("scan_netlist", ""))
    scan_chain = ROOT / str(required_inputs.get("scan_chain_definition", ""))

    backends = {name: shutil.which(name) for name in ATPG_BACKENDS}
    available = [name for name, path in backends.items() if path]

    blockers: list[str] = []
    if not available:
        blockers.append(
            "No open ATPG backend on PATH (fault/atalanta/quaigh/fan_atpg/podem). "
            "Vendor one under external/."
        )
    if not FAULT_MODEL_SCHEMA.is_file():
        blockers.append(f"missing fault-model schema: {FAULT_MODEL_SCHEMA.relative_to(ROOT)}")
    if not scan_netlist.is_file():
        blockers.append(
            f"scan-inserted netlist missing: {required_inputs.get('scan_netlist')}. "
            f"Run `make dft-scan-insert` then Fault stitching."
        )
    if not scan_chain.is_file():
        blockers.append(
            f"scan-chain contract missing: {required_inputs.get('scan_chain_definition')}. "
            f"Run `python3 scripts/build_scan_chain_contract.py`."
        )

    plan: dict[str, Any] = {
        "schema": "eliza.dft_atpg_bringup_plan.v1",
        "run_id": args.run_id,
        "top": args.top,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "status": "BLOCKED" if blockers else "READY_INPUTS_PRESENT_TOOL_NOT_RUN",
        "claim_boundary": "atpg_bringup_plan_only_no_atpg_executed_no_coverage_claim",
        "atpg_backends": backends,
        "inputs": {
            "scan_netlist": {
                "path": required_inputs.get("scan_netlist"),
                "present": scan_netlist.is_file(),
                "sha256": sha256_file(scan_netlist),
            },
            "scan_chain_definition": {
                "path": required_inputs.get("scan_chain_definition"),
                "present": scan_chain.is_file(),
                "sha256": sha256_file(scan_chain),
            },
            "fault_model_schema": {
                "path": str(FAULT_MODEL_SCHEMA.relative_to(ROOT)),
                "present": FAULT_MODEL_SCHEMA.is_file(),
            },
        },
        "fault_models": fault_config.get("required_inputs", {}).get("fault_model"),
        "expected_outputs": fault_config.get("expected_outputs"),
        "blockers": blockers,
        "note": (
            "This harness never runs ATPG and never asserts coverage. Coverage "
            "is only valid when produced by a vendored ATPG tool's fault "
            "simulation per pd/dft/fault_model.schema.yaml."
        ),
    }

    out_dir = QUARANTINE_ROOT / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    plan_path = out_dir / "atpg_bringup_plan.json"
    plan_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")

    if blockers:
        print(f"STATUS: BLOCKED atpg_bringup {plan_path.relative_to(ROOT)}")
        for blocker in blockers:
            print(f"  - {blocker}")
        return 2
    print(f"STATUS: READY atpg_bringup {plan_path.relative_to(ROOT)} (tool not run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
