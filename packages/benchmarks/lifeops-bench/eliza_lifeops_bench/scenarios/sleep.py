"""Sleep-domain scenarios.

Sleep flows are mostly schedule-shaped: bedtime reminders, wind-down
windows, and conflict detection between sleep targets and existing
calendar events.

Bedtime reminders use the LIFE umbrella (kind=alarm). Wind-down
sessions use the SCHEDULED_TASK umbrella (kind=reminder, trigger=once).
Conflict detection reads from CALENDAR + SCHEDULE.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_KAI_STUDENT,
    PERSONA_OWEN_RETIREE,
    PERSONA_TARA_NIGHT,
)

SLEEP_SCENARIOS: list[Scenario] = [
    Scenario(
        id="sleep.set_bedtime_reminder_1030pm_daily",
        name="Set daily 10:30pm bedtime reminder",
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="set a daily bedtime reminder for 10:30pm local",
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Bedtime",
                    "details": {
                        "kind": "alarm",
                        "cadence": "daily",
                        "timeOfDay": "22:30",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["bedtime", "10:30"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, every day. America/New_York time zone.",
            applies_when="agent asks about cadence or time zone",
        ),
        world_seed=2026,
        max_turns=5,
        description="Recurring daily alarm via LIFE_CREATE.",
    ),
    Scenario(
        id="sleep.find_calendar_conflict_with_bedtime_window",
        name="Find calendar conflicts with target bedtime",
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction=(
            "Find anything on my calendar tonight after 10pm that conflicts "
            "with a 10:30pm bedtime."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "search_events",
                    "intent": "search events tonight from 22:00 onward",
                    "details": {
                        "windowStart": "2026-05-10T22:00:00Z",
                        "windowEnd": "2026-05-11T07:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["bedtime"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "Search-based conflict detection. The agent should report any "
            "events overlapping the wind-down window."
        ),
    ),
    Scenario(
        id="sleep.schedule_wind_down_routine_tonight",
        name="Schedule a 30-minute wind-down routine tonight",
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction=(
            "Set a one-off 30-minute wind-down session starting tonight at "
            "10pm — no screens, lights low."
        ),
        ground_truth_actions=[
            Action(
                name="SCHEDULED_TASK_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "reminder",
                    "promptInstructions": (
                        "Wind-down: no screens, lights low, 30 minutes."
                    ),
                    "trigger": {
                        "kind": "once",
                        "atIso": "2026-05-10T22:00:00Z",
                    },
                    "priority": "medium",
                    "ownerVisible": True,
                    "source": "user_chat",
                },
            ),
        ],
        required_outputs=["wind"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just tonight, not recurring.",
            applies_when="agent asks if it should recur",
        ),
        world_seed=2026,
        max_turns=5,
        description="One-off scheduled task via SCHEDULED_TASK_CREATE.",
    ),
    Scenario(
        id="sleep.last_week_sleep_summary",
        name="Last week sleep summary",
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction="how have I been sleeping the past week?",
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
        description="Sleep-metric trend; same shape as health domain but framed as sleep question.",
    ),
]
