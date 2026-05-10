"""Live sleep scenarios."""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_TARA_NIGHT

LIVE_SLEEP_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.sleep.coach_better_sleep_schedule",
        name="Coach me toward a better sleep schedule",
        domain=Domain.SLEEP,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_TARA_NIGHT,
        instruction=(
            "I keep falling asleep around 2am and feeling wrecked. Look "
            "at my last week of sleep data, suggest a realistic bedtime "
            "target I can ramp toward, set up wind-down reminders, and "
            "find any calendar events that conflict with the new "
            "schedule. Be honest if my goals don't fit my data."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Behavior-change coaching that combines health metrics, "
            "reminders, and calendar reasoning."
        ),
        success_criteria=[
            "Executor references the persona's actual sleep data, not generic advice.",
            "Executor proposes a concrete bedtime target and wind-down time.",
            "Executor either sets up the wind-down reminder OR drafts what it would set up for approval.",
            "Executor flags calendar conflicts with the proposed bedtime if any exist.",
        ],
        world_assertions=[
            "If executed: a new daily reminder on list_personal with title containing 'wind-down' or 'bedtime'.",
        ],
    ),
]
