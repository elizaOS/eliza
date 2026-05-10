"""Reminders-domain scenarios.

Backed by 60 reminders across three lists (``list_inbox``,
``list_personal``, ``list_work``) seeded into
``data/snapshots/medium_seed_2026.json``. Six reminders are overdue
relative to ``2026-05-10T12:00:00Z`` for the overdue scenario.

Reminder verbs use the ``LIFE`` umbrella (definition kind: 'todo' /
'reminder') plus the dedicated ``LIFE_COMPLETE`` / ``LIFE_SNOOZE``
verbs from the manifest. The ``TODO`` action covers per-todo CRUD.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_DEV_FREELANCER,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
)

REMINDERS_SCENARIOS: list[Scenario] = [
    Scenario(
        id="reminders.create_pickup_reminder_tomorrow_9am",
        name="Create reminder due tomorrow at 9am",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Remind me tomorrow at 9am to pick up the kids' soccer uniforms "
            "from the laundry."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Pick up kids' soccer uniforms from the laundry",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T09:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["uniforms"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Personal list is fine.",
            applies_when="agent asks which reminder list",
        ),
        world_seed=2026,
        max_turns=5,
        description="Single-shot reminder create with explicit due time.",
    ),
    Scenario(
        id="reminders.complete_overdue_hiring_loop_followup",
        name="Mark overdue 'hiring loop' followup complete",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "Mark the 'Follow up on the hiring loop' reminder "
            "(reminder_00000) as complete — I sent the email already."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_COMPLETE",
                kwargs={
                    "subaction": "complete",
                    "target": "reminder_00000",
                    "title": "Follow up on the hiring loop",
                },
            ),
        ],
        required_outputs=["complete"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Targeted complete on a real overdue seed reminder.",
    ),
    Scenario(
        id="reminders.list_overdue",
        name="List overdue reminders",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="show me everything overdue across my reminder lists",
        ground_truth_actions=[
            Action(
                name="LIFE_REVIEW",
                kwargs={
                    "subaction": "review",
                    "intent": "list overdue reminders across all lists",
                },
            ),
        ],
        required_outputs=["overdue"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only review of overdue items.",
    ),
    Scenario(
        id="reminders.snooze_budget_followup_two_days",
        name="Snooze the 'budget' followup by 2 days",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Snooze the 'Follow up on the budget' reminder (reminder_00009) "
            "for two days; I won't have the numbers until then."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_SNOOZE",
                kwargs={
                    "subaction": "snooze",
                    "target": "reminder_00009",
                    "title": "Follow up on the budget",
                    "minutes": 2880,
                },
            ),
        ],
        required_outputs=["snooze"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Two days from the original time, same time of day.",
            applies_when="agent asks for new due time",
        ),
        world_seed=2026,
        max_turns=5,
        description="Snooze in minutes — 2 days = 2880.",
    ),
    Scenario(
        id="reminders.create_recurring_pill_alarm",
        name="Create a recurring daily pill alarm",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction=(
            "Please set up a daily reminder at 8am for my blood-pressure "
            "medication."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Take blood-pressure medication",
                    "details": {
                        "kind": "reminder",
                        "cadence": "daily",
                        "timeOfDay": "08:00",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["daily", "medication"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Every day, please. 8am works.",
            applies_when="agent asks about cadence or time of day",
        ),
        world_seed=2026,
        max_turns=6,
        description="Recurring reminder. Tests cadence-bearing details block.",
    ),
]
