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
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_SAM_FOUNDER,
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
    ),    Scenario(
        id='sleep.set_daily_bedtime_1030pm',
        name='Set daily bedtime reminder at 10:30pm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Please create a daily bedtime alarm for 10:30\u202fpm local time.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Bedtime',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'daily',
                        'timeOfDay': '22:30',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['bedtime', '10:30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a recurring bedtime alarm via LIFE_CREATE.',
    ),
    Scenario(
        id='sleep.set_oneoff_winddown_10pm',
        name='Schedule a one‑off wind‑down session at 10\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Set a one‑off 30‑minute wind‑down routine starting tonight at 10\u202fpm, no screens.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'reminder',
                    'promptInstructions': 'Wind‑down: no screens, lights low, 30\u202fminutes.',
                    'trigger': {
                        'kind': 'once',
                        'atIso': '2026-05-10T22:00:00Z',
                    },
                    'priority': 'medium',
                    'ownerVisible': True,
                    'source': 'user_chat',
                },
            ),
        ],
        required_outputs=['wind‑down'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just tonight, not recurring.',
            applies_when='agent asks if it should recur',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a one‑off scheduled task for a wind‑down routine.',
    ),
    Scenario(
        id='sleep.find_conflicts_after_10pm',
        name='Find calendar conflicts after 10\u202fpm tonight',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Show me any events on my primary calendar after 10\u202fpm that could interfere with my bedtime.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'search_events',
                    'intent': 'search events after 22:00',
                    'details': {
                        'windowStart': '2026-05-10T22:00:00Z',
                        'windowEnd': '2026-05-11T06:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['conflict'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Searches the primary calendar for events overlapping the bedtime window.',
    ),
    Scenario(
        id='sleep.set_weekend_bedtime_11pm',
        name='Set weekend bedtime alarm at 11\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Create a bedtime alarm for Saturdays and Sundays at 11\u202fpm.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Weekend Bedtime',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'weekly',
                        'dayOfWeek': [
                            'Saturday',
                            'Sunday',
                        ],
                        'timeOfDay': '23:00',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['11:00', 'weekend'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, only on weekends.',
            applies_when='agent asks if it should apply every day',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a weekly alarm limited to weekend days.',
    ),
    Scenario(
        id='sleep.update_bedtime_to_1030',
        name='Change bedtime alarm to 10:30\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Move my existing bedtime alarm to 10:30\u202fpm.',
        ground_truth_actions=[
            Action(
                name='LIFE_UPDATE',
                kwargs={
                    'subaction': 'update',
                    'kind': 'definition',
                    'title': 'Bedtime',
                    'details': {
                        'timeOfDay': '22:30',
                    },
                },
            ),
        ],
        required_outputs=['10:30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates the time of an existing bedtime alarm.',
    ),
    Scenario(
        id='sleep.skip_bedtime_tomorrow',
        name='Skip bedtime alarm for tomorrow',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Please skip my bedtime alarm for tomorrow morning.',
        ground_truth_actions=[
            Action(
                name='LIFE_SKIP',
                kwargs={
                    'subaction': 'skip',
                    'kind': 'definition',
                    'title': 'Bedtime',
                    'details': {
                        'skipDate': '2026-05-11',
                    },
                },
            ),
        ],
        required_outputs=['skip', 'tomorrow'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, just for tomorrow.',
            applies_when='agent asks which date to skip',
        ),
        world_seed=2026,
        max_turns=5,
        description='Temporarily disables the bedtime alarm for a single day.',
    ),
    Scenario(
        id='sleep.delete_nap_alarm',
        name='Delete my afternoon nap alarm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Please remove the nap alarm I have for 2\u202fpm each day.',
        ground_truth_actions=[
            Action(
                name='LIFE_DELETE',
                kwargs={
                    'subaction': 'delete',
                    'kind': 'definition',
                    'title': 'Afternoon Nap',
                    'details': {
                        'timeOfDay': '14:00',
                    },
                },
            ),
        ],
        required_outputs=['deleted', 'nap'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, the 2\u202fpm daily nap alarm.',
            applies_when='agent asks which nap alarm to delete',
        ),
        world_seed=2026,
        max_turns=5,
        description='Removes a recurring nap alarm.',
    ),
    Scenario(
        id='sleep.create_morning_wakeup_7am',
        name='Create a 7\u202fam morning wake‑up alarm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Set a daily wake‑up alarm for 7\u202fam.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Morning Wake‑up',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'daily',
                        'timeOfDay': '07:00',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['7:00', 'wake‑up'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a daily morning alarm.',
    ),
    Scenario(
        id='sleep.get_last_month_sleep_average',
        name='Average sleep hours for last month',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='What was my average sleep duration per night for the previous month?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'sleep_hours',
                    'days': 30,
                },
            ),
        ],
        required_outputs=['average', 'hours'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Aggregates sleep hours over the past 30 days.',
    ),
    Scenario(
        id='sleep.schedule_nap_reminder_2pm',
        name='Schedule a daily 2\u202fpm nap reminder',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Add a daily reminder for a 30‑minute nap at 2\u202fpm.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'reminder',
                    'promptInstructions': '30‑minute nap.',
                    'trigger': {
                        'kind': 'daily',
                        'atIso': '2026-05-10T14:00:00Z',
                    },
                    'priority': 'low',
                    'ownerVisible': True,
                    'source': 'user_chat',
                },
            ),
        ],
        required_outputs=['nap', '2:00'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just once a day, at 2\u202fpm.',
            applies_when='agent asks about recurrence',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a daily nap reminder via SCHEDULED_TASK_CREATE.',
    ),
    Scenario(
        id='sleep.find_conflicts_family_calendar',
        name='Find bedtime conflicts on family calendar',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Check my family calendar for any events after 10\u202fpm tonight that might clash with my bedtime.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'search_events',
                    'intent': 'search family calendar after 22:00',
                    'query': 'cal_family',
                    'details': {
                        'windowStart': '2026-05-10T22:00:00Z',
                        'windowEnd': '2026-05-11T06:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['family', 'conflict'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Searches the family calendar for overlapping events.',
    ),
    Scenario(
        id='sleep.set_bedtime_reminder_with_timezone',
        name='Set bedtime reminder with explicit timezone',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Create a daily bedtime alarm for 10\u202fpm Eastern Time.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Bedtime',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'daily',
                        'timeOfDay': '22:00',
                        'timeZone': 'America/New_York',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['10:00', 'Eastern'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, Eastern Time (America/New_York).',
            applies_when='agent asks which time zone to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a daily bedtime alarm with a specific time zone.',
    ),
    Scenario(
        id='sleep.get_recent_sleep_metrics',
        name='Show last 3 nights of sleep data',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Give me the sleep duration for the past three nights.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'sleep_hours',
                    'days': 3,
                },
            ),
        ],
        required_outputs=['hours', 'night'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Retrieves sleep hours for the most recent three days.',
    ),
    Scenario(
        id='sleep.delete_sleep_quality_metric',
        name='Delete the sleep‑quality metric',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Remove the sleep_quality health metric I added earlier.',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'delete_metric',
                    'metric': 'sleep_quality',
                },
            ),
        ],
        required_outputs=['deleted', 'sleep_quality'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Deletes a custom health metric.',
    ),
    Scenario(
        id='sleep.set_nap_alarm_30min',
        name='Create a 30‑minute nap alarm at 2\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Add a one‑off nap alarm for today at 2\u202fpm that lasts 30 minutes.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Afternoon Nap',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'once',
                        'timeOfDay': '14:00',
                        'durationMinutes': 30,
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['nap', '30'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just today, not recurring.',
            applies_when='agent asks if the nap should repeat',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a single‑use nap alarm with a set duration.',
    ),
    Scenario(
        id='sleep.snooze_winddown_10min',
        name="Snooze tonight's wind‑down reminder by 10\u202fminutes",
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Snooze my wind‑down task for tonight by ten minutes.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_SNOOZE',
                kwargs={
                    'subaction': 'snooze',
                    'taskId': 'task_00001',
                    'minutes': 10,
                    'reason': 'need more time',
                },
            ),
        ],
        required_outputs=['10', 'minutes'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Delays a scheduled wind‑down task.',
    ),
    Scenario(
        id='sleep.show_sleep_trends_last_90days',
        name='Show sleep trends for the last 90 days',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Give me a trend line of my average sleep duration over the past three months.',
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
        required_outputs=['trend', 'sleep'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Requests a trend analysis for sleep hours over 90 days.',
    ),
    Scenario(
        id='sleep.create_sleep_coach_task',
        name='Create a sleep‑coach scheduled task',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Set a daily reminder at 9\u202fpm to review my sleep goals.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'reminder',
                    'promptInstructions': 'Review sleep goals.',
                    'trigger': {
                        'kind': 'daily',
                        'atIso': '2026-05-10T21:00:00Z',
                    },
                    'priority': 'high',
                    'ownerVisible': True,
                    'source': 'user_chat',
                },
            ),
        ],
        required_outputs=['9:00', 'sleep'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just once a day, at 9\u202fpm.',
            applies_when='agent asks about recurrence',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a daily sleep‑coaching reminder.',
    ),
    Scenario(
        id='sleep.find_conflicts_with_work_calendar',
        name='Find bedtime conflicts on work calendar',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Search my work calendar for any events after 10\u202fpm that could interfere with bedtime.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'search_events',
                    'intent': 'search work calendar after 22:00',
                    'query': 'cal_work',
                    'details': {
                        'windowStart': '2026-05-10T22:00:00Z',
                        'windowEnd': '2026-05-11T06:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['work', 'conflict'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Checks the work calendar for late‑night events.',
    ),
    Scenario(
        id='sleep.set_weekday_bedtime_1030',
        name='Set weekday bedtime alarm at 10:30\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Create a bedtime alarm for Monday through Friday at 10:30\u202fpm.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Weekday Bedtime',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'weekly',
                        'dayOfWeek': [
                            'Monday',
                            'Tuesday',
                            'Wednesday',
                            'Thursday',
                            'Friday',
                        ],
                        'timeOfDay': '22:30',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['10:30', 'weekday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, only on weekdays.',
            applies_when='agent asks if it should apply on weekends',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a weekly alarm limited to weekdays.',
    ),
    Scenario(
        id='sleep.update_winddown_task_time',
        name='Change wind‑down task start time to 9:30\u202fpm',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Move my nightly wind‑down reminder to start at 9:30\u202fpm.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_UPDATE',
                kwargs={
                    'subaction': 'update',
                    'taskId': 'task_00003',
                    'trigger': {
                        'kind': 'once',
                        'atIso': '2026-05-10T21:30:00Z',
                    },
                    'reason': 'adjusted bedtime',
                },
            ),
        ],
        required_outputs=['9:30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates the start time of an existing wind‑down task.',
    ),
    Scenario(
        id='sleep.list_all_sleep_alarms',
        name='List all sleep‑related alarms',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Give me a list of all my sleep‑related alarms.',
        ground_truth_actions=[
            Action(
                name='LIFE',
                kwargs={
                    'subaction': 'list',
                    'kind': 'definition',
                    'title': 'Sleep Alarms',
                },
            ),
        ],
        required_outputs=['alarm'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Retrieves a list of all defined sleep alarms.',
    ),
    Scenario(
        id='sleep.disable_all_sleep_alarms',
        name='Disable all sleep alarms for the weekend',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Temporarily disable every sleep alarm for Saturday and Sunday.',
        ground_truth_actions=[
            Action(
                name='LIFE_UPDATE',
                kwargs={
                    'subaction': 'update',
                    'kind': 'definition',
                    'title': 'All Sleep Alarms',
                    'details': {
                        'skipDates': [
                            '2026-05-13',
                            '2026-05-14',
                        ],
                    },
                },
            ),
        ],
        required_outputs=['disabled', 'Saturday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, just for Saturday and Sunday.',
            applies_when='agent asks which days to disable',
        ),
        world_seed=2026,
        max_turns=5,
        description='Bulk‑disables sleep alarms for the weekend.',
    ),
    Scenario(
        id='sleep.set_nap_reminder_with_duration',
        name='Create a daily nap reminder with duration',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Add a daily reminder for a 45‑minute nap at 1\u202fpm.',
        ground_truth_actions=[
            Action(
                name='SCHEDULED_TASK_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'reminder',
                    'promptInstructions': '45‑minute nap.',
                    'trigger': {
                        'kind': 'daily',
                        'atIso': '2026-05-10T13:00:00Z',
                    },
                    'priority': 'low',
                    'ownerVisible': True,
                    'source': 'user_chat',
                },
            ),
        ],
        required_outputs=['45', 'nap'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just a daily reminder, not recurring on weekends.',
            applies_when='agent asks about weekend recurrence',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a daily nap reminder with a specific duration.',
    ),
    Scenario(
        id='sleep.get_sleep_quality_last_month',
        name='Retrieve sleep‑quality scores for the last month',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='What were my sleep_quality scores for each day of the past 30 days?',
        ground_truth_actions=[
            Action(
                name='HEALTH',
                kwargs={
                    'subaction': 'by_metric',
                    'metric': 'sleep_quality',
                    'days': 30,
                },
            ),
        ],
        required_outputs=['sleep_quality'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Fetches daily values of a custom sleep quality metric.',
    ),
    Scenario(
        id='sleep.set_bedtime_with_reason',
        name='Create bedtime alarm with a reason note',
        domain=Domain.SLEEP,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="Set a daily bedtime alarm for 11\u202fpm and add a note that says 'need more rest'.",
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Bedtime',
                    'details': {
                        'kind': 'alarm',
                        'cadence': 'daily',
                        'timeOfDay': '23:00',
                        'note': 'need more rest',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['11:00', 'rest'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a bedtime alarm with an attached explanatory note.',
    ),

]
