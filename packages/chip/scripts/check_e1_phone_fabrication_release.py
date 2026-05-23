#!/usr/bin/env python3
"""Fail-closed release gate for E1 phone fabrication/enclosure/e2e readiness."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
GATE_PATH = (
    ROOT / "board/kicad/e1-phone/production/readiness/"
    "fabrication-enclosure-e2e-release-gate-2026-05-22.yaml"
)
EXPECTED_SCHEMA = "eliza.e1_phone_fabrication_enclosure_e2e_release_gate.v1"
RELEASE_FLAGS = (
    "fabrication_release_allowed",
    "enclosure_release_allowed",
    "factory_first_article_allowed",
    "end_to_end_release_allowed",
)


def load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"missing release gate report: {path.relative_to(ROOT)}")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.relative_to(ROOT)} must be a YAML mapping")
    return data


def main() -> int:
    try:
        report = load_yaml_mapping(GATE_PATH)
        if report.get("schema") != EXPECTED_SCHEMA:
            raise ValueError(f"unexpected schema: {report.get('schema')!r}")
        summary = report.get("summary")
        if not isinstance(summary, dict):
            raise ValueError("summary must be a mapping")
        release_gates = report.get("release_gates")
        if not isinstance(release_gates, list) or not release_gates:
            raise ValueError("release_gates must be a non-empty list")

        blocked_gate_count = summary.get("blocked_release_gate_count")
        total_blockers = summary.get("total_blocker_count")
        release_state = summary.get("release_state")
        allowed = [summary.get(flag) is True for flag in RELEASE_FLAGS]
        if all(allowed) and blocked_gate_count == 0 and total_blockers == 0:
            print("STATUS: PASS E1 phone fabrication/enclosure/e2e release gate")
            return 0

        print(
            "STATUS: BLOCKED E1 phone fabrication/enclosure/e2e release gate "
            f"state={release_state} blocked_gates={blocked_gate_count} "
            f"blockers={total_blockers}"
        )
        return 2
    except ValueError as exc:
        print(f"FAIL: E1 phone fabrication release gate invalid: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
