#!/usr/bin/env python3
"""Capture dry-run hardware-security AI/EDA targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/hardware_security_targets"
CLAIM_BOUNDARY = "hardware_security_target_capture_only_no_vulnerability_or_trojan_claim"

INPUT_ARTIFACTS = (
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/security",
    "verify/formal/e1_soc_top_formal.sv",
    "verify/formal/e1_npu_formal.sv",
    "verify/formal/e1_dma_formal.sv",
    "verify/cocotb/test_e1_npu.py",
    "docs/arch/security.md",
    "docs/security/usb-storage-update-security-evidence.md",
    "docs/project/no-hardware-action-matrix-2026-05-17.yaml",
    "docs/project/security-usb-storage-update-fail-closed-work-order-2026-05-17.yaml",
    "scripts/run_rtl_check.sh",
    "scripts/run_formal.sh",
    "scripts/check_no_hardware_action_matrix.py",
    "scripts/check_security_usb_update_work_order.py",
)

OPTIONAL_COMMANDS = (
    "yosys",
    "verilator",
    "sby",
    "semgrep",
    "iverilog",
)

OPTIONAL_PYTHON_MODULES = (
    "torch",
    "networkx",
    "dgl",
    "torch_geometric",
    "pyverilog",
    "sklearn",
)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_tree(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(child for child in path.rglob("*") if child.is_file()):
        digest.update(str(item.relative_to(ROOT)).encode())
        digest.update(b"\0")
        digest.update(sha256_file(item).encode())
        digest.update(b"\0")
    return digest.hexdigest()


def artifact_entry(path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    if path.is_file():
        return {
            "path": path_text,
            "status": "PRESENT",
            "kind": "file",
            "sha256": sha256_file(path),
        }
    if path.is_dir():
        return {
            "path": path_text,
            "status": "PRESENT",
            "kind": "directory",
            "sha256": sha256_tree(path),
        }
    return {
        "path": path_text,
        "status": "MISSING",
        "kind": "unknown",
        "sha256": None,
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
        "schema": "eliza.ai_eda.hardware_security_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_SECURITY_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "hardware-trojan-ml",
            "veriloglavd",
            "hardsecbench",
            "pearl-trojan-llm",
            "trojansaint",
            "gnn-mff",
            "securerag-rtl",
            "bugwhisperer-hw-security",
            "vericwety",
            "lashed-llm-static-hw-security",
            "qihe-static-analysis",
            "trojanwhisper",
            "trojangym",
            "netlam",
            "ghost-benchmarks",
            "hardware-vulnerability-dataset",
            "ai-hardware-security-verification-survey",
            "safetune-rtl-poisoning",
            "trojanloc",
            "harmchip",
            "trojan-xai-comparison",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_netlist": False,
            "imports_external_benchmarks": False,
            "downloads_external_assets": False,
            "runs_security_scanner": False,
            "runs_llm_classifier": False,
            "inserts_trojan": False,
            "generates_exploit": False,
            "prediction_generated": False,
            "vulnerability_claim_allowed": False,
            "trojan_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "rtl-security-baseline-corpus",
                "status": "CAPTURED_NOT_LABELED",
                "target": "hash local RTL, formal properties, security docs, and no-hardware-action policy inputs",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "generated-rtl-security-review-gate",
                "status": "CAPTURED_NOT_ENABLED",
                "target": "future advisory gate for AI-generated or imported RTL/firmware before review, regression, and secure-generation checks",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/evaluate_rtl_model.py --help",
                    "make rtl-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "verilog-cwe-rule-watch",
                "status": "CAPTURED_NOT_SCANNED",
                "target": "future VerilogLAVD-style CWE rules must remain advisory until rule hashes, RTL parser versions, alert logs, false-positive review, and deterministic follow-up checks exist",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "trojan-detection-benchmark-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "review TrustHub/GHOST/NETLAM/TrojanGYM-style Trojan datasets and generators without importing benchmarks or generated Trojans into release evidence",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/probe_external_ai_eda_sources.py --run-id validation",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "security-rag-triage-watch",
                "status": "CAPTURED_NOT_CLASSIFIED",
                "target": "future cited RAG triage for RTL security findings after local rules and reviewer workflow exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/build_local_eda_rag_index.py --run-id validation",
                    "make docs-check",
                    "make formal",
                ],
            },
            {
                "id": "model-based-vulnerability-triage-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future BugWhisperer/VeriCWEty-style model or embedding use requires pinned model/data revisions, license review, E1 non-overlap checks, prompt/output hashes, generated finding quarantine, deterministic RTL/formal follow-up, and security signoff",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "static-analysis-fusion-watch",
                "status": "CAPTURED_NOT_SCANNED",
                "target": "future LASHED/Qihe-style static-analysis fusion requires pinned analyzer/parser/rule revisions, command logs, alert hashes, false-positive review, threat-model mapping, and before/after deterministic regression evidence",
                "acceptance_gates": [
                    "make rtl-check",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "rtl-poisoning-and-safety-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future RTL model fine-tuning, jailbreak evaluation, and line-level Trojan localization must stay quarantined until prompt, corpus, and security-review gates exist",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_external_model_corpus_intake_targets.py --run-id validation",
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no local known-good/known-bad E1 RTL security label set",
            "no pinned Trojan/vulnerability taxonomy mapped to E1 threat model",
            "no reviewed model, prompt, retrieval corpus, or benchmark license path",
            "no approved Verilog CWE rule-generation workflow with rule hashes, alert triage, false-positive review, and deterministic follow-up checks",
            "no released/reviewed HardSecBench assets, E1 non-overlap scan, or secure-generation dual RTL/firmware gate mapping",
            "no prompt quarantine or red-team isolation policy for hardware-security jailbreak prompts",
            "no poisoning-screening workflow for external RTL fine-tuning corpora",
            "no line-level Trojan-localization acceptance workflow tied to E1 RTL and formal/simulation evidence",
            "no dual-use approval, sandbox, or no-source-import boundary for NETLAM/TrojanGYM-style adversarial Trojan-generation frameworks",
            "no license-reviewed hardware vulnerability prompt dataset with taxonomy, split manifest, and prompt privacy review",
            "no approved model-card, training-corpus, embedding-model, or line-label review workflow for model-based Verilog CWE triage",
            "no approved static-analysis fusion workflow with analyzer revisions, parser compatibility, rule hashes, alert logs, false-positive review, and deterministic replay",
            "no acceptance contract for AI security findings, suppressions, or reviewer signoff",
            "no before/after deterministic regression gate for acting on AI security output",
            "external Trojan insertion benchmarks are adversarial test data, not design inputs",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.hardware_security.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
