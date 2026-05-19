#!/usr/bin/env python3
"""Capture dry-run requirements/spec-to-RTL traceability targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/spec_traceability_targets"
CLAIM_BOUNDARY = "spec_traceability_capture_only_no_rtl_assertion_or_requirement_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "docs/arch/npu-microarch.md",
    "docs/arch/soc.md",
    "docs/arch/interconnect.md",
    "docs/arch/memory-map.md",
    "docs/arch/linux-capable-cpu-contract.md",
    "docs/arch/android-contract.md",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "docs/spec-db/npu-2028-target.yaml",
    "sw/platform/e1_platform_contract.json",
    "verify/rtl_gap_work_order.yaml",
    "verify/ai_eda/assertion_candidates/e1_npu_descriptor.yaml",
    "scripts/check_platform_contract.py",
    "scripts/check_e1_npu_runtime_contract.py",
    "scripts/check_npu_2028_targets.py",
    "scripts/check_memory_interconnect_contract.py",
    "scripts/ai_eda/capture_verification_debug_targets.py",
    "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "rg",
    "jq",
    "verilator",
    "yosys",
    "sby",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "pydantic",
    "networkx",
    "tree_sitter",
    "z3",
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
        "schema": "eliza.ai_eda.spec_traceability_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_SPEC_TRACEABILITY_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "incrertl",
            "llm-fsm",
            "spec2assertion",
            "coverassert",
            "qimeng-codev-sva",
            "assertionforge",
            "sangam-sva",
            "codev-sva",
            "protocolllm",
            "vericontaminated",
        ],
        "policy": {
            "changes_requirements": False,
            "changes_specs": False,
            "changes_rtl": False,
            "changes_assertions": False,
            "changes_testbench": False,
            "exports_private_prompts": False,
            "runs_llm": False,
            "runs_model": False,
            "runs_parser": False,
            "runs_formal": False,
            "runs_simulation": False,
            "runs_synthesis": False,
            "generates_trace_matrix": False,
            "generates_rtl": False,
            "generates_sva": False,
            "generates_patch": False,
            "prediction_generated": False,
            "traceability_claim_allowed": False,
            "requirement_coverage_claim_allowed": False,
            "assertion_quality_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "e1-requirement-to-artifact-map-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future E1 requirement-to-RTL/SVA/test trace matrices must cite stable requirement IDs, source hashes, RTL ranges, verification gates, and reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make platform-contract-check",
                    "make docs-check",
                ],
            },
            {
                "id": "incremental-rtl-change-impact-watch",
                "status": "CAPTURED_NOT_REWRITTEN",
                "target": "future IncreRTL-style requirement evolution must localize affected files and keep generated patches quarantined until lint, simulation, formal, synthesis, and review pass",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                    "make rtl-check",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "nl-to-sva-pre-rtl-watch",
                "status": "CAPTURED_NOT_BOUND",
                "target": "future Spec2Assertion, CoverAssert, SANGAM, AssertionForge, or CodeV-SVA use must keep assertions as candidates until formal/simulation evidence accepts them",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_verification_debug_targets.py --run-id validation",
                    "make cocotb-contract",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "fsm-and-protocol-spec-eval-watch",
                "status": "CAPTURED_NOT_EVALUATED",
                "target": "future LLM-FSM or ProtocolLLM-style tasks must require waveform/protocol or formal checks instead of syntax-only pass rates",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
                    "make cocotb-npu",
                    "make formal",
                ],
            },
            {
                "id": "npu-runtime-spec-drift-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future AI spec triage must detect drift among docs/spec-db contracts, runtime tests, RTL descriptors, and verification work orders before proposing implementation changes",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "make npu-2028-target-check",
                    "make memory-interconnect-contract-check",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no approved stable requirement-ID scheme spanning E1 docs, spec-db, RTL modules, assertions, tests, and work orders",
            "no reviewed trace matrix generator for SystemVerilog ranges, SVA candidates, cocotb tests, formal properties, and generated software contracts",
            "no local policy for AI-generated requirement changes or spec edits",
            "no accepted NL-to-SVA or spec-to-RTL backend with license review, contamination review, prompt quarantine, and deterministic replay",
            "no equivalence or impact-analysis gate proving incremental RTL updates preserve unaffected behavior",
            "no coverage metric tying natural-language requirements to formal, cocotb, synthesis, and platform-contract evidence",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.spec_traceability.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
