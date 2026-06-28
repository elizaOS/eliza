#!/usr/bin/env python3
"""Validate the confidential-domain page-state transition policy."""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_POLICY = REPO_ROOT / "packages/chip/docs/spec-db/tee-page-state-transitions.json"
REQUIRED_STATES = {
    "free",
    "measured",
    "private",
    "shared",
    "device-assigned",
    "scrub-pending",
}
REQUIRED_FORBIDDEN = {
    ("private", "free"),
    ("measured", "shared"),
    ("measured", "free"),
}


def validate(policy: dict[str, object]) -> list[str]:
    errors: list[str] = []
    if policy.get("schemaVersion") != 1:
        errors.append("schemaVersion must be 1")
    states = policy.get("states")
    if not isinstance(states, list):
        errors.append("states must be a list")
        return errors
    state_set = {str(state) for state in states}
    missing_states = sorted(REQUIRED_STATES.difference(state_set))
    if missing_states:
        errors.append(f"states missing required items: {', '.join(missing_states)}")

    transitions = policy.get("transitions")
    if not isinstance(transitions, list) or not transitions:
        errors.append("transitions must be a non-empty list")
        return errors
    transition_pairs: set[tuple[str, str]] = set()
    for index, transition in enumerate(transitions):
        prefix = f"transitions[{index}]"
        if not isinstance(transition, dict):
            errors.append(f"{prefix} must be an object")
            continue
        source = transition.get("from")
        target = transition.get("to")
        if source not in state_set:
            errors.append(f"{prefix}.from is not a declared state")
        if target not in state_set:
            errors.append(f"{prefix}.to is not a declared state")
        if isinstance(source, str) and isinstance(target, str):
            transition_pairs.add((source, target))
        if not isinstance(transition.get("operation"), str):
            errors.append(f"{prefix}.operation must be a string")
        requires = transition.get("requires")
        if not isinstance(requires, list) or not requires:
            errors.append(f"{prefix}.requires must be a non-empty list")

    for required_pair in [
        ("free", "measured"),
        ("measured", "private"),
        ("private", "shared"),
        ("shared", "private"),
        ("private", "device-assigned"),
        ("device-assigned", "private"),
        ("private", "scrub-pending"),
        ("scrub-pending", "free"),
    ]:
        if required_pair not in transition_pairs:
            errors.append(f"missing required transition {required_pair[0]} -> {required_pair[1]}")

    forbidden = policy.get("forbiddenTransitions")
    if not isinstance(forbidden, list):
        errors.append("forbiddenTransitions must be a list")
        return errors
    forbidden_pairs = {
        (item.get("from"), item.get("to"))
        for item in forbidden
        if isinstance(item, dict) and "unlessRequires" not in item
    }
    conditional_forbidden_pairs = {
        (item.get("from"), item.get("to"))
        for item in forbidden
        if isinstance(item, dict) and "unlessRequires" in item
    }
    missing_forbidden = sorted(REQUIRED_FORBIDDEN.difference(forbidden_pairs))
    if missing_forbidden:
        errors.append(
            "forbiddenTransitions missing required pairs: "
            + ", ".join(f"{source}->{target}" for source, target in missing_forbidden)
        )

    for source, target in forbidden_pairs:
        if (source, target) in transition_pairs:
            errors.append(f"transition {source} -> {target} is both allowed and forbidden")
    for source, target in conditional_forbidden_pairs:
        if (source, target) not in transition_pairs:
            errors.append(
                f"conditional forbidden transition {source} -> {target} has no allowed transition to constrain"
            )

    device_transition = next(
        (
            transition
            for transition in transitions
            if isinstance(transition, dict)
            and transition.get("from") == "private"
            and transition.get("to") == "device-assigned"
        ),
        None,
    )
    if isinstance(device_transition, dict):
        requires = set(device_transition.get("requires", []))
        if not {"iopmp-policy", "measured-device"}.issubset(requires):
            errors.append(
                "private -> device-assigned must require iopmp-policy and measured-device"
            )

    return errors


def main(argv: list[str]) -> int:
    policy_path = Path(argv[1]) if len(argv) > 1 else DEFAULT_POLICY
    policy = json.loads(policy_path.read_text())
    errors = validate(policy)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"TEE page-state policy valid: {policy_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
