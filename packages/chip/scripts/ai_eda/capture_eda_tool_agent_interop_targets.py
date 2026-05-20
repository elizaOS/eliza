#!/usr/bin/env python3
"""Capture dry-run EDA tool-agent interoperability targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/eda_tool_agent_interop_targets"
CLAIM_BOUNDARY = "eda_tool_agent_interop_capture_only_no_tool_invocation_or_source_change"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_provenance_matrix.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_external_source_probe_summary.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_integration_backlog.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_automation_readiness.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "docs/evidence/pd/commercial-eda-gate.yaml",
    "docs/project/no-hardware-action-matrix-2026-05-17.yaml",
    "scripts/check_commercial_eda_gate.py",
    "scripts/check_no_hardware_action_matrix.py",
    "scripts/check_openlane_run_preflight.py",
    "scripts/check_pd_signoff.py",
    "scripts/ai_eda/build_local_eda_rag_index.py",
    "scripts/ai_eda/preflight_ai_eda_backends.py",
    "scripts/ai_eda/run_openroad_autotune_e1.sh",
    "scripts/run_openroad.sh",
    "scripts/run_openlane.sh",
    "pd/openlane/config.sky130.json",
    "pd/openroad/e1_soc.tcl",
    "build/ai_eda/rag_index/source_manifest.json",
    "build/ai_eda/backend_preflight/validation/backend_preflight_report.json",
)

OPTIONAL_COMMANDS = (
    "python3",
    "git",
    "openroad",
    "openlane",
    "yosys",
    "verilator",
    "klayout",
    "magic",
    "netgen",
    "dc_shell",
    "fc_shell",
    "genus",
    "innovus",
    "tempus",
    "primetime",
    "calibre",
)

OPTIONAL_PYTHON_MODULES = (
    "yaml",
    "pydantic",
    "fastapi",
    "mcp",
    "openai",
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
        "schema": "eliza.ai_eda.eda_tool_agent_interop_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_EDA_TOOL_AGENT_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "agentic-eda-survey-2512-23189v2",
            "autoeda-mcp",
            "chateda",
            "mcp4eda",
            "synopsys-ai-copilot",
            "cadence-jedai",
            "cadence-chipstack-ai-super-agent",
            "siemens-fuse-eda-ai-agent",
            "phoenix-bench",
        ],
        "policy": {
            "executes_agent": False,
            "invokes_open_source_eda": False,
            "invokes_commercial_eda": False,
            "calls_external_api": False,
            "starts_mcp_server": False,
            "generates_tcl": False,
            "generates_shell": False,
            "generates_rtl": False,
            "generates_testbench": False,
            "generates_constraints": False,
            "generates_waivers": False,
            "runs_simulation": False,
            "runs_synthesis": False,
            "runs_place_and_route": False,
            "runs_signoff": False,
            "changes_source": False,
            "changes_pd_config": False,
            "changes_constraints": False,
            "prediction_generated": False,
            "tool_quality_claim_allowed": False,
            "productivity_claim_allowed": False,
            "ppa_claim_allowed": False,
            "signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "eda-agent-command-allowlist-watch",
                "status": "CAPTURED_NOT_ENABLED",
                "target": "future MCP or copilot tool actions must use typed command schemas, explicit read/write scopes, dry-run manifests, and archived stdout/stderr before execution",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
            {
                "id": "commercial-copilot-intake-watch",
                "status": "CAPTURED_BLOCKED_ON_VENDOR_REVIEW",
                "target": "future Synopsys, Cadence, Siemens, or other vendor copilot output must remain advisory until licenses, data-handling terms, exact tool versions, and local replay evidence are approved",
                "acceptance_gates": [
                    "make commercial-eda-gate",
                    "make pd-signoff-manifest-check",
                    "make no-hardware-action-check",
                    "make docs-check",
                ],
            },
            {
                "id": "openroad-agent-dry-run-watch",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "future OpenROAD/OpenLane agentic flows must emit dry-run manifests and pass preflight before any generated Tcl or config can run",
                "acceptance_gates": [
                    "make openlane-run-preflight-check",
                    "make physical-closure-work-order-check",
                    "make pd-signoff-manifest-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "hardware-agent-benchmark-localization-watch",
                "status": "CAPTURED_NOT_BENCHMARKED",
                "target": "future Phoenix-bench-style repository agents must be evaluated on quarantined local tasks with hierarchy-aware localization, deterministic tests, and review before patches are accepted",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --run-id validation --dry-run",
                    "make rtl-check",
                    "make formal",
                    "make cocotb-npu",
                ],
            },
        ],
        "blocked_by": [
            "no approved write-capable EDA agent command schema or command allowlist",
            "no policy separating read-only RAG answers from executable Tcl, shell, simulator, synthesis, PnR, signoff, or release actions",
            "no commercial Synopsys, Cadence, Siemens, Ansys, or foundry tool license and data-handling review for AI copilot output",
            "no local replay harness that can reproduce AI-generated EDA actions from archived inputs, commands, logs, and output hashes",
            "no accepted MCP server version, authentication model, sandbox policy, or artifact quarantine path for E1",
            "no evidence that hardware-agent benchmark success transfers to E1 multi-file RTL, PD, verification, or software integration tasks",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.eda_tool_agent_interop.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
