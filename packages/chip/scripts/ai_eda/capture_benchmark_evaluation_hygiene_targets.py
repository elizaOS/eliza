#!/usr/bin/env python3
"""Capture dry-run benchmark contamination and evaluation-hygiene targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/benchmark_evaluation_hygiene_targets"
CLAIM_BOUNDARY = "benchmark_evaluation_hygiene_capture_only_no_import_or_score_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "research/alpha_chip_macro_placement/03_datasets/training_and_reference_inputs_2026-05-19.md",
    "research/alpha_chip_macro_placement/05_experiments/e1_rtl_model_eval_plan.md",
    "scripts/ai_eda/capture_external_model_corpus_intake_targets.py",
    "scripts/ai_eda/evaluate_rtl_model.py",
    "scripts/ai_eda/probe_external_ai_eda_sources.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "build/ai_eda/external_model_corpus_intake_targets/validation/targets_report.json",
    "build/ai_eda/external_source_probe/validation/source_probe_report.json",
    "build/ai_eda/rtl_model_eval/validation/eval_report.json",
    "build/ai_eda/rag_index/source_manifest.json",
)

OPTIONAL_COMMANDS = (
    "git",
    "python3",
    "rg",
    "jq",
    "verilator",
    "yosys",
)

OPTIONAL_PYTHON_MODULES = (
    "datasets",
    "huggingface_hub",
    "numpy",
    "sklearn",
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
        "schema": "eliza.ai_eda.benchmark_evaluation_hygiene_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_BENCHMARK_IMPORT_OR_EVALUATION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "vericontaminated",
            "verilog-eval",
            "rtlfixer",
            "pyhdl-eval",
            "rtllm",
            "cvdp",
            "protocolllm",
            "openrtlset",
            "mg-verilog",
            "llm-eda-opencores",
            "hardware-verilogeval-v2-hf",
            "llm4verilog-dataset",
            "qimeng-codev-r1",
            "qimeng-crux",
            "qimeng-salv",
            "evolve-verilog",
            "safetune-rtl-poisoning",
            "trojanloc",
            "harmchip",
            "llmsanitize",
            "min-k-prob-contamination",
        ],
        "policy": {
            "imports_benchmarks": False,
            "downloads_benchmarks": False,
            "downloads_datasets": False,
            "downloads_model_weights": False,
            "downloads_code": False,
            "exports_e1_tasks": False,
            "runs_model": False,
            "runs_inference": False,
            "runs_eval": False,
            "runs_contamination_detector": False,
            "generates_prompts": False,
            "generates_rtl": False,
            "changes_source": False,
            "score_claim_allowed": False,
            "contamination_claim_allowed": False,
            "model_quality_claim_allowed": False,
            "benchmark_quality_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "public-hdl-benchmark-contamination-review",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future VerilogEval, RTLLM, CVDP, ProtocolLLM, or mirrored HDL benchmark use must prove exact versions, source terms, task hashes, and training-corpus non-overlap before score claims",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "make docs-check",
                ],
            },
            {
                "id": "held-out-e1-evaluation-suite-watch",
                "status": "CAPTURED_NOT_EXPORTED",
                "target": "future E1 model-eval prompts must stay quarantined and held out from training, public issue text, generated answers, and benchmark feedback loops",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make no-hardware-action-check",
                    "make rtl-check",
                ],
            },
            {
                "id": "near-duplicate-and-license-hygiene-watch",
                "status": "CAPTURED_NOT_SCANNED",
                "target": "future external RTL corpus use must combine exact-match, normalized-token, AST-aware or parser-aware, and license/provenance review before import",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make docs-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "score-reproducibility-and-evaluator-version-watch",
                "status": "CAPTURED_NOT_SCORED",
                "target": "future benchmark scores must archive prompts, generated artifacts, simulator/synthesis versions, pass/fail logs, seeds, evaluator revisions, and reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
                    "make cocotb-npu",
                    "make formal",
                    "make synth",
                ],
            },
        ],
        "blocked_by": [
            "no approved benchmark import path with exact revisions, licenses, manifests, and quarantine directory",
            "no contamination report comparing public HDL benchmarks, external RTL corpora, model training disclosures, and held-out E1 tasks",
            "no near-duplicate scanner accepted for Verilog/SystemVerilog normalization, generated prompt variants, and source-license provenance",
            "no policy for preserving private E1 evaluation prompts outside training, public issue text, or generated feedback loops",
            "no benchmark-score protocol tying model outputs to lint, simulation, synthesis, formal, seeds, tool versions, and reviewer disposition",
            "no release gate allowing public benchmark pass rates to substitute for E1 integration evidence",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.benchmark_evaluation_hygiene.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
