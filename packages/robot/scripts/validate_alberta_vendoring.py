#!/usr/bin/env python3
"""Validate the vendored Alberta framework wiring used by packages/robot."""

from __future__ import annotations

import argparse
import importlib
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ROBOT_ROOT = ROOT / "robot"
ALBERTA_ROOT = ROOT / "alberta"
SHA_RE = re.compile(r"`([0-9a-f]{40})`")


def _vendored_commit(vendoring_text: str) -> str | None:
    for line in vendoring_text.splitlines():
        if "Vendored at commit" in line:
            match = SHA_RE.search(line)
            if match:
                return match.group(1)
    return None


def _import_path() -> str | None:
    if str(ALBERTA_ROOT) not in sys.path:
        sys.path.insert(0, str(ALBERTA_ROOT))
    try:
        module = importlib.import_module("alberta_framework")
    except Exception:
        return None
    return str(Path(module.__file__ or "").resolve())


def validate_alberta_vendoring(
    *,
    expected_upstream_head: str | None = None,
    root: Path = ROOT,
) -> dict[str, Any]:
    robot_root = root / "robot"
    alberta_root = root / "alberta"
    vendoring = alberta_root / "VENDORING.md"
    pyproject = robot_root / "pyproject.toml"
    lockfile = robot_root / "uv.lock"
    vendoring_text = vendoring.read_text(encoding="utf-8") if vendoring.is_file() else ""
    commit = _vendored_commit(vendoring_text)
    pyproject_data = tomllib.loads(pyproject.read_text(encoding="utf-8")) if pyproject.is_file() else {}
    source = (
        pyproject_data.get("tool", {})
        .get("uv", {})
        .get("sources", {})
        .get("alberta-framework", {})
    )
    lock_text = lockfile.read_text(encoding="utf-8") if lockfile.is_file() else ""
    imported_from = _import_path() if root == ROOT else None
    checks = {
        "alberta_root": alberta_root.is_dir(),
        "vendoring_metadata": vendoring.is_file() and commit is not None,
        "vendoring_upstream_url": "https://github.com/lalalune/alberta" in vendoring_text,
        "vendoring_commit_matches_expected": (
            True if expected_upstream_head is None else commit == expected_upstream_head
        ),
        "robot_pyproject_source": source == {"path": "../alberta", "editable": True},
        "uv_lock_source": 'source = { editable = "../alberta" }' in lock_text,
        "import_resolves_to_vendored_tree": (
            True if root != ROOT else imported_from is not None and Path(imported_from).is_relative_to(alberta_root)
        ),
        "local_modifications_documented": (
            "Local modifications vs upstream" in vendoring_text
            and "pyproject.toml" in vendoring_text
            and "alberta_framework/__init__.py" in vendoring_text
        ),
    }
    return {
        "ok": all(checks.values()),
        "alberta_root": str(alberta_root),
        "vendored_commit": commit,
        "expected_upstream_head": expected_upstream_head,
        "imported_from": imported_from,
        "checks": checks,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-upstream-head", default=None)
    args = parser.parse_args(argv)
    report = validate_alberta_vendoring(expected_upstream_head=args.expected_upstream_head)
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
