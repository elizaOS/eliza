#!/usr/bin/env python3
"""Capture dry-run verification planning and formal-debug AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/verification_debug_targets"
CLAIM_BOUNDARY = "verification_debug_target_capture_only_no_patch_testbench_or_assertion_binding"

INPUT_ARTIFACTS = (
    "rtl/top/e1_chip_top.sv",
    "rtl/top/e1_soc_top.sv",
    "rtl/npu/e1_npu.sv",
    "rtl/dma/e1_dma.sv",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/interrupts/e1_interrupt_controller.sv",
    "verify/formal/e1_npu_formal.sv",
    "verify/formal/e1_dma_formal.sv",
    "verify/formal/e1_soc_top_formal.sv",
    "verify/cocotb/test_e1_npu.py",
    "verify/cocotb/test_reset_domain_cleanup.py",
    "verify/ai_eda/assertion_candidates/e1_npu_descriptor.yaml",
    "verify/ai_eda/coverage_bins/e1_npu_descriptor_queue.yaml",
    "verify/regression_seeds/ai_eda_npu_descriptor_queue.yaml",
    "docs/spec-db/e1-npu-runtime-contract.json",
    "docs/project/rtl-soc-critical-gap-audit.md",
    "scripts/run_formal.sh",
    "scripts/run_rtl_check.sh",
    "scripts/yosys_formal_npu.ys",
    "scripts/yosys_formal_dma.ys",
    "build/reports/formal_manifest.json",
)

OPTIONAL_COMMANDS = (
    "yosys",
    "yosys-smtbmc",
    "sby",
    "z3",
    "verilator",
    "iverilog",
    "gtkwave",
    "surelog",
    "verible-verilog-lint",
    "verible-verilog-syntax",
    "slang",
)

OPTIONAL_PYTHON_MODULES = (
    "cocotb",
    "cocotb_bus",
    "cocotb_test",
    "cocotbext.axi",
    "networkx",
    "pyuvm",
    "pyverilog",
    "vcdvcd",
    "yaml",
    "z3",
    "transformers",
    "torch",
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
    try:
        present = importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:
        present = False
    return {
        "module": name,
        "status": "PRESENT" if present else "MISSING",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    report = {
        "schema": "eliza.ai_eda.verification_debug_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_VERIFICATION_PATCH_OR_CLAIM",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "pro-v",
            "autobench",
            "project-ava",
            "haven-uvm",
            "correctbench-hdl",
            "uvllm",
            "uvm2-machine",
            "verifllmbench",
            "verilogcoder",
            "saarthi-formal-verification",
            "sangam-sva",
            "stellar-sva",
            "proofloop-sva",
            "fvdebug",
            "assertsolver",
            "veridebug",
            "siliconmind-v1",
            "rtlfixer",
            "uvmarvel",
            "meic-rtl-debug",
            "r3a-rtl-repair",
            "clover-rtl-repair",
            "waveform-mcp",
            "mcp-vcd-waveform",
            "vaporview-waveform",
            "waveeye",
            "cocotb-core",
            "cocotb-test",
            "cocotb-bus",
            "cocotb-coverage",
            "pyuvm-cocotb",
            "cocotbext-axi",
            "surelog-uhdm-sv-frontend",
            "uhdm-systemverilog-data-model",
            "verible-sv-tooling",
            "sv-tests-compliance",
            "slang-sv-frontend",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_testbench": False,
            "changes_assertions": False,
            "generates_patch": False,
            "generates_testbench": False,
            "generates_assertion": False,
            "binds_assertion": False,
            "runs_llm": False,
            "runs_formal": False,
            "runs_simulation": False,
            "parses_waveforms": False,
            "downloads_external_assets": False,
            "imports_external_benchmarks": False,
            "prediction_generated": False,
            "debug_claim_allowed": False,
            "verification_closure_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "spec-to-verification-plan-watch",
                "status": "CAPTURED_NOT_PLANNED",
                "target": "future AI plans must cite E1 specs, RTL hashes, existing coverage bins, and deterministic promotion gates",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make docs-check",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "formal-counterexample-debug-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future formal-failure triage may summarize counterexample and RTL context, but cannot patch RTL or mark root cause without reviewer disposition",
                "acceptance_gates": [
                    "make formal",
                    "make rtl-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "verification-testbench-oracle-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future PRO-V, AutoBench, CorrectBench, Project Ava, or VerilogCoder-style testbench/oracle candidates must stay in build artifacts until oracle independence, deterministic cocotb regressions, and reviewer disposition pass",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/run_cocotb_stimulus_search.py --dry-run --run-id validation",
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make cocotb-npu",
                    "make cocotb-contract",
                ],
            },
            {
                "id": "uvm-testbench-automation-watch",
                "status": "CAPTURED_NOT_GENERATED",
                "target": "future UVM/HAVEN/UVLLM/UVM2/UVMarvel/VerifLLMBench-style subsystem testbenches require a protocol IR, commercial-simulator availability, coverage logs, benchmark non-overlap review, and cocotb/formal cross-checks before promotion",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make cocotb-contract",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "assertion-self-refine-watch",
                "status": "CAPTURED_NOT_BOUND",
                "target": "future SANGAM, STELLAR, or ProofLoop-style SVA search must produce reviewed assertion candidates with retrieval/proof logs, not direct RTL bindings",
                "acceptance_gates": [
                    "make formal",
                    "python3 scripts/ai_eda/capture_cdc_rdc_targets.py --run-id validation",
                    "python3 scripts/check_ai_eda_source_inventory.py",
                ],
            },
            {
                "id": "verilog-debug-model-watch",
                "status": "CAPTURED_NOT_CLASSIFIED",
                "target": "future VeriDebug-style buggy-line localization, bug-type classification, or patch suggestions must remain advisory until code/model/dataset revisions, overlap scan, prompt logs, and deterministic replay gates pass",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make rtl-check",
                    "make formal",
                    "make synth",
                ],
            },
            {
                "id": "patch-quarantine-equivalence-watch",
                "status": "CAPTURED_NOT_PATCHED",
                "target": "future MEIC, UVLLM, FVDebug, AssertSolver, VeriDebug, SiliconMind, RTLFixer, R3A, or Clover debug fixes must remain quarantined until review, simulation, formal, synthesis, and equivalence gates pass",
                "acceptance_gates": [
                    "make formal",
                    "make synth",
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                ],
            },
            {
                "id": "assertion-failure-repair-model-watch",
                "status": "CAPTURED_NOT_PATCHED",
                "target": "future AssertSolver-style assertion-failure repair can propose candidate RTL fixes only inside quarantine, with exact model/code revisions, assertion/testbench overlap review, prompt logs, and deterministic sim/formal/synth/equivalence replay before any source change",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/capture_benchmark_evaluation_hygiene_targets.py --run-id validation",
                    "make formal",
                    "make synth",
                    "python3 scripts/ai_eda/capture_rtl_rewrite_equivalence_targets.py --run-id validation",
                ],
            },
            {
                "id": "waveform-context-mcp-watch",
                "status": "CAPTURED_NOT_CONNECTED",
                "target": "future Waveform MCP, MCP VCD, VaporView, WaveEye, or similar waveform-context tooling must pin waveform hashes, allowed signal/time scopes, command/tool logs, prompt context, simulator replay, and reviewer disposition before any AI root-cause summary is trusted",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make cocotb-contract",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "deterministic-waveform-root-cause-watch",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future WaveEye-style RTL/VCD root-cause analysis for AXI-Lite failures must stay advisory until RTL/VCD hashes, signal scopes, protocol assumptions, proof JSON, simulator replay, cocotb/formal correlation, and reviewer disposition are archived",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make cocotb-contract",
                    "make formal",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "python-verification-infrastructure-watch",
                "status": "CAPTURED_NOT_IMPORTED",
                "target": "future cocotb, cocotb-test, cocotb-bus, cocotb-coverage, pyuvm, or cocotbext-axi use must pin versions, coverage schemas, bus-interface mappings, scoreboards, seed manifests, simulator logs, and cocotb/formal correlation before generated tests or coverage claims are promoted",
                "acceptance_gates": [
                    "python3 scripts/ai_eda/run_cocotb_stimulus_search.py --dry-run --run-id validation",
                    "make cocotb-npu",
                    "make cocotb-contract",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "systemverilog-frontend-assertion-hygiene-watch",
                "status": "CAPTURED_NOT_RUN",
                "target": "future AI-generated SVA, bind stubs, or verification snippets must pass pinned Surelog/UHDM, Verible, sv-tests-qualified, or slang frontend checks with unsupported-construct reports, input hashes, diagnostics, formal/cocotb replay, and reviewer disposition before source promotion",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make formal",
                    "make cocotb-contract",
                    "make no-hardware-action-check",
                ],
            },
        ],
        "blocked_by": [
            "no approved AI-generated verification-plan promotion workflow",
            "no archived failing formal counterexample corpus for E1",
            "no waveform/trace-to-causal-graph parser pinned for local formal failures",
            "no license-reviewed PRO-V, AutoBench, Project Ava, HAVEN, VerilogCoder, Saarthi, SANGAM, STELLAR, ProofLoop, FVDebug, VeriDebug, SiliconMind, or RTLFixer integration path",
            "no license-reviewed CorrectBench, UVLLM, UVM2, VerifLLMBench, MEIC, R3A, or Clover asset path with benchmark non-overlap and prompt/model provenance",
            "no UVM-capable simulator/license, protocol IR, or coverage-to-cocotb correlation workflow for E1 subsystem verification",
            "no approved mutation-test, cocotb-repair, AST-waveform tracing, or simulator failure-taxonomy workflow for generated verification collateral",
            "no approved assertion retrieval corpus, AST fingerprint, solver-query log, or proof replay workflow",
            "no license-reviewed AssertSolver code/model revision, assertion/testbench overlap scan, prompt log, model-access approval, or local replay harness",
            "no license-reviewed Verilog debug model/dataset revision, benchmark overlap scan, or local replay harness",
            "no approved oracle-independence, repair-search-trace, or coverage-waiver disposition workflow for generated verification artifacts",
            "no reviewer disposition schema for AI-suggested root causes or patches",
            "no deterministic source-promotion gate for AI-generated testbenches, assertions, or RTL fixes",
            "no approved Waveform MCP, MCP VCD, VaporView, or WaveEye workflow with trace scope allowlists, waveform hashes, MCP/tool logs or proof JSON, prompt redaction where applicable, replay evidence, and reviewer disposition",
            "no approved cocotb core, cocotb-test, cocotb-bus, cocotb-coverage, pyuvm, or cocotbext-axi integration path with version pins, coverage schemas, bus mappings, scoreboards, seeds, simulator logs, and cocotb/formal correlation",
            "no approved Surelog/UHDM, Verible, sv-tests, or slang workflow with revision pins, rule/test manifests, unsupported-construct reports, parser/lint/elaboration diagnostics, input hashes, replay evidence, and reviewer disposition",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.verification_debug.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
