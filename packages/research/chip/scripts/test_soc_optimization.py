#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPT = ROOT / "benchmarks/sim/optimize_soc_operating_point.py"
CHECKER = ROOT / "scripts/check_soc_optimization.py"

spec = importlib.util.spec_from_file_location("check_soc_optimization", CHECKER)
if spec is None or spec.loader is None:
    raise RuntimeError(f"could not import {CHECKER}")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def run_optimizer(out: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(OPT), "--out", str(out), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )


def test_optimizer_checker_passes() -> None:
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
    if "no-throttle" not in result.stdout:
        raise AssertionError(result.stdout)


def test_optimizer_selects_feasible_no_throttle_point() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "benchmarks/results/test-temp") as td:
        out = Path(td) / "optimized.json"
        result = run_optimizer(out)
        if result.returncode != 0:
            raise AssertionError(result.stdout)
        data = json.loads(out.read_text(encoding="utf-8"))

    errors = checker.check_report(data)
    if errors:
        raise AssertionError("\n".join(errors))
    flags = {key: value for key, value in data.items() if key.endswith("_claim_allowed")}
    if not flags or any(value is not False for value in flags.values()):
        raise AssertionError(flags)
    optimized = data["optimized"]["summary"]
    baseline = data["baseline"]["summary"]
    if optimized["any_modeled_throttle_required"]:
        raise AssertionError("optimized point still throttles")
    if optimized["max_die_temp_c"] >= baseline["max_die_temp_c"]:
        raise AssertionError("optimized point did not reduce max die temperature")
    if optimized["min_bandwidth_margin_gbps"] <= baseline["min_bandwidth_margin_gbps"]:
        raise AssertionError("optimized point did not improve bandwidth margin")
    robustness = data["robustness"]["summary"]
    if not robustness["pass"]:
        raise AssertionError("optimized point does not pass guardband robustness")
    if robustness["min_bandwidth_margin_gbps"] < 0:
        raise AssertionError("robust optimized point has negative guardband bandwidth margin")
    if robustness["min_npu_int8_tops"] < 20:
        raise AssertionError("robust optimized point drops below NPU TOPS floor")


def test_unreachable_constraints_fail_closed() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT / "benchmarks/results/test-temp") as td:
        out = Path(td) / "unreachable.json"
        result = run_optimizer(out, "--max-die-c", "40", "--min-npu-tops", "80")
    if result.returncode == 0:
        raise AssertionError("unreachable constraints unexpectedly passed")
    if "no feasible operating point" not in result.stdout:
        raise AssertionError(result.stdout)


def main() -> int:
    (ROOT / "benchmarks/results/test-temp").mkdir(parents=True, exist_ok=True)
    for test in (
        test_optimizer_checker_passes,
        test_optimizer_selects_feasible_no_throttle_point,
        test_unreachable_constraints_fail_closed,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
