#!/usr/bin/env python3
"""Capture dry-run CDC/RDC and reset-domain AI/EDA targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cdc_rdc_targets"
CLAIM_BOUNDARY = "cdc_rdc_target_capture_only_no_constraint_waiver_or_signoff_claim"

INPUT_ARTIFACTS = (
    "rtl/clock/e1_reset_sync.sv",
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/debug/e1_dbg_mmio_bridge.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/interrupts/e1_interrupt_controller.sv",
    "pd/constraints/e1_soc.sdc",
    "verify/cocotb/test_reset_domain_cleanup.py",
    "verify/cocotb/Makefile",
    "verify/formal/e1_soc_top_formal.sv",
    "docs/project/rtl-soc-critical-gap-audit.md",
    "verify/rtl_gap_work_order.yaml",
    "scripts/run_rtl_check.sh",
    "scripts/run_formal.sh",
)

OPTIONAL_COMMANDS = (
    "verilator",
    "yosys",
    "sby",
    "iverilog",
    "openroad",
)

OPTIONAL_PYTHON_MODULES = (
    "networkx",
    "pyverilog",
    "hdlparse",
    "yaml",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "path": path_text,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def command_entry(name: str) -> dict[str, str | None]:
    resolved = shutil.which(name)
    return {
        "command": name,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


def module_entry(name: str) -> dict[str, str]:
    return {
        "module": name,
        "status": "PRESENT" if importlib.util.find_spec(name) else "MISSING",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.cdc_rdc_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_CDC_RDC_SIGNOFF_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "accellera-cdc-rdc-standard",
            "formal-cdc-msi",
            "questa-cdc-rdc-assist",
            "opencdc",
            "mcp4eda",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_constraints": False,
            "generates_cdc_constraints": False,
            "generates_rdc_constraints": False,
            "creates_waivers": False,
            "runs_cdc_tool": False,
            "runs_rdc_tool": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "cdc_signoff_claim_allowed": False,
            "rdc_signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "clock-reset-domain-inventory",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "hash local clock/reset synchronizer, top-level reset wiring, and SDC inputs",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make platform-contract-check",
                ],
            },
            {
                "id": "reset-domain-regression-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "exercise reset-domain cocotb scaffolds before accepting any RDC finding",
                "acceptance_gates": [
                    "make cocotb-contract",
                    "make cocotb",
                ],
            },
            {
                "id": "cdc-rdc-intent-standard-watch",
                "status": "CAPTURED_NOT_AUTHORED",
                "target": "future vendor-neutral CDC/RDC intent manifest aligned to Accellera abstraction",
                "acceptance_gates": [
                    "make docs-check",
                    "make pd-contract-check",
                ],
            },
            {
                "id": "ml-assisted-cdc-rdc-triage-watch",
                "status": "CAPTURED_NOT_CLASSIFIED",
                "target": "future advisory ranking of CDC/RDC findings after deterministic reports exist",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no local CDC/RDC structural analysis report",
            "no explicit E1 clock-domain and reset-domain intent manifest",
            "no approved waiver or constraint-generation workflow",
            "no local CDC/RDC labeled finding corpus for ML-assisted triage",
            "no deterministic before/after regression gate for CDC/RDC fixes",
            "commercial ML CDC/RDC assist behavior cannot be reproduced in this repo",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cdc_rdc.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
