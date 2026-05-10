"""Live contacts scenarios."""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_RIA_PM

LIVE_CONTACTS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.contacts.disambiguate_and_log_followup",
        name="Disambiguate a contact and log a follow-up",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_RIA_PM,
        instruction=(
            "I had a great call this morning with someone named Carter "
            "— I want to log a follow-up note and add them to my work "
            "tag. There's more than one Carter in my contacts. Help me "
            "pick the right one. After we agree, log the note: "
            "'discussed Q3 partnership terms; will follow up in 2 weeks.'"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Disambiguation + interaction logging. Persona expects the "
            "agent to enumerate matches, pick one with their input, then "
            "execute."
        ),
        success_criteria=[
            "Executor enumerates the multiple Carter matches before acting.",
            "Executor asks the persona to pick (or proposes the most likely with reasoning).",
            "After resolution, executor logs the note OR drafts what it would log for confirmation.",
        ],
        world_assertions=[
            "If executed: an interaction log against a specific contact_* with notes mentioning 'Q3 partnership'.",
        ],
    ),
]
