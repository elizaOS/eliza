#!/usr/bin/env python3
"""Fail-closed gate for phone-class CPU benchmark claims.

This gate intentionally does not run SPEC, JetStream, CoreMark, Dhrystone,
or lmbench. It verifies that the artifacts which would justify a phone-class
CPU claim are present, schema-valid, non-blocked, and tied to a real L5/L6
benchmark report with raw-output hashes.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "benchmarks/run_benchmarks.py"
DEFAULT_REPORT = ROOT / "benchmarks/results/cpu-phone/report.json"
OUT = ROOT / "build/reports/cpu_phone_benchmark_claim_gate.json"

SIDE_RESULT_SPECS = {
    "spec_cpu2017": ROOT / "benchmarks/results/cpu/spec/result.json",
    "coremark": ROOT / "benchmarks/results/cpu/coremark/result.json",
    "dhrystone": ROOT / "benchmarks/results/cpu/dhrystone/result.json",
    "jetstream2": ROOT / "benchmarks/results/cpu/jetstream/result.json",
}
REQUIRED_REPORT_BENCHES = {"lmbench_bw_mem", "lmbench_lat_mem_rd"}
REQUIRED_CLAIM_LEVELS = {"L5_PROTOTYPE_SILICON", "L6_COMPLETE_PHONE"}
REQUIRED_SIDE_SCHEMA = "eliza.cpu_benchmark_result.v1"
CPU_PHONE_REPORT_COMMAND = (
    "python3 benchmarks/run_benchmarks.py run --report-id cpu-phone "
    "--bench lmbench_bw_mem --bench lmbench_lat_mem_rd "
    "--platform e1-phone-prototype --platform-revision <prototype-or-phone-revision> "
    "--claim-level L5_PROTOTYPE_SILICON "
    "--metadata benchmarks/metadata/<real-target-metadata>.json --strict-missing"
)
CPU_PHONE_REPORT_REQUIREMENTS = (
    "Requires target-built bw_mem and lat_mem_rd on PATH, a real target metadata JSON "
    "with software/clocks/memory/thermal/power/process/calibration sections, and "
    "calibrated clock_source, power_meter, lmbench_binary, and memory_model assets."
)


def summarize_blocked_requirements(result: dict[str, Any], limit: int = 8) -> str | None:
    requirements = result.get("blocked_requirements")
    if not isinstance(requirements, list):
        return None
    names: list[str] = []
    for item in requirements:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        reason = item.get("reason")
        if not isinstance(name, str) or not name:
            continue
        names.append(f"{name} ({reason})" if isinstance(reason, str) and reason else name)
    if not names:
        return None
    shown = names[:limit]
    remaining = len(names) - len(shown)
    suffix = f"; +{remaining} more" if remaining > 0 else ""
    return "; ".join(shown) + suffix


def load_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return None, "missing"
    except json.JSONDecodeError as exc:
        return None, f"invalid_json:{exc}"
    if not isinstance(data, dict):
        return None, "not_object"
    return data, None


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def load_benchmark_runner():
    spec = importlib.util.spec_from_file_location("run_benchmarks", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to import {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def side_result_findings() -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for name, path in SIDE_RESULT_SPECS.items():
        data, error = load_json(path)
        base = {"name": name, "path": rel(path)}
        if error is not None:
            findings.append({**base, "status": "missing_or_invalid", "reason": error})
            continue
        assert data is not None
        if data.get("schema") != REQUIRED_SIDE_SCHEMA:
            findings.append(
                {
                    **base,
                    "status": "invalid",
                    "reason": f"schema must be {REQUIRED_SIDE_SCHEMA}",
                }
            )
            continue
        status = data.get("status")
        if status != "passed":
            findings.append(
                {
                    **base,
                    "status": "blocked",
                    "reason": str(data.get("reason") or data.get("missing_dependency") or status),
                    "record_status": status,
                }
            )
            continue
        findings.append({**base, "status": "pass", "record_status": status})
    return findings


def report_findings(report_path: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    data, error = load_json(report_path)
    if error is not None:
        return [
            {
                "name": "benchmark_report",
                "path": rel(report_path),
                "status": "missing_or_invalid",
                "reason": error,
                "next_command": CPU_PHONE_REPORT_COMMAND,
                "requirements": CPU_PHONE_REPORT_REQUIREMENTS,
            }
        ]
    assert data is not None

    runner = load_benchmark_runner()
    validation_errors = runner.validate_report(data)
    if validation_errors:
        findings.append(
            {
                "name": "benchmark_report_schema",
                "path": rel(report_path),
                "status": "invalid",
                "reason": "; ".join(validation_errors),
            }
        )

    claim_level = data.get("claim_level")
    if claim_level not in REQUIRED_CLAIM_LEVELS:
        findings.append(
            {
                "name": "benchmark_report_claim_level",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "claim_level must be L5_PROTOTYPE_SILICON or L6_COMPLETE_PHONE",
                "claim_level": claim_level,
            }
        )

    if data.get("dry_run") is not False:
        findings.append(
            {
                "name": "benchmark_report_dry_run",
                "path": rel(report_path),
                "status": "blocked",
                "reason": "phone-class claim report must be a real run, not dry-run",
            }
        )

    results = {
        item.get("name"): item for item in data.get("results", []) if isinstance(item, dict)
    }
    for bench in sorted(REQUIRED_REPORT_BENCHES):
        result = results.get(bench)
        if result is None:
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "missing",
                    "reason": "required lmbench result absent from report",
                }
            )
            continue
        if result.get("status") != "passed":
            blocked_summary = summarize_blocked_requirements(result)
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "blocked",
                    "reason": f"result status is {result.get('status')!r}",
                    **(
                        {"blocked_requirements_summary": blocked_summary}
                        if blocked_summary
                        else {}
                    ),
                }
            )
            continue
        artifacts = result.get("artifacts")
        if not isinstance(artifacts, dict) or not isinstance(
            artifacts.get("raw_output_sha256"), str
        ):
            findings.append(
                {
                    "name": bench,
                    "path": rel(report_path),
                    "status": "invalid",
                    "reason": "passed result must include artifacts.raw_output_sha256",
                }
            )
            continue
        findings.append({"name": bench, "path": rel(report_path), "status": "pass"})
    return findings


def build_report(report_path: Path) -> dict[str, Any]:
    side_findings = side_result_findings()
    bench_findings = report_findings(report_path)
    findings = side_findings + bench_findings
    blocked = [item for item in findings if item.get("status") != "pass"]
    status = "pass" if not blocked else "blocked"
    return {
        "schema": "eliza.cpu_phone_benchmark_claim_gate.v1",
        "status": status,
        "claim_allowed": status == "pass",
        "claim_boundary": (
            "Phone-class CPU benchmark claims require non-blocked SPEC CPU 2017, "
            "CoreMark, Dhrystone, JetStream 2, lmbench bandwidth, lmbench latency, "
            "real target metadata, and raw-output hashes at L5 prototype silicon "
            "or L6 complete phone claim level."
        ),
        "required_side_results": {name: rel(path) for name, path in SIDE_RESULT_SPECS.items()},
        "required_report": rel(report_path),
        "required_report_benchmarks": sorted(REQUIRED_REPORT_BENCHES),
        "findings": findings,
        "blocked_count": len(blocked),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return 2 while required phone-class benchmark evidence is blocked.",
    )
    args = parser.parse_args()

    report_path = args.report if args.report.is_absolute() else ROOT / args.report
    report = build_report(report_path)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if report["status"] == "pass":
        print("STATUS: PASS cpu.phone_benchmark_claim_gate - phone-class CPU evidence present")
        return 0

    print(
        "STATUS: BLOCKED cpu.phone_benchmark_claim_gate - "
        "phone-class CPU benchmark claim is not backed by required evidence"
    )
    for finding in report["findings"]:
        if finding.get("status") != "pass":
            print(f"  - {finding['name']}: {finding['status']} ({finding.get('reason')})")
    print(f"  wrote {rel(OUT)}")
    return 2 if args.strict else 0


if __name__ == "__main__":
    raise SystemExit(main())
