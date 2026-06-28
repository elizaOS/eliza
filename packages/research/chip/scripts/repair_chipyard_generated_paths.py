#!/usr/bin/env python3
"""Check or rewrite stale absolute paths in generated Chipyard Verilator files."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKOUT = ROOT / "external/chipyard"
CONFIG = "ElizaRocketConfig"
GENERATED_CONFIG_DIR = (
    CHECKOUT / "sims/verilator/generated-src/chipyard.harness.TestHarness.ElizaRocketConfig"
)
KNOWN_FILES = (
    GENERATED_CONFIG_DIR / "sim_files.common.f",
    GENERATED_CONFIG_DIR / "sim_files.f",
    GENERATED_CONFIG_DIR / "chipyard.harness.TestHarness.ElizaRocketConfig.all.f",
    GENERATED_CONFIG_DIR / "chipyard.harness.TestHarness.ElizaRocketConfig" / "VTestDriver.mk",
)
DEFAULT_STALE_ROOTS = ("/work", "/workspace", "/__w")
HOST_REPO_ENV = "ELIZA_HOST_REPO_DIR"
GENERATED_METADATA_PATTERNS = ("*.f", "*.mk", "*.d")


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def rewrite_text(text: str, stale_root: str, replacement_root: Path) -> tuple[str, int]:
    normalized = stale_root.rstrip("/")
    replacement = str(replacement_root).rstrip("/")
    pattern = re.compile(rf"(?<![A-Za-z0-9_.-]){re.escape(normalized)}(?=(/|[\s:,'\")]|$))")
    rewritten, replacements = pattern.subn(replacement, text)
    if rewritten == normalized:
        rewritten = replacement
        replacements += 1
    return rewritten, replacements


def default_stale_roots(replacement_root: Path) -> list[str]:
    roots = [root.rstrip("/") for root in DEFAULT_STALE_ROOTS]
    host_repo = os.environ.get(HOST_REPO_ENV)
    if host_repo:
        roots.append(host_repo.rstrip("/"))
    if replacement_root == Path("/work"):
        roots.append(str(ROOT).rstrip("/"))
    return sorted(set(root for root in roots if root and root != str(replacement_root).rstrip("/")))


def generated_files(extra_files: list[str]) -> list[Path]:
    files = list(KNOWN_FILES)
    if GENERATED_CONFIG_DIR.exists():
        for pattern in GENERATED_METADATA_PATTERNS:
            files.extend(GENERATED_CONFIG_DIR.rglob(pattern))
    files.extend(Path(path) if Path(path).is_absolute() else ROOT / path for path in extra_files)
    return sorted(set(files))


def inspect_or_rewrite(
    files: list[Path], stale_roots: list[str], replacement_root: Path, *, rewrite: bool
) -> tuple[list[dict[str, object]], int]:
    results: list[dict[str, object]] = []
    total_replacements = 0
    for path in files:
        result: dict[str, object] = {
            "path": rel(path),
            "exists": path.is_file(),
            "replacements": 0,
            "stale_roots_found": [],
            "rewritten": False,
        }
        if not path.is_file():
            results.append(result)
            continue
        original = path.read_text(encoding="utf-8", errors="replace")
        current = original
        found: list[str] = []
        replacements = 0
        for stale_root in stale_roots:
            if stale_root.rstrip("/") in current:
                found.append(stale_root.rstrip("/"))
            current, count = rewrite_text(current, stale_root, replacement_root)
            replacements += count
        result["stale_roots_found"] = found
        result["replacements"] = replacements
        if rewrite and replacements and current != original:
            path.write_text(current, encoding="utf-8")
            result["rewritten"] = True
            total_replacements += replacements
        results.append(result)
    return results, total_replacements


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rewrite", action="store_true", help="rewrite stale roots in place")
    parser.add_argument(
        "--stale-root",
        action="append",
        default=[],
        help="absolute stale root to replace; defaults to /work",
    )
    parser.add_argument(
        "--replacement-root",
        default=str(ROOT),
        help="replacement absolute root; defaults to this repository",
    )
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        help="additional generated file to inspect or rewrite",
    )
    parser.add_argument("--json", action="store_true", help="print machine-readable results")
    args = parser.parse_args()

    replacement_root = Path(args.replacement_root).resolve()
    stale_roots = args.stale_root or default_stale_roots(replacement_root)
    results, total_replacements = inspect_or_rewrite(
        generated_files(args.file), stale_roots, replacement_root, rewrite=args.rewrite
    )
    stale_results = [
        result
        for result in results
        if result["exists"] and result["stale_roots_found"] and not result["rewritten"]
    ]
    status = "pass"
    if stale_results:
        status = "blocked"
    if args.rewrite and total_replacements:
        status = "repaired"

    report = {
        "schema": "eliza.chipyard_generated_path_repair.v1",
        "status": status,
        "rewrite": args.rewrite,
        "stale_roots": [root.rstrip("/") for root in stale_roots],
        "replacement_root": str(replacement_root),
        "results": results,
        "total_replacements": total_replacements,
    }
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    elif status == "pass":
        print("STATUS: PASS chipyard.generated_paths - no stale generated roots found")
    elif status == "repaired":
        print(
            "STATUS: REPAIR chipyard.generated_paths - rewrote "
            f"{total_replacements} stale generated path occurrence(s)"
        )
        for result in results:
            if result["rewritten"]:
                print(f"  - {result['path']}: replacements={result['replacements']}")
    else:
        print("STATUS: BLOCKED chipyard.generated_paths - stale generated roots found")
        for result in stale_results:
            roots_found = result["stale_roots_found"]
            roots = (
                ", ".join(str(root) for root in roots_found)
                if isinstance(roots_found, list)
                else str(roots_found)
            )
            print(f"  - {result['path']}: {roots}")
        print("  next: python3 scripts/repair_chipyard_generated_paths.py --rewrite")
    return 2 if status == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
