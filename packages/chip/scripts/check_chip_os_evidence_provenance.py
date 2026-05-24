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
MAX_FILE_BYTES = 750_000
HOST_PATH_RE = re.compile(r"(?<![\w/])/(?:home|Users|tmp|var/tmp)/[^\s\"'<>]+")
PLACEHOLDER_RE = re.compile(r"\b(placeholder|stub|dummy|fake|sentinel|all-zero|TODO|TBD)\b", re.I)
BLOCKED_RE = re.compile(r"\b(BLOCKED|FAIL|blocked until|not yet|missing required)\b", re.I)
REFERENCE_ONLY_RE = re.compile(
    r"(reference[_ -]?only|no[_ -]?(?:silicon|hardware|chip|boot)|not[_ -]?(?:rtl|chip|boot|launcher|runtime))",
    re.I,
)
TIMESTAMP_KEYS = {
    "generated_utc",
    "timestamp",
    "timestamps",
    "start_utc",
    "created_at",
    "updated_at",
    "date",
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
    if any(part in EXCLUDED_DIRS for part in path.parts):
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
    if status and status.lower() in {"blocked", "fail", "failed"}:
        rows.append(
            finding(
                category="nonpassing_status",
                code=f"nonpassing_status_{status.lower()}",
                path=path,
                message=f"structured evidence status is {status}",
                evidence=f"status={status}",
            )
        )

    boundary = data.get("claim_boundary")
    if not isinstance(boundary, str) or not boundary.strip():
        rows.append(
            finding(
                category="missing_claim_boundary",
                code="missing_claim_boundary",
                path=path,
                message="structured evidence is missing a claim_boundary",
                evidence=rel(path),
            )
        )
    elif REFERENCE_ONLY_RE.search(boundary):
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


def line_findings(path: Path, text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
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
        placeholder_match = PLACEHOLDER_RE.search(line)
        if placeholder_match:
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
        if blocked_match:
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


def scan_path(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    rows = line_findings(path, text)
    structured = load_structured(path, text)
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
