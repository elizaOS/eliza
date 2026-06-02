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
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
REPORT = ROOT / "build/reports/chip-os-gap-keyword-inventory.json"

SCHEMA = "eliza.chip_os_gap_keyword_inventory.v1"
CLAIM_BOUNDARY = "source_keyword_inventory_only_not_boot_or_launcher_evidence"
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
    "packages/os/linux/agent",
    "packages/os/linux/crates/elizad",
    "packages/os/android/vendor/eliza",
    "packages/os/android/scripts",
    "packages/os/android/installer/manifests",
    "packages/os/android/installer/scripts",
    "packages/os/android/system-ui/native",
    "packages/os/android/system-ui/src",
    "packages/app/android/app/build.gradle",
    "packages/app/android/app/src/main",
    "packages/app/src",
    "packages/app/scripts",
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
    "docs/spec-db/traceability",
    "app/src/main/assets",
}
EXCLUDED_FILENAMES = {
    "chip-os-boot-gap-survey-2026-05-20.md",
    "check_chip_os_gap_keyword_inventory.py",
    "test_chip_os_gap_keyword_inventory.py",
}
CLASSIFIED_BLOCKER_INVENTORY_PATH_PATTERNS = (
    re.compile(
        r"^packages/chip/(docs|verify)/.*"
        r"("
        r"gap|gaps|audit|blocker|work[-_]order|inventory|"
        r"critical[-_]gap[-_]review|workstream[-_]gap[-_]review|"
        r"status[-_]dashboard|workstreams|road[-_]to|roadmap|todo|dossier"
        r").*\.(json|md|yaml|yml)$",
        re.I,
    ),
    re.compile(r"^packages/chip/docs/.+evidence-manifest\.json$", re.I),
    re.compile(r"^packages/chip/docs/security/tee-plan/.*\.md$", re.I),
    re.compile(r"^packages/chip/docs/architecture-optimization/(?:sota-2028/)?[^/]*report.*\.md$", re.I),
    re.compile(r"^packages/chip/docs/spec-db/competitor-.*\.(?:json|md|yaml|yml)$", re.I),
)
TEST_FILE_PATTERNS = (
    re.compile(r"(^|/)test_[^/]+\.(c|cc|cpp|h|java|kt|py|rs|ts|tsx)$"),
    re.compile(r"(^|/)[^/]+_test\.(c|cc|cpp|h|java|kt|rs|ts|tsx)$"),
    re.compile(r"(^|/)[^/]+\.(test|spec)\.(js|jsx|ts|tsx)$"),
)
BENIGN_LINE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "implementation_missing",
        re.compile(r"\bUnsupported HTTP method\b"),
    ),
    (
        "stub_placeholder",
        re.compile(r'\bplaceholder:\s*"[^"]+"'),
    ),
)
CLASSIFIED_DIAGNOSTIC_PATH_PATTERNS = (
    re.compile(r"^packages/chip/scripts/(?:.*/)?(?:check|capture)_[^/]*\.py$"),
    re.compile(r"^packages/chip/scripts/(?:aggregate_tapeout_readiness|product_check)\.py$"),
    re.compile(r"^packages/chip/scripts/run_[^/]+\.sh$"),
    re.compile(r"^packages/chip/sw/check_[^/]+\.py$"),
    re.compile(r"^packages/chip/verify/check_[^/]+\.py$"),
    re.compile(r"^packages/os/linux/elizaos/scripts/(?:check|capture)[^/]*\.py$"),
)
CLASSIFIED_GENERATOR_PATH_PATTERNS = (re.compile(r"^packages/chip/scripts/generate_[^/]+\.py$"),)
CLASSIFIED_OPERATOR_DOC_PATH_PATTERNS = (
    re.compile(
        r"^packages/chip/docs/(?:android|arch|sw|toolchain|benchmarks|npu|pd)/.*\.(?:md|yaml|yml)$",
        re.I,
    ),
)
CLASSIFIED_DIAGNOSTIC_LINE_RE = re.compile(
    r"("
    r"raise SystemExit|errors\.append|blockers\.append|findings\.append|"
    r"closure_evidence=|description=|next_step|next_command|message|evidence|"
    r"CLAIM_BOUNDARY|claim_boundary|re\.compile|AllowedFinding|print\(|help=|"
    r"TEMPLATE_|template|sentinel|manifest|classification policy|"
    r"for placeholder, replacement in|text\.replace\(placeholder, replacement\)"
    r")"
)
CLASSIFIED_GENERATOR_LINE_RE = re.compile(
    r"("
    r"non[-_]release|evidence_class|demo|template|generated|generator|"
    r"placeholder|remain(?:s)? blocked|not yet|"
    r"scaffold files|concept/scaffold|Replace .*placeholder|Not fabrication-bound"
    r")",
    re.I,
)
CLASSIFIED_OPERATOR_DOC_LINE_RE = re.compile(
    r"("
    r"fail[- ]closed scaffold|repo[- ]local scaffold check|"
    r"scaffold audit|explicit stub rationale|no stub may fake|"
    r"return unsupported when (?:the )?(?:device node|hardware|backend).*absent|"
    r"unsupported operations without crashing|unsupported access paths fail closed|"
    r"not .* evidence|not .* implementation|"
    r"not yet (?:complete|locally covered|run)|does not yet (?:prove|run)|"
    r"(?:is |are )?blocked until .* evidence|"
    r"evidence blocked|remains? blocked|placeholder files do not close this gate|"
    r"claim(?:s)? remain(?:s)? blocked until|must block until|"
    r"before .* replace the scaffold|must .* before .* readiness claim|"
    r"no .* claim may rely on this scaffold|"
    r"test scaffold until generated|non[- ]Linux scaffold|"
    r"fail[- ]closed on unsupported|poll for unsupported bits|"
    r"non[- ]claiming scaffold checks|"
    r"scaffold map|control scaffold|scaffold accesses|scaffold routes|"
    r"virtual[- ]device smoke|operator guide|capture plan"
    r")",
    re.I,
)
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
        re.compile(
            r"\b(STATUS_LATER(?:_[A-Z0-9_]+)?|deferred|blocked until|remain(?:s)? blocked|not yet)\b",
            re.I,
        ),
    ),
)

