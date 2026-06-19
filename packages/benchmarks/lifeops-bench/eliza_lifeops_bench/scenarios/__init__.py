"""LifeOpsBench scenario registry.

Hand-authored scenarios are organized one module per Domain. Each
module exports a single ``<DOMAIN>_SCENARIOS`` list. This module
aggregates them into the public ``ALL_SCENARIOS`` registry plus the
two index dicts.

The two original smoke scenarios (``smoke_static_calendar_01`` and
``smoke_live_mail_01``) are kept at the front of the list for back-compat
with the scaffold test that imports them by id.
"""

from __future__ import annotations

from dataclasses import replace

from ..types import Domain, Scenario
from ._smoke_scenarios import SMOKE_SCENARIOS
from .calendar import CALENDAR_SCENARIOS
from .contacts import CONTACTS_SCENARIOS
from .expanded import EXPANDED_SCENARIOS
from .finance import FINANCE_SCENARIOS
from .focus import FOCUS_SCENARIOS
from .health import HEALTH_SCENARIOS
from .live import ALL_LIVE_SCENARIOS
from .mail import MAIL_SCENARIOS
from .messages import MESSAGES_SCENARIOS
from .reminders import REMINDERS_SCENARIOS
from .sleep import SLEEP_SCENARIOS
from .travel import TRAVEL_SCENARIOS

EDGE_EXPANSION_MULTIPLIER = 10
EDGE_VARIANTS: tuple[tuple[str, str, str], ...] = (
    ("polite", "Polite framing.", "Please help with this: {instruction}"),
    ("urgent", "Urgent operations framing.", "This is urgent: {instruction}"),
    ("mobile", "Mobile-message framing.", "Sent from mobile, quick note: {instruction}"),
    ("followup", "Follow-up thread framing.", "Following up from earlier: {instruction}"),
    ("quoted", "Forwarded quoted request.", "Forwarded request:\n> {instruction}"),
    ("context", "Extra operating context.", "Context: LifeOps benchmark edge case\n{instruction}"),
    ("brief", "Brevity preference.", "Keep this brief if you reply: {instruction}"),
    ("noisy", "Natural chat filler.", "Hey, sorry for the messy phrasing, {instruction}"),
    ("boundary", "Explicit user-intent boundary.", "User intent starts here:\n{instruction}"),
    ("handoff", "Teammate handoff framing.", "My teammate asked me to pass this along: {instruction}"),
)

if len(EDGE_VARIANTS) != EDGE_EXPANSION_MULTIPLIER:
    raise RuntimeError(
        f"LifeOpsBench edge expansion requires {EDGE_EXPANSION_MULTIPLIER} variants, "
        f"found {len(EDGE_VARIANTS)}"
    )

CORE_SCENARIOS: list[Scenario] = [
    *SMOKE_SCENARIOS,
    *CALENDAR_SCENARIOS,
    *MAIL_SCENARIOS,
    *MESSAGES_SCENARIOS,
    *CONTACTS_SCENARIOS,
    *REMINDERS_SCENARIOS,
    *FINANCE_SCENARIOS,
    *TRAVEL_SCENARIOS,
    *HEALTH_SCENARIOS,
    *SLEEP_SCENARIOS,
    *FOCUS_SCENARIOS,
    *ALL_LIVE_SCENARIOS,
    *EXPANDED_SCENARIOS,
]

EDGE_EXPANDED_SCENARIOS: list[Scenario] = [
    replace(
        scenario,
        id=f"{scenario.id}--edge-{variant_id}",
        name=f"{scenario.name} ({variant_id})",
        instruction=template.format(instruction=scenario.instruction),
        description=f"{scenario.description} Edge variant: {description}",
    )
    for scenario in CORE_SCENARIOS
    for variant_id, description, template in EDGE_VARIANTS
]

if len(EDGE_EXPANDED_SCENARIOS) != len(CORE_SCENARIOS) * EDGE_EXPANSION_MULTIPLIER:
    raise RuntimeError(
        "LifeOpsBench edge expansion mismatch: "
        f"expected {len(CORE_SCENARIOS) * EDGE_EXPANSION_MULTIPLIER}, "
        f"found {len(EDGE_EXPANDED_SCENARIOS)}"
    )

ALL_SCENARIOS: list[Scenario] = [
    *CORE_SCENARIOS,
    *EDGE_EXPANDED_SCENARIOS,
]

SCENARIOS_BY_ID: dict[str, Scenario] = {s.id: s for s in ALL_SCENARIOS}

SCENARIOS_BY_DOMAIN: dict[Domain, list[Scenario]] = {}
for _scenario in ALL_SCENARIOS:
    SCENARIOS_BY_DOMAIN.setdefault(_scenario.domain, []).append(_scenario)


def count_lifeops_scenarios() -> dict[str, int | str | float]:
    return {
        "suite": "lifeops-bench",
        "existing": len(CORE_SCENARIOS),
        "added": len(EDGE_EXPANDED_SCENARIOS),
        "total": len(ALL_SCENARIOS),
        "multiplierAdded": len(EDGE_EXPANDED_SCENARIOS) / len(CORE_SCENARIOS),
    }


def validate_lifeops_scenarios() -> dict[str, object]:
    ids: set[str] = set()
    duplicate_ids: set[str] = set()
    empty_instructions: list[str] = []
    for scenario in ALL_SCENARIOS:
        if scenario.id in ids:
            duplicate_ids.add(scenario.id)
        ids.add(scenario.id)
        if not scenario.instruction.strip():
            empty_instructions.append(scenario.id)
    expansion_matches = (
        len(EDGE_EXPANDED_SCENARIOS)
        == len(CORE_SCENARIOS) * EDGE_EXPANSION_MULTIPLIER
    )
    return {
        "valid": not duplicate_ids and not empty_instructions and expansion_matches,
        "total": len(ALL_SCENARIOS),
        "uniqueIds": len(ids),
        "duplicateIds": sorted(duplicate_ids),
        "emptyInstructions": empty_instructions,
        "expansionMatches": expansion_matches,
    }


__all__ = [
    "ALL_LIVE_SCENARIOS",
    "ALL_SCENARIOS",
    "CALENDAR_SCENARIOS",
    "CONTACTS_SCENARIOS",
    "CORE_SCENARIOS",
    "EDGE_EXPANDED_SCENARIOS",
    "EXPANDED_SCENARIOS",
    "FINANCE_SCENARIOS",
    "FOCUS_SCENARIOS",
    "HEALTH_SCENARIOS",
    "MAIL_SCENARIOS",
    "MESSAGES_SCENARIOS",
    "REMINDERS_SCENARIOS",
    "SCENARIOS_BY_DOMAIN",
    "SCENARIOS_BY_ID",
    "SLEEP_SCENARIOS",
    "SMOKE_SCENARIOS",
    "TRAVEL_SCENARIOS",
    "count_lifeops_scenarios",
    "validate_lifeops_scenarios",
]
