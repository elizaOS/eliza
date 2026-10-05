"""Neurotypical-control scenarios for plain Maya-family logistics.

This pack is the negative-control floor for persona-specific scaffolding:
ordinary, clearly stated requests should stay fast, direct, and free of
ADHD/night-shift/travel/comms adaptations unless Maya actually asks for them.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_MAYA_PARENT

NEUROTYPICAL_CONTROL_SCENARIOS: list[Scenario] = [
    Scenario(
        id="control.reminders.plain_daily_reminder_no_scaffolding",
        name="Plain daily reminder - no persona scaffolding should trigger",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="set a reminder every day at 7am to pack the kids' lunches",
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Pack kids' lunches",
                    "details": {
                        "kind": "reminder",
                        "cadence": "daily",
                        "timeOfDay": "07:00",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["7", "lunches"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Every day, 7am, same as I said. No need to double check.",
            applies_when="agent asks to confirm cadence or time already stated plainly",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Baseline-canary: the simplest possible reminder request from the "
            "control persona. Must be created fast and plainly. Regression "
            "signal if the agent offers task decomposition, a 'shrink to a "
            "2-minute step' reframe, a wake-anchor question, or any other "
            "persona-specific scaffolding built for a different pack - none of "
            "that belongs on a plain, clearly-stated, clearly-timed request."
        ),
    ),
    Scenario(
        id="control.calendar.family_soccer_pickup_event",
        name="Add Leo's soccer pickup to the family calendar",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Put Leo's soccer pickup on the family calendar this Friday, "
            "May 15, from 4:30 to 5pm at North Field."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create Leo soccer pickup on the family calendar",
                    "title": "Leo soccer pickup",
                    "details": {
                        "calendarId": "cal_family",
                        "start": "2026-05-15T16:30:00Z",
                        "end": "2026-05-15T17:00:00Z",
                        "location": "North Field",
                    },
                },
            ),
        ],
        required_outputs=["Leo", "soccer"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Control: standard family-calendar event capture with a child "
            "referenced by first name. No decomposition or coaching is warranted."
        ),
    ),
    Scenario(
        id="control.reminders.simple_allergy_medicine_pickup",
        name="Create a simple one-off medicine pickup reminder",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Remind me today at 3pm to pick up Avery's allergy medicine.",
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Pick up Avery's allergy medicine",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-10T15:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["3", "medicine"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Personal list is fine.",
            applies_when="agent asks which reminder list to use",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Control: the basic explicit-clock reminder path. The agent "
            "should create the one-off reminder without anchor questions or "
            "habit-building scaffolding."
        ),
    ),
    Scenario(
        id="control.health.steps_today_no_unsolicited_coaching",
        name="Report today's steps without unsolicited coaching",
        domain=Domain.HEALTH,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Just tell me today's step count; no pep talk, I only need the number.",
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
        required_outputs=["steps"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description=(
            "[T2] Control tone check: answer the read-only health query without "
            "unsolicited coaching, therapy language, motivation, or behavior change."
        ),
    ),
    Scenario(
        id="control.calendar.school_events_plain_start_time_preference",
        name="Store a plain school-event notification preference",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "For school calendar stuff, just tell me when it happens. Don't "
            "batch it or make a digest unless I ask."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "update_preferences",
                    "intent": (
                        "for school-related calendar items, surface the event "
                        "time plainly and do not create batches or digests"
                    ),
                    "details": {
                        "category": "school",
                        "notificationStyle": "plain_start_time",
                        "digest": False,
                    },
                },
            ),
        ],
        required_outputs=["school"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Family calendar and school events only.",
            applies_when="agent asks which calendar or event category this preference applies to",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "[T2] Control: standard preference statement. The agent should not "
            "invent VIP routing, batching, digest, or escalation machinery."
        ),
    ),
    Scenario(
        id="control.reminders.preview_then_confirm_bright_smile_call",
        name="Preview a reminder before saving it",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Draft a reminder for tomorrow at 10am to call Bright Smile "
            "Dental, but don't save it until I confirm."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Call Bright Smile Dental",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-11T10:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["Bright Smile", "10"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, save it now.",
            applies_when="agent asks for confirmation before saving the drafted reminder",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T3] Control: two-phase commit sanity check. The agent should "
            "preview the reminder, wait for confirmation, and only then save it."
        ),
    ),
    Scenario(
        id="control.contacts.add_coach_lena_basic_contact",
        name="Add Coach Lena as a basic contact",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Add Coach Lena Ortiz to my contacts: lena.ortiz@example.test, "
            "+15551239876. No fancy tagging, I just need her saved."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "add",
                    "name": "Lena Ortiz",
                    "email": "lena.ortiz@example.test",
                    "phone": "+15551239876",
                    "channel": "email",
                    "handle": "lena.ortiz@example.test",
                    "relationship": "acquaintance",
                    "notes": "Coach Lena Ortiz",
                },
            ),
        ],
        required_outputs=["Lena"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Email is the main channel; no special tag.",
            applies_when="agent asks for preferred channel or tag",
        ),
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Control: basic contact addition with no special "
            "categorization, relationship goal, or social-followup scaffolding."
        ),
    ),
    Scenario(
        id="control.calendar.reschedule_launch_checklist_plain_default",
        name="Reschedule the family launch checklist to next week",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Move the launch checklist thing on the family calendar to next "
            "week, same time on Thursday."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "update_event",
                    "intent": (
                        "move the tentative family launch checklist event one "
                        "week later while keeping the 45-minute duration"
                    ),
                    "details": {
                        "eventId": "event_00052",
                        "calendarId": "cal_family",
                        "start": "2026-05-28T08:30:00Z",
                        "end": "2026-05-28T09:15:00Z",
                    },
                },
            ),
        ],
        required_outputs=["launch", "Thursday"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "The tentative launch checklist one on the family calendar. "
                "Keep the same length."
            ),
            applies_when="agent asks which launch checklist event or how long it should be",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Control: mildly ambiguous ordinary reschedule resolved by a "
            "plain seeded-event default, not by wake anchors, shifts, or time zones."
        ),
    ),
]
