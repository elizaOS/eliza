#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / "scripts/check_cpu_npu_tapeout_readiness_audit.py"


def load_check_module():
    spec = importlib.util.spec_from_file_location("check_cpu_npu_tapeout_readiness_audit", CHECK)
    if spec is None or spec.loader is None:
        raise AssertionError("failed to load tapeout readiness audit module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_executable(path: Path, payload: bytes = b"#!/bin/sh\nexit 0\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def with_clean_path(func) -> None:
    original = os.environ.get("PATH")
    try:
        os.environ["PATH"] = ""
        func()
    finally:
        if original is None:
            os.environ.pop("PATH", None)
        else:
            os.environ["PATH"] = original


def test_repo_local_flow_tools_count_as_available() -> None:
    module = load_check_module()

    def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module.ROOT = root
            write_executable(root / "tools/bin/riscv64-unknown-elf-gcc")
            write_executable(root / "tools/bin/renode")
            write_executable(root / "external/oss-cad-suite/bin/verilator")
            write_executable(root / "external/oss-cad-suite/bin/yosys")

            for binary in (
                "riscv64-unknown-elf-gcc",
                "renode",
                "verilator",
                "yosys",
            ):
                available, path, reason = module.resolve_required_tool(binary)
                if not available:
                    raise AssertionError(f"{binary} was not available: {reason}")
                if not path.startswith(str(root)):
                    raise AssertionError(f"{binary} resolved outside repo tool paths: {path}")
                if reason != "available":
                    raise AssertionError(f"{binary} unexpected reason: {reason}")

    with_clean_path(run)


def test_host_smoke_benchmark_model_stays_blocked() -> None:
    module = load_check_module()

    def run() -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module.ROOT = root
            write_executable(
                root / "benchmarks/tools/benchmark_model",
                b"#!/bin/sh\n# eliza-host-smoke\nexit 0\n",
            )

            available, path, reason = module.resolve_required_tool("benchmark_model")
            if available:
                raise AssertionError("host smoke benchmark_model must not count as release tool")
            if not path.endswith("benchmarks/tools/benchmark_model"):
                raise AssertionError(f"missing host smoke path diagnostic: {path}")
            if reason != "repo_local_host_smoke_tool_not_release_evidence":
                raise AssertionError(f"unexpected blocker reason: {reason}")

    with_clean_path(run)


def test_benchmark_release_rows_enumerate_dry_run_blockers() -> None:
    module = load_check_module()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        module.ROOT = root
        module.DRY_RUN_REPORT = root / "benchmarks/results/dry-run/report.json"
        module.DRY_RUN_REPORT.parent.mkdir(parents=True)
        module.DRY_RUN_REPORT.write_text(
            json.dumps(
                {
                    "schema": "eliza.benchmark_run.v1",
                    "dry_run": True,
                    "results": [
                        {
                            "name": "tflite_e1_npu",
                            "status": "blocked",
                            "blocked_requirements": [],
                            "blocked_assets": [
                                {
                                    "kind": "capability_artifact",
                                    "name": "benchmarks/capabilities/e1_npu_nnapi.proof.json",
                                    "reason": "missing_capability_artifact",
                                }
                            ],
                            "dependencies": [
                                {
                                    "kind": "executable",
                                    "name": "benchmark_model",
                                    "available": True,
                                    "path": "/tmp/tools/bin/benchmark_model",
                                }
                            ],
                        },
                        {
                            "name": "npu_arch_sim_sota_2028",
                            "status": "planned",
                            "blocked_requirements": [],
                            "blocked_assets": [],
                            "dependencies": [],
                        },
                    ],
                }
            ),
            encoding="utf-8",
        )

        rows = module.benchmark_release_rows()
        by_id = {row["id"]: row for row in rows}
        if by_id["tflite_e1_npu"]["status"] != "blocked":
            raise AssertionError("tflite_e1_npu release benchmark must be blocked")
        if by_id["npu_arch_sim_sota_2028"]["status"] != "pass":
            raise AssertionError("simulator-only planned row should pass release-readiness audit")
        if by_id["tflite_e1_npu"]["blocked_requirement_names"] != [
            "benchmarks/capabilities/e1_npu_nnapi.proof.json",
        ]:
            raise AssertionError(by_id["tflite_e1_npu"]["blocked_requirement_names"])
        if by_id["tflite_e1_npu"]["rejected_host_smoke_tools"] != []:
            raise AssertionError(by_id["tflite_e1_npu"]["rejected_host_smoke_tools"])


def test_chipyard_preflight_summary_accepts_fallback_report() -> None:
    module = load_check_module()

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        module.ROOT = root
        report = root / "benchmarks/results/chipyard/bootstrap-preflight.json"
        module.CHIPYARD_IMPORT_PREFLIGHT_REPORTS = (
            root / "build/chipyard/eliza_rocket/bootstrap-preflight.json",
            report,
        )
        report.parent.mkdir(parents=True)
        report.write_text(
            json.dumps(
                {
                    "schema": "eliza.cpu_ap_bootstrap_preflight.v1",
                    "status": "pass",
                    "checkout": "external/chipyard",
                    "chipyard": {
                        "tag": "main-2026-05-20",
                        "commit": "48f904aefbb3903dce6efa7901982642853ae6a7",
                    },
                    "selected_path": {"config_name": "ElizaRocketConfig"},
                    "blockers": [],
                    "errors": [],
                }
            ),
            encoding="utf-8",
        )

        summary = module.chipyard_import_preflight_summary()
        if summary["status"] != "pass":
            raise AssertionError(summary)
        if summary["artifact"] != "benchmarks/results/chipyard/bootstrap-preflight.json":
            raise AssertionError(summary)


def test_tapeout_audit_declares_false_claim_flags() -> None:
    module = load_check_module()
    data = module.build_report()
    errors = module.validate_report(data)
    if errors:
        raise AssertionError(errors)
    if data.get("false_claim_flags") != module.FALSE_CLAIM_FLAGS:
        raise AssertionError(data.get("false_claim_flags"))
    for key, value in module.FALSE_CLAIM_FLAGS.items():
        if data.get(key) is not value:
            raise AssertionError(f"{key} drifted: {data.get(key)!r}")


def main() -> int:
    for test in (
        test_repo_local_flow_tools_count_as_available,
        test_host_smoke_benchmark_model_stays_blocked,
        test_benchmark_release_rows_enumerate_dry_run_blockers,
        test_chipyard_preflight_summary_accepts_fallback_report,
        test_tapeout_audit_declares_false_claim_flags,
    ):
        test()
        print(f"PASS {test.__name__}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
