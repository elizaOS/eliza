#!/usr/bin/env python3
"""Capture dry-run circuit foundation model and embedding AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/circuit_foundation_model_targets"
CLAIM_BOUNDARY = "circuit_foundation_model_target_capture_only_no_training_embedding_or_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "scripts/ai_eda/probe_external_ai_eda_sources.py",
    "scripts/ai_eda/evaluate_rtl_model.py",
    "scripts/ai_eda/capture_openroad_ml_snapshot.py",
    "scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py",
    "scripts/ai_eda/capture_verification_debug_targets.py",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "docs/project/rtl-soc-critical-gap-audit.md",
    "build/ai_eda/rag_index/source_manifest.json",
    "build/ai_eda/external_source_probe/validation/source_probe_report.json",
    "build/ai_eda/pd_predictor_dataset/validation/snapshot_manifest.json",
)

OPTIONAL_COMMANDS = (
    "yosys",
    "openroad",
    "python3",
    "git",
)

OPTIONAL_PYTHON_MODULES = (
    "networkx",
    "pyverilog",
    "torch",
    "transformers",
    "sentence_transformers",
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
        "schema": "eliza.ai_eda.circuit_foundation_model_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_FOUNDATION_MODEL_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "circuit-foundation-model-survey",
            "chipnemo",
            "geneda",
            "nettag",
            "deepgate4",
            "chiplingo",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_constraints": False,
            "changes_training_data": False,
            "generates_embeddings": False,
            "trains_model": False,
            "finetunes_model": False,
            "runs_inference": False,
            "runs_llm": False,
            "exports_dataset": False,
            "imports_external_corpus": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "prediction_generated": False,
            "embedding_claim_allowed": False,
            "model_quality_claim_allowed": False,
            "design_decision_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "circuit-corpus-governance-watch",
                "status": "CAPTURED_NOT_EXPORTED",
                "target": "future E1 circuit corpus must define allowed RTL, netlist, log, spec, and layout sources with license and privacy review before model training",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make docs-check",
                ],
            },
            {
                "id": "multimodal-representation-watch",
                "status": "CAPTURED_NOT_EMBEDDED",
                "target": "future graph, text, RTL, netlist, and layout embeddings must remain advisory until feature hashes and deterministic downstream tasks exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_openroad_ml_snapshot.py --run-id validation",
                    "make synth",
                    "make pd-contract-check",
                ],
            },
            {
                "id": "domain-adapted-eda-llm-watch",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "future ChipNeMo or ChipLingo-style domain adaptation needs curated corpus manifests, model revisions, and held-out E1 tasks",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --dry-run --run-id validation",
                    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                ],
            },
            {
                "id": "netlist-function-reasoning-watch",
                "status": "CAPTURED_NOT_REASONED",
                "target": "future GenEDA or NetTAG-style netlist reasoning must be checked against local RTL, formal, and synthesis evidence before any design claim",
                "acceptance_gates": [
                    "make formal",
                    "make synth",
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                ],
            },
            {
                "id": "foundation-model-verification-debug-watch",
                "status": "CAPTURED_NOT_USED",
                "target": "future foundation-model use for bug triage or design assistance must cite local artifacts and stay behind verification-debug gates",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_verification_debug_targets.py --run-id validation",
                    "make cocotb-contract",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no license-reviewed E1 training corpus spanning RTL, netlists, layouts, logs, specs, and reports",
            "no approved data-governance policy for exporting chip-design artifacts to a model-training pipeline",
            "no pinned circuit foundation model code or model weights selected for local evaluation",
            "no local graph/text/layout embedding schema with deterministic downstream tasks and held-out splits",
            "no E1 netlist-function reasoning benchmark with formal, synthesis, and human-review labels",
            "no model-quality or design-decision promotion policy that can turn embeddings into release evidence",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.circuit_foundation_model.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
