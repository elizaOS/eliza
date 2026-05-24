#!/usr/bin/env python3
"""Write the target-module BPU cocotb aggregate report.

The BPU result directory may contain auxiliary debug or MPKI XMLs. This report
counts only the 10 target-module suites that back the target regression claim.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
RESULT_DIR = ROOT / "verify/cocotb/bpu/results"
OUT = ROOT / "build/reports/bpu/cocotb-aggregate.json"

TARGET_RESULTS = {
    "ras": ("test_ras.py", "ras_tb_test_ras.xml"),
    "ftq": ("test_ftq.py", "ftq_tb_test_ftq.xml"),
    "ftb": ("test_ftb.py", "ftb_tb_test_ftb.xml"),
    "uftb": ("test_uftb.py", "uftb_tb_test_uftb.xml"),
    "loop_predictor": ("test_loop_predictor.py", "loop_predictor_tb_test_loop_predictor.xml"),
    "tage": ("test_tage.py", "tage_tb_test_tage.xml"),
    "ittage": ("test_ittage.py", "ittage_tb_test_ittage.xml"),
    "sc": ("test_sc.py", "sc_tb_test_sc.xml"),
    "l1i_frontend": (
        "test_bpu_l1i_frontend.py",
        "e1_bpu_l1i_frontend_tb_test_bpu_l1i_frontend.xml",
    ),
    "bpu_top": ("test_bpu_top.py", "bpu_top_tb_test_bpu_top.xml"),
}

EXPECTED_TOTAL = None


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def count_result(path: Path) -> dict[str, object]:
    if not path.exists():
        return {
            "status": "missing",
            "path": rel(path),
            "tests": 0,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
        }

    try:
        root = ElementTree.parse(path).getroot()
    except ElementTree.ParseError as exc:
        return {
            "status": "invalid_xml",
            "path": rel(path),
            "reason": str(exc),
            "tests": 0,
            "failures": 0,
            "errors": 0,
            "skipped": 0,
        }

    tests = len(root.findall(".//testcase"))
    failures = len(root.findall(".//failure"))
    errors = len(root.findall(".//error"))
    skipped = len(root.findall(".//skipped"))
    status = "pass" if tests > 0 and failures == 0 and errors == 0 else "blocked"
    return {
        "status": status,
        "path": rel(path),
        "tests": tests,
        "failures": failures,
        "errors": errors,
        "skipped": skipped,
    }


def cocotb_test_count(path: Path) -> int:
    module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    total = 0
    for node in module.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            try:
                text = ast.unparse(decorator)
            except Exception:
                text = ""
            if text == "cocotb.test" or text.startswith("cocotb.test("):
                total += 1
                break
    return total


def expected_counts() -> dict[str, int]:
    return {
        name: cocotb_test_count(ROOT / "verify/cocotb/bpu" / source)
        for name, (source, _result) in TARGET_RESULTS.items()
    }


def build_report() -> dict[str, object]:
    expected_by_module = expected_counts()
    expected_total = sum(expected_by_module.values())
    modules = {
        name: {
            **count_result(RESULT_DIR / result),
            "expected_tests": expected_by_module[name],
            "source": rel(ROOT / "verify/cocotb/bpu" / source),
        }
        for name, (source, result) in TARGET_RESULTS.items()
    }
    auxiliary = sorted(
        rel(path)
        for path in RESULT_DIR.glob("*.xml")
        if path.name not in {result for _source, result in TARGET_RESULTS.values()}
    )
    total_tests = sum(int(item["tests"]) for item in modules.values())
    total_failures = sum(int(item["failures"]) for item in modules.values())
    total_errors = sum(int(item["errors"]) for item in modules.values())
    missing = [name for name, item in modules.items() if item["status"] == "missing"]
    status = (
        "PASS"
        if not missing
        and total_tests == expected_total
        and all(int(item["tests"]) == int(item["expected_tests"]) for item in modules.values())
        and total_failures == 0
        and total_errors == 0
        else "BLOCKED"
    )
    return {
        "schema": "eliza.bpu_cocotb_aggregate.v1",
        "status": status,
        "as_of": datetime.now(UTC).isoformat(),
        "claim": f"{expected_total}/{expected_total} target-module BPU cocotb regression across 10 modules",
        "target_module_count": len(TARGET_RESULTS),
        "expected_total_tests": expected_total,
        "total_tests": total_tests,
        "total_failures": total_failures,
        "total_errors": total_errors,
        "missing_modules": missing,
        "modules": modules,
        "auxiliary_xml_ignored": auxiliary,
        "claim_boundary": (
            "Counts only target-module BPU correctness suites. Auxiliary debug, "
            "MPKI, or exploratory XMLs in verify/cocotb/bpu/results are excluded "
            f"from the {expected_total}/{expected_total} regression claim."
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    report = build_report()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"STATUS: {report['status']} bpu.cocotb_aggregate - "
        f"{report['total_tests']}/{report['expected_total_tests']} target tests, "
        f"failures={report['total_failures']} errors={report['total_errors']}"
    )
    print(f"  wrote {rel(OUT)}")
    return 1 if args.strict and report["status"] != "PASS" else 0


if __name__ == "__main__":
    sys.exit(main())
