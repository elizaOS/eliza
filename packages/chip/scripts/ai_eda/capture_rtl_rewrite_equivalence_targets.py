#!/usr/bin/env python3
"""Capture dry-run RTL rewrite, PPA optimization, and equivalence targets for E1."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/rtl_rewrite_equivalence_targets"
CLAIM_BOUNDARY = "rtl_rewrite_equivalence_target_capture_only_no_rewrite_or_ppa_claim"

INPUT_ARTIFACTS = (
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "verify/formal/e1_npu_formal.sv",
    "verify/formal/e1_dma_formal.sv",
    "verify/formal/e1_soc_top_formal.sv",
    "verify/cocotb/test_e1_npu.py",
    "compiler/runtime/e1_npu_runtime.py",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "research/alpha_chip_macro_placement/05_experiments/e1_rtl_model_eval_plan.md",
    "scripts/ai_eda/evaluate_rtl_model.py",
    "scripts/ai_eda/run_rtlmul_ppa_advisory.py",
    "scripts/run_rtl_check.sh",
    "scripts/run_yosys.sh",
    "scripts/run_formal.sh",
    "scripts/yosys_e1_soc.ys",
    "scripts/yosys_formal_npu.ys",
    "scripts/yosys_formal_dma.ys",
)

OPTIONAL_COMMANDS = (
    "yosys",
    "yosys-smtbmc",
    "sby",
    "z3",
    "abc",
    "verilator",
    "iverilog",
)

OPTIONAL_PYTHON_MODULES = (
    "pyverilog",
    "networkx",
    "z3",
    "sklearn",
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
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.rtl_rewrite_equivalence_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_REWRITE_OR_PPA_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "symrtlo",
            "hyperheurist",
            "rtlrewriter-bench",
            "formalrtl",
            "cktevo",
            "rtl-timing-metamorphosis",
            "openabc-d",
            "rocketppa",
        ],
        "policy": {
            "changes_rtl": False,
            "generates_rewrite": False,
            "runs_llm": False,
            "runs_equivalence": False,
            "runs_synthesis": False,
            "runs_simulation": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "equivalence_claim_allowed": False,
            "ppa_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "rtl-rewrite-benchmark-corpus",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "hash E1 RTL modules and select only bounded candidate rewrite scopes",
                "acceptance_gates": [
                    "make rtl-check",
                    "make cocotb-npu",
                    "make synth",
                ],
            },
            {
                "id": "repo-level-rtl-evolution-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future CktEvo-style repository-level RTL evolution must preserve behavior across cross-file dependencies and keep generated edits quarantined until toolchain feedback, equivalence, simulation, synthesis, and PPA evidence pass",
                "acceptance_gates": [
                    "make rtl-check",
                    "make cocotb-contract",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "staged-rtl-ppa-search-watch",
                "status": "CAPTURED_NOT_SEARCHED",
                "target": "future HYPERHEURIST-style simulated-annealing search over LLM RTL candidates must keep candidates quarantined until compile, structural, simulation, equivalence, synthesis, and before/after PPA evidence pass",
                "acceptance_gates": [
                    "make rtl-check",
                    "make cocotb-contract",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "yosys-equivalence-harness-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future before/after miter or SAT equivalence checks for generated artifacts in build/ai_eda only",
                "acceptance_gates": [
                    "make formal",
                    "make rtl-check",
                    "make synth",
                ],
            },
            {
                "id": "ppa-before-after-evidence-contract",
                "status": "CAPTURED_NOT_MEASURED",
                "target": "future comparison of before/after synthesis, OpenLane, timing, area, and power artifacts",
                "acceptance_gates": [
                    "make synth",
                    "make openlane-run-preflight-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "timing-logic-and-clock-domain-regression",
                "status": "CAPTURED_NOT_TESTED",
                "target": "block rewrite use on timing-control, clock-domain, reset-domain, and protocol-sensitive RTL until regressions pass",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation",
                    "make cocotb-contract",
                    "make formal",
                ],
            },
        ],
        "blocked_by": [
            "no local before/after equivalence harness for AI-rewritten RTL",
            "no approved source-promotion workflow for generated RTL rewrites",
            "no held-out E1 RTL rewrite benchmark with functional and PPA labels",
            "no repository-level E1 RTL evolution task pack with cross-file dependency, oracle, and rollback manifests",
            "no deterministic synthesis/OpenLane before-after comparison corpus",
            "no policy for timing-control, clock-domain, reset-domain, or protocol-sensitive rewrites",
            "no license-reviewed SymRTLO, HYPERHEURIST, RTLRewriter, FormalRTL, or RocketPPA implementation path",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.rtl_rewrite_equivalence.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
