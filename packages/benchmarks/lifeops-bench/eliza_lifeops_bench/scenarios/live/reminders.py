"""Live reminders scenarios."""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_OWEN_RETIREE

LIVE_REMINDERS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.reminders.set_up_medication_routine",
        name="Set up a complete medication routine",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_OWEN_RETIREE,
        instruction=(
            "I take three pills now: blood pressure in the morning, a "
            "vitamin at lunch, and a sleep aid at night. Set up the "
            "reminders for me. I don't remember the exact times — please "
            "ask me what works."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Multi-reminder setup. Persona is non-technical and expects "
            "the agent to walk through times one by one."
        ),
        success_criteria=[
            "Executor asks for the times of each medication rather than guessing.",
            "Executor creates three distinct daily reminders (or proposes them clearly), one per medication.",
            "Executor uses the persona's own confirmed times — no hallucinated defaults.",
        ],
        world_assertions=[
            "Three new reminders on list_personal with cadence=daily and titles referencing 'blood pressure', 'vitamin', and 'sleep aid' (or close synonyms).",
        ],
    ),
]
