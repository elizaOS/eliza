#!/usr/bin/env python3
"""Capture dry-run reliability, aging, EM, and soft-error AI/EDA targets."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/reliability_resilience_targets"
CLAIM_BOUNDARY = "reliability_resilience_target_capture_only_no_fault_aging_or_signoff_claim"

INPUT_ARTIFACTS = (
    "research/alpha_chip_macro_placement/01_sources/ai_eda_source_inventory.yaml",
    "research/alpha_chip_macro_placement/01_sources/ai_eda_sota_review.md",
    "docs/spec-db/process-14a-effects.yaml",
    "pd/signoff/si-pi/local-evidence.yaml",
    "pd/signoff/pdn-current/local-budget.yaml",
    "pd/signoff/manifest.yaml",
    "docs/evidence/cache/cache-evidence-gate.yaml",
    "docs/evidence/linux/linux-external-bsp-status.json",
    "benchmarks/power/workload-plan.yaml",
    "benchmarks/power/manifests/e1-npu-sustained-capture.template.json",
    "benchmarks/power/sustained-run-evidence.schema.json",
    "rtl/npu/e1_npu.sv",
    "rtl/memory/e1_axi_lite_dram.sv",
    "rtl/memory/dram_ctrl/e1_dram_ctrl.sv",
    "rtl/cache/cache_pkg.sv",
    "scripts/check_cpu_npu_14a_process_eval.py",
    "scripts/check_cpu_npu_burst_thermal_transient.py",
    "scripts/check_memory_evidence_templates.py",
    "scripts/check_memory_interconnect_contract.py",
    "scripts/check_pd_signoff.py",
    "scripts/run_formal.sh",
    "scripts/yosys_formal_npu_structural.ys",
)

OPTIONAL_COMMANDS = (
    "openroad",
    "ngspice",
    "yosys",
    "sby",
    "verilator",
    "qemu-riscv64",
    "python3",
    "git",
)

OPTIONAL_PYTHON_MODULES = (
    "numpy",
    "scipy",
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
        "schema": "eliza.ai_eda.reliability_resilience_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_RELIABILITY_RESILIENCE_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "agentictcad",
            "tcadgpt",
            "proton-em",
            "emspice2",
            "bti-hci-aging-models",
            "sofia-soft-error-framework",
            "arm-ethos-u55-soft-error",
            "ibex-seu-formal",
            "bec-soft-error-llvm",
            "hdfit-fault-injection",
            "llfi-llvm-fault-injection",
            "lltfi-mlir-fault-injection",
            "hamartia-fault-injection",
            "fies-qemu-fault-injection",
            "tensorfi",
            "pytorchfi",
            "pytorchalfi",
            "mrfi",
            "ares-dnn-fault-injection",
            "caliptra-error-injection",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_netlist": False,
            "changes_layout": False,
            "changes_pdn": False,
            "changes_firmware": False,
            "inserts_faults": False,
            "runs_fault_injection": False,
            "runs_aging_analysis": False,
            "runs_em_analysis": False,
            "runs_formal": False,
            "runs_simulator": False,
            "runs_ml_model": False,
            "generates_mitigation": False,
            "generates_ecc_or_tmr": False,
            "downloads_external_assets": False,
            "downloads_model_weights": False,
            "imports_external_corpus": False,
            "prediction_generated": False,
            "reliability_claim_allowed": False,
            "aging_lifetime_claim_allowed": False,
            "soft_error_claim_allowed": False,
            "em_ir_signoff_claim_allowed": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "aging-em-target-readiness",
                "status": "CAPTURED_NOT_ANALYZED",
                "target": "future BTI/HCI/TDDB/EM screening must require process, activity, thermal, PDN, and signoff provenance before any lifetime or reliability claim",
                "acceptance_gates": [
                    "python3 scripts/check_ai_eda_source_inventory.py",
                    "make process-14a-effects-check",
                    "make power-thermal-evidence-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "tcad-process-device-assumption-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future TCAD-generated device, process, reliability-corner, leakage, or degradation assumptions must trace to authorized decks, calibration, and signoff evidence",
                "acceptance_gates": [
                    "make process-14a-effects-check",
                    "make power-thermal-evidence-check",
                    "make pd-signoff-manifest-check",
                ],
            },
            {
                "id": "soft-error-fault-injection-watch",
                "status": "CAPTURED_NOT_INJECTED",
                "target": "future RTL, netlist, formal, QEMU, LLVM/MLIR, or workload-level fault injection must quarantine results and require deterministic fault campaigns, fault-site manifests, seeds, signatures, output classifiers, replay logs, and review",
                "acceptance_gates": [
                    "make formal",
                    "make cocotb-npu",
                    "make qemu-check",
                    "make no-hardware-action-check",
                ],
            },
            {
                "id": "npu-resilience-target-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future TensorFI, PyTorchFI, PyTorchALFI, MRFI, Ares, or other NPU workload resilience analysis must hash workload, model, activation, fault-site, RTL, runtime, and simulator evidence before mitigation decisions",
                "acceptance_gates": [
                    "python3 compiler/runtime/test_e1_npu_runtime.py",
                    "python3 compiler/runtime/test_e1_npu_runtime_sim.py",
                    "make npu-runtime-contract-check",
                    "make benchmark-sim-metrics",
                ],
            },
            {
                "id": "memory-ecc-mitigation-watch",
                "status": "CAPTURED_NOT_MODIFIED",
                "target": "future ECC, TMR, replay, redundancy, or selective-hardening proposals must remain outside source until memory, cache, RTL, simulator, synthesis, and review gates exist",
                "acceptance_gates": [
                    "make memory-evidence-template-check",
                    "make memory-interconnect-contract-check",
                    "make rtl-check",
                    "make synth",
                ],
            },
        ],
        "blocked_by": [
            "no E1 process-qualified BTI, HCI, TDDB, EM, SER, or radiation fault-rate model",
            "no calibrated activity, temperature, voltage, PDN current-density, or lifetime mission-profile evidence",
            "no reviewed RTL/netlist/formal/QEMU/LLVM/MLIR/workload fault-injection harness for E1 with fault-site manifests, random seeds, signatures, output classifiers, and pass/fail taxonomy",
            "no local labels linking fault campaigns, formal traces, simulator failures, or silicon logs to approved mitigations",
            "no approved TCAD/DTCO model, deck, simulator license, calibration corpus, or process-device authority for E1 reliability assumptions",
            "no approved workflow for AI-generated ECC, TMR, replay, redundancy, hardening, derating, or reliability ECO changes",
            "no signoff evidence showing EM/IR, aging timing, soft-error, safety, or reliability closure",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.reliability_resilience.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
