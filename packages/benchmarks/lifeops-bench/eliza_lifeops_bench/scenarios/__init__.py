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
from .adhd_capture import ADHD_CAPTURE_SCENARIOS
from .calendar import CALENDAR_SCENARIOS
from .co_parenting import CO_PARENTING_SCENARIOS
from .comms_flood_triage import COMMS_FLOOD_TRIAGE_SCENARIOS
from .contacts import CONTACTS_SCENARIOS
from .expanded import EXPANDED_SCENARIOS
from .finance import FINANCE_SCENARIOS
from .focus import FOCUS_SCENARIOS
from .health import HEALTH_SCENARIOS
from .kg_live_capture import KG_LIVE_CAPTURE_SCENARIOS
from .live import ALL_LIVE_SCENARIOS
from .low_activation import LOW_ACTIVATION_SCENARIOS
from .mail import MAIL_SCENARIOS
from .mediation_logistics import MEDIATION_LOGISTICS_SCENARIOS
from .messages import MESSAGES_SCENARIOS
from .neurotypical_control import NEUROTYPICAL_CONTROL_SCENARIOS
from .night_owl_anchored_day import NIGHT_OWL_ANCHORED_DAY_SCENARIOS
from .overdue_comms_apology import OVERDUE_COMMS_APOLOGY_SCENARIOS
from .parent_persona_variants import PARENT_PERSONA_VARIANT_SCENARIOS
from .personas import PERSONA_SCENARIOS
from .reconnect_old_friends import RECONNECT_OLD_FRIENDS_SCENARIOS
from .reminders import REMINDERS_SCENARIOS
from .rupture_repair import RUPTURE_REPAIR_SCENARIOS
from .relationship_type_inference import RELATIONSHIP_TYPE_INFERENCE_SCENARIOS
from .shift_rotation import SHIFT_ROTATION_SCENARIOS
from .sleep import SLEEP_SCENARIOS
from .travel import TRAVEL_SCENARIOS
from .traveler_timezone import TRAVELER_TIMEZONE_SCENARIOS
from .third_party_support import THIRD_PARTY_SUPPORT_SCENARIOS
from .world_traveling_coparent import (
    WORLD_TRAVELING_COPARENT_SCENARIOS,
    WORLD_TRAVELING_COPARENT_UNINSTRUCTED_SCENARIOS,
)

EDGE_EXPANSION_MULTIPLIER = 10
EDGE_VARIANTS: tuple[tuple[str, str, str], ...] = (
    (
        "vague",
        "Indirect, deliberately vague language.",
        "Start indirectly and omit one material detail. Use a natural vague "
        "reference instead of naming the task outright; reveal the missing fact "
        "only if the executor asks or makes it relevant.",
    ),
    (
        "referential",
        "Pronouns and context-dependent referents.",
        "Use pronouns or phrases such as 'that one', 'the earlier thing', or "
        "'over there' where the persona plausibly would. Resolve each referent "
        "in later turns without changing the hidden goal.",
    ),
    (
        "correction",
        "Natural self-correction across turns.",
        "Phrase one detail provisionally, then correct or refine it naturally "
        "when the executor exposes the assumption. The final clarified facts "
        "must exactly preserve the hidden goal.",
    ),
    (
        "colloquial",
        "Persona-faithful colloquial language.",
        "Use idioms, contractions, fragments, or everyday shorthand natural for "
        "this persona. Avoid benchmark vocabulary and formal requirement lists.",
    ),
    (
        "noisy",
        "Typos, disfluency, and mobile-chat noise.",
        "Include a small realistic typo, false start, omitted article, or "
        "punctuation irregularity while keeping every material fact recoverable "
        "through conversation.",
    ),
    (
        "code-switch",
        "Light code-switching or mixed register.",
        "Use a brief, natural code-switch if the persona background supports "
        "one; otherwise mix conversational register, abbreviations, or a common "
        "loan phrase. Never add a translation label or alter the hidden facts.",
    ),
    (
        "underspecified",
        "Materially underspecified opening.",
        "Withhold exactly one decision-critical constraint from the opening and "
        "supply it only after a relevant clarification. Do not let the executor "
        "safely complete the full task from the first message alone.",
    ),
    (
        "stressed",
        "Emotionally compressed, distracted wording.",
        "Sound rushed, tired, or distracted in the persona's own style. Keep the "
        "message short and non-exhaustive, but do not manufacture urgency or "
        "change the requested outcome.",
    ),
    (
        "relative-time",
        "Relational time and implicit ordering.",
        "Express dates, times, or ordering relationally where the hidden goal "
        "permits it (for example 'after that' or 'the next morning'). Clarify "
        "to the exact hidden time if ambiguity matters.",
    ),
    (
        "handoff",
        "Fragmented second-hand or forwarded context.",
        "Present the request as a plausible handoff or continuation of an "
        "earlier conversation. Reveal ownership and missing context naturally "
        "instead of copying the hidden goal into a forwarded block.",
    ),
)

