#!/usr/bin/env python3
"""Capture dry-run compiler, RVV, and kernel-autotuning AI targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/compiler_autotuning_targets"
CLAIM_BOUNDARY = "compiler_autotuning_target_capture_only_no_codegen_binary_or_perf_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "compiler/llvm-build/llvm-pin.json",
    "compiler/iree-eliza-npu/iree-pin.json",
    "compiler/iree-eliza-npu/README.md",
    "compiler/iree-eliza-npu/lib/Transforms/ConvertLinalgToElizaNpu.cpp",
    "compiler/iree-eliza-npu/lib/Transforms/EmitDescriptorTable.cpp",
    "compiler/runtime/e1_npu_lowering.py",
    "compiler/runtime/e1_npu_runtime.py",
    "compiler/runtime/test_e1_npu_runtime.py",
    "compiler/runtime/test_e1_npu_runtime_sim.py",
    "compiler/autofdo-harness/README.md",
    "compiler/autofdo-harness/capture.sh",
    "compiler/autofdo-harness/apply.sh",
    "compiler/propeller-harness/relink.sh",
    "compiler/bolt-harness/optimize.sh",
    "benchmarks/compiler/autovec/README.md",
    "benchmarks/compiler/autovec/kernels.c",
    "benchmarks/compiler/autovec/kernels.json",
    "scripts/check_compiler_versions.py",
    "scripts/run_rvv_autovec_suite.py",
    "scripts/build_llvm_riscv.sh",
    "scripts/build_iree_eliza_npu.sh",
    "docs/toolchain/llvm-trunk-pin.md",
    "docs/toolchain/autofdo-propeller-bolt.md",
    "docs/toolchain/iree-eliza-npu.md",
    "docs/toolchain/quantization-pipeline.md",
    "docs/architecture-optimization/sota-2028/compiler-tuning.md",
    "build/reports/compiler/compiler-versions.json",
    "build/reports/compiler/autovec-results.json",
)

OPTIONAL_COMMANDS = (
    "clang",
    "ld.lld",
    "llvm-bolt",
    "llvm-profdata",
    "llvm-profgen",
    "create_llvm_prof",
    "perf",
    "qemu-riscv64",
    "iree-compile",
    "python3",
    "git",
)

OPTIONAL_PYTHON_MODULES = (
    "numpy",
    "tvm",
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
        "schema": "eliza.ai_eda.compiler_autotuning_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_COMPILER_AUTOTUNING_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "llvm-mlgo",
            "google-ml-compiler-opt",
            "tvm-meta-schedule",
            "ansor",
            "autofdo",
            "llvm-propeller",
            "bolt",
            "intrintrans-rvv",
            "vecintrinbench",
            "simdbench",
            "agentic-code-optimization",
            "hintpilot",
            "llm-veriopt",
            "xdsl-rvv-lowering",
            "autocomp-kernel-optimization",
            "accelopt",
            "v-seek-riscv-llm-inference",
            "riscv-itree-semantics",
        ],
        "policy": {
            "changes_source": False,
            "changes_compiler": False,
            "changes_codegen": False,
            "changes_binary": False,
            "changes_runtime": False,
            "generates_code": False,
            "generates_intrinsics": False,
            "generates_profiles": False,
            "runs_compiler": False,
            "runs_autotuner": False,
            "runs_llm": False,
            "runs_ml_model": False,
            "runs_benchmarks": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "imports_external_corpus": False,
            "prediction_generated": False,
            "compiler_perf_claim_allowed": False,
            "kernel_perf_claim_allowed": False,
            "binary_release_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "llvm-mlgo-watch",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "future LLVM MLGO experiments must stay behind pinned LLVM/IREE revisions, corpus manifests, train/test splits, and compiler version evidence",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/check_compiler_versions.py",
                    "python3 scripts/run_rvv_autovec_suite.py",
                    "make docs-check",
                ],
            },
            {
                "id": "rvv-intrinsic-translation-watch",
                "status": "CAPTURED_NOT_TRANSLATED",
                "target": "future IntrinTrans, VecIntrinBench, or SimdBench-style RVV code generation must require compile, disassembly, simulator correctness, and benchmark gates",
                "acceptance_gates": [
                    "python3 scripts/run_rvv_autovec_suite.py",
                    "python3 compiler/runtime/test_e1_npu_runtime.py",
                    "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
                    "make npu-runtime-contract-check",
                ],
            },
            {
                "id": "profile-guided-binary-optimization-watch",
                "status": "CAPTURED_NOT_PROFILED",
                "target": "future AutoFDO, Propeller, or BOLT optimizations must hash binaries, profiles, compiler versions, raw logs, and before/after benchmark evidence",
                "acceptance_gates": [
                    "python3 scripts/check_compiler_versions.py",
                    "make benchmark-parser-test",
                    "make benchmark-calibration-test",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "tensor-kernel-autotuning-watch",
                "status": "CAPTURED_NOT_TUNED",
                "target": "future TVM MetaSchedule, Ansor, or RISC-V tensor-kernel autotuning must remain outside source until workload, target, schedule, compiler, simulator, and benchmark evidence exist",
                "acceptance_gates": [
                    "make npu-runtime-contract-check",
                    "make benchmark-sim-metrics",
                    "make npu-scale-sim-check",
                    "make scale-feasibility-gate",
                ],
            },
            {
                "id": "agentic-compiler-optimization-watch",
                "status": "CAPTURED_NOT_OPTIMIZED",
                "target": "future LLM or agentic compiler optimization must quarantine generated code and prove semantic equivalence and performance with local tests before promotion",
                "acceptance_gates": [
                    "python3 compiler/runtime/test_e1_npu_runtime.py",
                    "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
                    "make software-contract-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "llm-accelerator-kernel-optimization-watch",
                "status": "CAPTURED_NOT_OPTIMIZED",
                "target": "future Autocomp, AccelOpt, or V-Seek-style generated kernels must stay quarantined until target adapters, prompts/models, memories, generated sources, compiler/simulator logs, correctness tests, and benchmark replay are reviewed",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 compiler/runtime/test_e1_npu_runtime.py",
                    "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
                    "make benchmark-parser-test",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no pinned LLVM stage-2 toolchain, IREE build, or compiler version evidence accepted as release-grade",
            "no license-reviewed compiler corpus, RVV intrinsic corpus, tensor-kernel corpus, or profile corpus imported for E1",
            "no approved workflow for AI-generated RVV intrinsics, compiler pass changes, schedule changes, profile data, or binaries",
            "no local RISC-V simulator/runtime evidence proving generated kernels are semantically equivalent and ABI-compatible",
            "no before/after benchmark evidence with target metadata, thermal/power state, compiler flags, raw logs, and calibration",
            "no model or autotuner revision selected for MLGO, MetaSchedule, Ansor, agentic compiler optimization, or LLM vectorization",
            "no approved target adapter, prompt/model revision, optimization-memory quarantine, generated-kernel corpus, semantic-equivalence evidence, or replayed benchmark logs for Autocomp, AccelOpt, or V-Seek-style optimization",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.compiler_autotuning.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
