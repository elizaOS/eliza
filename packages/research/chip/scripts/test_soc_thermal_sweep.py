#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIM = ROOT / "benchmarks/sim/run_soc_thermal_sweep.py"
CHECKER = ROOT / "scripts/check_soc_thermal_sweep.py"

spec = importlib.util.spec_from_file_location("check_soc_thermal_sweep", CHECKER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {CHECKER}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def run_sim(out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SIM), "--out", str(out)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_sweep_checker_passes() -> None:
    result = subprocess.run(
        [sys.executable, str(CHECKER)],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout)
    if "modeled-only" not in result.stdout:
        raise AssertionError(result.stdout)


def test_generated_sweep_has_no_phone_score_and_all_corners() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "benchmarks/results/test-temp") as td:
        out = Path(td) / "soc-sweep.json"
        result = run_sim(out)
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        data = json.loads(out.read_text(encoding="utf-8"))

    if {"phone_score", "geekbench_score", "wall_clock_score"} & set(data):
        raise AssertionError("forbidden comparable score present")
    flags = {key: value for key, value in data.items() if key.endswith("_claim_allowed")}
    if not flags or any(value is not False for value in flags.values()):
        raise AssertionError(flags)
    errors = checker.check_report(data)
    if errors:
        raise AssertionError("\n".join(errors))
    if data["summary"]["process_corner_count"] != 4:
        raise AssertionError("expected four process corners")


def test_release_use_drift_is_rejected() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "benchmarks/results/test-temp") as td:
        out = Path(td) / "soc-sweep.json"
        result = run_sim(out)
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        data = json.loads(out.read_text(encoding="utf-8"))

    data["process_corners"][0]["scenarios"][0]["release_use"] = "release_allowed"
    errors = checker.check_report(data)
    if not any("release_use must prohibit" in error for error in errors):
        raise AssertionError("\n".join(errors))


def main() -> int:
    temp_parent = ROOT / "benchmarks/results/test-temp"
    temp_parent.mkdir(parents=True, exist_ok=True)
    for test in (
        test_sweep_checker_passes,
        test_generated_sweep_has_no_phone_score_and_all_corners,
        test_release_use_drift_is_rejected,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