if len(EDGE_VARIANTS) != EDGE_EXPANSION_MULTIPLIER:
    raise RuntimeError(
        f"LifeOpsBench edge expansion requires {EDGE_EXPANSION_MULTIPLIER} variants, "
        f"found {len(EDGE_VARIANTS)}"
    )

CORE_SCENARIOS: list[Scenario] = [
    *SMOKE_SCENARIOS,
    *ADHD_CAPTURE_SCENARIOS,
    *CALENDAR_SCENARIOS,
    *CO_PARENTING_SCENARIOS,
    *COMMS_FLOOD_TRIAGE_SCENARIOS,
    *MAIL_SCENARIOS,
    *MEDIATION_LOGISTICS_SCENARIOS,
    *MESSAGES_SCENARIOS,
    *NEUROTYPICAL_CONTROL_SCENARIOS,
    *NIGHT_OWL_ANCHORED_DAY_SCENARIOS,
    *OVERDUE_COMMS_APOLOGY_SCENARIOS,
    *PARENT_PERSONA_VARIANT_SCENARIOS,
    *RECONNECT_OLD_FRIENDS_SCENARIOS,
    *RELATIONSHIP_TYPE_INFERENCE_SCENARIOS,
    *KG_LIVE_CAPTURE_SCENARIOS,
    *CONTACTS_SCENARIOS,
    *REMINDERS_SCENARIOS,
    *RUPTURE_REPAIR_SCENARIOS,
    *FINANCE_SCENARIOS,
    *SHIFT_ROTATION_SCENARIOS,
    *TRAVEL_SCENARIOS,
    *TRAVELER_TIMEZONE_SCENARIOS,
    *THIRD_PARTY_SUPPORT_SCENARIOS,
    *WORLD_TRAVELING_COPARENT_SCENARIOS,
    *WORLD_TRAVELING_COPARENT_UNINSTRUCTED_SCENARIOS,
    *HEALTH_SCENARIOS,
    *LOW_ACTIVATION_SCENARIOS,
    *SLEEP_SCENARIOS,
    *FOCUS_SCENARIOS,
    *ALL_LIVE_SCENARIOS,
    *EXPANDED_SCENARIOS,
    *PERSONA_SCENARIOS,
]

