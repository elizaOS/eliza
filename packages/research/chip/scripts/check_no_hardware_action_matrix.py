#!/usr/bin/env python3
"""Validate the no-hardware action matrix stays concrete and fail-closed."""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
MATRIX = ROOT / "docs/project/no-hardware-action-matrix-2026-05-17.yaml"

REQUIRED_WORKSTREAMS = {
    "cpu_ap",
    "android_bsp",
    "simulators",
    "benchmarks",
    "physical_package_board",
    "product_features_compliance",
}

REQUIRED_COMMANDS = {
    "make evidence-regression-test",
    "make mvp-status",
    "make archive-release",
    "make product-release-check",
    "make software-bsp-evidence-check",
    "make cpu-ap-evidence-check",
    "make renode-check-strict",
}


def main() -> int:
    if not MATRIX.is_file():
        print(f"missing no-hardware action matrix: {MATRIX.relative_to(ROOT)}")
        return 1

    data = yaml.safe_load(MATRIX.read_text())
    errors: list[str] = []
    if not isinstance(data, dict):
        print("no-hardware action matrix must be a YAML mapping")
        return 1

    if data.get("schema") != "eliza.no_hardware_action_matrix.v1":
        errors.append("wrong schema id")
    if "This is not a claim that Android or silicon works." not in str(data.get("purpose", "")):
        errors.append("purpose must explicitly reject Android/silicon claims")

    claim_policy = "\n".join(str(item) for item in data.get("claim_policy", []))
    for term in (
        "No Android support is claimed",
        "No silicon/board/product claim",
        "No benchmark passes",
    ):
        if term not in claim_policy:
            errors.append(f"claim_policy missing term: {term}")

    workstreams = data.get("workstreams")
    if not isinstance(workstreams, list):
        errors.append("workstreams must be a list")
        workstreams = []
    ids = {item.get("id") for item in workstreams if isinstance(item, dict)}
    missing = sorted(REQUIRED_WORKSTREAMS - ids)
    if missing:
        errors.append("missing workstreams: " + ", ".join(missing))

    observed_commands: set[str] = set()
    for item in workstreams:
        if not isinstance(item, dict):
            errors.append("workstream entries must be mappings")
            continue
        workstream_id = item.get("id", "<unknown>")
        if not isinstance(item.get("doable_now"), list) or len(item["doable_now"]) < 3:
            errors.append(f"{workstream_id}: doable_now must list at least three concrete actions")
        if not isinstance(item.get("current_blocker"), str) or "No " not in item["current_blocker"]:
            errors.append(f"{workstream_id}: current_blocker must be explicit")
        next_artifact = item.get("next_artifact")
        if not isinstance(next_artifact, str) or not next_artifact:
            errors.append(f"{workstream_id}: next_artifact is required")
        elif not (ROOT / next_artifact).exists():
            errors.append(
                f"{workstream_id}: next_artifact points at missing repo path {next_artifact}"
            )
        commands = item.get("local_commands")
        if not isinstance(commands, list) or not commands:
            errors.append(f"{workstream_id}: local_commands must not be empty")
        else:
            observed_commands.update(str(command) for command in commands)

    aggregate = data.get("aggregate_commands")
    if not isinstance(aggregate, dict):
        errors.append("aggregate_commands must be a mapping")
    else:
        for value in aggregate.values():
            if isinstance(value, str):
                observed_commands.add(value)
            elif isinstance(value, list):
                observed_commands.update(str(command) for command in value)

    missing_commands = sorted(REQUIRED_COMMANDS - observed_commands)
    if missing_commands:
        errors.append("missing required local commands: " + ", ".join(missing_commands))

    if errors:
        print("No-hardware action matrix check failed:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("no-hardware action matrix is concrete and fail-closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
