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
)
EXCLUDED_PATH_PARTS = (
    ("firmware", "usr", "share", "qemu", "firmware"),
)
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
    ".template.log",
)
MAX_FILE_BYTES = 750_000
HOST_PATH_RE = re.compile(r"(?<![\w/>])/(?:home|Users|tmp|var/tmp)/[^\s\"'<>]+")
PLACEHOLDER_RE = re.compile(r"\b(placeholder|stub|dummy|fake|sentinel|all-zero|TODO|TBD)\b", re.I)
BLOCKED_RE = re.compile(r"\b(BLOCKED|FAIL|blocked until|not yet|missing required)\b", re.I)
KERNEL_BUILD_PLACEHOLDER_PATH_RE = re.compile(
    r"\bdrivers/(?:firmware/efi/libstub/|net/dummy(?:\.|/)|iio/dummy/)", re.I
)
KERNEL_BUILD_OUTPUT_RE = re.compile(r"^\s*(?:CC|AR|LD|STUBCPY)(?:\s|\[)", re.I)
LINUX_RUNTIME_PLACEHOLDER_FALSE_POSITIVE_RE = re.compile(
    r"(EFI stub:|Console: colour dummy device|dummy_hcd(?:\.|\s)|Dummy host controller|"
    r"dummy-cpufreq\.ko|\bFAKE/|\bFake: out/target/product/)",
    re.I,
)
REPORT_REFERENCE_PLACEHOLDER_FALSE_POSITIVE_RE = re.compile(
    r"(stub[-_ ]audit|stub_audit|pd/(?:n2p|a14|intel-14a|sf2p)-stub/access-gate\.yaml)",
    re.I,
)
LINUX_RUNTIME_BLOCKED_FALSE_POSITIVE_RE = re.compile(
    r"(fail-safe mode|serial port \d+ not yet initialized)",
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


def has_claim_boundary(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (dict, list)):
        return bool(value)
    return False


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
    elif isinstance(boundary, str) and REFERENCE_ONLY_RE.search(boundary):
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


def line_findings(
    path: Path, text: str, structured_status_value: str | None = None
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    skip_marker_lines = (
        path.name in LINE_MARKER_EXCLUDED_FILENAMES
        or path.name.endswith(LINE_MARKER_EXCLUDED_SUFFIXES)
        or (
            isinstance(structured_status_value, str)
            and is_nonpassing_status(structured_status_value)
        )
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
        KERNEL_BUILD_OUTPUT_RE.search(line)
        and KERNEL_BUILD_PLACEHOLDER_PATH_RE.search(line)
    )


def is_false_positive_placeholder_line(line: str) -> bool:
    return bool(
        is_kernel_build_placeholder_output(line)
        or LINUX_RUNTIME_PLACEHOLDER_FALSE_POSITIVE_RE.search(line)
        or REPORT_REFERENCE_PLACEHOLDER_FALSE_POSITIVE_RE.search(line)
    )


def is_false_positive_blocked_line(line: str) -> bool:
    return bool(LINUX_RUNTIME_BLOCKED_FALSE_POSITIVE_RE.search(line))


def scan_path(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    structured = load_structured(path, text)
    rows = line_findings(path, text, structured_status(structured))
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
        },
        "scan_roots": roots,
        "scan_root_summary": by_root,
        "top_paths": [{"path": path, "findings": count} for path, count in by_path.most_common(25)],
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