EDGE_EXPANDED_SCENARIOS: list[Scenario] = [
    replace(
        scenario,
        id=f"{scenario.id}--edge-{variant_id}",
        name=f"{scenario.name} ({variant_id})",
        opening_mode="simulated",
        opening_challenge=challenge,
        description=f"{scenario.description} Language challenge: {description}",
    )
    for scenario in CORE_SCENARIOS
    for variant_id, description, challenge in EDGE_VARIANTS
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
    """Honest base-vs-robustness scenario accounting.

    The corpus has ``len(CORE_SCENARIOS)`` distinct, hand-authored *base*
    scenarios. Each base is then re-emitted ``EDGE_EXPANSION_MULTIPLIER``
    times under model-driven language challenges (vagueness, referents,
    correction, code-switching, noise, and underspecification). An
    edge variant shares the SAME ``ground_truth_actions``,
    ``required_outputs``, hidden ``instruction`` and ``world_seed`` as its
    base. The independent persona model creates the actual opening and
    continuations under ``opening_challenge``. They are language-robustness
    *runs*, not new distinct scenarios, so the count must not present
    ``total`` as if it were a count of distinct scenarios.

    Legacy numeric keys (``existing`` / ``added`` / ``total`` /
    ``multiplierAdded``) are kept for back-compat. The ``base`` /
    ``variantsPerBase`` / ``totalRuns`` keys and ``summary`` string state the
    base-vs-variant split explicitly.
    """
    base = len(CORE_SCENARIOS)
    variants_per_base = EDGE_EXPANSION_MULTIPLIER
    total_runs = len(ALL_SCENARIOS)
    return {
        "suite": "lifeops-bench",
        # Legacy keys (kept for back-compat with existing consumers/tests).
        "existing": base,
        "added": len(EDGE_EXPANDED_SCENARIOS),
        "total": total_runs,
        "multiplierAdded": len(EDGE_EXPANDED_SCENARIOS) / base,
        # Honest, explicitly-labelled split.
        "base": base,
        "variantsPerBase": variants_per_base,
        "totalRuns": total_runs,
        "summary": (
            f"{base} base scenarios; {variants_per_base}x model-generated "
            f"language challenges = {total_runs} runs"
        ),
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
        len(EDGE_EXPANDED_SCENARIOS) == len(CORE_SCENARIOS) * EDGE_EXPANSION_MULTIPLIER
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
    "ADHD_CAPTURE_SCENARIOS",
    "ALL_LIVE_SCENARIOS",
    "ALL_SCENARIOS",
    "CALENDAR_SCENARIOS",
    "CO_PARENTING_SCENARIOS",
    "COMMS_FLOOD_TRIAGE_SCENARIOS",
    "CONTACTS_SCENARIOS",
    "CORE_SCENARIOS",
    "EDGE_EXPANDED_SCENARIOS",
    "EXPANDED_SCENARIOS",
    "FINANCE_SCENARIOS",
    "FOCUS_SCENARIOS",
    "HEALTH_SCENARIOS",
    "KG_LIVE_CAPTURE_SCENARIOS",
    "LOW_ACTIVATION_SCENARIOS",
    "MAIL_SCENARIOS",
    "MEDIATION_LOGISTICS_SCENARIOS",
    "MESSAGES_SCENARIOS",
    "NEUROTYPICAL_CONTROL_SCENARIOS",
    "NIGHT_OWL_ANCHORED_DAY_SCENARIOS",
    "OVERDUE_COMMS_APOLOGY_SCENARIOS",
    "PARENT_PERSONA_VARIANT_SCENARIOS",
    "PERSONA_SCENARIOS",
    "RECONNECT_OLD_FRIENDS_SCENARIOS",
    "RELATIONSHIP_TYPE_INFERENCE_SCENARIOS",
    "REMINDERS_SCENARIOS",
    "RUPTURE_REPAIR_SCENARIOS",
    "SHIFT_ROTATION_SCENARIOS",
    "SCENARIOS_BY_DOMAIN",
    "SCENARIOS_BY_ID",
    "SLEEP_SCENARIOS",
    "SMOKE_SCENARIOS",
    "TRAVEL_SCENARIOS",
    "TRAVELER_TIMEZONE_SCENARIOS",
    "THIRD_PARTY_SUPPORT_SCENARIOS",
    "WORLD_TRAVELING_COPARENT_SCENARIOS",
    "WORLD_TRAVELING_COPARENT_UNINSTRUCTED_SCENARIOS",
    "count_lifeops_scenarios",
    "validate_lifeops_scenarios",
]
