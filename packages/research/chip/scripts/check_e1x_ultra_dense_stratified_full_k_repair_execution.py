#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "scripts/check_e1x_dense_stratified_full_k_repair_execution.py"

spec = importlib.util.spec_from_file_location("e1x_dense_stratified_gate", BASE)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not load {BASE}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
gate = cast(Any, module)

gate.REPORT = ROOT / "build/reports/e1x_ultra_dense_stratified_full_k_repair_execution.json"
gate.GATE = "e1x-ultra-dense-stratified-full-k-repair-execution"
gate.CHECK_PREFIX = "e1x_ultra_dense_stratified_full_k_repair_execution"
gate.LABEL = "ultra-dense stratified full-K repair execution"
gate.SCRIPT_EVIDENCE_PATH = "scripts/check_e1x_ultra_dense_stratified_full_k_repair_execution.py"
gate.ROWS_PER_LAYER = 64
gate.EXPECTED_ROWS = 18_112
gate.EXPECTED_MACS = 88_478_784
gate.MIN_TOUCHED_LOGICAL_CORES = 6_545


if __name__ == "__main__":
    raise SystemExit(gate.main())
