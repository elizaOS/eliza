"""Health-domain scenarios.

Backed by 540 health metrics in ``data/snapshots/medium_seed_2026.json``
spanning steps, heart_rate, sleep_hours, weight_kg, blood_pressure,
calories. The ``HEALTH`` umbrella action exposes today / trend /
by_metric / status subactions.

Logging a workout is *not* directly modeled by HEALTH (the action is
read-only). For workout capture we use ``LIFE_CREATE`` with a
``kind=workout`` detail block; this matches the Eliza pattern of
storing arbitrary life entries through the LIFE umbrella.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_OWEN_RETIREE,
    PERSONA_TARA_NIGHT,
)

HEALTH_SCENARIOS: list[Scenario] = [
    Scenario(
        id="health.sleep_average_last_7_days",
        name="Sleep average last 7 days",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="what's my average sleep over the last 7 days?",
        ground_truth_actions=[
            Action(
                name="HEALTH",
                kwargs={
                    "subaction": "by_metric",
                    "metric": "sleep_hours",
                    "days": 7,
                },
            ),
        ],
        required_outputs=["sleep"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only sleep trend over 7-day window.",
    ),
    Scenario(
        id="health.step_count_today",
        name="Get today's step count",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction="how many steps have I taken today?",
        ground_truth_actions=[
            Action(
                name="HEALTH",
                kwargs={
                    "subaction": "by_metric",
                    "metric": "steps",
                    "date": "2026-05-10",
                },
            ),
        ],
        required_outputs=["step"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=3,
        description="Single-day metric read.",
    ),
    Scenario(
        id="health.log_morning_run_workout",
        name="Log a 5k morning run",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction=(
            "Log this morning's workout: 5k run, 28 minutes, easy effort."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "5k morning run",
                    "details": {
                        "kind": "workout",
                        "distanceKm": 5.0,
                        "durationMinutes": 28,
                        "effort": "easy",
                        "occurredAtIso": "2026-05-10T08:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["5k", "logged"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="No heart-rate data, just the distance and time.",
            applies_when="agent asks for HR / pace / effort",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "Workout capture through the LIFE umbrella since HEALTH is "
            "read-only in the manifest."
        ),
    ),
    Scenario(
        id="health.log_weight_today",
        name="Log today's weight",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction="log my weight: 72.4 kg",
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Weight log",
                    "details": {
                        "kind": "health_metric",
                        "metric": "weight_kg",
                        "value": 72.4,
                        "occurredAtIso": "2026-05-10T12:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["72.4"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description=(
            "Manual metric entry — same LIFE umbrella since HEALTH is "
            "read-only."
        ),
    ),
    Scenario(
        id="health.heart_rate_trend_30_days",
        name="Heart-rate trend last 30 days",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="show me my resting heart-rate trend over the last 30 days",
        ground_truth_actions=[
            Action(
                name="HEALTH",
                kwargs={
                    "subaction": "trend",
                    "metric": "heart_rate",
                    "days": 30,
                },
            ),
        ],
        required_outputs=["heart"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="30-day trend read.",
    ),
]
