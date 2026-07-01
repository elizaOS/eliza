#!/usr/bin/env python3
"""Fail-closed spec-traceability AI-use policy gate.

This replaces the prior dry-run capture posture (which hardcoded every
traceability flag to ``False`` and listed the feature as blocked-by
"no approved stable requirement-ID scheme"). That scheme now exists:
``docs/spec-db/requirements/*.yaml`` (``eliza.requirement.v1``) feeds the
reviewed, deterministic graph builder and gate.

This gate enforces the policy in ``docs/spec-db/spec-traceability-policy.yaml``
and then runs the real traceability gate. It fails closed when:

* the policy manifest is missing or relaxes any AI-use restriction;
* the declared generator / gate / change-impact scripts are missing;
* the underlying ``check_traceability`` gate reports any dangling link,
  orphan requirement, unknown gate, expired waiver, or source-doc-sha drift.

AI agents may read the traceability graph; they may not generate or close
requirements, specs, RTL, assertions, or waivers, and no traceability or
coverage signoff claim is promoted here.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import check_traceability
import yaml

ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "docs/spec-db/spec-traceability-policy.yaml"
EXPECTED_SCHEMA = "eliza.spec_traceability_policy.v1"

REQUIRED_FALSE_FLAGS = (
    "generated_requirements_allowed",
    "generated_spec_edits_allowed",
    "generated_rtl_allowed",
    "generated_assertions_allowed",
    "generated_waivers_allowed",
    "traceability_signoff_claim_allowed",
    "requirement_coverage_signoff_claim_allowed",
)
FALSE_CLAIM_FLAGS = {key: False for key in REQUIRED_FALSE_FLAGS}


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def check_policy(errors: list[str]) -> dict[str, Any] | None:
    if not POLICY_PATH.is_file():
        errors.append(f"policy manifest missing: {_rel(POLICY_PATH)}")
        return None
    payload = yaml.safe_load(POLICY_PATH.read_text())
    if not isinstance(payload, dict):
        errors.append(f"policy manifest is not a mapping: {_rel(POLICY_PATH)}")
        return None
    if payload.get("schema") != EXPECTED_SCHEMA:
        errors.append(f"policy schema must be {EXPECTED_SCHEMA}")
    if payload.get("status") != "ACTIVE":
        errors.append("policy status must be ACTIVE")
    policy = payload.get("ai_use_policy")
    if not isinstance(policy, dict):
        errors.append("ai_use_policy must be a mapping")
    else:
        for flag in REQUIRED_FALSE_FLAGS:
            if policy.get(flag) is not False:
                errors.append(f"ai_use_policy.{flag} must be false")
        if policy.get("false_claim_flags") != FALSE_CLAIM_FLAGS:
            errors.append("ai_use_policy.false_claim_flags must match denied traceability claims")
    return payload


def check_referenced_scripts(payload: dict[str, Any], errors: list[str]) -> None:
    referenced = [
        ("generator", "graph_builder"),
        ("gate", "checker"),
        ("change_impact", "query"),
    ]
    for section, key in referenced:
        block = payload.get(section)
        if not isinstance(block, dict):
            errors.append(f"policy.{section} must be a mapping")
            continue
        script = block.get(key)
        if not isinstance(script, str) or not (ROOT / script).is_file():
            errors.append(f"policy.{section}.{key} must reference an existing script")


def main() -> int:
    errors: list[str] = []
    payload = check_policy(errors)
    if payload is not None:
        check_referenced_scripts(payload, errors)
    if errors:
        for line in errors:
            print(f"FAIL: {line}", file=sys.stderr)
        return 1

    code, coverage, gate_errors = check_traceability.run(write=True)
    if gate_errors:
        for line in gate_errors:
            print(f"FAIL: {line}", file=sys.stderr)
        print(
            "FAIL: spec-traceability AI policy gate blocked by traceability errors", file=sys.stderr
        )
        return 1 if code == 0 else code

    summary = coverage["summary"]
    print(
        "STATUS: PASS spec_traceability_ai_policy "
        f"{_rel(POLICY_PATH)} "
        f"(requirements={summary['requirements']} "
        f"overall_closure={summary['overall_closure_pct']}%)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
