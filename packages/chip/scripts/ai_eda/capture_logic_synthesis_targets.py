#!/usr/bin/env python3
"""Capture dry-run logic synthesis, tech-mapping, and gate-level QoR targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/logic_synthesis_targets"
CLAIM_BOUNDARY = "logic_synthesis_capture_only_no_netlist_or_qor_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "Makefile",
    "scripts/run_yosys.sh",
    "scripts/yosys_e1_soc.ys",
    "scripts/yosys_formal_top.ys",
    "scripts/yosys_formal_npu.ys",
    "scripts/yosys_formal_dma.ys",
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/memory/e1_axi_lite_dram.sv",
    "rtl/memory/e1_weight_buffer_sram.sv",
    "pd/openlane/config.sky130.json",
    "docs/evidence/pd/multi-corner-sta-evidence.yaml",
    "docs/evidence/pd/dft-evidence.yaml",
    "docs/evidence/pd/commercial-eda-gate.yaml",
    "docs/evidence/scale/verification-maturity-matrix.yaml",
    "docs/evidence/scale/ram-cpu-npu-scale-feasibility-gate.yaml",
    "docs/pd/high-fanout-routing-pressure-2026-05-18.json",
    "build/reports/e1_soc_yosys.log",
    "build/netlist/e1_chip_synth.v",
    "scripts/check_pd_signoff.py",
    "scripts/check_openlane_run_preflight.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "yosys",
    "abc",
    "yosys-abc",
    "openroad",
    "verilator",
    "sby",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "networkx",
    "numpy",
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
        "schema": "eliza.ai_eda.logic_synthesis_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_LOGIC_SYNTHESIS_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "yosys",
            "abc",
            "mockturtle",
            "aigverse",
            "openabc-d",
            "openls-dgf",
            "drills",
            "lsoracle",
            "abc-rl",
            "boils",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_synthesis_script": False,
            "changes_constraints": False,
            "changes_netlist": False,
            "changes_pd_config": False,
            "runs_synthesis": False,
            "runs_abc": False,
            "runs_formal": False,
            "runs_openlane": False,
            "runs_llm_or_agent": False,
            "downloads_external_assets": False,
            "generates_abc_recipe": False,
            "generates_netlist": False,
            "generates_mapping": False,
            "prediction_generated": False,
            "area_timing_power_claim_allowed": False,
            "equivalence_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "abc-recipe-search-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future ML/RL/Bayesian ABC or Yosys recipe search must stay quarantined until baseline netlists, scripts, libraries, and constraints are hash-pinned",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make synth",
                    "make formal",
                    "make rtl-check",
                ],
            },
            {
                "id": "tech-mapping-qor-label-watch",
                "status": "CAPTURED_NOT_LABELED",
                "target": "future technology-mapping labels must include RTL, script, Liberty, SDC, generated netlist, synthesis log, STA, and OpenLane context",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_logic_synthesis_targets.py --run-id validation",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                    "make power-thermal-evidence-check",
                ],
            },
            {
                "id": "gate-level-equivalence-watch",
                "status": "CAPTURED_NOT_PROVEN",
                "target": "future gate-level optimization or recipe changes must prove functional equivalence before any QoR comparison is accepted",
                "acceptance_gates": [
                    "make formal",
                    "make cocotb-contract",
                    "make platform-contract-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "netlist-debug-and-hotspot-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future AI netlist, high-fanout, critical-path, or mapping diagnostics may triage logs but cannot edit source or constraints without reviewed diffs and deterministic gates",
                "acceptance_gates": [
                    "make docs-check",
                    "make pd-signoff-manifest-check",
                    "make openlane-run-preflight-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no accepted E1 synthesis optimization corpus with pinned RTL, scripts, Liberty, SDC, netlist, log, STA, and OpenLane artifact hashes",
            "current make synth is blocked until the local synthesis source list includes every referenced module and generated macro wrapper intentionally",
            "no local equivalence policy for accepting alternative ABC/Yosys recipes or gate-level transformations",
            "no license-reviewed external synthesis optimizer, dataset, model, or RL environment with pinned revisions and replay manifests",
            "no release gate allowing AI-generated synthesis scripts, technology mappings, netlists, constraints, or QoR claims to bypass RTL, formal, cocotb, synthesis, OpenLane, STA, power, and review gates",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.logic_synthesis.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
