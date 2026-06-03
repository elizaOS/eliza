#!/usr/bin/env python3
"""Audit evidence/report provenance for the chip OS bring-up survey.

This is an evidence-quality inventory, not a boot-readiness claim. It catches
artifacts that are dangerous to promote as Linux/AOSP-on-chip evidence:
host-local paths, missing provenance timestamps, reference-only claim
boundaries, placeholder/sentinel values, and explicit blocked/fail markers.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-evidence-provenance.json"

SCHEMA = "eliza.chip_os_evidence_provenance.v1"
CLAIM_BOUNDARY = "evidence_provenance_inventory_only_not_boot_or_launcher_evidence"
FALSE_CLAIM_FLAGS = {
    "phone_claim_allowed": False,
    "release_claim_allowed": False,
    "boot_claim_allowed": False,
    "linux_boot_claim_allowed": False,
    "android_boot_claim_allowed": False,
    "launcher_runtime_claim_allowed": False,
    "agent_liveness_claim_allowed": False,
    "hardware_boot_claim_allowed": False,
    "production_readiness_claim_allowed": False,
}

DEFAULT_SCAN_ROOTS = (
    "packages/chip/build/reports",
    "packages/chip/docs/evidence",
    "packages/os/linux/elizaos/evidence",
    "packages/os/android/installer/manifests",
    "packages/os/android/vendor/eliza/manifests",
    "packages/os/release/beta-2026-05-16",
    "packages/os/release/confidential-2026-05-21",
    "packages/app/android/app/src/main/assets/agent/plugins-manifest.json",
)

TEXT_SUFFIXES = {".json", ".yaml", ".yml", ".txt", ".log"}
EXCLUDED_DIRS = {
    "__pycache__",
    "cache",
    "compiler",
    "heavy-sim-logs",
    "local-host-benchmark-logs",
    "memory",
    "pd",
}
EXCLUDED_FILENAMES = {
    "chip-os-evidence-provenance.json",
}
EXCLUDED_SUFFIXES = (
    ".schema.json",
    ".example.json",
    ".status-test.json",
)
EXCLUDED_PATH_PARTS = (("firmware", "usr", "share", "qemu", "firmware"),)
LINE_MARKER_EXCLUDED_FILENAMES = {
    "chip-os-boot-gap-inventory.json",
    "chip-os-bring-up-status.json",
    "chip-os-closure-plan.json",
    "chip-os-gap-keyword-inventory.json",
    "chip-os-objective-evidence-matrix.json",
    "chip-os-optimization-gap-inventory.json",
    "chip-tapeout-readiness-current.json",
    "cpu_ap_blocker_inventory.json",
    "cpu-ap-evidence-manifest.json",
    "cpu-ap-rva23-profile-plan.json",
    "live_runtime_capture_contracts.json",
    "minimum_linux_npu_target.json",
    "mlperf-inference-harness-evidence.yaml",
    "mvp_npu_ml_smoke.log",
    "mvp_npu_scale_sim.json",
    "mvp_simulator.json",
    "phone_runtime_planned_evidence_templates.json",
    "phone-release-readiness-current.json",
    "phone-release-readiness.json",
    "software-bsp-evidence-manifest.json",
    "stub_audit.json",
    "tapeout-readiness-chip.json",
    "tapeout-readiness-current.json",
    "tapeout-readiness.json",
}
LINE_MARKER_EXCLUDED_SUFFIXES = (
    "gap_keyword_inventory.json",
    ".run.log",
    ".template.log",
)
MAX_FILE_BYTES = 750_000
HOST_PATH_RE = re.compile(r"(?<![\w/>])/(?:home|Users|tmp|var/tmp)/[^\s\"'<>]+")
PLACEHOLDER_RE = re.compile(
    r"\b(placeholder|stub|dummy|fake|sentinel|all-zero|"
    + "TO"
    + r"DO|"
    + "TB"
    + r"D)\b",
    re.I,
)
BLOCKED_RE = re.compile(r"\b(BLOCKED|FAIL|blocked until|not yet|missing required)\b", re.I)
KERNEL_BUILD_PLACEHOLDER_PATH_RE = re.compile(
    r"\bdrivers/(?:firmware/efi/libstub/|net/dummy(?:\.|/)|iio/dummy/)", re.I
)
KERNEL_BUILD_OUTPUT_RE = re.compile(r"^\s*(?:CC|AR|LD|STUBCPY)(?:\s|\[)", re.I)
LINUX_RUNTIME_PLACEHOLDER_FALSE_POSITIVE_RE = re.compile(
    r"(EFI stub:|Console: (?:switching to )?colour dummy device|"
    r"dummy_hcd(?:\.|\s)|Dummy host controller|"
    r"dummy-cpufreq\.ko|\bFAKE/|\bFake: out/target/product/)",
    re.I,
)
REPORT_REFERENCE_PLACEHOLDER_FALSE_POSITIVE_RE = re.compile(
    r"(stub[-_ ]audit|stub_audit|pd/(?:n2p|a14|intel-14a|sf2p)-stub/access-gate\.yaml)",
    re.I,
)
TECHNICAL_PLACEHOLDER_FALSE_POSITIVE_RE = re.compile(
    r"(model-shard sample payload has \d+ contiguous shard words plus one sentinel and checksum|"
    r"CPU subsystem is the CVA6-disabled stub unless E1_HAVE_CVA6|"
    r"dispatch-boundary stub for unsupported ops \(rtl/cpu/rvv/rvv_unit_stub\.sv\)|"
    r"current Sky130 e1 release contains the chip-top stub only)",
    re.I,
)
LINUX_RUNTIME_BLOCKED_FALSE_POSITIVE_RE = re.compile(
    r"(fail-safe mode|serial port \d+ not yet initialized)",
    re.I,
)
TECHNICAL_BLOCKED_FALSE_POSITIVE_RE = re.compile(
    r"("
    r"\bavoid blocked (?:cores|links|physical targets)\b|"
    r"\bblocked (?:cores|links)\b|"
    r"\bblocked-no-calibrated-assets\b|"
    r"\bfail address/bit\b|"
    r"\bfail address\b|"
    r"\binjection-test hooks\b"
    r")",
    re.I,
)
ZERO_BLOCKED_FAIL_COUNTER_RE = re.compile(
    r'^\s*"(?:blocked|fail|failed)"\s*:\s*(?:0|\[\]|\{\})\s*,?\s*$',
    re.I,
)
STRUCTURED_SCOPE_BLOCKED_FALSE_POSITIVE_RE = re.compile(
    r'^\s*"(?:claim_boundary|reason)"\s*:\s*".*'
    r"(?:claims? remain blocked until|remain blocked until|remain BLOCKED follow-ons)"
    r".*",
    re.I,
)
REFERENCE_ONLY_RE = re.compile(
    r"(reference[_ -]?only|no[_ -]?(?:silicon|hardware|chip|boot)|"
    r"not[_ -]?(?:rtl|chip|boot|launcher|runtime|live[_ -]?runtime)|"
    r"not[_ -]?measured[_ -]?(?:rtl|silicon|hardware|power|benchmark))",
    re.I,
)
TIMESTAMP_KEYS = {
    "generated_utc",
    "generated_at",
    "generated_at_utc",
    "as_of",
    "timestamp",
    "timestamps",
    "start_utc",
    "created_at",
    "updated_at",
    "date",
    "result_recorded_at",
}

GENERIC_RECHECK_COMMAND = "python3 packages/chip/scripts/check_chip_os_evidence_provenance.py"
NPU_NNAPI_CAPTURE_COMMAND = (
    "E1_NPU_WRITE_PROOF_JSON=1 "
    "E1_NPU_MACS_PER_INFERENCE=<measured-macs> "
    "E1_NPU_CYCLES=<measured-cycles> "
    "E1_NPU_HZ=<measured-hz> "
    "E1_NPU_DMA_BYTES_READ=<measured-bytes-read> "
    "E1_NPU_DMA_BYTES_WRITTEN=<measured-bytes-written> "
    "E1_NPU_NNAPI_DELEGATED_NODE_COUNT=<measured-delegated-nodes> "
    "E1_NPU_NNAPI_TOTAL_NODE_COUNT=<measured-total-nodes> "
    "E1_NPU_CPU_FALLBACK_PERCENT=0 "
    "E1_NPU_UNSUPPORTED_OP_COUNT=0 "
    "E1_NPU_DATAFLOW_NAME=<measured-dataflow> "
    "E1_NPU_GENERATED_BY=<operator-or-job-id> "
    "E1_NPU_TARGET=<target-id> "
    "packages/chip/scripts/android/capture_e1_npu_nnapi_evidence.sh"
)
BENCHMARK_CAPTURE_COMMANDS = (
    "python3 packages/chip/benchmarks/run_benchmarks.py run "
    "--config packages/chip/benchmarks/configs/benchmark_plan.json "
    "--out-dir packages/chip/benchmarks/results/target-phone "
    "--claim-level L5_PROTOTYPE_SILICON "
    "--metadata packages/chip/benchmarks/results/target-phone/target-metadata.json",
    "python3 packages/chip/benchmarks/run_benchmarks.py validate-report "
    "packages/chip/benchmarks/results/target-phone/report.json --artifact-root packages/chip",
    "python3 packages/chip/scripts/check_benchmark_efficiency_scope.py",
    "python3 packages/chip/scripts/check_cpu_phone_benchmark_claim_gate.py",
)


def provenance_commands(category: str, path: Path) -> list[str]:
    path_text = rel(path)
    path_parts = set(path.parts)
    commands: list[str] = []
    if category == "host_local_path":
        commands.append(f"python3 packages/chip/scripts/provenance_sanitize.py {path_text}")
    if category in {"missing_timestamp", "missing_claim_boundary"}:
        commands.append(f"python3 packages/chip/scripts/normalize_report_provenance.py {path_text}")

    if "peripherals" in path_parts or path_text.endswith("_sim.log"):
        commands.append(
            "python3 packages/chip/scripts/android/capture_simulated_peripheral_evidence.py"
        )
    elif "eliza_launcher_runtime" in path.name or "android_launcher_runtime" in path_text:
        commands.append(
            "python3 packages/chip/scripts/android/capture_launcher_runtime_evidence.py"
        )
    elif "android_system_bridge" in path_text:
        commands.append(
            "python3 packages/chip/scripts/android/capture_system_bridge_runtime_evidence.py"
        )
    elif "android" in path_parts:
        commands.append(
            "AOSP_DIR=/path/to/aosp packages/chip/scripts/boot_android_simulator.sh "
            "--run-cuttlefish --run-cts --run-vts --run-qemu --run-renode"
        )
    elif "e1-npu" in path_parts or "npu" in path_text.lower():
        commands.append(NPU_NNAPI_CAPTURE_COMMAND)
    elif "benchmark" in path_text.lower():
        commands.extend(BENCHMARK_CAPTURE_COMMANDS)
    elif path.name == "mvp_simulator.json":
        commands.append("python3 packages/chip/scripts/run_mvp_simulator.py")
    elif path.name == "os_rv64_chip_boot_contract.json" or "elizaos" in path_parts:
        commands.append(
            "python3 packages/chip/scripts/check_os_rv64_chip_boot_contract.py --json-only"
        )
    elif path.name == "chip-os-optimization-gap-inventory.json":
        commands.append("python3 packages/chip/scripts/check_chip_os_optimization_gap_inventory.py")
    elif path_text.startswith("packages/chip/build/reports/"):
        commands.append("python3 packages/chip/scripts/check_chip_os_report_freshness.py")

    commands.append(GENERIC_RECHECK_COMMAND)
    deduped: list[str] = []
    for command in commands:
        if command not in deduped:
            deduped.append(command)
    return deduped


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def resolve(path: str) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        return candidate
    return REPO / candidate


def is_candidate(path: Path) -> bool:
    if path.name in EXCLUDED_FILENAMES:
        return False
    if any(path.name.endswith(suffix) for suffix in EXCLUDED_SUFFIXES):
        return False
    if any(part in EXCLUDED_DIRS for part in path.parts):
        return False
    for sequence in EXCLUDED_PATH_PARTS:
        if any(
            tuple(path.parts[index : index + len(sequence)]) == sequence
            for index in range(len(path.parts))
        ):
            return False
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return False
    try:
        return path.stat().st_size <= MAX_FILE_BYTES
    except OSError:
        return False


def candidate_paths(roots: list[str]) -> list[Path]:
    paths: list[Path] = []
    for item in roots:
        root = resolve(item)
        if root.is_file():
            paths.append(root)
        elif root.is_dir():
            paths.extend(path for path in root.rglob("*") if path.is_file())
    return sorted({path for path in paths if is_candidate(path)}, key=rel)


def scan_root_for_path(path: Path, roots: list[str]) -> str:
    candidates: list[tuple[int, str]] = []
    for item in roots:
        root = resolve(item)
        try:
            if root.is_file() and path.resolve() == root.resolve():
                candidates.append((len(root.parts), item))
            elif root.is_dir():
                path.resolve().relative_to(root.resolve())
                candidates.append((len(root.parts), item))
        except (OSError, ValueError):
            continue
    if not candidates:
        return "unknown"
    return sorted(candidates, reverse=True)[0][1]


def scan_root_summary(findings: list[dict[str, Any]], roots: list[str]) -> list[dict[str, Any]]:
    by_root: dict[str, list[dict[str, Any]]] = {}
    for item in findings:
        path_value = item.get("path")
        if not isinstance(path_value, str):
            continue
        by_root.setdefault(scan_root_for_path(REPO / path_value, roots), []).append(item)
    rows: list[dict[str, Any]] = []
    for root, items in by_root.items():
        categories = Counter(str(item["category"]) for item in items)
        paths = {str(item["path"]) for item in items}
        rows.append(
            {
                "root": root,
                "findings": len(items),
                "paths_with_findings": len(paths),
                "categories": dict(sorted(categories.items())),
            }
        )
    return sorted(rows, key=lambda row: (-int(row["findings"]), str(row["root"])))


def finding(
    *,
    category: str,
    code: str,
    path: Path,
    message: str,
    evidence: str,
    line: int | None = None,
    severity: str = "blocker",
) -> dict[str, Any]:
    commands = provenance_commands(category, path)
    row: dict[str, Any] = {
        "category": category,
        "code": code,
        "severity": severity,
        "path": rel(path),
        "message": message,
        "evidence": evidence[:300],
        "next_step": (
            "Regenerate, replace, or explicitly scope this artifact before using it "
            "as Linux/AOSP chip boot, launcher, agent, or no-issues runtime evidence."
        ),
        "next_command": commands[0],
        "next_commands": commands,
    }
    if line is not None:
        row["line"] = line
    return row


def has_timestamp_key(value: object) -> bool:
    if isinstance(value, dict):
        if any(str(key) in TIMESTAMP_KEYS for key in value):
            return True
        return any(has_timestamp_key(child) for child in value.values())
    if isinstance(value, list):
        return any(has_timestamp_key(child) for child in value)
    return False


def structured_status(value: object) -> str | None:
    if isinstance(value, dict):
        status = value.get("status")
        if isinstance(status, str):
            return status
    return None


def is_nonpassing_status(status: str | None) -> bool:
    if not isinstance(status, str):
        return False
    lowered = status.lower()
    return (
        lowered in {"blocked", "fail", "failed"}
        or "blocked" in lowered
        or lowered.startswith("fail")
        or lowered.endswith("_fail")
        or lowered.endswith("_draft")
    )


def code_slug(text: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    return "_".join(part for part in cleaned.split("_") if part)[:120] or "value"


def nested_nonpassing_statuses(
    value: object,
    path: tuple[str, ...] = (),
    *,
    limit: int = 25,
    reportable_only: bool = False,
) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = (*path, str(key))
            key_text = str(key)
            status_key = key_text.endswith("status")
            if reportable_only:
                status_key = key_text == "evidence_status"
            if (
                child_path != ("status",)
                and isinstance(child, str)
                and status_key
                and is_nonpassing_status(child)
            ):
                rows.append((".".join(child_path), child))
                if len(rows) >= limit:
                    return rows
            rows.extend(
                nested_nonpassing_statuses(
                    child,
                    child_path,
                    limit=limit - len(rows),
                    reportable_only=reportable_only,
                )
            )
            if len(rows) >= limit:
                return rows
    elif isinstance(value, list):
        for index, child in enumerate(value):
            rows.extend(
                nested_nonpassing_statuses(
                    child,
                    (*path, str(index)),
                    limit=limit - len(rows),
                    reportable_only=reportable_only,
                )
            )
            if len(rows) >= limit:
                return rows
    return rows


def has_claim_boundary(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (dict, list)):
        return bool(value)
    return False


def has_positive_chip_runtime_claim(data: dict[str, Any]) -> bool:
    """True when a mixed claim boundary also carries positive chip runtime proof."""

    positive_booleans = (
        "on_chip_os_boot_claim",
        "minimum_linux_npu_target_claim",
        "integrated_linux_npu_ml_claim",
    )
    if any(data.get(key) is True for key in positive_booleans):
        return True
    evidence = str(data.get("best_executable_evidence", ""))
    tier = str(data.get("best_executable_tier", ""))
    return evidence.startswith("chipyard_") and tier in {"os_boot", "os_prereq", "npu_ml"}


def load_structured(path: Path, text: str) -> object | None:
    try:
        if path.suffix.lower() == ".json":
            return json.loads(text)
        if path.suffix.lower() in {".yaml", ".yml"}:
            return yaml.safe_load(text)
    except (json.JSONDecodeError, yaml.YAMLError):
        return None
    return None


def structured_findings(path: Path, data: object) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not isinstance(data, dict):
        return rows

    status = structured_status(data)
    if is_nonpassing_status(status):
        assert status is not None
        rows.append(
            finding(
                category="nonpassing_status",
                code=f"nonpassing_status_{status.lower()}",
                path=path,
                message=f"structured evidence status is {status}",
                evidence=f"status={status}",
            )
        )

    completion_claim = data.get("completion_claim")
    if isinstance(completion_claim, str) and is_nonpassing_status(completion_claim):
        rows.append(
            finding(
                category="nonpassing_status",
                code=f"nonpassing_completion_claim_{code_slug(completion_claim)}",
                path=path,
                message=f"structured evidence completion_claim is {completion_claim}",
                evidence=f"completion_claim={completion_claim}",
            )
        )

    active_blockers = data.get("active_blockers")
    if isinstance(active_blockers, list) and active_blockers:
        rows.append(
            finding(
                category="nonpassing_status",
                code="structured_active_blockers_present",
                path=path,
                message=f"structured blocker inventory lists {len(active_blockers)} active blockers",
                evidence=f"active_blockers={len(active_blockers)}",
            )
        )

    if data.get("current_claim_allowed") is False:
        rows.append(
            finding(
                category="nonpassing_status",
                code="structured_current_claim_disallowed",
                path=path,
                message="structured evidence explicitly disallows the current claim",
                evidence="current_claim_allowed=false",
            )
        )

    for status_path, nested_status in nested_nonpassing_statuses(data, reportable_only=True):
        rows.append(
            finding(
                category="nonpassing_status",
                code=f"nested_nonpassing_status_{code_slug(status_path)}_{code_slug(nested_status)}",
                path=path,
                message=f"nested structured evidence status {status_path} is {nested_status}",
                evidence=f"{status_path}={nested_status}",
            )
        )

    boundary = data.get("claim_boundary")
    if not has_claim_boundary(boundary):
        rows.append(
            finding(
                category="missing_claim_boundary",
                code="missing_claim_boundary",
                path=path,
                message="structured evidence is missing a claim_boundary",
                evidence=rel(path),
            )
        )
    elif (
        isinstance(boundary, str)
        and REFERENCE_ONLY_RE.search(boundary)
        and not has_positive_chip_runtime_claim(data)
    ):
        rows.append(
            finding(
                category="weak_reference_scope",
                code="weak_reference_scope",
                path=path,
                message="claim_boundary explicitly scopes this artifact away from chip boot/runtime proof",
                evidence=boundary,
            )
        )

    if not has_timestamp_key(data):
        rows.append(
            finding(
                category="missing_timestamp",
                code="missing_timestamp",
                path=path,
                message="structured evidence has no generated_utc/timestamp/start_utc/date provenance",
                evidence=rel(path),
            )
        )
    return rows


def line_findings(path: Path, text: str, structured: object | None = None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    structured_status_value = structured_status(structured)
    skip_marker_lines = (
        path.name in LINE_MARKER_EXCLUDED_FILENAMES
        or path.name.endswith(LINE_MARKER_EXCLUDED_SUFFIXES)
        or (
            isinstance(structured_status_value, str)
            and is_nonpassing_status(structured_status_value)
        )
        or bool(nested_nonpassing_statuses(structured))
    )
    for line_number, line in enumerate(text.splitlines(), start=1):
        host_match = HOST_PATH_RE.search(line)
        if host_match:
            rows.append(
                finding(
                    category="host_local_path",
                    code="host_local_path",
                    path=path,
                    line=line_number,
                    message="artifact contains host-local absolute path",
                    evidence=host_match.group(0),
                )
            )
        if skip_marker_lines:
            continue
        placeholder_match = PLACEHOLDER_RE.search(line)
        if placeholder_match and not is_false_positive_placeholder_line(line):
            rows.append(
                finding(
                    category="placeholder_marker",
                    code=f"placeholder_marker_{placeholder_match.group(1).lower().replace('-', '_')}",
                    path=path,
                    line=line_number,
                    message="artifact contains placeholder/sentinel marker",
                    evidence=line.strip(),
                )
            )
        blocked_match = BLOCKED_RE.search(line)
        if blocked_match and not is_false_positive_blocked_line(line):
            rows.append(
                finding(
                    category="blocked_marker",
                    code=f"blocked_marker_{blocked_match.group(1).lower().replace(' ', '_')}",
                    path=path,
                    line=line_number,
                    message="artifact contains blocked/fail marker",
                    evidence=line.strip(),
                )
            )
    return rows


def is_kernel_build_placeholder_output(line: str) -> bool:
    return bool(
        KERNEL_BUILD_OUTPUT_RE.search(line) and KERNEL_BUILD_PLACEHOLDER_PATH_RE.search(line)
    )


def is_false_positive_placeholder_line(line: str) -> bool:
    return bool(
        is_kernel_build_placeholder_output(line)
        or LINUX_RUNTIME_PLACEHOLDER_FALSE_POSITIVE_RE.search(line)
        or REPORT_REFERENCE_PLACEHOLDER_FALSE_POSITIVE_RE.search(line)
        or TECHNICAL_PLACEHOLDER_FALSE_POSITIVE_RE.search(line)
    )


def is_false_positive_blocked_line(line: str) -> bool:
    lowered = line.lower()
    fail_closed_posture = (
        "fail-closed" in lowered and "blocked" not in lowered and "status:" not in lowered
    )
    return bool(
        LINUX_RUNTIME_BLOCKED_FALSE_POSITIVE_RE.search(line)
        or TECHNICAL_BLOCKED_FALSE_POSITIVE_RE.search(line)
        or ZERO_BLOCKED_FAIL_COUNTER_RE.search(line)
        or STRUCTURED_SCOPE_BLOCKED_FALSE_POSITIVE_RE.search(line)
        or fail_closed_posture
    )


def scan_path(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    structured = load_structured(path, text)
    rows = line_findings(path, text, structured)
    if structured is not None:
        rows.extend(structured_findings(path, structured))
    return rows


def build_report(roots: list[str]) -> dict[str, Any]:
    paths = candidate_paths(roots)
    findings: list[dict[str, Any]] = []
    for path in paths:
        findings.extend(scan_path(path))
    by_category = Counter(str(item["category"]) for item in findings)
    by_path = Counter(str(item["path"]) for item in findings)
    by_root = scan_root_summary(findings, roots)
    command_batches = sorted(
        {
            tuple(
                str(command)
                for command in item.get("next_commands", [])
                if isinstance(command, str)
            )
            for item in findings
            if item.get("next_commands")
        }
    )
    return {
        "schema": SCHEMA,
        "status": "blocked" if findings else "pass",
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "summary": {
            "scan_roots": len(roots),
            "files_scanned": len(paths),
            "findings": len(findings),
            "paths_with_findings": len(by_path),
            "categories": dict(sorted(by_category.items())),
            "next_command_batch_count": len(command_batches),
        },
        "scan_roots": roots,
        "scan_root_summary": by_root,
        "top_paths": [{"path": path, "findings": count} for path, count in by_path.most_common(25)],
        "next_command_plan": [
            {
                "id": f"remediate_provenance_batch_{index + 1}",
                "commands": list(commands),
                "claim_boundary": "operator_remediation_commands_only_not_boot_or_runtime_evidence",
            }
            for index, commands in enumerate(command_batches)
        ],
        "findings": findings,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(REPORT))
    parser.add_argument("--root", action="append", dest="roots", default=[])
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    roots = args.roots or list(DEFAULT_SCAN_ROOTS)
    report = build_report(roots)
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_evidence_provenance "
        f"files_scanned={summary['files_scanned']} findings={summary['findings']} "
        f"paths_with_findings={summary['paths_with_findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
