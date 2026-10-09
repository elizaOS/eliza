"""Checks every parent-suite policy against the committed generated-action drift detector."""

from __future__ import annotations

import json
from pathlib import Path

from eliza_lifeops_bench.scenarios.world_traveling_coparent import (
    _CAPABILITY_ACTION_POLICIES,
)

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "manifests" / "actions.manifest.json"
BENCH_ONLY_PLUGIN = "@elizaos/lifeops-bench"

# These cases still require a domain redesign before their modeled stand-ins
# can be replaced. Keeping the set exact makes new stand-ins fail the audit.
KNOWN_BENCH_ONLY_POLICIES = {
    ("G5", "BOOK_TRAVEL"),
    ("G6", "BOOK_TRAVEL"),
    ("G13", "LIFE_CREATE"),
    ("G25", "HEALTH"),
    ("G25", "LIFE_REVIEW"),
}

# Calendar mutation requests create approvals; RESOLVE_REQUEST performs the
# write. These stale required kwargs cannot be removed until those cases model
# the two-action approval lifecycle.
KNOWN_NON_MANIFEST_REQUIRED_KWARGS = {
    ("G8", "CALENDAR", "approvalId"),
    ("G14", "CALENDAR", "approvalId"),
    ("G18", "CALENDAR", "approvalId"),
    ("G41", "CALENDAR", "approvalId"),
    ("G42", "CALENDAR", "approvalId"),
    ("G43", "CALENDAR", "approvalId"),
    ("G44", "CALENDAR", "approvalId"),
    ("G45", "CALENDAR", "approvalId"),
}


def _manifest() -> dict[str, dict[str, object]]:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    return {entry["function"]["name"]: entry for entry in raw["actions"]}


def test_all_parent_action_policies_match_manifest_names_and_discriminators() -> None:
    manifest = _manifest()
    errors: list[str] = []
    bench_only: set[tuple[str, str]] = set()
    non_manifest_required: set[tuple[str, str, str]] = set()

    for capability_id, policies in _CAPABILITY_ACTION_POLICIES.items():
        for policy in policies:
            entry = manifest.get(policy.name)
            if entry is None:
                errors.append(f"{capability_id}: missing action {policy.name}")
                continue
            if entry.get("_plugin") == BENCH_ONLY_PLUGIN:
                bench_only.add((capability_id, policy.name))
            function = entry["function"]
            assert isinstance(function, dict)
            parameters = function["parameters"]
            assert isinstance(parameters, dict)
            properties = parameters.get("properties")
            assert isinstance(properties, dict)
            if policy.discriminator_field is not None:
                discriminator = properties.get(policy.discriminator_field)
                if not isinstance(discriminator, dict):
                    errors.append(
                        f"{capability_id}: {policy.name} has no "
                        f"{policy.discriminator_field} discriminator"
                    )
                else:
                    allowed = discriminator.get("enum")
                    if not isinstance(allowed, list):
                        errors.append(
                            f"{capability_id}: {policy.name} "
                            f"{policy.discriminator_field} has no enum"
                        )
                    else:
                        invalid = sorted(
                            set(policy.allowed_discriminators).difference(allowed)
                        )
                        if invalid:
                            errors.append(
                                f"{capability_id}: {policy.name} rejects "
                                f"{policy.discriminator_field}={invalid}"
                            )
            non_manifest_required.update(
                (capability_id, policy.name, field)
                for field in policy.required_kwargs
                if field not in properties
            )

    assert errors == []
    assert bench_only == KNOWN_BENCH_ONLY_POLICIES
    assert non_manifest_required == KNOWN_NON_MANIFEST_REQUIRED_KWARGS
