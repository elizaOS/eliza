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
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
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
    ),    Scenario(
        id='health.weight_log_morning',
        name='Log morning weight',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Log my weight this morning: 68.2 kg.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning weight',
                    'details': {
                        'kind': 'health_metric',
                        'metric': 'weight_kg',
                        'value': 68.2,
                        'occurredAtIso': '2026-05-10T08:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['68.2'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Simple weight logging via LIFE_CREATE.',
    ),
    Scenario(
        id='health.steps_today_query',
        name='Query steps today',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='How many steps have I taken so far today?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'steps',
                    'date': '2026-05-10',
                },
            ),
        ],
        required_outputs=['steps'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=3,
        description='Read‑only step count for the current day.',
    ),
    Scenario(
        id='health.heart_rate_trend_14_days',
        name='Heart‑rate trend two weeks',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Show my resting heart‑rate trend over the past two weeks.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'heart_rate',
                    'days': 14,
                },
            ),
        ],
        required_outputs=['heart'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Two‑week heart‑rate trend reading.',
    ),
    Scenario(
        id='health.log_morning_yoga',
        name='Log morning yoga session',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Log a yoga session I did this morning: 45 minutes, moderate intensity.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning yoga',
                    'details': {
                        'kind': 'workout',
                        'workoutType': 'yoga',
                        'durationMinutes': 45,
                        'intensity': 'moderate',
                        'occurredAtIso': '2026-05-10T06:30:00Z',
                    },
                },
            ),
        ],
        required_outputs=['yoga'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Capture a yoga workout using LIFE_CREATE.',
    ),
    Scenario(
        id='health.sleep_average_last_30_days',
        name='Average sleep last month',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='What’s my average sleep duration over the last month?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'sleep_hours',
                    'days': 30,
                },
            ),
        ],
        required_outputs=['average'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='30‑day sleep‑hours trend to compute average.',
    ),
    Scenario(
        id='health.log_evening_walk',
        name='Log evening walk',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='I walked 3\u202fkm in the evening, took me 35 minutes. Please log it.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Evening walk',
                    'details': {
                        'kind': 'workout',
                        'distanceKm': 3.0,
                        'durationMinutes': 35,
                        'occurredAtIso': '2026-05-10T18:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['3 km'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Log a short evening walking session.',
    ),
    Scenario(
        id='health.weight_trend_7_days',
        name='Weight change last week',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me a quick view of my weight change over the past week.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'weight_kg',
                    'days': 7,
                },
            ),
        ],
        required_outputs=['kg'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='7‑day weight trend reading.',
    ),
    Scenario(
        id='health.steps_goal_progress',
        name='Check steps toward daily goal',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='How close am I to my daily step goal of 10,000 steps?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'steps',
                    'date': '2026-05-10',
                },
            ),
        ],
        required_outputs=['steps'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read current step count; the agent must compute progress against 10k goal.',
    ),
    Scenario(
        id='health.log_night_run',
        name='Log night run',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Log a night run: 10\u202fkm, 55 minutes, fast pace, started at 10\u202fpm.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Night run',
                    'details': {
                        'kind': 'workout',
                        'distanceKm': 10.0,
                        'durationMinutes': 55,
                        'intensity': 'fast',
                        'occurredAtIso': '2026-05-09T22:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['10 km'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Log a long evening run.',
    ),
    Scenario(
        id='health.heart_rate_today',
        name='Average resting heart‑rate today',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='What was my average resting heart‑rate today?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'heart_rate',
                    'date': '2026-05-10',
                },
            ),
        ],
        required_outputs=['heart'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read‑only daily heart‑rate metric.',
    ),
    Scenario(
        id='health.log_meditation',
        name='Log evening meditation',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Add a meditation session: 20 minutes, mindfulness, done at 8\u202fpm.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Evening meditation',
                    'details': {
                        'kind': 'workout',
                        'workoutType': 'meditation',
                        'durationMinutes': 20,
                        'occurredAtIso': '2026-05-10T20:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['meditation'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Capture a mindfulness meditation session.',
    ),
    Scenario(
        id='health.get_sleep_last_night',
        name='Query last night sleep hours',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='How many hours did I sleep last night?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'sleep_hours',
                    'date': '2026-05-09',
                },
            ),
        ],
        required_outputs=['hours'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=3,
        description='Read‑only sleep‑hours metric for the previous day.',
    ),
    Scenario(
        id='health.log_weight_evening',
        name='Log evening weight',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Log my weight this evening: 67.9 kg.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Evening weight',
                    'details': {
                        'kind': 'health_metric',
                        'metric': 'weight_kg',
                        'value': 67.9,
                        'occurredAtIso': '2026-05-10T20:30:00Z',
                    },
                },
            ),
        ],
        required_outputs=['67.9'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Record a second daily weight measurement.',
    ),
    Scenario(
        id='health.steps_average_last_week',
        name='Average daily steps last week',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='What’s my average daily steps over the past week?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'steps',
                    'days': 7,
                },
            ),
        ],
        required_outputs=['average'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='7‑day steps trend to derive average.',
    ),
    Scenario(
        id='health.log_swim',
        name='Log swimming workout',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Log a swimming workout: 30 minutes, freestyle, 1\u202fkm distance.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Swim',
                    'details': {
                        'kind': 'workout',
                        'workoutType': 'swim',
                        'distanceKm': 1.0,
                        'durationMinutes': 30,
                        'style': 'freestyle',
                        'occurredAtIso': '2026-05-10T07:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['swim'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Log a short freestyle swimming session.',
    ),
    Scenario(
        id='health.get_weight_today',
        name="Current day's weight",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='What is my current weight recorded for today?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'weight_kg',
                    'date': '2026-05-10',
                },
            ),
        ],
        required_outputs=['kg'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=3,
        description='Read‑only weight metric for today.',
    ),
    Scenario(
        id='health.log_cycling',
        name='Log afternoon cycling',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Add a cycling session: 20\u202fkm, 60 minutes, moderate effort, this afternoon.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Afternoon cycling',
                    'details': {
                        'kind': 'workout',
                        'distanceKm': 20.0,
                        'durationMinutes': 60,
                        'intensity': 'moderate',
                        'occurredAtIso': '2026-05-10T15:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['20 km'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Log a moderate cycling activity.',
    ),
    Scenario(
        id='health.sleep_trend_90_days',
        name='Three‑month sleep trend',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Show my sleep duration trend for the last three months.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'sleep_hours',
                    'days': 90,
                },
            ),
        ],
        required_outputs=['sleep'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Long‑range sleep‑hours trend.',
    ),
    Scenario(
        id='health.log_body_fat',
        name='Log body fat percentage',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Record my body fat percentage: 22.5% measured at 10\u202fam.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Body fat',
                    'details': {
                        'kind': 'health_metric',
                        'metric': 'body_fat_percent',
                        'value': 22.5,
                        'occurredAtIso': '2026-05-10T10:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['22.5'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Capture a body‑fat metric.',
    ),
    Scenario(
        id='health.heart_rate_trend_7_days',
        name='Heart‑rate trend last week',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Give me the heart rate trend for the past week.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'trend',
                    'metric': 'heart_rate',
                    'days': 7,
                },
            ),
        ],
        required_outputs=['heart'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='7‑day heart‑rate trend.',
    ),
    Scenario(
        id='health.log_hike',
        name='Log morning hike',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Log a hike: 8\u202fkm, 4 hours, moderate, started at 9\u202fam.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning hike',
                    'details': {
                        'kind': 'workout',
                        'distanceKm': 8.0,
                        'durationMinutes': 240,
                        'intensity': 'moderate',
                        'occurredAtIso': '2026-05-10T09:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['hike'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Log a longer outdoor activity.',
    ),
    Scenario(
        id='health.steps_yesterday',
        name='Steps yesterday',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='How many steps did I take yesterday?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'steps',
                    'date': '2026-05-09',
                },
            ),
        ],
        required_outputs=['steps'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=3,
        description='Read‑only step count for the previous day.',
    ),
    Scenario(
        id='health.log_morning_run_with_pace',
        name='Log morning run with pace',
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Log a run I did this morning: 5\u202fkm in 28 minutes, average pace 5:36 min/km.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning run',
                    'details': {
                        'kind': 'workout',
                        'distanceKm': 5.0,
                        'durationMinutes': 28,
                        'paceMinPerKm': '5:36',
                        'occurredAtIso': '2026-05-10T07:30:00Z',
                    },
                },
            ),
        ],
        required_outputs=['5 km'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Capture a run with explicit pace information.',
    ),

]
