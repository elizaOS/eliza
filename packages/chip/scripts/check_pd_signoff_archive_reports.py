#!/usr/bin/env python3
"""Fail-closed gate verifying PD signoff archive reports describe real files.

`scripts/archive_pd_signoff_run.py` writes a per-run archive report under
`pd/signoff/reports/<run>-archive-report.yaml` that lists, for each artifact
class, the source `files` (under the OpenLane run directory) and the copied
`archive_files` (under `build/pd-signoff-archives/<run>/`). Both the run
directories and the `build/` archive tree are routinely pruned, after which a
report can keep asserting `status: present` / `release_ready: true` for files
that exist nowhere. That is a false evidence claim.

This checker reads every committed archive report and verifies that every file
it claims is `present` actually exists on disk. It is fail-closed: any dangling
claim is an error. `build/pd-signoff-archives/` is gitignored and rebuildable,
so a report whose only gap is its archive copies is reported with the exact
regenerate command rather than treated as silently fine.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "pd/signoff/reports"
ARCHIVE_SCRIPT = "scripts/archive_pd_signoff_run.py"
PRESENT_STATUSES = {"present"}


def load_report(path: Path) -> dict:
    payload = yaml.safe_load(path.read_text())
    if not isinstance(payload, dict):
        raise ValueError("archive report must be a YAML mapping")
    if payload.get("schema") != "eliza.pd_signoff_archive_report.v1":
        raise ValueError(
            f"unexpected schema {payload.get('schema')!r}; "
            "expected eliza.pd_signoff_archive_report.v1"
        )
    return payload


def missing_paths(values: object) -> list[str]:
    if not isinstance(values, list):
        return []
    missing: list[str] = []
    for item in values:
        if not isinstance(item, str):
            continue
        if not (ROOT / item).exists():
            missing.append(item)
    return missing


def check_report(path: Path) -> list[str]:
    rel = path.relative_to(ROOT)
    try:
        payload = load_report(path)
    except (ValueError, yaml.YAMLError) as exc:
        return [f"{rel}: {exc}"]

    failures: list[str] = []
    run_dir = (payload.get("run") or {}).get("run_dir")
    if isinstance(run_dir, str) and not (ROOT / run_dir).is_dir():
        failures.append(
            f"{rel}: run.run_dir is missing: {run_dir} "
            f"(delete this stale report or regenerate from a surviving run)"
        )

    regen = (
        f"python3 {ARCHIVE_SCRIPT} --run {run_dir} --allow-incomplete"
        if isinstance(run_dir, str)
        else f"python3 {ARCHIVE_SCRIPT} --run <run-dir> --allow-incomplete"
    )

    artifacts = payload.get("artifacts")
    if not isinstance(artifacts, list):
        failures.append(f"{rel}: artifacts must be a list")
        return failures

    for artifact in artifacts:
        if not isinstance(artifact, dict):
            failures.append(f"{rel}: artifact entry must be a mapping")
            continue
        name = artifact.get("name", "<unnamed>")
        status = artifact.get("status")
        if status not in PRESENT_STATUSES:
            continue
        for missing in missing_paths(artifact.get("files")):
            failures.append(
                f"{rel}: artifact {name} status=present but source file is missing: {missing}"
            )
        for missing in missing_paths(artifact.get("archive_files")):
            failures.append(
                f"{rel}: artifact {name} status=present but archive copy is missing: {missing} "
                f"(regenerate with: {regen})"
            )

    if payload.get("release_ready") is True and failures:
        failures.append(f"{rel}: release_ready=true while claimed artifacts are missing")
    return failures


def main() -> int:
    if not REPORT_DIR.is_dir():
        print(
            f"PD signoff archive report check: no report directory at {REPORT_DIR.relative_to(ROOT)}"
        )
        return 0

    reports = sorted(REPORT_DIR.glob("*-archive-report.yaml"))
    failures: list[str] = []
    for report in reports:
        failures.extend(check_report(report))

    if failures:
        print("PD signoff archive report check failed:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(f"PD signoff archive report check passed for {len(reports)} report(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
