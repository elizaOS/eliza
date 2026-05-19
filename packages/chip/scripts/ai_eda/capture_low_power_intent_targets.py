#!/usr/bin/env python3
"""Capture dry-run low-power, DVFS, clock-gating, and UPF AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/low_power_intent_targets"
CLAIM_BOUNDARY = "low_power_intent_target_capture_only_no_power_intent_or_rtl_change"

INPUT_ARTIFACTS = (
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/clock/e1_reset_sync.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/cpu/e1_cpu_subsystem_stub.sv",
    "rtl/cpu/e1_cva6_wrapper.sv",
    "pd/constraints/e1_soc.sdc",
    "pd/constraints/e1_soc_gf180.sdc",
    "pd/padframe/e1_demo_padframe.yaml",
    "docs/evidence/cpu-ap-2028-target-deltas.json",
    "docs/spec-db/npu-2028-target.yaml",
    "docs/spec-db/process-14a-effects.yaml",
    "docs/project/road-to-mediatek.md",
    "docs/project/rtl-soc-critical-gap-audit.md",
    "docs/project/phone-soc-minimum-blocks.yaml",
    "benchmarks/results/cpu-npu-2028-burst-sustained-policy.json",
    "benchmarks/results/cpu-npu-2028-burst-thermal-transient.json",
    "benchmarks/power/workload-plan.yaml",
    "benchmarks/power/scripts/check_sustained_run_evidence.py",
    "scripts/run_yosys.sh",
    "scripts/run_formal.sh",
    "scripts/run_rtl_check.sh",
    "scripts/check_cpu_npu_burst_sustained_policy.py",
    "scripts/check_cpu_npu_burst_thermal_transient.py",
)

OPTIONAL_COMMANDS = (
    "yosys",
    "openroad",
    "verilator",
    "iverilog",
    "sby",
    "opensta",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "networkx",
    "pyverilog",
    "sklearn",
    "torch",
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
        "schema": "eliza.ai_eda.low_power_intent_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_LOW_POWER_INTENT_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "ieee-1801-upf",
            "ieee-upf-open-source",
            "yosys-clockgate",
            "lighter-clock-gating",
            "codmas-rtlopt",
            "rtl-opt-benchmark",
            "prompting-for-power",
            "poet-rtl-ppa",
            "rtl-ppa-sog",
            "openroad-two-phase-clock",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_constraints": False,
            "generates_upf": False,
            "generates_power_domains": False,
            "generates_clock_gating": False,
            "generates_dvfs_policy": False,
            "generates_retention_or_isolation": False,
            "runs_clockgate": False,
            "runs_power_aware_simulation": False,
            "runs_synthesis": False,
            "runs_llm": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "power_intent_claim_allowed": False,
            "power_saving_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "power-state-intent-inventory",
                "status": "CAPTURED_NOT_AUTHORED",
                "target": "define E1 power states, supply sets, reset sequencing, always-on assumptions, and off-domain accessibility before any UPF is generated",
                "acceptance_gates": [
                    "make platform-contract-check",
                    "make pd-contract-check",
                    "make docs-check",
                ],
            },
            {
                "id": "clock-gating-candidate-watch",
                "status": "CAPTURED_NOT_TRANSFORMED",
                "target": "future Yosys, Lighter, or LLM-assisted clock-gating candidates must preserve RTL behavior and pass scan, CDC/RDC, timing, synthesis, and power evidence gates",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "low-power-rtl-benchmark-intake-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future RTL-OPT-style low-power/PPA benchmark use requires exact assets, non-overlap review, synthesis setup hashes, functional/equivalence logs, and before/after PPA evidence",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make rtl-check",
                    "make synth",
                ],
            },
            {
                "id": "dvfs-and-idle-policy-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future DVFS, idle-state, and clock-domain policies require workload-aligned power, frequency, thermal, firmware, and OS governor evidence",
                "acceptance_gates": [
                    "make cpu-npu-burst-sustained-policy",
                    "make cpu-npu-burst-thermal-transient",
                    "make software-bsp-check",
                ],
            },
            {
                "id": "upf-retention-isolation-verification-watch",
                "status": "CAPTURED_NOT_VERIFIED",
                "target": "future UPF retention, isolation, level-shifter, supply-set, and power-state artifacts require power-aware simulation or formal low-power verification evidence",
                "acceptance_gates": [
                    "make cocotb-contract",
                    "make formal",
                    "make power-thermal-evidence-check",
                ],
            },
            {
                "id": "low-power-ppa-before-after-contract",
                "status": "CAPTURED_NOT_MEASURED",
                "target": "future low-power claims need before/after RTL, synthesis, timing, power, OpenLane, scan/DFT, and equivalence evidence",
                "acceptance_gates": [
                    "make synth",
                    "make pd-signoff-manifest-check",
                    "python3 scripts/ai_eda/capture_low_power_intent_targets.py --run-id validation",
                ],
            },
        ],
        "blocked_by": [
            "no E1 power-state table, always-on partition, supply-set map, or IEEE 1801 UPF source",
            "no local power-aware simulation or formal low-power verification backend",
            "no approved clock-gating, power-gating, DVFS, retention, isolation, or level-shifter insertion workflow",
            "no approved Lighter plugin revision, library-map review, or RTL-OPT benchmark asset/non-overlap review",
            "no scan/DFT, CDC/RDC, reset, and timing policy for generated gated clocks or power domains",
            "no workload-aligned voltage, frequency, power, and thermal traces for DVFS or idle-state validation",
            "no before/after low-power PPA corpus with equivalence and signoff evidence for E1",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.low_power_intent.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