GENERIC_RECHECK_COMMAND = "python3 packages/chip/scripts/check_chip_os_gap_keyword_inventory.py"


def cleanup_commands(path: Path, line_number: int) -> list[str]:
    path_text = rel(path)
    parts = set(path.parts)
    commands = [
        f"${{EDITOR:-vi}} +{line_number} {path_text}",
    ]
    lower_path = path_text.lower()
    if "npu" in lower_path:
        commands.append("python3 packages/chip/scripts/check_npu_scope.py")
    if "benchmark" in lower_path or "benchmarks" in parts:
        commands.append("python3 packages/chip/scripts/check_benchmark_efficiency_scope.py")
    if "cpu_ap" in lower_path or "chipyard" in lower_path or "riscv" in lower_path:
        commands.append("python3 packages/chip/scripts/check_cpu_ap_scope.py")
    if "android" in parts or "aosp" in lower_path:
        commands.append("python3 packages/chip/scripts/check_android_sim_boot.py")
    if "linux" in parts or "elizaos" in parts:
        commands.append("python3 packages/chip/scripts/check_os_rv64_chip_boot_contract.py --json-only")
    if "runtime" in lower_path or "peripheral" in lower_path:
        commands.append("python3 packages/chip/scripts/check_phone_runtime_readiness_contract.py")
    commands.append(GENERIC_RECHECK_COMMAND)
    deduped: list[str] = []
    for command in commands:
        if command not in deduped:
            deduped.append(command)
    return deduped


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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


def scan_root_for_path(path: Path, roots: list[str]) -> str:
    matches: list[tuple[int, str]] = []
    for item in roots:
        root = Path(item)
        if not root.is_absolute():
            root = REPO / root
        try:
            if root.is_file() and path.resolve() == root.resolve():
                matches.append((len(root.parts), item))
            elif root.is_dir():
                path.resolve().relative_to(root.resolve())
                matches.append((len(root.parts), item))
        except (OSError, ValueError):
            continue
    if not matches:
        return "unknown"
    return sorted(matches, reverse=True)[0][1]


