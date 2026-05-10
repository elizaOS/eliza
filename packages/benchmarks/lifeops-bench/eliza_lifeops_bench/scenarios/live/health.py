"""Live health scenarios."""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_OWEN_RETIREE

LIVE_HEALTH_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.health.weekly_health_checkin",
        name="Weekly health check-in conversation",
        domain=Domain.HEALTH,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_OWEN_RETIREE,
        instruction=(
            "Could you give me a friendly run-through of how I've been "
            "doing this week? Steps, sleep, weight, blood pressure if "
            "it's there. If anything looks off, tell me kindly — and "
            "remind me to ask my doctor about it."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Health summary with bedside manner. Persona is non-technical "
            "and wants reassurance + actionable next steps."
        ),
        success_criteria=[
            "Executor reports specific numbers from at least three of: steps, sleep, weight, blood pressure.",
            "Executor uses warm, accessible language (not medical jargon dumps).",
            "If any metric is unusual, executor either creates a 'ask doctor about X' reminder or proposes one for approval.",
        ],
        world_assertions=[
            "If executed: a new reminder on list_personal containing 'doctor' in the title.",
        ],
    ),
]
