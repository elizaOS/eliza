#!/usr/bin/env python3
"""Capture dry-run external AI/EDA model and corpus intake targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/external_model_corpus_intake_targets"
CLAIM_BOUNDARY = "external_model_corpus_intake_capture_only_no_import_training_or_inference"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_for_chip_design_sota.md",
    "research/alpha_chip_macro_placement/03_datasets/training_and_reference_inputs_2026-05-19.md",
    "research/alpha_chip_macro_placement/05_experiments/e1_rtl_model_eval_plan.md",
    "scripts/ai_eda/probe_external_ai_eda_sources.py",
    "scripts/ai_eda/evaluate_rtl_model.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "scripts/ai_eda/capture_circuit_foundation_model_targets.py",
    "scripts/ai_eda/capture_openroad_ml_snapshot.py",
    "build/ai_eda/external_source_probe/validation/source_probe_report.json",
    "build/ai_eda/rag_index/source_manifest.json",
    "build/ai_eda/rtl_model_eval/validation/eval_report.json",
)

OPTIONAL_COMMANDS = (
    "git",
    "python3",
    "curl",
    "huggingface-cli",
    "verilator",
    "yosys",
)

OPTIONAL_PYTHON_MODULES = (
    "datasets",
    "huggingface_hub",
    "transformers",
    "torch",
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
        "schema": "eliza.ai_eda.external_model_corpus_intake_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_EXTERNAL_MODEL_CORPUS_IMPORT",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "openrtlset",
            "mg-verilog",
            "deepcircuitx",
            "metrex",
            "circuitnet-3",
            "veriforge-deepseek-coder",
            "llm-eda-opencores",
            "hardware-verilogeval-v2-hf",
            "llm4verilog-dataset",
            "siliconmind-v1",
            "chipcraftx-rtlgen-7b",
            "chipseek",
            "rtlseek",
            "qimeng-codev-r1",
            "evolve-verilog",
            "veriagent",
            "codev-sva",
            "radai-wm811k-wafer-defect-model",
        ],
        "policy": {
            "imports_external_assets": False,
            "downloads_datasets": False,
            "downloads_model_weights": False,
            "downloads_code": False,
            "exports_local_corpus": False,
            "trains_model": False,
            "fine_tunes_model": False,
            "runs_inference": False,
            "runs_eval": False,
            "generates_rtl": False,
            "generates_assertions": False,
            "generates_layout_features": False,
            "changes_source": False,
            "prediction_generated": False,
            "model_quality_claim_allowed": False,
            "dataset_quality_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "hf-rtl-model-candidate-watch",
                "status": "CAPTURED_NOT_DOWNLOADED",
                "target": "future SiliconMind, ChipCraftX, ChipSeek, RTLSeek, CodeV-R1, EvolVE, VeriAgent, VeriForge, CodeV, or similar model tests must pin exact revisions, model-card terms, prompts, outputs, and evaluator logs",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "rtl-corpus-license-contamination-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future OpenRTLSet, MG-Verilog, DeepCircuitX, OpenCores, VerilogEval, CVDP, and LLM4Verilog corpus use must prove license compatibility, provenance, de-duplication, and contamination checks",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make docs-check",
                    "make rtl-check",
                ],
            },
            {
                "id": "metric-and-pd-corpus-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future MetRex and CircuitNet 3.0 use must stay separate from E1 claims until technology, label, split, and local error analysis are archived",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id validation",
                    "make synth",
                    "make pd-signoff-manifest-check",
                    "make physical-closure-work-order-check",
                ],
            },
            {
                "id": "external-model-promotion-review-watch",
                "status": "CAPTURED_NOT_PROMOTED",
                "target": "future external model or corpus promotion must require manual license review, exact revision lock, quarantine path, deterministic local gates, and reviewer disposition",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_circuit_foundation_model_targets.py --run-id validation",
                    "make cocotb-npu",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no approved external model or corpus license review for release use",
            "no pinned HuggingFace dataset/model revisions, file manifests, or storage quarantine policy",
            "no contamination or de-duplication report comparing external RTL corpora against E1 tasks and benchmark prompts",
            "no DeepCircuitX dataset manifest, source-repository license audit, or PPA-label transfer analysis for E1",
            "no ChipSeek or RTLSeek revision, model-weight manifest, EDA-feedback reward audit, or local benchmark non-overlap report",
            "no local evaluator allowed to download weights, import datasets, train, fine-tune, run inference, or generate source",
            "no held-out E1 task suite with lint, simulation, synthesis, formal, and reviewer disposition for external models",
            "no technology-matched label corpus proving MetRex, CircuitNet 3.0, or other public labels transfer to E1",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.external_model_corpus_intake.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
