#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from chip_utils import load_json_object, load_yaml_object, require

ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PLAN = ROOT / "benchmarks/configs/benchmark_plan.json"
REPORT_SCHEMA = ROOT / "docs/benchmarks/report-schema.yaml"
TARGET_METADATA_EXAMPLE = ROOT / "benchmarks/configs/target-metadata.example.json"
TARGET_METADATA_CONTRACT = ROOT / "benchmarks/configs/target-metadata.contract.json"
RUNNER = ROOT / "benchmarks/run_benchmarks.py"
CALIBRATION_TEST = ROOT / "scripts/test_benchmark_calibration.py"
PARSER_TEST = ROOT / "scripts/test_benchmark_parsers.py"
MAKEFILE = ROOT / "Makefile"
AP_BENCHMARK_WIRING_REPORT = ROOT / "build/reports/cpu_ap_benchmark_runner_wiring.json"
OUT = ROOT / "build/reports/benchmark_efficiency_scope.json"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "calibrated_target_benchmark_claim_allowed": False,
    "prototype_silicon_claim_allowed": False,
    "complete_phone_claim_allowed": False,
    "measured_tops_w_claim_allowed": False,
    "measured_joules_per_inference_claim_allowed": False,
    "commercial_phone_comparison_claim_allowed": False,
    "release_efficiency_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

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
REAL_METADATA_REQUIRED_FIELDS: dict[str, dict[str, Any]] = {
    "software": {
        "os": str,
        "kernel": str,
        "firmware": str,
        "runtime": str,
        "build_id": str,
    },
    "clocks": {
        "source": str,
        "cpu_hz": (int, float),
        "npu_hz": (int, float),
        "memory_hz": (int, float),
        "governor": str,
    },
    "memory": {
        "type": str,
        "capacity_bytes": int,
        "bandwidth_bytes_per_second": (int, float),
        "channels": int,
    },
    "thermal": {
        "ambient_c": (int, float),
        "die_c": (int, float),
        "cooling": str,
        "throttle_state": str,
    },
    "power": {
        "source": str,
        "watts": (int, float),
        "measurement_method": str,
        "sample_count": int,
        "averaging_window_seconds": (int, float),
    },
    "process": {
        "node": str,
        "pdk": str,
        "process_effects_contract": dict,
        "process_corner_count": int,
        "worst_process_corner": str,
        "pdk_signoff_claim": str,
    },
    "calibration": {
        "status": str,
        "source": str,
        "ground_truth_reference": str,
        "last_calibrated_utc": "utc_timestamp",
        "assets": dict,
    },
}
REQUIRED_CAPTURE_COMMANDS = {
    "target_benchmark_report": (
        "python3 benchmarks/run_benchmarks.py run "
        "--config benchmarks/configs/benchmark_plan.json "
        "--out-dir benchmarks/results/target-phone "
        "--claim-level L5_PROTOTYPE_SILICON "
        "--target-metadata benchmarks/results/target-phone/target-metadata.json"
    ),
    "target_benchmark_validation": (
        "python3 benchmarks/run_benchmarks.py validate-report "
        "benchmarks/results/target-phone/report.json "
        "--artifact-root ."
    ),
    "npu_nnapi_proof": (
        "E1_NPU_WRITE_PROOF_JSON=1 scripts/android/capture_e1_npu_nnapi_evidence.sh"
    ),
    "launcher_agent_runtime": "scripts/android/capture_eliza_launcher_runtime_evidence.sh",
}
REQUIRED_GENERATED_AP_CAPTURE_SNIPPETS = (
    "scripts/build_firemarshal_eliza_ap_benchmarks_payload.sh",
    "capture_chipyard_linux_evidence.sh ap-benchmarks",
    "scripts/capture_cpu_ap_evidence.py intake ap-benchmarks",
)
GENERATED_AP_CLAIM_BOUNDARY = (
    "operator_commands_only_not_calibrated_efficiency_evidence_not_L5_or_L6_release_evidence"
)
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


