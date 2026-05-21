#!/usr/bin/env python3
"""Validate every PD evidence gate under docs/evidence/pd/.

Each evidence YAML must:
  - parse as a mapping
  - have schema, status, release_use, scope, source_artifacts, release_blockers
  - reference only repo-relative source artifacts that exist on disk
  - if status == 'complete_local_evidence', release_blockers must be empty
  - if status != 'complete_local_evidence', release_blockers must be non-empty

The gate is fail-closed: any malformed evidence yaml or missing referenced
source artifact returns non-zero.
"""

from __future__ import annotations

import sys
from pathlib import Path
import json

import yaml

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "docs" / "evidence" / "pd"
REPORT = ROOT / "build/reports/pd_evidence_gates.json"

REQUIRED_KEYS = {
    "schema",
    "status",
    "release_use",
    "scope",
    "source_artifacts",
    "release_blockers",
}
ALLOWED_STATUS = {
    "blocked",
    "blocked_external_tool",
    "blocked_external_vendor",
    "draft_local_evidence",
    "complete_local_evidence",
}
ALLOWED_RELEASE_USE = {
    "prohibited_until_external_review",
    "released_for_external_review",
}


def fail(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)


def validate_manifest(path: Path) -> list[str]:
    rel = path.relative_to(ROOT)
    failures: list[str] = []
    try:
        payload = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        return [f"{rel}: invalid YAML: {exc}"]
    if not isinstance(payload, dict):
        return [f"{rel}: top-level must be a mapping"]

    missing = sorted(REQUIRED_KEYS - set(payload))
    if missing:
        failures.append(f"{rel}: missing required keys: {', '.join(missing)}")

    status = payload.get("status")
    if status not in ALLOWED_STATUS:
        failures.append(
            f"{rel}: status must be one of {', '.join(sorted(ALLOWED_STATUS))}; got {status}"
        )
    if payload.get("release_use") not in ALLOWED_RELEASE_USE:
        failures.append(
            f"{rel}: release_use must be one of {', '.join(sorted(ALLOWED_RELEASE_USE))}"
        )

    artifacts = payload.get("source_artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        failures.append(f"{rel}: source_artifacts must be a non-empty list")
    else:
        for item in artifacts:
            if not isinstance(item, str):
                failures.append(f"{rel}.source_artifacts: entries must be strings")
                continue
            p = Path(item)
            if p.is_absolute() or ".." in p.parts:
                failures.append(f"{rel}.source_artifacts: must be repo-relative: {item}")
                continue
            if not (ROOT / item).exists():
                failures.append(f"{rel}.source_artifacts: missing on disk: {item}")

    blockers = payload.get("release_blockers")
    if not isinstance(blockers, list):
        failures.append(f"{rel}: release_blockers must be a list")
    else:
        if status == "complete_local_evidence" and blockers:
            failures.append(
                f"{rel}: status complete_local_evidence requires empty release_blockers"
            )
        if status != "complete_local_evidence" and not blockers:
            failures.append(f"{rel}: non-complete status requires non-empty release_blockers")

    return failures


def code_from_text(text: str) -> str:
    cleaned = "".join(char.lower() if char.isalnum() else "_" for char in text)
    return "_".join(part for part in cleaned.split("_") if part)[:96] or "pd_evidence_gate_failure"


def write_report(failures: list[str], manifest_count: int) -> None:
    findings = [
        {
            "code": code_from_text(failure),
            "severity": "fail",
            "message": failure,
            "evidence": "docs/evidence/pd",
            "next_step": "Fix the malformed or incomplete PD evidence manifest before using PD evidence as release support.",
        }
        for failure in failures
    ]
    report = {
        "schema": "eliza.pd_evidence_gates.v1",
        "status": "fail" if failures else "pass",
        "claim_boundary": "pd_evidence_schema_check_only_not_physical_signoff_evidence",
        "summary": {"manifests": manifest_count, "findings": len(findings)},
        "findings": findings,
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    if not EVIDENCE_DIR.is_dir():
        failures = [f"evidence directory missing: {EVIDENCE_DIR.relative_to(ROOT)}"]
        write_report(failures, 0)
        for failure in failures:
            fail(failure)
        return 1
    manifests = sorted(EVIDENCE_DIR.glob("*.yaml"))
    if not manifests:
        failures = [f"no evidence manifests under {EVIDENCE_DIR.relative_to(ROOT)}"]
        write_report(failures, 0)
        for failure in failures:
            fail(failure)
        return 1
    all_failures: list[str] = []
    for manifest in manifests:
        all_failures.extend(validate_manifest(manifest))
    write_report(all_failures, len(manifests))
    if all_failures:
        for f in all_failures:
            fail(f)
        return 1
    print(f"PASS: validated {len(manifests)} PD evidence gate(s)")
    for manifest in manifests:
        print(f"  - {manifest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
