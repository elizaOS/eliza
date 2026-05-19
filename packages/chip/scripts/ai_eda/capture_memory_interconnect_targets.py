#!/usr/bin/env python3
"""Capture dry-run memory, NoC, coherency, and SoC DSE targets for E1."""

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
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/memory_interconnect_targets"
CLAIM_BOUNDARY = "memory_interconnect_target_capture_only_no_fabric_or_claim_change"

INPUT_ARTIFACTS = (
    "docs/arch/memory-subsystem.md",
    "docs/arch/interconnect.md",
    "docs/arch/memory-map.md",
    "docs/project/uma-coherency-validation-strategy.yaml",
    "docs/evidence/memory/uma-dram-evidence-gate.yaml",
    "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json",
    "docs/benchmarks/benchmark-matrix.md",
    "docs/architecture-optimization/soc-optimized-operating-point.yaml",
    "rtl/interconnect/e1_axi_lite_interconnect.sv",
    "rtl/interconnect/e1_linux_soc_contract.sv",
    "rtl/memory/e1_axi_lite_dram.sv",
    "rtl/dma/e1_dma.sv",
    "scripts/check_memory_interconnect_contract.py",
    "scripts/check_memory_uma_claim_gate.py",
)

OPTIONAL_COMMANDS = (
    "gem5.opt",
    "gem5",
    "booksim",
    "ramulator2",
    "dramsim3",
    "renode",
    "qemu-system-riscv64",
)

OPTIONAL_PYTHON_MODULES = (
    "gymnasium",
    "gym",
    "ray",
    "torch",
    "skopt",
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
        "schema": "eliza.ai_eda.memory_interconnect_targets.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_MEMORY_FABRIC_CHANGE",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": [
            "archgym",
            "ai-noc-dse",
            "ai-driven-noc-dse-2512",
            "booksim2",
            "ramulator2",
            "dramsim3",
            "dramsys",
            "gem5-aladdin",
            "gem5-accesys",
        ],
        "policy": {
            "changes_rtl": False,
            "changes_memory_map": False,
            "changes_coherency_policy": False,
            "generates_fabric": False,
            "runs_external_simulator": False,
            "downloads_external_assets": False,
            "prediction_generated": False,
            "release_use_allowed": False,
        },
        "input_artifacts": [artifact_entry(path) for path in INPUT_ARTIFACTS],
        "optional_backends": {
            "commands": [command_entry(name) for name in OPTIONAL_COMMANDS],
            "python_modules": [module_entry(name) for name in OPTIONAL_PYTHON_MODULES],
        },
        "candidate_tasks": [
            {
                "id": "memory-fabric-dse-environment",
                "status": "CAPTURED_NOT_EXECUTED",
                "target": "wrap E1 memory/interconnect phases as a Gym-like DSE environment",
                "acceptance_gates": [
                    "make memory-interconnect-contract-check",
                    "make memory-uma-claim-gate",
                ],
            },
            {
                "id": "noc-qos-simulator-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future NoC/BookSim traffic model for CPU, DMA, NPU, display, GPU/2D contention",
                "acceptance_gates": [
                    "make memory-interconnect-contract-check",
                    "make benchmark-sim-metrics",
                ],
            },
            {
                "id": "noc-inverse-ml-dse-watch",
                "status": "CAPTURED_NOT_TRAINED",
                "target": "future BookSim-generated NoC datasets, inverse MLP/CVAE/diffusion models, or target-latency/throughput parameter predictors require topology constraints, traffic traces, replayed simulator logs, and architecture review",
                "acceptance_gates": [
                    "make memory-interconnect-contract-check",
                    "make memory-uma-claim-gate",
                    "make benchmark-sim-metrics",
                ],
            },
            {
                "id": "lpddr-dram-simulator-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future Ramulator2/DRAMsim3/DRAMSys LPDDR timing and bandwidth exploration",
                "acceptance_gates": [
                    "make memory-uma-claim-gate",
                    "make memory-evidence-template-check",
                ],
            },
            {
                "id": "accelerator-system-simulator-watch",
                "status": "CAPTURED_NOT_MODELED",
                "target": "future gem5-Aladdin or Gem5-AcceSys style CPU/NPU/memory co-simulation",
                "acceptance_gates": [
                    "make chipyard-generated-linux-contract-check",
                    "make npu-runtime-contract-check",
                ],
            },
        ],
        "blocked_by": [
            "current RTL is an AXI-Lite SRAM-backed scaffold",
            "no cache hierarchy, coherent fabric, IOMMU/SMMU, LPDDR PHY, or QoS implementation",
            "no executable BookSim/Ramulator/gem5 backend selected or pinned",
            "no approved NoC inverse-ML dataset generation manifest, topology constraints, traffic trace corpus, or BookSim replay evidence",
            "no real target bandwidth, latency, Android shared-buffer, or contention evidence",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "targets_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.memory_interconnect.targets {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
