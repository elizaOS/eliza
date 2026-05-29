#!/usr/bin/env python3
"""Add missing provenance metadata to generated structured reports.

This does not promote evidence status or remove blockers. It only records a
claim boundary and a timestamp for reports that already exist but lack those
fields, so inventory tooling can distinguish metadata debt from runtime debt.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
OLD_DEFAULT_CLAIM_BOUNDARY = (
    "generated_report_metadata_only_not_chip_boot_runtime_release_or_no_issues_evidence"
)
DEFAULT_CLAIM_BOUNDARY = "scope_limited_to_structural_metadata_inventory_and_gate_diagnostics"
TIMESTAMP_KEYS = {
    "generated_utc",
    "timestamp",
    "timestamps",
    "start_utc",
    "created_at",
    "updated_at",
    "date",
}


def has_timestamp(value: Any) -> bool:
    if isinstance(value, dict):
        if any(str(key) in TIMESTAMP_KEYS for key in value):
            return True
        return any(has_timestamp(child) for child in value.values())
    if isinstance(value, list):
        return any(has_timestamp(child) for child in value)
    return False


def mtime_utc(path: Path) -> str:
    when = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.UTC)
    return when.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_payload(path: Path, payload: Any) -> tuple[Any, bool]:
    if not isinstance(payload, dict):
        return payload, False
    changed = False
    claim_boundary = payload.get("claim_boundary")
    has_claim_boundary = (
        isinstance(claim_boundary, str)
        and bool(claim_boundary.strip())
        and claim_boundary != OLD_DEFAULT_CLAIM_BOUNDARY
    ) or (
        isinstance(claim_boundary, (dict, list))
        and bool(claim_boundary)
    )
    if (
        not has_claim_boundary
    ):
        payload["claim_boundary"] = DEFAULT_CLAIM_BOUNDARY
        changed = True
    if not has_timestamp(payload):
        payload["generated_utc"] = mtime_utc(path)
        changed = True
    return payload, changed


def normalize_path(path: Path) -> bool:
    suffix = path.suffix.lower()
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
        if suffix == ".json":
            payload = json.loads(text)
        elif suffix in {".yaml", ".yml"}:
            payload = yaml.safe_load(text)
        else:
            return False
    except (OSError, json.JSONDecodeError, yaml.YAMLError):
        return False
    payload, changed = normalize_payload(path, payload)
    if not changed:
        return False
    if suffix == ".json":
        text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    else:
        text = yaml.safe_dump(payload, sort_keys=True)
    try:
        path.write_text(text, encoding="utf-8")
    except PermissionError:
        try:
            fd, raw_tmp = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
                text=True,
            )
        except PermissionError:
            return False
        tmp = Path(raw_tmp)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    return True


def iter_paths(roots: list[Path]) -> list[Path]:
    paths: list[Path] = []
    for root in roots:
        if root.is_file():
            paths.append(root)
        elif root.is_dir():
            paths.extend(
                path
                for path in root.rglob("*")
                if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}
            )
    return sorted(set(paths))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", type=Path, default=[ROOT / "build/reports"])
    return parser.parse_args()


def resolve_input(path: Path) -> Path:
    if path.is_absolute():
        return path
    if path.parts and path.parts[0] == "packages":
        return REPO / path
    return ROOT / path


def display_path(path: Path) -> str:
    for base in (ROOT, REPO):
        try:
            return path.relative_to(base).as_posix()
        except ValueError:
            continue
    return str(path)


def main() -> int:
    args = parse_args()
    roots = [resolve_input(path) for path in args.paths]
    changed = [path for path in iter_paths(roots) if normalize_path(path)]
    print(f"normalized_report_provenance changed={len(changed)}")
    for path in changed[:25]:
        print(display_path(path))
    if len(changed) > 25:
        print(f"... {len(changed) - 25} more")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
