#!/usr/bin/env python3
"""Create a dry-run RTLMUL-style RTL PPA advisory report from local evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_ROOT = ROOT / "build/ai_eda/rtlmul_ppa"
YOSYS_LOG = ROOT / "build/reports/e1_soc_yosys.log"
NETLIST = ROOT / "build/netlist/e1_chip_synth.v"
CLAIM_BOUNDARY = "advisory_ppa_target_capture_only_no_prediction_no_design_decision"

RTL_TARGETS = (
    ("e1_chip_top", "rtl/top/e1_chip_top.sv"),
    ("e1_soc_top", "rtl/top/e1_soc_top.sv"),
    ("e1_npu", "rtl/npu/e1_npu.sv"),
)


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def module_stat_block(text: str, module: str) -> str | None:
    pattern = re.compile(rf"=== {re.escape(module)} ===\n(?P<body>.*?)(?=\n=== |\Z)", re.DOTALL)
    matches = list(pattern.finditer(text))
    if not matches:
        return None
    return matches[-1].group("body")


def parse_count(body: str, label: str) -> int | None:
    match = re.search(rf"^\s*(\d+)\s+{re.escape(label)}$", body, re.MULTILINE)
    return int(match.group(1)) if match else None


def parse_cell_types(body: str) -> dict[str, int]:
    cell_types: dict[str, int] = {}
    for count, name in re.findall(
        r"^\s*(\d+)\s+(\$[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_$]*)$", body, re.MULTILINE
    ):
        if name in {
            "wires",
            "ports",
            "cells",
            "memories",
            "processes",
            "submodules",
        }:
            continue
        cell_types[name] = int(count)
    return cell_types


def yosys_module_summary(module: str) -> dict[str, Any]:
    if not YOSYS_LOG.is_file():
        return {"module": module, "status": "MISSING_YOSYS_LOG"}
    body = module_stat_block(YOSYS_LOG.read_text(errors="replace"), module)
    if body is None:
        return {"module": module, "status": "MISSING_MODULE_STATS"}
    return {
        "module": module,
        "status": "LOCAL_SYNTHESIS_STATS_CAPTURED",
        "wires": parse_count(body, "wires"),
        "wire_bits": parse_count(body, "wire bits"),
        "cells": parse_count(body, "cells"),
        "submodules": parse_count(body, "submodules"),
        "cell_types": parse_cell_types(body),
    }


def target_entry(module: str, path_text: str) -> dict[str, Any]:
    path = ROOT / path_text
    return {
        "module": module,
        "rtl_path": path_text,
        "rtl_sha256": sha256_file(path) if path.is_file() else None,
        "rtl_status": "PRESENT" if path.is_file() else "MISSING",
        "yosys_summary": yosys_module_summary(module),
        "prediction": None,
        "prediction_status": "NOT_RUN_NO_MODEL_WEIGHTS_LOADED",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--out-root", type=Path, default=DEFAULT_OUT_ROOT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    transformers_present = importlib.util.find_spec("transformers") is not None
    torch_present = importlib.util.find_spec("torch") is not None
    report = {
        "schema": "eliza.ai_eda.rtlmul_ppa_advisory.v1",
        "run_id": args.run_id,
        "created_at_utc": datetime.now(UTC).replace(microsecond=0).isoformat(),
        "mode": "dry-run",
        "status": "TARGET_CAPTURE_ONLY_NO_MODEL_EXECUTION",
        "claim_boundary": CLAIM_BOUNDARY,
        "source_ids": ["rtlmul"],
        "model_policy": {
            "model_url": "https://huggingface.co/stupid-zwl/rtlmul",
            "model_weights_downloaded": False,
            "model_loaded": False,
            "prediction_generated": False,
            "release_use_allowed": False,
            "license_review_required": True,
            "heldout_e1_error_analysis_required": True,
        },
        "local_backend": {
            "transformers_present": transformers_present,
            "torch_present": torch_present,
            "runnable_candidate": transformers_present and torch_present,
        },
        "input_artifacts": [
            {
                "path": rel(YOSYS_LOG),
                "status": "PRESENT" if YOSYS_LOG.is_file() else "MISSING",
                "sha256": sha256_file(YOSYS_LOG) if YOSYS_LOG.is_file() else None,
            },
            {
                "path": rel(NETLIST),
                "status": "PRESENT" if NETLIST.is_file() else "MISSING",
                "sha256": sha256_file(NETLIST) if NETLIST.is_file() else None,
            },
        ],
        "targets": [target_entry(module, path) for module, path in RTL_TARGETS],
        "required_followup_gates": [
            "make synth",
            "python3 scripts/check_ai_eda_source_inventory.py",
            "manual RTLMUL model-card and license review",
            "held-out E1 Yosys/OpenLane PPA error analysis",
        ],
        "blocked_by": [
            "model weights intentionally not downloaded",
            "no pinned RTLMUL revision",
            "no held-out E1 PPA validation set",
            "no approval to use predictor output for design decisions",
        ],
    }
    out_dir = (args.out_root / args.run_id).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "ppa_advisory_report.json"
    path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(f"STATUS: PASS ai_eda.rtlmul_ppa.advisory {rel(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
