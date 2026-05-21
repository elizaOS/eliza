#!/usr/bin/env python3
"""Capture dry-run CPU microarchitecture AI/architecture-search targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/cpu_microarchitecture_targets"
CLAIM_BOUNDARY = "cpu_microarchitecture_target_capture_only_no_rtl_perf_or_product_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "docs/arch/branch-prediction.md",
    "docs/arch/cache-hierarchy.md",
    "docs/arch/ooo-cluster.md",
    "docs/architecture-optimization/2028-sota-integrated-report.md",
    "docs/architecture-optimization/sota-2028/branch-predictors.md",
    "docs/architecture-optimization/sota-2028/cache-hierarchies.md",
    "docs/architecture-optimization/sota-2028/ooo-execution.md",
    "docs/evidence/cache/cache-evidence-gate.yaml",
    "rtl/cpu/bpu/bpu_pkg.sv",
    "rtl/cpu/bpu/bpu_top.sv",
    "rtl/cpu/bpu/tage.sv",
    "rtl/cpu/bpu/ittage.sv",
    "rtl/cpu/bpu/ras.sv",
    "rtl/cache/cache_pkg.sv",
    "rtl/cache/prefetch/e1_berti_prefetcher.sv",
    "rtl/cache/prefetch/e1_pythia_stub.sv",
    "rtl/cache/replacement/e1_mockingjay.sv",
    "rtl/cache/replacement/e1_hawkeye.sv",
    "scripts/check_branch_prediction.py",
    "scripts/check_cache_hierarchy.py",
    "scripts/champsim_sweep.py",
    "benchmarks/cpu/branch/run_mpki.py",
    "benchmarks/cpu/branch/bpu_model.py",
    "benchmarks/cpu/cache/lmbench_cache_curve.py",
    "docs/evidence/cpu_ap/mpki_results_synthetic.json",
    "build/reports/cache/champsim_sweep.json",
    "build/reports/cache/lmbench_host_curve.json",
)

OPTIONAL_COMMANDS = (
    "champsim",
    "gem5.opt",
    "gem5",
    "run-sniper",
    "sniper",
    "verilator",
    "sby",
    "yosys",
    "python3",
    "git",
)

OPTIONAL_PYTHON_MODULES = (
    "numpy",
    "pandas",
    "sklearn",
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
    parser.add_argument("--run-id", default=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.cpu_microarchitecture_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_CPU_MICROARCHITECTURE_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "agentic-architect",
            "perfvec",
            "concorde-cpu-performance-model",
            "gem5-simulator",
            "sniper-simulator",
            "champsim",
            "branchnet",
            "llbp",
            "pythia-prefetcher",
            "mockingjay-cache-replacement",
            "drishti-cache-replacement",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_microarchitecture": False,
            "changes_cache_policy": False,
            "changes_branch_predictor": False,
            "changes_prefetcher": False,
            "generates_rtl": False,
            "runs_simulator": False,
            "runs_ml_model": False,
            "runs_llm": False,
            "downloads_external_traces": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "imports_benchmark_traces": False,
            "prediction_generated": False,
            "ipc_claim_allowed": False,
            "mpki_claim_allowed": False,
            "area_power_claim_allowed": False,
            "product_performance_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "branch-predictor-ai-search-watch",
                "status": "CAPTURED_NOT_SEARCHED",
                "target": "future Agentic Architect or BranchNet-style branch predictor search must stay behind local BPU parameters, synthetic traces, cocotb, formal, and MPKI evidence",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make branch-prediction-check",
                    "make mpki-eval",
                    "make cocotb-bpu",
                    "make formal-bpu",
                ],
            },
            {
                "id": "cache-prefetch-replacement-watch",
                "status": "CAPTURED_NOT_SWEEPED",
                "target": "future Pythia, Berti, Mockingjay, or Drishti-style cache and prefetch policies need local cache hierarchy hashes, ChampSim traces, and RTL gate review",
                "acceptance_gates": [
                    "python3 scripts/check_cache_hierarchy.py",
                    "python3 scripts/champsim_sweep.py",
                    "make memory-interconnect-contract-check",
                    "make memory-uma-claim-gate",
                ],
            },
            {
                "id": "cpu-performance-model-watch",
                "status": "CAPTURED_NOT_PREDICTED",
                "target": "future gem5, Sniper, PerfVec, or Concorde-style CPU performance studies must use pinned simulator configs, traces, microarchitecture encodings, held-out workloads, comparison baselines, and error analysis",
                "acceptance_gates": [
                    "make benchmark-cpu-ap-sim-metrics",
                    "make benchmark-cpu-ap-sota-sim-metrics",
                    "make cpu-ap-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "architecture-simulator-backend-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future gem5 or Sniper use must remain advisory until exact revisions, build/config manifests, workload hashes, command logs, stats outputs, model-assumption reviews, and local E1 calibration evidence exist",
                "acceptance_gates": [
                    "make benchmark-cpu-ap-sim-metrics",
                    "make cpu-ap-evidence-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "simulator-backed-uarch-dse-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future simulator-backed CPU design-space exploration must keep generated policies outside source until before/after RTL, simulator, benchmark, synthesis, and review gates pass",
                "acceptance_gates": [
                    "make rtl-check",
                    "make synth",
                    "make formal",
                    "make docs-check",
                ],
            },
        ],
        "blocked_by": [
            "no pinned ChampSim, gem5, Sniper, PerfVec, Concorde, Agentic Architect, BranchNet, Pythia, Mockingjay, or Drishti backend selected for local execution",
            "no license-reviewed external branch, cache, or SPEC/DPC trace corpus imported for E1 experiments",
            "no held-out E1 application trace suite with branch, cache, prefetch, IPC, area, power, and workload provenance",
            "no before/after RTL, synthesis, formal, cocotb, simulator, and benchmark promotion policy for generated microarchitecture changes",
            "no silicon or calibrated full-system simulator evidence tying MPKI/IPC estimates to product performance",
            "no approved workflow for AI-generated branch predictor, cache replacement, prefetcher, or CPU-architecture edits",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.cpu_microarchitecture.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
