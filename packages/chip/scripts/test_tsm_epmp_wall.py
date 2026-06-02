#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_tsm_epmp_wall.py"

spec = importlib.util.spec_from_file_location("check_tsm_epmp_wall", CHECK)
if spec is None or spec.loader is None:
    raise SystemExit(f"unable to import {CHECK}")
check_tsm_epmp_wall = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_tsm_epmp_wall
spec.loader.exec_module(check_tsm_epmp_wall)


def test_provenance_safe_sanitizes_cocotb_host_paths() -> None:
    raw = {
        "detail": (
            "no results_tsm_epmp.xml; cocotb/verilator unavailable. "
            "/home/shaw/.local/lib/python3.12/site-packages/cocotb/share/"
            "makefiles/simulators/Makefile.verilator:28: "
            "*** Unable to locate command >verilator<. Stop."
        )
    }
    sanitized = check_tsm_epmp_wall.provenance_safe(raw)
    detail = sanitized["detail"]
    if "/home/shaw" in detail:
        raise AssertionError(detail)
    if "Makefile.verilator:28:" not in detail:
        raise AssertionError(detail)
    if "Unable to locate command >verilator<" not in detail:
        raise AssertionError(detail)


def main() -> int:
    test_provenance_safe_sanitizes_cocotb_host_paths()
    print("PASS test_provenance_safe_sanitizes_cocotb_host_paths")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
