#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "docs/evidence/memory/templates/bandwidth-latency-contended-access.template.json"

REAL_REPORT_CANDIDATES = (
    ROOT / "docs/evidence/memory/lpddr_bandwidth_latency_benchmark_report.json",
    ROOT / "docs/evidence/memory/contended_bandwidth_latency_report.json",
    ROOT / "docs/evidence/memory/contended_android_memory_trace.json",
    ROOT / "docs/evidence/memory/phone_2028_memory_scorecard.json",
)

PLACEHOLDER_RE = re.compile(r"__[A-Z0-9_]+__")
REQUIRED_METRICS = {
    "peak_bandwidth_gbps",
    "sustained_bandwidth_gbps",
    "p95_random_read_latency_ns",
    "contended_cpu_latency_ns",
    "display_underflow_count",
    "dma_copy_bandwidth_gbps",
    "worst_process_corner_sustained_bandwidth_gbps",
    "worst_process_corner_p95_random_read_latency_ns",
}
REQUIRED_REJECTION_KEYS = {
    "host_benchmark",
    "simulator_wall_clock",
    "axi_lite_sram_model_cycle_count",
    "generated_memmap_without_target_run",
    "process_corner_without_contract_hash",
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def flatten_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        strings: list[str] = []
        for item in value.values():
            strings.extend(flatten_strings(item))
        return strings
    if isinstance(value, list):
        strings = []
        for item in value:
            strings.extend(flatten_strings(item))
        return strings
    return []


def at(data: dict[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def require(condition: bool, message: str, errors: list[str]) -> None:
    if not condition:
        errors.append(message)


def is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def validate_template(errors: list[str]) -> None:
    if not TEMPLATE.is_file():
        errors.append(f"missing template {TEMPLATE.relative_to(ROOT)}")
        return

    data = load_json(TEMPLATE)
    require(isinstance(data, dict), "memory evidence template must be a JSON object", errors)
    if not isinstance(data, dict):
        return

    require(
        data.get("schema") == "eliza.memory.bandwidth_latency_contended_access.template.v1",
        "memory evidence template schema drifted",
        errors,
    )
    require(
        data.get("template_status") == "template_only_not_evidence",
        "memory evidence template must remain template_only_not_evidence",
        errors,
    )
    report = data.get("report")
    require(isinstance(report, dict), "memory evidence template missing report object", errors)
    if not isinstance(report, dict):
        return

    placeholders = [text for text in flatten_strings(report) if PLACEHOLDER_RE.search(text)]
    require(
        len(placeholders) >= 16,
        "memory evidence template must keep explicit placeholders in every required field",
        errors,
    )
    require(
        at(report, ("target", "is_host")) is False
        and at(report, ("target", "is_simulator")) is False,
        "memory evidence template must default host/simulator evidence to false",
        errors,
    )
    metrics = at(report, ("parsed_metrics",))
    require(isinstance(metrics, dict), "memory evidence template missing parsed_metrics", errors)
    if isinstance(metrics, dict):
        missing = sorted(REQUIRED_METRICS - set(metrics))
        require(
            not missing, "memory evidence template missing metrics: " + ", ".join(missing), errors
        )

    process = at(report, ("process_corners",))
    require(
        isinstance(process, dict),
        "memory evidence template missing process_corners",
        errors,
    )
    if isinstance(process, dict):
        contract = process.get("process_effects_contract")
        require(
            isinstance(contract, dict),
            "memory evidence template missing process_effects_contract",
            errors,
        )
        if isinstance(contract, dict):
            require(
                contract.get("path") == "docs/spec-db/process-14a-effects.yaml",
                "memory evidence template must bind to docs/spec-db/process-14a-effects.yaml",
                errors,
            )
            require(
                contract.get("sha256") == "__REQUIRED_SHA256__",
                "memory evidence template must require process effects contract sha256",
                errors,
            )
        require(
            process.get("worst_process_corner") == "__REQUIRED_14A_CORNER_ID__",
            "memory evidence template must require worst 14A process corner id",
            errors,
        )
        require(
            process.get("pdk_signoff_claim") == "none",
            "memory evidence template must make no PDK signoff claim",
            errors,
        )

    rejections = at(report, ("negative_evidence_rejection",))
    require(
        isinstance(rejections, dict),
        "memory evidence template missing negative_evidence_rejection",
        errors,
    )
    if isinstance(rejections, dict):
        missing = sorted(REQUIRED_REJECTION_KEYS - set(rejections))
        require(
            not missing,
            "memory evidence template missing rejection keys: " + ", ".join(missing),
            errors,
        )
        for key in REQUIRED_REJECTION_KEYS & set(rejections):
            require(rejections[key] == "reject", f"template rejection {key} must be reject", errors)


def validate_real_report(path: Path, errors: list[str]) -> None:
    data = load_json(path)
    rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
    require(isinstance(data, dict), f"{rel}: report must be a JSON object", errors)
    if not isinstance(data, dict):
        return

    placeholder_hits = [
        text for text in flatten_strings(data) if PLACEHOLDER_RE.search(text) or text.strip() == ""
    ]
    require(
        not placeholder_hits,
        f"{rel}: report contains placeholders or blank strings; first={placeholder_hits[:1]}",
        errors,
    )
    require(
        data.get("evidence_class") == "real_target_measurement",
        f"{rel}: evidence_class must be real_target_measurement",
        errors,
    )
    require(at(data, ("target", "is_host")) is False, f"{rel}: host results are invalid", errors)
    require(
        at(data, ("target", "is_simulator")) is False,
        f"{rel}: simulator wall-clock results are invalid",
        errors,
    )

    process = at(data, ("process_corners",))
    require(isinstance(process, dict), f"{rel}: process_corners must be an object", errors)
    if isinstance(process, dict):
        contract = process.get("process_effects_contract")
        require(
            isinstance(contract, dict),
            f"{rel}: process_effects_contract must be an object",
            errors,
        )
        if isinstance(contract, dict):
            require(
                contract.get("path") == "docs/spec-db/process-14a-effects.yaml",
                f"{rel}: process_effects_contract path must bind to 14A effects contract",
                errors,
            )
            require(
                isinstance(contract.get("sha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", contract["sha256"]) is not None,
                f"{rel}: process_effects_contract sha256 must be lowercase hex",
                errors,
            )
        require(
            isinstance(process.get("process_corner_count"), int)
            and not isinstance(process.get("process_corner_count"), bool)
            and process["process_corner_count"] > 0,
            f"{rel}: process_corner_count must be a positive integer",
            errors,
        )
        require(
            isinstance(process.get("worst_process_corner"), str)
            and process["worst_process_corner"].startswith("14a_"),
            f"{rel}: worst_process_corner must name a 14A corner",
            errors,
        )
        require(
            process.get("pdk_signoff_claim") == "none",
            f"{rel}: pdk_signoff_claim must remain none",
            errors,
        )

    memory_type = at(data, ("memory_config", "memory_type"))
    require(
        isinstance(memory_type, str)
        and memory_type not in {"AXI-Lite SRAM model", "SimDRAM", "host DRAM", "unknown"},
        f"{rel}: memory_type must name a real target memory type or explicit downgrade",
        errors,
    )
    capacity = at(data, ("memory_config", "capacity_gib"))
    require(is_number(capacity) and capacity > 0, f"{rel}: capacity_gib must be numeric", errors)

    metrics = at(data, ("parsed_metrics",))
    require(isinstance(metrics, dict), f"{rel}: parsed_metrics must be an object", errors)
    if isinstance(metrics, dict):
        missing = sorted(REQUIRED_METRICS - set(metrics))
        require(not missing, f"{rel}: missing metrics: " + ", ".join(missing), errors)
        for metric in REQUIRED_METRICS & set(metrics):
            require(is_number(metrics[metric]), f"{rel}: metric {metric} must be numeric", errors)

    commands = data.get("benchmark_commands")
    require(
        isinstance(commands, list)
        and bool(commands)
        and all(isinstance(command, str) and command.strip() for command in commands),
        f"{rel}: benchmark_commands must list exact non-empty commands",
        errors,
    )
    raw_artifacts = data.get("raw_artifacts")
    require(
        isinstance(raw_artifacts, list) and bool(raw_artifacts),
        f"{rel}: raw_artifacts must list raw logs/traces",
        errors,
    )
    if isinstance(raw_artifacts, list):
        for artifact in raw_artifacts:
            require(
                isinstance(artifact, dict), f"{rel}: raw_artifacts entries must be objects", errors
            )
            if isinstance(artifact, dict):
                require(
                    isinstance(artifact.get("path"), str)
                    and artifact["path"]
                    and not Path(artifact["path"]).is_absolute()
                    and ".." not in Path(artifact["path"]).parts,
                    f"{rel}: raw artifact path must be a relative repo path",
                    errors,
                )
                require(
                    isinstance(artifact.get("sha256"), str)
                    and re.fullmatch(r"[0-9a-f]{64}", artifact["sha256"]) is not None,
                    f"{rel}: raw artifact sha256 must be lowercase hex",
                    errors,
                )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        action="append",
        default=[],
        help="validate an additional real memory performance report",
    )
    args = parser.parse_args()

    errors: list[str] = []
    validate_template(errors)

    reports = [ROOT / report for report in args.report]
    reports.extend(path for path in REAL_REPORT_CANDIDATES if path.is_file())
    for report in reports:
        if report.is_file():
            validate_real_report(report, errors)
        else:
            errors.append(f"report does not exist: {report}")

    if errors:
        print("Memory evidence template check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(
        "Memory evidence template check passed: template is non-evidence and real-report placeholder rejection is armed."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