def code_from_text(text: str, fallback: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    parts = [part for part in cleaned.split("_") if part]
    return "_".join(parts[:10]) or fallback


def structured_findings(
    blocked_until_real_evidence: list[str], checks: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for item in blocked_until_real_evidence:
        findings.append(
            {
                "code": f"benchmark_efficiency_missing_real_evidence_{code_from_text(item, 'evidence')}",
                "severity": "blocker",
                "message": item,
                "evidence": "blocked_until_real_evidence",
                "next_step": "Capture calibrated target benchmark evidence before allowing efficiency, TOPS/W, joules-per-inference, or phone comparison claims.",
            }
        )
    for check in checks:
        if check.get("status") == "pass":
            continue
        ident = str(check.get("id", "scope_check"))
        findings.append(
            {
                "code": f"benchmark_efficiency_scope_check_failed_{code_from_text(ident, 'scope_check')}",
                "severity": "blocker",
                "message": f"{ident} structural scope check is {check.get('status')}",
                "evidence": str(check.get("evidence", "")),
                "next_step": "Repair the benchmark efficiency scope contract before using this report as runtime optimization evidence.",
            }
        )
    return findings


def command_plan_commands(
    capture_commands: dict[str, str],
    command_plan: list[dict[str, Any]],
) -> list[str]:
    commands = [command for command in capture_commands.values() if isinstance(command, str)]
    for batch in command_plan:
        values = batch.get("commands")
        if isinstance(values, list):
            commands.extend(command for command in values if isinstance(command, str) and command)
    commands.append("python3 scripts/check_benchmark_efficiency_scope.py")
    return list(dict.fromkeys(commands))


def finding_payload(
    finding: dict[str, Any],
    capture_commands: dict[str, str],
    command_plan: list[dict[str, Any]],
) -> dict[str, Any]:
    row = dict(finding)
    commands = command_plan_commands(capture_commands, command_plan)
    if commands:
        row["next_command"] = commands[0]
        row["next_commands"] = commands
    return row


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
                "Real reports (`dry_run: false`) with passed measured results must include populated software, clocks, memory, thermal, power, process, and calibration metadata",
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


def type_name(expected: Any) -> str:
    if expected is str:
        return "string"
    if expected is int:
        return "integer"
    if expected == (int, float):
        return "number"
    if expected is dict:
        return "object"
    return str(expected)


def target_metadata_contract_matches_runner(contract: dict[str, Any]) -> bool:
    boundary = str(contract.get("claim_boundary", ""))
    required_fields = mapping(contract.get("required_fields"))
    required_sections = set(str(item) for item in list_values(contract.get("required_sections")))
    calibration_assets = set(
        str(item) for item in list_values(contract.get("required_calibration_assets"))
    )
    process_contract = mapping(contract.get("process_effects_contract"))
    asset_fields = set(
        str(item) for item in list_values(contract.get("calibration_asset_required_fields"))
    )
    if contract.get("schema") != "eliza.benchmark_target_metadata_contract.v1":
        return False
    if "not benchmark evidence" not in boundary or "not a release efficiency claim" not in boundary:
        return False
    if required_sections != set(REAL_METADATA_REQUIRED_FIELDS):
        return False
    if calibration_assets != REQUIRED_REAL_CALIBRATION_ASSETS:
        return False
    if asset_fields != {"status", "source", "sha256", "evidence"}:
        return False
    if process_contract.get("path") != "docs/spec-db/process-14a-effects.yaml":
        return False
    if "64-character lowercase SHA-256" not in str(process_contract.get("sha256", "")):
        return False
    for section, fields in REAL_METADATA_REQUIRED_FIELDS.items():
        section_contract = mapping(required_fields.get(section))
        for field, expected_type in fields.items():
            if section_contract.get(field) != type_name(expected_type):
                return False
    notes = "\n".join(str(item) for item in list_values(contract.get("release_gate_notes")))
    return contains_all(
        notes,
        (
            "dry_run=false L5/L6 benchmark reports",
            "calibrated clock_source and power_meter assets",
            "archived under packages/chip",
            "Simulator wall-clock",
        ),
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
            "TARGET_METADATA_CONTRACT_PATH",
            "target_metadata_contract_sha256",
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


def generated_ap_benchmark_wiring_is_actionable(report: dict[str, Any]) -> bool:
    commands = "\n".join(str(item) for item in list_values(report.get("next_commands_after_prerequisites_exist")))
    packaged = mapping(report.get("packaged_generated_ap_workload"))
    accepted = mapping(report.get("accepted_benchmark_evidence"))
    return (
        report.get("schema") == "eliza.cpu_ap_benchmark_runner_wiring.v1"
        and (
            (
                report.get("derived_command_available") is True
                and report.get("runner_command_derivable") is True
                and packaged.get("status") == "ready"
                and all(snippet in commands for snippet in REQUIRED_GENERATED_AP_CAPTURE_SNIPPETS)
            )
            or accepted.get("accepted") is True
        )
    )


def generated_ap_benchmark_evidence_is_intaken(report: dict[str, Any]) -> bool:
    accepted = mapping(report.get("accepted_benchmark_evidence"))
    if accepted.get("accepted") is not True:
        return False
    path = ROOT / str(accepted.get("path") or "")
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    required_markers = (
        "CoreMark/MHz:",
        "STREAM Triad:",
        "lat_mem_rd:",
        "fio:",
        "process effects contract: simulator-only benchmark, no silicon process evidence",
        "eliza-evidence: ap_benchmark_wrapper_marker=present",
        "eliza-evidence: status=PASS",
    )
    return all(marker in text for marker in required_markers)


def generated_ap_benchmark_command_plan(wiring_report: dict[str, Any]) -> dict[str, Any]:
    commands = [
        str(item)
        for item in list_values(wiring_report.get("next_commands_after_prerequisites_exist"))
        if isinstance(item, str) and item.strip()
    ]
    return {
        "id": "capture_generated_ap_l3_benchmark_markers",
        "source": rel(AP_BENCHMARK_WIRING_REPORT),
        "claim_boundary": GENERATED_AP_CLAIM_BOUNDARY,
        "commands": commands,
        "requires": [
            "generated-AP Linux userspace reaches the benchmark workload",
            "captured transcript includes all required L3 raw benchmark markers",
            "rerun wire_cpu_ap_capture_commands.py and check_benchmark_efficiency_scope.py after capture",
        ],
    }


def build_report() -> dict[str, Any]:
    plan = load_json_object(BENCHMARK_PLAN)
    schema = load_yaml_object(REPORT_SCHEMA)
    metadata = load_json_object(TARGET_METADATA_EXAMPLE)
    metadata_contract = load_json_object(TARGET_METADATA_CONTRACT)
    ap_benchmark_wiring = load_json_object(AP_BENCHMARK_WIRING_REPORT)
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
            "id": "target_metadata_contract_matches_runner_requirements",
            "status": "pass"
            if target_metadata_contract_matches_runner(metadata_contract)
            else "fail",
            "evidence": rel(TARGET_METADATA_CONTRACT),
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
        {
            "id": "generated_ap_l3_benchmark_capture_plan_is_actionable",
            "status": "pass"
            if generated_ap_benchmark_wiring_is_actionable(ap_benchmark_wiring)
            else "fail",
            "evidence": rel(AP_BENCHMARK_WIRING_REPORT),
        },
        {
            "id": "generated_ap_l3_benchmark_evidence_is_intaken",
            "status": "pass"
            if generated_ap_benchmark_evidence_is_intaken(ap_benchmark_wiring)
            else "fail",
            "evidence": str(
                mapping(ap_benchmark_wiring.get("accepted_benchmark_evidence")).get(
                    "path", rel(AP_BENCHMARK_WIRING_REPORT)
                )
            ),
            "claim_boundary": (
                "generated-AP simulator benchmark evidence only; not calibrated L5/L6 "
                "phone efficiency, silicon power, TOPS/W, or commercial comparison evidence"
            ),
        },
    ]
    blocked_until_real_evidence = [
        "prototype-silicon or complete-phone target identity, board serial, SoC revision, and OS/BSP build ID",
        "schema-valid benchmark report generated with dry_run false and claim level L5 or L6 as appropriate",
        "calibrated clock-source records with SHA-256 artifact hashes for every passing result",
        "calibrated power-meter records, raw power traces, and integration-window metadata",
        "thermal traces aligned to the benchmark window with die/package/ambient readings and throttle state",
        "memory configuration and bandwidth/latency metadata from the target, not simulator defaults",
        "raw benchmark stdout/log/report artifacts with SHA-256 hashes and parser-derived metrics",
        "NPU NNAPI proof showing e1-npu selection, zero unsupported ops, and zero CPU fallback",
        "reviewer confirmation that simulator wall-clock, host-smoke tools, and FPGA power are excluded from phone efficiency comparisons",
    ]
    findings = structured_findings(blocked_until_real_evidence, checks)
    command_plan = [
        generated_ap_benchmark_command_plan(ap_benchmark_wiring),
    ]
    return {
        "schema": "eliza.benchmark_efficiency_scope.v1",
        "generated_utc": datetime.now(UTC).isoformat(),
        "status": "benchmark_efficiency_scope_release_blocked",
        "claim_boundary": (
            "Benchmark efficiency scope audit only; not calibrated target benchmark evidence, "
            "not prototype-silicon evidence, not complete-phone evidence, not measured TOPS/W "
            "evidence, not measured joules-per-inference evidence, not commercial phone "
            "comparison evidence, and not a release efficiency claim."
        ),
        **FALSE_CLAIM_FLAGS,
        "current_scaffolds": {
            "benchmark_plan": rel(BENCHMARK_PLAN),
            "report_schema": rel(REPORT_SCHEMA),
            "target_metadata_example": rel(TARGET_METADATA_EXAMPLE),
            "target_metadata_contract": rel(TARGET_METADATA_CONTRACT),
            "runner": rel(RUNNER),
            "calibration_regression_test": rel(CALIBRATION_TEST),
            "parser_regression_test": rel(PARSER_TEST),
            "generated_ap_benchmark_wiring": rel(AP_BENCHMARK_WIRING_REPORT),
        },
        "accepted_generated_ap_benchmark_evidence": mapping(
            ap_benchmark_wiring.get("accepted_benchmark_evidence")
        ),
        "blocked_until_real_evidence": blocked_until_real_evidence,
        "next_capture_commands": REQUIRED_CAPTURE_COMMANDS,
        "next_command_plan": command_plan,
        "findings": [
            finding_payload(finding, REQUIRED_CAPTURE_COMMANDS, command_plan)
            for finding in findings
        ],
        "checks": checks,
        "summary": {
            "check_count": len(checks),
            "passing_check_count": len([check for check in checks if check["status"] == "pass"]),
            "release_claim_allowed": False,
            "next_command_batch_count": 1,
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
    for key, expected in FALSE_CLAIM_FLAGS.items():
        require(data.get(key) is expected, f"{key} must stay false", errors)
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
    findings = data.get("findings")
    if not isinstance(findings, list) or not findings:
        errors.append("findings must list structured benchmark efficiency blockers")
    scaffolds = data.get("current_scaffolds")
    if not isinstance(scaffolds, dict):
        errors.append("current_scaffolds must be a mapping")
    else:
        for key in (
            "benchmark_plan",
            "report_schema",
            "target_metadata_example",
            "target_metadata_contract",
            "runner",
            "calibration_regression_test",
            "parser_regression_test",
            "generated_ap_benchmark_wiring",
        ):
            require(isinstance(scaffolds.get(key), str), f"current_scaffolds missing {key}", errors)
    accepted_generated_ap = data.get("accepted_generated_ap_benchmark_evidence")
    if not isinstance(accepted_generated_ap, dict):
        errors.append("accepted_generated_ap_benchmark_evidence must be a mapping")
    else:
        require(
            accepted_generated_ap.get("accepted") is True,
            "accepted generated-AP benchmark evidence must be intaken",
            errors,
        )
        require(
            isinstance(accepted_generated_ap.get("path"), str)
            and bool(accepted_generated_ap.get("path")),
            "accepted generated-AP benchmark evidence path missing",
            errors,
        )
    commands = data.get("next_capture_commands")
    if not isinstance(commands, dict):
        errors.append("next_capture_commands must be a mapping")
    else:
        for key, expected_cmd in REQUIRED_CAPTURE_COMMANDS.items():
            require(
                commands.get(key) == expected_cmd,
                f"next_capture_commands missing or changed {key}",
                errors,
            )
    command_plan = data.get("next_command_plan")
    if not isinstance(command_plan, list) or not command_plan:
        errors.append("next_command_plan must include generated-AP benchmark capture commands")
    else:
        first = command_plan[0]
        if not isinstance(first, dict):
            errors.append("next_command_plan entries must be mappings")
        else:
            require(
                first.get("claim_boundary") == GENERATED_AP_CLAIM_BOUNDARY,
                "generated-AP benchmark command plan claim boundary drifted",
                errors,
            )
            require(
                first.get("source") == rel(AP_BENCHMARK_WIRING_REPORT),
                "generated-AP benchmark command plan source drifted",
                errors,
            )
            command_text = "\n".join(str(item) for item in list_values(first.get("commands")))
            for snippet in REQUIRED_GENERATED_AP_CAPTURE_SNIPPETS:
                require(
                    snippet in command_text,
                    f"generated-AP benchmark command plan missing {snippet}",
                    errors,
                )
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
