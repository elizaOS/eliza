#!/usr/bin/env python3
"""Create a dry-run RTL model evaluation manifest for E1-style tasks."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/rtl_model_eval"
PLAN = ROOT / "research/alpha_chip_macro_placement/05_experiments/e1_rtl_model_eval_plan.md"
CLAIM_BOUNDARY = "generated_rtl_artifact_only_not_source_or_release_evidence"

MODELS = (
    {
        "id": "rtl-coder",
        "source_id": "rtl-coder",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "openllm-rtl",
        "source_id": "openllm-rtl",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "verigen-codegen-verilog",
        "source_id": "verigen-codegen-verilog",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "origen-verilog",
        "source_id": "origen-verilog",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "verireason-rtl-grpo",
        "source_id": "verireason-rtl-grpo",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "deepv-verilog-rag",
        "source_id": "deepv-verilog-rag",
        "license_status": "paper_and_space_assets_review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "chipcraftx-rtlgen-7b",
        "source_id": "chipcraftx-rtlgen-7b",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "chipseek",
        "source_id": "chipseek",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "circuitmind-tcbench",
        "source_id": "circuitmind-tcbench",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "rtlseek",
        "source_id": "rtlseek",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "qimeng-codev-r1",
        "source_id": "qimeng-codev-r1",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "qimeng-crux",
        "source_id": "qimeng-crux",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "qimeng-salv",
        "source_id": "qimeng-salv",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "evolve-verilog",
        "source_id": "evolve-verilog",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "veriagent",
        "source_id": "veriagent",
        "license_status": "paper_assets_review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
    {
        "id": "rtl-llm-hf",
        "source_id": "chipcraftx-rtlgen-7b",
        "license_status": "review_required",
        "backend_status": "not_configured",
        "release_use": "blocked",
    },
)

TASKS = (
    {
        "id": "axi_lite_ro_register_block",
        "description": "Generate a small AXI-Lite read-only status register block.",
        "required_gates": ["make rtl-check", "make synth"],
    },
    {
        "id": "descriptor_fifo_status_counter",
        "description": "Generate a status counter around an existing descriptor FIFO contract.",
        "required_gates": ["make rtl-check", "make cocotb-npu", "make synth"],
    },
    {
        "id": "npu_saturating_arithmetic_helper",
        "description": "Generate a bounded saturating arithmetic helper for NPU datapath review.",
        "required_gates": ["make rtl-check", "make cocotb-npu", "make synth"],
    },
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", required=True)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def task_entry(task: dict[str, Any]) -> dict[str, Any]:
    prompt = (
        f"E1 RTL evaluation task {task['id']}: {task['description']} "
        "Return SystemVerilog only after license and backend gates are enabled."
    )
    return {
        **task,
        "status": "DRY_RUN_NOT_GENERATED",
        "prompt_sha256": sha256_text(prompt),
        "generated_rtl_path": None,
        "generated_rtl_sha256": None,
        "lint_log": None,
        "simulation_log": None,
        "synthesis_log": None,
        "human_review_status": "not_started",
    }


def main() -> int:
    args = parse_args()
    out_dir = (args.out_root / args.run_id).resolve()
    plan_hash = sha256_file(PLAN) if PLAN.is_file() else None
    report = {
        "schema": "eliza.ai_eda.rtl_model_eval.report.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "DRY_RUN_NO_MODEL_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "plan": rel(PLAN),
        "plan_sha256": plan_hash,
        "evaluation_policy": {
            "generated_rtl_committed": False,
            "generated_rtl_enters_source": False,
            "release_use_blocked": True,
            "model_quality_claim_allowed": False,
            "requires_human_review": True,
            "requires_deterministic_gates": True,
            "false_claim_flags": {
                "generated_rtl_committed": False,
                "generated_rtl_enters_source": False,
                "model_quality_claim_allowed": False,
            },
        },
        "models": list(MODELS),
        "tasks": [task_entry(task) for task in TASKS],
        "blocked_by": [
            "per-model license review",
            "local inference or API backend decision",
            "executed lint, simulation, and synthesis logs",
            "human reviewer acceptance for any promoted source change",
        ],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "eval_report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.rtl_model_eval.dry_run {rel(out_dir / 'eval_report.json')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
