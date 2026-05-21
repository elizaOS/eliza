#!/usr/bin/env python3
"""Inventory source-level unfinished markers across chip and OS bring-up paths.

This is a survey aid, not a readiness gate. It scans curated source/document
paths that affect the Linux/AOSP-on-chip objective and writes a structured
inventory of TODO/stub/placeholder/deferred markers. Generated bundles,
evidence logs, build outputs, and package caches are intentionally skipped.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-gap-keyword-inventory.json"

SCHEMA = "eliza.chip_os_gap_keyword_inventory.v1"
CLAIM_BOUNDARY = "source_keyword_inventory_only_not_boot_or_launcher_evidence"

DEFAULT_SCAN_ROOTS = (
    "packages/chip/rtl",
    "packages/chip/fw",
    "packages/chip/sw",
    "packages/chip/scripts",
    "packages/chip/verify",
    "packages/chip/docs",
    "packages/os/linux/elizaos/README.md",
    "packages/os/linux/elizaos/STATUS.md",
    "packages/os/linux/elizaos/manifest.json",
    "packages/os/linux/elizaos/config",
    "packages/os/linux/elizaos/scripts",
    "packages/os/android/vendor/eliza",
    "packages/app/android/app/build.gradle",
    "packages/app/android/app/src/main",
)

EXCLUDED_DIRS = {
    ".git",
    ".gradle",
    ".idea",
    "__pycache__",
    "node_modules",
    "build",
    "out",
    "cache",
    "chroot",
    "binary",
    "artifacts",
    "evidence",
    "assets",
    "dist",
    "target",
}
EXCLUDED_PATH_PARTS = {
    "build/reports",
    "docs/evidence",
    "docs/archive",
    "docs/reports",
    "app/src/main/assets",
}
EXCLUDED_FILENAMES = {
    "chip-os-boot-gap-survey-2026-05-20.md",
    "check_chip_os_gap_keyword_inventory.py",
    "test_chip_os_gap_keyword_inventory.py",
}
TEXT_SUFFIXES = {
    "",
    ".bp",
    ".c",
    ".cc",
    ".cfg",
    ".conf",
    ".cpp",
    ".dts",
    ".dtsi",
    ".gradle",
    ".h",
    ".ini",
    ".java",
    ".json",
    ".kt",
    ".mk",
    ".md",
    ".py",
    ".rc",
    ".rs",
    ".s",
    ".sh",
    ".sv",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
MAX_FILE_BYTES = 1_000_000

PATTERNS: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    ("todo", "TODO/FIXME/XXX/HACK/TBD marker", re.compile(r"\b(TODO|FIXME|XXX|HACK|TBD)\b")),
    (
        "implementation_missing",
        "not-implemented or unsupported marker",
        re.compile(r"\b(NotImplementedError|not implemented|unimplemented|unsupported)\b", re.I),
    ),
    (
        "stub_placeholder",
        "stub/placeholder/scaffold/mock/fake marker",
        re.compile(r"\b(stub|placeholder|scaffold|dummy|mock|fake)\b", re.I),
    ),
    (
        "deferred_blocked",
        "deferred or blocked-work marker",
        re.compile(r"\b(STATUS_LATER(?:_[A-Z0-9_]+)?|deferred|blocked until|remain(?:s)? blocked|not yet)\b", re.I),
    ),
)


def rel(path: Path) -> str:
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        return str(path)


def source_paths(roots: list[str]) -> list[Path]:
    paths: list[Path] = []
    for item in roots:
        path = Path(item)
        if not path.is_absolute():
            path = REPO / path
        if path.is_file():
            paths.append(path)
        elif path.is_dir():
            for child in path.rglob("*"):
                if child.is_file():
                    paths.append(child)
    return sorted(set(paths), key=lambda p: rel(p))


def is_excluded(path: Path) -> bool:
    relative = rel(path)
    if path.name in EXCLUDED_FILENAMES:
        return True
    if any(part in EXCLUDED_DIRS for part in path.parts):
        return True
    return any(fragment in relative for fragment in EXCLUDED_PATH_PARTS)


def is_text_candidate(path: Path) -> bool:
    if is_excluded(path):
        return False
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return False
    try:
        return path.stat().st_size <= MAX_FILE_BYTES
    except OSError:
        return False


def line_findings(path: Path, line_number: int, line: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for category, description, pattern in PATTERNS:
        match = pattern.search(line)
        if not match:
            continue
        findings.append(
            {
                "category": category,
                "code": f"{category}_{match.group(1).lower().replace(' ', '_')}",
                "path": rel(path),
                "line": line_number,
                "marker": match.group(1),
                "description": description,
                "excerpt": line.strip()[:240],
                "next_step": (
                    "Classify this marker in a dedicated blocker report or remove it by "
                    "completing the implementation before using it as boot, launcher, "
                    "agent, or release evidence."
                ),
            }
        )
    return findings


def scan_file(path: Path) -> list[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    findings: list[dict[str, Any]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        findings.extend(line_findings(path, line_number, line))
    return findings


def build_report(roots: list[str]) -> dict[str, Any]:
    files_scanned = 0
    findings: list[dict[str, Any]] = []
    for path in source_paths(roots):
        if not is_text_candidate(path):
            continue
        files_scanned += 1
        findings.extend(scan_file(path))
    by_category = Counter(str(item["category"]) for item in findings)
    by_path = Counter(str(item["path"]) for item in findings)
    status = "blocked" if findings else "pass"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        "summary": {
            "scan_roots": len(roots),
            "files_scanned": files_scanned,
            "findings": len(findings),
            "categories": dict(sorted(by_category.items())),
            "paths_with_findings": len(by_path),
        },
        "scan_roots": roots,
        "top_paths": [
            {"path": path, "findings": count} for path, count in by_path.most_common(25)
        ],
        "findings": findings,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root",
        action="append",
        dest="roots",
        default=[],
        help="repo-relative or absolute source path to scan; may be repeated",
    )
    parser.add_argument("--report", default=str(REPORT))
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
        f"STATUS: {str(report['status']).upper()} chip_os_gap_keyword_inventory "
        f"files_scanned={summary['files_scanned']} findings={summary['findings']} "
        f"paths_with_findings={summary['paths_with_findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