def scan_root_summary(findings: list[dict[str, Any]], roots: list[str]) -> list[dict[str, Any]]:
    by_root: dict[str, list[dict[str, Any]]] = {}
    for item in findings:
        path = REPO / str(item["path"])
        by_root.setdefault(scan_root_for_path(path, roots), []).append(item)
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


def is_excluded(path: Path) -> bool:
    relative = rel(path)
    if path.name in EXCLUDED_FILENAMES:
        return True
    if any(pattern.search(relative) for pattern in CLASSIFIED_BLOCKER_INVENTORY_PATH_PATTERNS):
        return True
    if any(pattern.search(relative) for pattern in TEST_FILE_PATTERNS):
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
        if path.stat().st_size > MAX_FILE_BYTES:
            return False
        sample = path.read_bytes()[:4096]
    except OSError:
        return False
    if b"\0" in sample:
        return False
    try:
        sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True


def is_classified_diagnostic_line(path: Path, line: str) -> bool:
    relative = rel(path)
    if not any(pattern.search(relative) for pattern in CLASSIFIED_DIAGNOSTIC_PATH_PATTERNS):
        return False
    stripped = line.strip()
    if not stripped:
        return False
    if '"' in stripped or "'" in stripped:
        return True
    return bool(CLASSIFIED_DIAGNOSTIC_LINE_RE.search(stripped))


def is_classified_generator_line(path: Path, line: str) -> bool:
    relative = rel(path)
    if not any(pattern.search(relative) for pattern in CLASSIFIED_GENERATOR_PATH_PATTERNS):
        return False
    stripped = line.strip()
    if not stripped:
        return False
    if re.search(r"\b(TODO|FIXME|XXX|HACK|TBD)\b", stripped):
        return False
    if stripped.startswith("#") and CLASSIFIED_GENERATOR_LINE_RE.search(stripped):
        return True
    return bool(CLASSIFIED_GENERATOR_LINE_RE.search(stripped))


def is_classified_operator_doc_line(path: Path, line: str) -> bool:
    relative = rel(path)
    if not any(pattern.search(relative) for pattern in CLASSIFIED_OPERATOR_DOC_PATH_PATTERNS):
        return False
    stripped = line.strip()
    if not stripped:
        return False
    if re.match(r"^(?:make|python3|scripts/)[\w./ -]+$", stripped):
        return True
    return bool(CLASSIFIED_OPERATOR_DOC_LINE_RE.search(stripped))


def line_findings(path: Path, line_number: int, line: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for category, description, pattern in PATTERNS:
        match = pattern.search(line)
        if not match:
            continue
        if is_classified_diagnostic_line(path, line):
            continue
        if is_classified_generator_line(path, line):
            continue
        if is_classified_operator_doc_line(path, line):
            continue
        if any(
            benign_category == category and benign_pattern.search(line)
            for benign_category, benign_pattern in BENIGN_LINE_PATTERNS
        ):
            continue
        commands = cleanup_commands(path, line_number)
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
                "next_command": commands[0],
                "next_commands": commands,
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
    by_root = scan_root_summary(findings, roots)
    command_batches = {
        tuple(str(command) for command in item.get("next_commands", []) if isinstance(command, str))
        for item in findings
    }
    status = "blocked" if findings else "pass"
    return {
        "schema": SCHEMA,
        "status": status,
        "claim_boundary": CLAIM_BOUNDARY,
        **FALSE_CLAIM_FLAGS,
        "generated_utc": utc_now(),
        "summary": {
            "scan_roots": len(roots),
            "files_scanned": files_scanned,
            "findings": len(findings),
            "categories": dict(sorted(by_category.items())),
            "paths_with_findings": len(by_path),
            "next_command_batch_count": len(command_batches),
        },
        "scan_roots": roots,
        "scan_root_summary": by_root,
        "top_paths": [{"path": path, "findings": count} for path, count in by_path.most_common(25)],
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
    parser.add_argument("--json-only", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    roots = args.roots or list(DEFAULT_SCAN_ROOTS)
    report = build_report(roots)
    output = Path(args.report)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if args.json_only:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0
    summary = report["summary"]
    print(
        f"STATUS: {str(report['status']).upper()} chip_os_gap_keyword_inventory "
        f"files_scanned={summary['files_scanned']} findings={summary['findings']} "
        f"paths_with_findings={summary['paths_with_findings']} report={rel(output)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
