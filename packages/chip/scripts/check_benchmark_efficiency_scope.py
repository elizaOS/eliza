#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
REPORT_SCHEMA = ROOT / "docs/benchmarks/report-schema.yaml"
TARGET_METADATA_EXAMPLE = ROOT / "benchmarks/configs/target-metadata.example.json"
RUNNER = ROOT / "benchmarks/run_benchmarks.py"
CALIBRATION_TEST = ROOT / "scripts/test_benchmark_calibration.py"
PARSER_TEST = ROOT / "scripts/test_benchmark_parsers.py"
MAKEFILE = ROOT / "Makefile"
OUT = ROOT / "build/reports/benchmark_efficiency_scope.json"

REQUIRED_REAL_BENCHMARKS = {
    "coremark",
    "stream",
    "lmbench_bw_mem",
    "lmbench_lat_mem_rd",
    "fio_seq_read",
    "fio_rand_rw",
    "tflite_cpu",
    "tflite_e1_npu",
}
REQUIRED_SIMULATOR_BENCHMARKS = {
    "npu_arch_sim_open_2028",
    "npu_arch_sim_sota_2028",
    "simulator_arch_metrics",
    "cpu_arch_sim_sota_2028",
    "simulator_energy_metrics_timeloop",
}
REQUIRED_REAL_METADATA = {
    "software",
    "clocks",
    "memory",
    "thermal",
    "power",
    "process",
    "calibration",
}
REQUIRED_REAL_CALIBRATION_ASSETS = {
    "clock_source",
    "power_meter",
}
FORBIDDEN_SIMULATOR_SCORE_METRICS = {
    "wall_clock_score",
    "phone_score",
    "geekbench_score",
}
ZERO_SHA256 = "0" * 64


def rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def contains_all(text: str, tokens: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return all(token.lower() in lowered for token in tokens)


def mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def list_values(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def bench_by_name(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for bench in list_values(plan.get("benchmarks")):
        if isinstance(bench, dict) and isinstance(bench.get("name"), str):
            result[bench["name"]] = bench
    return result


def plan_real_entries_are_calibrated(benches: dict[str, dict[str, Any]]) -> bool:
    for name in REQUIRED_REAL_BENCHMARKS:
        bench = benches.get(name)
        if not bench:
            return False
        metadata = set(str(item) for item in list_values(bench.get("required_metadata")))
        assets = set(str(item) for item in list_values(bench.get("required_calibration_assets")))
        if not metadata >= REQUIRED_REAL_METADATA:
            return False
        if not assets >= REQUIRED_REAL_CALIBRATION_ASSETS:
            return False
        if not list_values(bench.get("required_metrics")):
            return False
    return True


def plan_simulator_entries_are_bounded(benches: dict[str, dict[str, Any]]) -> bool:
    for name in REQUIRED_SIMULATOR_BENCHMARKS:
        bench = benches.get(name)
        if not bench:
            return False
        metrics = set(str(item) for item in list_values(bench.get("required_metrics")))
        if bench.get("provenance") != "simulator":
            return False
        if metrics & FORBIDDEN_SIMULATOR_SCORE_METRICS:
            return False
        if name == "simulator_energy_metrics_timeloop":
            install = str(bench.get("install", "")).lower()
            if "modeled joules-per-inference only" not in install:
                return False
    return True


def schema_has_efficiency_release_guards(schema: dict[str, Any], text: str) -> bool:
    required_fields = mapping(schema.get("required_fields"))
    result_fields = mapping(mapping(required_fields.get("results")).get("item"))
    optional_result_fields = mapping(schema.get("optional_result_fields"))
    return (
        mapping(required_fields.get("clocks")).get("cpu_hz") == "number"
        and mapping(required_fields.get("power")).get("watts") == "number"
        and mapping(required_fields.get("thermal")).get("die_c") == "number"
        and mapping(required_fields.get("calibration")).get("assets", {}).get("type") == "object"
        and result_fields.get("artifacts", {}).get("raw_output") == "string"
        and "energy_joules_per_inference" in optional_result_fields
        and contains_all(
            text,
            (
                "Real reports (`dry_run: false`) must include populated software, clocks, memory, thermal, and power metadata",
                "Passed real results must include `calibration.status: calibrated`",
                "64-character lowercase SHA-256 hex digest",
                "Simulator wall-clock time must not be compared against commercial phone scores",
                "Simulator-only metrics must use provenance `simulator`, claim level L0-L2",
                "FPGA power must not be reported as mobile SoC power",
                "fabricate the energy value",
            ),
        )
    )


def target_metadata_example_is_non_release(metadata: dict[str, Any]) -> bool:
    calibration = mapping(metadata.get("calibration"))
    assets = mapping(calibration.get("assets"))
    clock = mapping(assets.get("clock_source"))
    power_meter = mapping(assets.get("power_meter"))
    process_contract = mapping(mapping(metadata.get("process")).get("process_effects_contract"))
    return (
        mapping(metadata.get("clocks")).get("cpu_hz") == 0
        and mapping(metadata.get("power")).get("sample_count") == 0
        and clock.get("source") == "example-clock-readback-log"
        and power_meter.get("source") == "example-meter-calibration-record"
        and process_contract.get("sha256") == ZERO_SHA256
    )


def runner_enforces_release_boundaries(text: str) -> bool:
    return contains_all(
        text,
        (
            "passed with non-release dependency",
            "benchmark_success_allowed",
            "wall_clock_score",
            "phone_score",
            "geekbench_score",
            "not calibrated benchmark evidence",
            "calibration.last_calibrated_utc",
            "energy_joules_per_inference",
            "copy.deepcopy(energy_metadata)",
        ),
    )


def local_regression_targets_are_wired(makefile: str) -> bool:
    return contains_all(
        makefile,
        (
            "benchmark-calibration-test:",
            "scripts/test_benchmark_calibration.py",
            "benchmark-parser-test:",
            "scripts/test_benchmark_parsers.py",
            "benchmark-modeled-artifacts:",
            "benchmark-sim-metrics-test",
        ),
    )


def build_report() -> dict[str, Any]:
    plan = load_json_object(BENCHMARK_PLAN)
    schema = load_yaml_object(REPORT_SCHEMA)
    metadata = load_json_object(TARGET_METADATA_EXAMPLE)
    schema_text = REPORT_SCHEMA.read_text(encoding="utf-8")
    runner_text = RUNNER.read_text(encoding="utf-8")
    makefile = MAKEFILE.read_text(encoding="utf-8")
    benches = bench_by_name(plan)

    checks = [
        {
            "id": "benchmark_plan_covers_real_phone_efficiency_suites",
            "status": "pass"
            if set(benches) >= REQUIRED_REAL_BENCHMARKS
            and plan_real_entries_are_calibrated(benches)
            else "fail",
            "evidence": rel(BENCHMARK_PLAN),
        },
        {
            "id": "benchmark_plan_separates_simulator_model_evidence",
            "status": "pass" if plan_simulator_entries_are_bounded(benches) else "fail",
            "evidence": rel(BENCHMARK_PLAN),
        },
        {
            "id": "report_schema_requires_calibrated_efficiency_metadata",
            "status": "pass"
            if schema_has_efficiency_release_guards(schema, schema_text)
            else "fail",
            "evidence": rel(REPORT_SCHEMA),
        },
        {
            "id": "target_metadata_example_cannot_be_release_evidence",
            "status": "pass" if target_metadata_example_is_non_release(metadata) else "fail",
            "evidence": rel(TARGET_METADATA_EXAMPLE),
        },
        {
            "id": "benchmark_runner_fails_closed_for_efficiency_claims",
            "status": "pass" if runner_enforces_release_boundaries(runner_text) else "fail",
            "evidence": rel(RUNNER),
        },
        {
            "id": "benchmark_regression_tests_cover_calibration_and_parsers",
            "status": "pass"
            if CALIBRATION_TEST.is_file()
            and PARSER_TEST.is_file()
            and local_regression_targets_are_wired(makefile)
            else "fail",
            "evidence": rel(MAKEFILE),
        },
    ]
    return {
        "schema": "eliza.benchmark_efficiency_scope.v1",
        "status": "benchmark_efficiency_scope_release_blocked",
        "claim_boundary": (
            "Benchmark efficiency scope audit only; not calibrated target benchmark evidence, "
            "not prototype-silicon evidence, not complete-phone evidence, not measured TOPS/W "
            "evidence, not measured joules-per-inference evidence, not commercial phone "
            "comparison evidence, and not a release efficiency claim."
        ),
        "current_scaffolds": {
            "benchmark_plan": rel(BENCHMARK_PLAN),
            "report_schema": rel(REPORT_SCHEMA),
            "target_metadata_example": rel(TARGET_METADATA_EXAMPLE),
            "runner": rel(RUNNER),
            "calibration_regression_test": rel(CALIBRATION_TEST),
            "parser_regression_test": rel(PARSER_TEST),
        },
        "blocked_until_real_evidence": [
            "prototype-silicon or complete-phone target identity, board serial, SoC revision, and OS/BSP build ID",
            "schema-valid benchmark report generated with dry_run false and claim level L5 or L6 as appropriate",
            "calibrated clock-source records with SHA-256 artifact hashes for every passing result",
            "calibrated power-meter records, raw power traces, and integration-window metadata",
            "thermal traces aligned to the benchmark window with die/package/ambient readings and throttle state",
            "memory configuration and bandwidth/latency metadata from the target, not simulator defaults",
            "raw benchmark stdout/log/report artifacts with SHA-256 hashes and parser-derived metrics",
            "NPU NNAPI proof showing e1-npu selection, zero unsupported ops, and zero CPU fallback",
            "reviewer confirmation that simulator wall-clock, host-smoke tools, and FPGA power are excluded from phone efficiency comparisons",
        ],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
        },
    }


def validate_report(data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    require(data.get("schema") == "eliza.benchmark_efficiency_scope.v1", "schema mismatch", errors)
    require(
        data.get("status") == "benchmark_efficiency_scope_release_blocked",
        "status must remain benchmark_efficiency_scope_release_blocked",
        errors,
    )
    boundary = str(data.get("claim_boundary", ""))
    for token in (
        "not calibrated target benchmark evidence",
        "not prototype-silicon",
        "not complete-phone",
        "not measured TOPS/W",
        "not measured joules-per-inference",
        "not commercial phone comparison",
        "not a release efficiency claim",
    ):
        require(token in boundary, f"claim boundary missing {token}", errors)
    summary = data.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be a mapping")
        return errors
    require(
        summary.get("release_claim_allowed") is False,
        "release_claim_allowed must stay false",
        errors,
    )
    checks = data.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty list")
        return errors
    for check in checks:
        if not isinstance(check, dict):
            errors.append("checks entries must be mappings")
            continue
        if check.get("status") != "pass":
            errors.append(f"{check.get('id')}: must pass structural scope check")
    blocked = data.get("blocked_until_real_evidence")
    if not isinstance(blocked, list) or len(blocked) < 8:
        errors.append("benchmark efficiency scope must enumerate blocked real-evidence items")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "benchmark_plan",
            "report_schema",
            "target_metadata_example",
            "runner",
            "calibration_regression_test",
            "parser_regression_test",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    return errors


def main() -> int:
    report = build_report()
    errors = validate_report(report)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    print(f"Benchmark efficiency scope check passed: {rel(OUT)} remains release-blocked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
