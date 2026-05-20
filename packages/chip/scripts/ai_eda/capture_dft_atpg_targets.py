#!/usr/bin/env python3
"""Capture dry-run DFT, ATPG, scan, and testability AI/EDA targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/dft_atpg_targets"
CLAIM_BOUNDARY = "dft_atpg_target_capture_only_no_scan_or_pattern_generation"

INPUT_ARTIFACTS = (
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "pd/constraints/e1_soc.sdc",
    "pd/signoff/manifest.yaml",
    "docs/manufacturing/physical-closure-work-order.yaml",
    "docs/manufacturing/release-manifest.yaml",
    "docs/security/test-plan.md",
    "scripts/run_yosys.sh",
    "scripts/run_rtl_check.sh",
    "scripts/run_formal.sh",
    "scripts/check_manufacturing_artifacts.py",
)

OPTIONAL_COMMANDS = (
    "fault",
    "atalanta",
    "quaigh",
    "fan_atpg",
    "podem",
    "yosys",
    "verilator",
    "sby",
    "openroad",
)

OPTIONAL_PYTHON_MODULES = (
    "torch",
    "networkx",
    "dgl",
    "torch_geometric",
    "pyverilog",
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
        "schema": "eliza.ai_eda.dft_atpg_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_DFT_INSERTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "fault-dft",
            "openroad-dft",
            "atalanta-atpg",
            "fault-ucb-hw-testing",
            "verirag-llm4dft",
            "deeptpi",
            "deft-atpg",
            "inf-atpg",
            "lite-scan-instrumentation",
            "drl-atpg",
            "atpg-via-ai-survey",
            "atpg-toolkit",
            "fan-atpg",
            "quaigh-atpg-equivalence",
            "nn-for-atpg",
        ],
        "policy": {
            "inserts_scan": False,
            "inserts_test_points": False,
            "changes_rtl": False,
            "changes_netlist": False,
            "runs_atpg": False,
            "generates_test_patterns": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "fault_coverage_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "gate-level-netlist-dft-preflight",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "hash synthesized netlist and identify prerequisites for scan/ATPG flow",
                "acceptance_gates": [
                    "make synth",
                    "make rtl-check",
                ],
            },
            {
                "id": "scan-policy-and-test-port-contract",
                "status": "CAPTURED_NOT_AUTHORED",
                "target": "define scan enable, scan IO, reset, clock-domain, and JTAG/test-mode policy",
                "acceptance_gates": [
                    "make platform-contract-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "atpg-toolchain-backend-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "evaluate Fault/OpenROAD/Atalanta/FAN/Quaigh ATPG and DFT backends after license, netlist-format, and proprietary subtool review",
                "acceptance_gates": [
                    "make synth",
                    "make manufacturing-artifacts-check",
                ],
            },
            {
                "id": "deterministic-atpg-baseline-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future AI ATPG comparisons must first pin deterministic ATPG and fault-simulation baselines, accepted netlist subsets, stuck-at/transition fault manifests, pattern hashes, and replay logs",
                "acceptance_gates": [
                    "make synth",
                    "python3 scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation",
                ],
            },
            {
                "id": "ai-testability-ranking-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future ML ranking of hard-to-test nodes, test points, or partial ATPG seeds",
                "acceptance_gates": [
                    "make formal",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "rl-gnn-atpg-pattern-watch",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "future InF-ATPG-style FFR partitioning, QGNN/RL training, and generated test patterns require netlist, fault-list, feature, training, pattern, replay, and deterministic ATPG baseline evidence",
                "acceptance_gates": [
                    "make synth",
                    "make manufacturing-artifacts-check",
                    "python3 scripts/ai_eda/capture_dft_atpg_targets.py --run-id validation",
                ],
            },
            {
                "id": "llm-dft-repair-quarantine-watch",
                "status": "CAPTURED_NOT_REPAIRED",
                "target": "future VeriRAG/LLM4DFT-style testability repairs must remain quarantined until DFT, synthesis, formal, simulation, and signoff gates pass",
                "acceptance_gates": [
                    "make synth",
                    "make formal",
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                ],
            },
        ],
        "blocked_by": [
            "no E1 scan architecture or scan IO contract",
            "no reviewed gate-level DFT netlist flow",
            "no ATPG backend selected, pinned, or license-reviewed",
            "OpenROAD DFT, Atalanta, FAN_ATPG, Quaigh, and Fault hardware-testing backends are watchlist-only until exact revisions, formats, build logs, fault models, and replay contracts are reviewed",
            "no license-reviewed LLM4DFT/VeriDFT revision, local testability-rule oracle, or generated-repair quarantine workflow",
            "no approved InF-ATPG implementation/assets, FFR feature manifest, RL training log, generated-pattern quarantine, or deterministic replay oracle",
            "Fault may bundle proprietary/noncommercial ATPG engines that cannot be assumed release-safe",
            "no fault model, pattern format, coverage target, or tester interface contract",
            "no before/after timing, area, power, or signoff evidence for scan/test-point insertion",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.dft_atpg.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
