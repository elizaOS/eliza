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
    ),    Scenario(
        id='reminders.create_dentist_monday_10am',
        name='Create reminder for dentist appointment Monday at 10am',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Remind me Monday at 10:00 UTC to go to the dentist.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Dentist appointment',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-13T10:00:00Z',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['dentist', 'Monday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list works.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=5,
        description='Simple one‑off reminder creation with explicit due time.',
    ),
    Scenario(
        id='reminders.complete_expense_report',
        name='Mark expense report reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Mark the 'Submit expense report' reminder (reminder_00001) as done—I already sent it.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00001',
                    'title': 'Submit expense report',
                },
            ),
        ],
        required_outputs=['complete'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Targeted completion of an existing reminder.',
    ),
    Scenario(
        id='reminders.snooze_call_mom_three_days',
        name="Snooze 'Call Mom' reminder for three days",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Snooze the 'Call Mom' reminder (reminder_00002) for three days; I’ll be busy until then.",
        ground_truth_actions=[
            Action(
                name='LIFE_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'target': 'reminder_00002',
                    'title': 'Call Mom',
                    'minutes': 4320,
                },
            ),
        ],
        required_outputs=['snooze'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Three days from now, same time.',
            applies_when='agent asks for new due time',
        ),
        world_seed=2026,
        max_turns=5,
        description='Snoozing a reminder by a specific number of minutes.',
    ),
    Scenario(
        id='reminders.list_upcoming',
        name='List all upcoming reminders',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Show me all upcoming reminders across my lists.',
        ground_truth_actions=[
            Action(
                name='LIFE_REVIEW',
                kwargs={
                    'subaction': 'review',
                    'intent': 'list upcoming reminders across all lists',
                },
            ),
        ],
        required_outputs=['upcoming'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Read‑only review of future reminders.',
    ),
    Scenario(
        id='reminders.delete_birthday_gift',
        name='Delete birthday gift reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Delete the 'Buy birthday gift' reminder (reminder_00010) – I already ordered it.",
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'target': 'reminder_00010',
                    'title': 'Buy birthday gift',
                },
            ),
        ],
        required_outputs=['deleted'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Targeted deletion of an existing reminder.',
    ),
    Scenario(
        id='reminders.create_weekly_team_sync',
        name='Create weekly team sync reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Set a weekly reminder for our team sync every Wednesday at 14:00 UTC.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Team sync',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-15T14:00:00Z',
                        'cadence': 'weekly',
                        'listId': 'list_work',
                    },
                },
            ),
        ],
        required_outputs=['weekly', 'sync'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work list is fine.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Recurring reminder with weekly cadence.',
    ),
    Scenario(
        id='reminders.complete_pay_electricity',
        name='Mark electricity bill reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction="Please mark the 'Pay electricity bill' reminder (reminder_00004) as completed; I paid it this morning.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00004',
                    'title': 'Pay electricity bill',
                },
            ),
        ],
        required_outputs=['completed'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Completing a bill‑payment reminder.',
    ),
    Scenario(
        id='reminders.snooze_gym_one_day',
        name='Snooze gym session reminder for one day',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="Snooze the 'Gym session' reminder (reminder_00005) by one day; I'm traveling tomorrow.",
        ground_truth_actions=[
            Action(
                name='LIFE_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'target': 'reminder_00005',
                    'title': 'Gym session',
                    'minutes': 1440,
                },
            ),
        ],
        required_outputs=['snoozed'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='One day later, same time.',
            applies_when='agent asks for new due time',
        ),
        world_seed=2026,
        max_turns=5,
        description='Simple snooze by a single day.',
    ),
    Scenario(
        id='reminders.review_overdue_personal',
        name='Review overdue personal reminders',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='List all overdue reminders in my personal list.',
        ground_truth_actions=[
            Action(
                name='LIFE_REVIEW',
                kwargs={
                    'subaction': 'review',
                    'intent': 'list overdue reminders in list_personal',
                },
            ),
        ],
        required_outputs=['overdue'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Filtered review of overdue reminders.',
    ),
    Scenario(
        id='reminders.create_pickup_dry_cleaning',
        name='Create reminder to pick up dry cleaning',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Remind me tomorrow at 4pm to pick up the dry cleaning.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Pick up dry cleaning',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-11T16:00:00Z',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['dry cleaning'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list is fine.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=5,
        description='Simple tomorrow reminder creation.',
    ),
    Scenario(
        id='reminders.delete_unused_trial',
        name='Delete trial subscription reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Delete the 'Cancel trial for MusicApp' reminder (reminder_00012). I already cancelled it.",
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'target': 'reminder_00012',
                    'title': 'Cancel trial for MusicApp',
                },
            ),
        ],
        required_outputs=['deleted'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Deletion of a reminder about a cancelled trial.',
    ),
    Scenario(
        id='reminders.create_monthly_budget_review',
        name='Create monthly budget review reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Add a recurring reminder on the first day of each month at 09:00 UTC to review the budget.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Monthly budget review',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-06-01T09:00:00Z',
                        'cadence': 'monthly',
                        'listId': 'list_work',
                    },
                },
            ),
        ],
        required_outputs=['budget', 'monthly'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work list works.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Recurring monthly reminder for budgeting.',
    ),
    Scenario(
        id='reminders.complete_car_service',
        name='Mark car service reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction="Please mark the 'Car service' reminder (reminder_00007) as completed; the service was done today.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00007',
                    'title': 'Car service',
                },
            ),
        ],
        required_outputs=['completed'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Completing a maintenance reminder.',
    ),
    Scenario(
        id='reminders.snooze_meeting_two_hours',
        name='Snooze meeting reminder for two hours',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction="Snooze the 'Project meeting' reminder (reminder_00008) for two hours; I'm stuck in another call.",
        ground_truth_actions=[
            Action(
                name='LIFE_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'target': 'reminder_00008',
                    'title': 'Project meeting',
                    'minutes': 120,
                },
            ),
        ],
        required_outputs=['snoozed'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Two hours later, same time.',
            applies_when='agent asks for new due time',
        ),
        world_seed=2026,
        max_turns=5,
        description='Short‑duration snooze for a meeting.',
    ),
    Scenario(
        id='reminders.list_all_overdue',
        name='List all overdue reminders',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me a list of every overdue reminder I have.',
        ground_truth_actions=[
            Action(
                name='LIFE_REVIEW',
                kwargs={
                    'subaction': 'review',
                    'intent': 'list all overdue reminders',
                },
            ),
        ],
        required_outputs=['overdue'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Comprehensive overdue reminder review.',
    ),
    Scenario(
        id='reminders.create_medication_evening',
        name='Create daily evening medication reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='Please set a daily reminder at 20:00 UTC to take my cholesterol medication.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Take cholesterol medication',
                    'details': {
                        'kind': 'reminder',
                        'cadence': 'daily',
                        'timeOfDay': '20:00',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['daily', 'medication'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list is fine.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Recurring daily reminder with time of day.',
    ),
    Scenario(
        id='reminders.delete_unused_report',
        name='Delete unused report reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="Delete the 'Prepare weekly report' reminder (reminder_00015); I no longer need it.",
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'target': 'reminder_00015',
                    'title': 'Prepare weekly report',
                },
            ),
        ],
        required_outputs=['deleted'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Removal of a no‑longer‑relevant reminder.',
    ),
    Scenario(
        id='reminders.create_annual_tax_deadline',
        name='Create annual tax deadline reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Add a yearly reminder on April 15 at 12:00 UTC for filing taxes.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'File taxes',
                    'details': {
                        'kind': 'reminder',
                        'due': '2027-04-15T12:00:00Z',
                        'cadence': 'yearly',
                        'listId': 'list_work',
                    },
                },
            ),
        ],
        required_outputs=['taxes', 'yearly'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work list works.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Annual recurring reminder for tax filing.',
    ),
    Scenario(
        id='reminders.complete_visa_renewal',
        name='Mark visa renewal reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="Mark the 'Visa renewal' reminder (reminder_00018) as done; I submitted the paperwork.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00018',
                    'title': 'Visa renewal',
                },
            ),
        ],
        required_outputs=['completed'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Completing a legal‑process reminder.',
    ),
    Scenario(
        id='reminders.snooze_plant_watering_one_week',
        name='Snooze plant watering reminder for a week',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Snooze the 'Water indoor plants' reminder (reminder_00020) for 7 days; I'm on vacation.",
        ground_truth_actions=[
            Action(
                name='LIFE_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'target': 'reminder_00020',
                    'title': 'Water indoor plants',
                    'minutes': 10080,
                },
            ),
        ],
        required_outputs=['snoozed'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='One week later, same time.',
            applies_when='agent asks for new due time',
        ),
        world_seed=2026,
        max_turns=5,
        description='Long‑duration snooze for a recurring home task.',
    ),
    Scenario(
        id='reminders.list_overdue_work',
        name='List overdue work reminders',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Show me overdue reminders in my work list.',
        ground_truth_actions=[
            Action(
                name='LIFE_REVIEW',
                kwargs={
                    'subaction': 'review',
                    'intent': 'list overdue reminders in list_work',
                },
            ),
        ],
        required_outputs=['overdue'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Filtered overdue reminder review for work list.',
    ),
    Scenario(
        id='reminders.create_daily_stretch_reminder',
        name='Create daily stretch reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Add a daily reminder at 07:30 UTC to do my morning stretch routine.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning stretch routine',
                    'details': {
                        'kind': 'reminder',
                        'cadence': 'daily',
                        'timeOfDay': '07:30',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['daily', 'stretch'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list works.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Daily health‑related reminder.',
    ),
    Scenario(
        id='reminders.delete_old_meeting_note',
        name='Delete old meeting note reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Delete the 'Review meeting notes' reminder (reminder_00022) – I already did it.",
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'target': 'reminder_00022',
                    'title': 'Review meeting notes',
                },
            ),
        ],
        required_outputs=['deleted'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Removal of a completed meeting‑notes reminder.',
    ),
    Scenario(
        id='reminders.create_monthly_tax_estimate',
        name='Create monthly tax estimate reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Add a recurring reminder on the 5th of each month at 10:00 UTC to estimate taxes.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Monthly tax estimate',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-05T10:00:00Z',
                        'cadence': 'monthly',
                        'listId': 'list_work',
                    },
                },
            ),
        ],
        required_outputs=['monthly', 'tax'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Work list is fine.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Monthly recurring tax reminder.',
    ),
    Scenario(
        id='reminders.complete_holiday_gift',
        name='Mark holiday gift reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Mark the 'Buy holiday gifts' reminder (reminder_00025) as done; I finished shopping.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00025',
                    'title': 'Buy holiday gifts',
                },
            ),
        ],
        required_outputs=['completed'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Completing a seasonal shopping reminder.',
    ),
    Scenario(
        id='reminders.snooze_water_plants_two_hours',
        name='Snooze water plants reminder for two hours',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction="Snooze the 'Water house plants' reminder (reminder_00027) for two hours; I'm in class.",
        ground_truth_actions=[
            Action(
                name='LIFE_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'target': 'reminder_00027',
                    'title': 'Water house plants',
                    'minutes': 120,
                },
            ),
        ],
        required_outputs=['snoozed'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Two hours later, same time.',
            applies_when='agent asks for new due time',
        ),
        world_seed=2026,
        max_turns=5,
        description='Short snooze for a plant‑watering reminder.',
    ),
    Scenario(
        id='reminders.list_all_upcoming',
        name='List all upcoming reminders',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Give me a list of every upcoming reminder I have.',
        ground_truth_actions=[
            Action(
                name='LIFE_REVIEW',
                kwargs={
                    'subaction': 'review',
                    'intent': 'list all upcoming reminders',
                },
            ),
        ],
        required_outputs=['upcoming'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Comprehensive upcoming reminders review.',
    ),
    Scenario(
        id='reminders.create_weekly_grocery_shopping',
        name='Create weekly grocery shopping reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Set a weekly reminder on Saturdays at 11:00 UTC to do grocery shopping.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Grocery shopping',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-13T11:00:00Z',
                        'cadence': 'weekly',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['weekly', 'grocery'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list works.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Weekly recurring reminder for shopping.',
    ),
    Scenario(
        id='reminders.delete_unused_renewal',
        name='Delete unused subscription renewal reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Delete the 'Renew streaming subscription' reminder (reminder_00030) – I canceled the service.",
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'target': 'reminder_00030',
                    'title': 'Renew streaming subscription',
                },
            ),
        ],
        required_outputs=['deleted'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Removal of a reminder for a cancelled subscription.',
    ),
    Scenario(
        id='reminders.create_daily_journal_prompt',
        name='Create daily journal prompt reminder',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Add a daily reminder at 22:00 UTC to write my journal entry.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Write journal entry',
                    'details': {
                        'kind': 'reminder',
                        'cadence': 'daily',
                        'timeOfDay': '22:00',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['daily', 'journal'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Personal list is fine.',
            applies_when='agent asks which reminder list',
        ),
        world_seed=2026,
        max_turns=6,
        description='Daily reflective reminder for journaling.',
    ),
    Scenario(
        id='reminders.complete_fitness_goal',
        name='Mark fitness goal reminder complete',
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Mark the 'Run 5km' reminder (reminder_00033) as done; I completed the run.",
        ground_truth_actions=[
            Action(
                name='LIFE_COMPLETE',
                kwargs={
                    'subaction': 'complete',
                    'target': 'reminder_00033',
                    'title': 'Run 5km',
                },
            ),
        ],
        required_outputs=['completed'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Completing a fitness‑related reminder.',
    ),

]
