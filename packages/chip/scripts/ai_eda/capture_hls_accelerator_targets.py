#!/usr/bin/env python3
"""Capture dry-run HLS/accelerator automation targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/hls_accelerator_targets"
CLAIM_BOUNDARY = "hls_target_capture_only_no_generated_hls_or_rtl"

INPUT_ARTIFACTS = (
    "compiler/runtime/e1_npu_lowering.py",
    "compiler/runtime/test_e1_npu_runtime.py",
    "compiler/runtime/test_e1_npu_runtime_sim.py",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "docs/arch/npu.md",
)

OPTIONAL_COMMANDS = (
    "vitis_hls",
    "vivado_hls",
    "bambu",
    "xlscc",
    "dslx",
)

OPTIONAL_PYTHON_MODULES = (
    "hlsfactory",
    "hls_eval",
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "path": path_text,
        "status": "PRESENT" if path.is_file() else "MISSING",
        "sha256": sha256_file(path) if path.is_file() else None,
    }


def command_entry(name: str) -> dict[str, Any]:
    resolved = shutil.which(name)
    return {
        "command": name,
        "status": "PRESENT" if resolved else "MISSING",
        "path": resolved,
    }


def module_entry(name: str) -> dict[str, Any]:
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
        "schema": "eliza.ai_eda.hls_accelerator_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_HLS_GENERATION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "hlsfactory",
            "hls-eval",
            "hlstrans",
            "sage-hls",
            "bench4hls",
            "llm-dse",
            "idse-hls",
            "mpm-llm4dse",
            "forgehls",
            "diffhls",
            "hls-seek",
            "timelyhls",
            "flexllm-hls",
            "tapa-rapidstream",
            "secda-dse",
            "scalehls",
            "autodse-hls",
            "ai4dse-hls",
            "hlspilot",
            "db4hls",
            "dp-hls",
            "hls4ml",
            "finn-qnn",
            "amd-hls-dataflow-case-study",
        ],
        "policy": {
            "generates_hls_code": False,
            "generates_rtl": False,
            "runs_hls_synthesis": False,
            "downloads_external_assets": False,
            "release_use_allowed": False,
            "human_review_required_for_generated_code": True,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "e1-matmul-smoke-hls",
                "source_spec": "docs/spec-db/e1-npu-runtime-contract.json",
                "runtime_api": "lower_matmul_smoke",
                "target": "bounded int8/int4 matmul smoke adapter",
                "status": "CAPTURED_NOT_GENERATED",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
                    "make synth",
                ],
            },
            {
                "id": "e1-npu-descriptor-queue-hls",
                "source_spec": "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml",
                "target": "descriptor queue scheduling and bounds behavior",
                "status": "CAPTURED_NOT_GENERATED",
                "acceptance_gates": [
                    "make cocotb-npu",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "hls-directive-agent-search-watch",
                "source_spec": "compiler/runtime/test_e1_npu_runtime.py",
                "target": "future LLM-DSE, HLSPilot, iDSE, MPM-LLM4DSE, DiffHLS, HLS-Seek, TimelyHLS, AutoDSE, or AI4DSE-style profiling, directive, proxy-reward, QoR-prediction, and accelerator-parameter search for bounded E1 kernels",
                "status": "CAPTURED_NOT_SEARCHED",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "python3 compiler/runtime/test_e1_npu_runtime.py",
                    "make synth",
                ],
            },
            {
                "id": "hls-model-dataset-intake-watch",
                "source_spec": "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
                "target": "future HLS QoR models, HLStrans/SAGE-HLS/Bench4HLS/ForgeHLS/DB4HLS datasets, HLS-Seek proxy rewards, hls4ml/FINN/FlexLLM libraries, ScaleHLS infrastructure, AutoDSE baselines, or TAPA/RapidStream/DP-HLS backends must remain metadata-only until revisions, licenses, tool versions, generated artifacts, overlap checks, and replay manifests are reviewed",
                "status": "CAPTURED_NOT_IMPORTED",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
        ],
        "blocked_by": [
            "no HLS backend selected or version-pinned",
            "no generated HLS code isolated under build/ai_eda",
            "no C-simulation, HLS synthesis, RTL simulation, or equivalence logs",
            "no pinned LLM-DSE environment, HLSyn input subset, prompt log, or directive-search replay manifest",
            "no HLStrans/SAGE-HLS/Bench4HLS/ForgeHLS snapshot, license, split, model-card, prompt, or benchmark-overlap review",
            "no DiffHLS/HLS-Seek implementation, reward/proxy, feature extraction, calibration-label, synthesis-switch, or QoR replay review",
            "no approved MPM-LLM4DSE model/dataset intake, TimelyHLS benchmark replay, FlexLLM artifact review, or TAPA/RapidStream FPGA backend evidence",
            "no ScaleHLS/AutoDSE/AI4DSE revision, license, HLS backend, search manifest, generated-IR quarantine, prompt/model manifest, or QoR replay review",
            "no HLSPilot, DB4HLS, DP-HLS, hls4ml, FINN, or AMD HLS dataflow case-study intake with exact revisions, licenses, model/workload manifests, generated-artifact quarantine, and replay evidence",
            "external benchmark and framework licenses not manually reviewed",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.hls_accelerator.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
