#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "build/reports/e1x_core_cocotb.json"
PE_CORE_REPORT = ROOT / "build/reports/e1x_pe_core_cocotb.json"
GENERATED_MODEL_SHARD_SAMPLE_JSON = (
    ROOT / "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json"
)
RUNS = {
    "tiny_core": {
        "top": "e1x_tiny_core_tb",
        "module": "test_e1x_tiny_core",
        "result": ROOT / "verify/cocotb/results/e1x_tiny_core_tb_test_e1x_tiny_core.xml",
        "expected": {
            "tiny_core_executes_minimal_rv64i_integer_program",
            "tiny_core_accumulates_wavelets_into_local_register",
            "tiny_core_ecall_halts_fetch_and_wavelet_ingress",
        },
    },
    "local_sram_shard_loader": {
        "top": "e1x_local_sram_shard_loader_tb",
        "module": "test_e1x_local_sram_shard_loader",
        "result": ROOT
        / "verify/cocotb/results/e1x_local_sram_shard_loader_tb_test_e1x_local_sram_shard_loader.xml",
        "expected": {
            "local_sram_loader_accepts_quantized_weight_shard_and_reports_checksum",
            "local_sram_loader_flags_out_of_capacity_shard_write_and_clear_recovers",
        },
    },
    "generated_model_shard_loader": {
        "top": "e1x_local_sram_shard_loader_tb",
        "module": "test_e1x_generated_model_shard_loader",
        "result": ROOT
        / "verify/cocotb/results/e1x_local_sram_shard_loader_tb_test_e1x_generated_model_shard_loader.xml",
        "expected": {
            "generated_high_failure_model_shard_loads_into_rtl_local_sram",
        },
        "env": {
            "E1X_MODEL_SHARD_SAMPLE_JSON": str(GENERATED_MODEL_SHARD_SAMPLE_JSON),
        },
    },
}


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_generated_model_shard_sample() -> None:
    if GENERATED_MODEL_SHARD_SAMPLE_JSON.is_file():
        return
    subprocess.run(
        ["scripts/generate_e1x_scaled_model_evidence.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    )


def run_cocotb(top: str, module: str, extra_env: dict[str, str] | None = None) -> tuple[bool, str]:
    env = os.environ.copy()
    env["COCOTB_DIR"] = "verify/cocotb/e1x"
    env["COCOTB_TOPLEVEL"] = top
    env["COCOTB_MODULE"] = module
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        ["scripts/run_cocotb.sh"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:]
    return True, "cocotb command completed"


def parse_results(result_xml: Path, expected_tests: set[str]) -> tuple[bool, str, dict[str, int]]:
    if not result_xml.is_file():
        return False, f"missing cocotb result {result_xml.relative_to(ROOT)}", {}
    root = ET.fromstring(result_xml.read_text(encoding="utf-8", errors="ignore"))
    cases = list(root.iter("testcase"))
    names = {case.attrib.get("name", "") for case in cases}
    failures = sum(1 for case in cases if case.find("failure") is not None)
    errors = sum(1 for case in cases if case.find("error") is not None)
    missing = sorted(expected_tests - names)
    counts = {
        "testcases": len(cases),
        "failures": failures,
        "errors": errors,
        "missing_expected_tests": len(missing),
    }
    if failures or errors or missing:
        return False, f"failures={failures} errors={errors} missing={','.join(missing)}", counts
    return True, f"{len(cases)} E1X tiny-core cocotb tests passed", counts


def run_pe_core_gate() -> tuple[bool, str, dict[str, int]]:
    proc = subprocess.run(
        [sys.executable, "scripts/check_e1x_pe_core_cocotb.py"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        return False, (proc.stderr.strip() or proc.stdout.strip())[-1200:], {}
    if not PE_CORE_REPORT.is_file():
        return False, f"missing PE-core report {PE_CORE_REPORT.relative_to(ROOT)}", {}
    report = json.loads(PE_CORE_REPORT.read_text(encoding="utf-8"))
    summary = report.get("summary", {})
    counts = {
        "testcases": int(summary.get("testcases", 0)),
        "failures": int(summary.get("failures", 0)),
        "errors": int(summary.get("errors", 0)),
        "missing_expected_tests": int(summary.get("missing_expected_tests", 0)),
    }
    if report.get("status") != "PASS":
        return False, f"PE-core gate status={report.get('status')}", counts
    return True, f"{counts['testcases']} E1X PE-core cocotb tests passed", counts


def main() -> int:
    ensure_generated_model_shard_sample()
    checks = []
    aggregate_counts = {"testcases": 0, "failures": 0, "errors": 0, "missing_expected_tests": 0}
    for run_id, run in RUNS.items():
        extra_env = run.get("env")
        if extra_env is not None and not isinstance(extra_env, dict):
            raise TypeError("invalid E1X core cocotb env table")
        command_ok, command_detail = run_cocotb(
            str(run["top"]),
            str(run["module"]),
            {str(key): str(value) for key, value in extra_env.items()} if extra_env else None,
        )
        result_path = run["result"]
        expected = run["expected"]
        if not isinstance(result_path, Path) or not isinstance(expected, set):
            raise TypeError("invalid E1X core cocotb run table")
        results_ok, results_detail, counts = (
            parse_results(result_path, expected) if command_ok else (False, "not run", {})
        )
        for key in aggregate_counts:
            aggregate_counts[key] += int(counts.get(key, 0))
        checks.extend(
            [
                {
                    "id": f"e1x_{run_id}_cocotb_command",
                    "status": "pass" if command_ok else "fail",
                    "detail": command_detail,
                },
                {
                    "id": f"e1x_{run_id}_cocotb_results",
                    "status": "pass" if results_ok else "fail",
                    "detail": results_detail,
                },
            ]
        )
    pe_core_ok, pe_core_detail, pe_core_counts = run_pe_core_gate()
    for key in aggregate_counts:
        aggregate_counts[key] += int(pe_core_counts.get(key, 0))
    checks.append(
        {
            "id": "e1x_pe_core_cocotb_gate",
            "status": "pass" if pe_core_ok else "fail",
            "detail": pe_core_detail,
        }
    )
    failures = [check for check in checks if check["status"] != "pass"]
    report = {
        "schema": "eliza.gate_status.v1",
        "gate": "e1x-core-cocotb",
        "status": "PASS" if not failures else "BLOCKED",
        "as_of": datetime.now(UTC).isoformat(),
        "generated_utc": utc_now(),
        "subsystem": "e1x",
        "claim_boundary": "E1X core cocotb verification covers the legacy tiny-core tile contract, local SRAM shard loading, generated model-shard loading, and standalone RV64IM_Zicsr_Zifencei PE-core execution tests; not full RISC-V compliance, full model compiler/runtime, PD, DFT, package, or silicon evidence.",
        "evidence_paths": [
            "rtl/e1x/e1x_tiny_core_contract.sv",
            "rtl/e1x/e1x_pe_core.sv",
            "rtl/e1x/e1x_local_sram_shard_loader.sv",
            "verify/cocotb/e1x/e1x_tiny_core_tb.sv",
            "verify/cocotb/e1x/e1x_local_sram_shard_loader_tb.sv",
            "verify/cocotb/e1x_core_full/e1x_pe_core_tb.sv",
            "verify/cocotb/e1x/test_e1x_tiny_core.py",
            "verify/cocotb/e1x/test_e1x_local_sram_shard_loader.py",
            "verify/cocotb/e1x/test_e1x_generated_model_shard_loader.py",
            "verify/cocotb/e1x_core_full/test_e1x_pe_core.py",
            "benchmarks/results/e1x-scaled-8gb-model-load.high_failure_model_shard_sample.json",
            "verify/cocotb/results/e1x_tiny_core_tb_test_e1x_tiny_core.xml",
            "verify/cocotb/results/e1x_local_sram_shard_loader_tb_test_e1x_local_sram_shard_loader.xml",
            "verify/cocotb/results/e1x_local_sram_shard_loader_tb_test_e1x_generated_model_shard_loader.xml",
            "verify/cocotb/results/e1x_pe_core_tb_test_e1x_pe_core.xml",
            "build/reports/e1x_pe_core_cocotb.json",
        ],
        "checks": checks,
        "summary": {
            **aggregate_counts,
            "check_count": len(checks),
            "failing_check_count": len(failures),
        },
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if failures:
        print("BLOCKED: E1X core cocotb failed: " + ", ".join(c["id"] for c in failures))
        return 1
    print(f"PASS: E1X core cocotb; report {REPORT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
