"""Calendar-domain scenarios.

Every scenario references real entity ids from the medium snapshot
(``data/snapshots/medium_seed_2026.json``) — calendars (``cal_primary``,
``cal_work``, ``cal_family``) plus concrete event ids that were seeded
into the snapshot. Times are anchored to the snapshot ``now_iso`` of
``2026-05-10T12:00:00Z``.

Action vocabulary: every ``Action.name`` here exists in
``manifests/actions.manifest.json``. Calendar verbs are surfaced via
the ``CALENDAR`` umbrella action with a ``subaction`` discriminator,
mirroring how the Eliza planner sees them at runtime.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
<<<<<<< HEAD
    PERSONA_KAI_STUDENT,
=======
>>>>>>> 914a397b2eaff4835f3909100a5e192af92e44ee
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
)

CALENDAR_SCENARIOS: list[Scenario] = [
    Scenario(
        id="calendar.reschedule_roadmap_sync_to_afternoon",
        name="Reschedule today's roadmap sync to 3pm",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Move my 'Sync: the roadmap' meeting today to 3pm UTC instead of "
            "the morning slot. Keep the 2-hour duration."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "update_event",
                    "intent": "move event_00040 from morning to 15:00-17:00 UTC today",
                    "details": {
                        "eventId": "event_00040",
                        "calendarId": "cal_primary",
                        "start": "2026-05-10T15:00:00Z",
                        "end": "2026-05-10T17:00:00Z",
                    },
                },
            ),
        ],
        required_outputs=["roadmap", "3"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes — keep it on my Personal calendar and keep the same attendees.",
            applies_when="agent asks which calendar or whether to keep attendees",
        ),
        world_seed=2026,
        max_turns=8,
        description=(
            "Single-event reschedule. Tests that the agent reads the seeded event "
            "from cal_primary and emits an update_event with the right new bounds."
        ),
    ),
    Scenario(
        id="calendar.cancel_tentative_launch_checklist",
        name="Cancel tentative launch checklist sync",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="cancel that tentative launch checklist sync next thursday on my family calendar",
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "delete_event",
                    "intent": "cancel tentative event 'Sync: the launch checklist' on cal_family on 2026-05-21",
                    "details": {
                        "eventId": "event_00052",
                        "calendarId": "cal_family",
                    },
                },
            ),
        ],
        required_outputs=["cancel"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "Single-event cancel. Disambiguation hint: the event is tentative and "
            "lives on cal_family — there is exactly one 'launch checklist' on that day."
        ),
    ),
    Scenario(
        id="calendar.find_free_60min_this_week",
        name="Propose a 60-minute slot this week",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Propose three 60-minute slots later this week (between 2026-05-12 "
            "and 2026-05-15) that fit my preferred working hours."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "propose_times",
                    "intent": "find three 60-minute open slots between 2026-05-12 and 2026-05-15",
                    "durationMinutes": 60,
                    "slotCount": 3,
                    "windowStart": "2026-05-12T13:00:00Z",
                    "windowEnd": "2026-05-15T22:00:00Z",
                },
            ),
        ],
        required_outputs=["slot"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="One hour. No specific attendees — just for me to focus.",
            applies_when="agent asks for duration or attendees",
        ),
        world_seed=2026,
        max_turns=6,
        description="Pure availability search. Should not write to the world.",
    ),
    Scenario(
        id="calendar.check_availability_thursday_morning",
        name="Check availability Thursday 9-10am",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction="am i free thursday 9-10am UTC?",
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "check_availability",
                    "intent": "is the owner free 2026-05-14T09:00 to 10:00 UTC",
                    "startAt": "2026-05-14T09:00:00Z",
                    "endAt": "2026-05-14T10:00:00Z",
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Read-only availability probe.",
    ),
    Scenario(
        id="calendar.create_dentist_event_next_friday",
        name="Create dentist event next Friday",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction=(
            "Add a 1-hour dentist appointment next Friday (2026-05-15) at 2pm "
            "UTC on my personal calendar. Location: Bright Smile Dental."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "create 1-hour dentist appointment at 14:00 UTC on 2026-05-15",
                    "title": "Dentist appointment",
                    "details": {
                        "calendarId": "cal_primary",
                        "start": "2026-05-15T14:00:00Z",
                        "end": "2026-05-15T15:00:00Z",
                        "location": "Bright Smile Dental",
                    },
                },
            ),
        ],
        required_outputs=["dentist", "Friday"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Personal calendar, no extra attendees.",
            applies_when="agent asks which calendar or about attendees",
        ),
        world_seed=2026,
        max_turns=6,
        description="Single-shot create_event with full detail block.",
    ),
    Scenario(
        id="calendar.next_event_today",
        name="What's my next event today",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="what's my next meeting?",
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "next_event",
                    "intent": "what is the next upcoming event on my calendars",
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description="Trivial next-event read.",
    ),
    Scenario(
        id="calendar.update_preferences_blackout_evenings",
        name="Update calendar preferences with evening blackout",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "Stop scheduling meetings after 5pm local time on weekdays. Set my "
            "preferred meeting hours to 9am-5pm and add a daily blackout window "
            "from 17:00 to 22:00."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "update_preferences",
                    "intent": "block meetings after 17:00 local on weekdays",
                    "preferredStartLocal": "09:00",
                    "preferredEndLocal": "17:00",
                    "blackoutWindows": [
                        {
                            "label": "evenings",
                            "startLocal": "17:00",
                            "endLocal": "22:00",
                            "daysOfWeek": [1, 2, 3, 4, 5],
                        }
                    ],
                },
            ),
        ],
        required_outputs=["preference"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="My local time zone is America/New_York.",
            applies_when="agent asks for time zone",
        ),
        world_seed=2026,
        max_turns=6,
        description="Preference update — mutates planner config, not events.",
    ),
    Scenario(
        id="calendar.search_pitch_meetings_this_quarter",
        name="Search 'pitch' meetings this quarter",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "List every meeting with 'pitch' in the title between 2026-04-01 "
            "and 2026-06-30."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "search_events",
                    "intent": "search calendar events containing 'pitch' Q2 2026",
                    "query": "pitch",
                    "details": {
                        "windowStart": "2026-04-01T00:00:00Z",
                        "windowEnd": "2026-06-30T23:59:59Z",
                    },
                },
            ),
        ],
        required_outputs=["pitch"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Pure search across the seeded calendar.",
    ),    Scenario(
        id='calendar.reschedule_dentist_to_friday',
        name='Reschedule dentist appointment to Friday morning',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Please move my dentist appointment to Friday at 10am UTC.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move dentist appointment to Friday morning',
                    'details': {
                        'eventId': 'event_00030',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-12T10:00:00Z',
                        'end': '2026-05-12T10:30:00Z',
                    },
                },
            ),
        ],
        required_outputs=['dentist', 'Friday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, keep it on my primary calendar.',
            applies_when='agent asks which calendar',
        ),
        world_seed=2026,
        max_turns=8,
        description='Reschedules a single existing event to a new day and time, testing correct update_event payload.',
    ),
    Scenario(
        id='calendar.cancel_yoga_class',
        name='Cancel weekly yoga class',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Cancel my yoga class that repeats every Wednesday at 6pm on my family calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel yoga class on Wednesday evening',
                    'details': {
                        'eventId': 'event_00055',
                        'calendarId': 'cal_family',
                    },
                },
            ),
        ],
        required_outputs=['canceled', 'yoga'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description='Deletes a recurring event, ensuring the correct calendar and event IDs are used.',
    ),
    Scenario(
        id='calendar.propose_meeting_with_alex',
        name='Propose three 30‑minute slots for meeting with Alex',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Suggest three 30‑minute windows next week (May 13‑19) for a meeting with Alex.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'propose three 30‑minute slots for meeting with Alex',
                    'durationMinutes': 30,
                    'slotCount': 3,
                    'windowStart': '2026-05-13T09:00:00Z',
                    'windowEnd': '2026-05-19T17:00:00Z',
                    'title': 'Meeting with Alex',
                },
            ),
        ],
        required_outputs=['slot', 'Alex'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='30 minutes, no attendees needed.',
            applies_when='agent asks for duration or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Tests availability proposal generation with specific duration and window constraints.',
    ),
    Scenario(
        id='calendar.check_monday_morning_block',
        name='Check availability Monday morning 2‑hour block',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Am I free Monday from 9am to 11am UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'check free slot Monday 09:00‑11:00 UTC',
                    'startAt': '2026-05-13T09:00:00Z',
                    'endAt': '2026-05-13T11:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description='Simple availability query for a fixed two‑hour window.',
    ),
    Scenario(
        id='calendar.create_lunch_maya_15may',
        name='Create lunch meeting with Dr. Sam',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Schedule a lunch with Dr. Sam at 12:30pm UTC on 2026-05-15 for 45 minutes, on my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create lunch with Dr. Sam on 2026-05-15 12:30-13:15 UTC',
                    'title': 'Lunch with Dr. Sam',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-15T12:30:00Z',
                        'end': '2026-05-15T13:15:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Lunch', 'Dr. Sam', '12:30'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='primary calendar, no other attendees',
            applies_when='agent asks which calendar or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Create a single event with a specific time, duration, and title on the primary calendar.',
    ),
    Scenario(
        id='calendar.reschedule_dentist_friday',
        name='Reschedule dentist appointment to Friday morning',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Move my dentist appointment to Friday at 10:00 UTC.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move dentist appointment event_00045 to Friday 10:00-10:30 UTC',
                    'details': {
                        'eventId': 'event_00045',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-12T10:00:00Z',
                        'end': '2026-05-12T10:30:00Z',
                    },
                },
            ),
        ],
        required_outputs=['dentist', 'Friday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Yes, move it to Friday at 10am on my primary calendar.',
            applies_when='agent asks for confirmation before moving the appointment',
        ),
        world_seed=2026,
        max_turns=8,
        description='Reschedule an existing dentist appointment to a new day and time.',
    ),
    Scenario(
        id='calendar.cancel_team_sync_monday',
        name='Cancel team sync meeting on Monday',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Please cancel the 'Team Sync' meeting scheduled for next Monday on my work calendar.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': "cancel 'Team Sync' event event_00070 on cal_work on 2026-05-13",
                    'details': {
                        'eventId': 'event_00070',
                        'calendarId': 'cal_work',
                    },
                },
            ),
        ],
        required_outputs=['Team Sync', 'cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description='Cancel a specific meeting on the work calendar.',
    ),
    Scenario(
        id='calendar.propose_coffee_chat',
        name='Propose coffee chat slots',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Propose three 30‑minute time slots between 2026-05-12 and 2026-05-14 for a coffee chat with Alex.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'find three 30-minute slots between 2026-05-12 and 2026-05-14 for coffee chat',
                    'durationMinutes': 30,
                    'slotCount': 3,
                    'windowStart': '2026-05-12T00:00:00Z',
                    'windowEnd': '2026-05-14T23:59:59Z',
                    'title': 'Coffee chat with Alex',
                },
            ),
        ],
        required_outputs=['coffee', '30', 'slot'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just me and Alex, no other attendees.',
            applies_when='agent asks about attendees or duration',
        ),
        world_seed=2026,
        max_turns=8,
        description='Search for multiple possible meeting times for a short coffee chat.',
    ),
    Scenario(
        id='calendar.check_availability_saturday',
        name='Check availability Saturday afternoon',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='am i free saturday 14:00-16:00 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is owner free 2026-05-14T14:00 to 16:00 UTC',
                    'startAt': '2026-05-14T14:00:00Z',
                    'endAt': '2026-05-14T16:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description='Simple availability query for a two‑hour block on Saturday.',
    ),
    Scenario(
        id='calendar.create_meeting_john_next_monday',
        name='Create meeting with John next Monday at 14:00 UTC',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Please schedule a 45‑minute meeting with John Doe next Monday at 2\u202fpm UTC on my work calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create meeting with John Doe on 2026-05-13 14:00-14:45 UTC',
                    'title': 'Meeting with John Doe',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-05-13T14:00:00Z',
                        'end': '2026-05-13T14:45:00Z',
                    },
                },
            ),
        ],
        required_outputs=['John', 'Monday', '45'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='work calendar, no other attendees needed.',
            applies_when='agent asks which calendar or whether to add attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Simple event creation on the work calendar, testing correct time conversion and calendar selection.',
    ),
    Scenario(
        id='calendar.cancel_dentist_appointment',
        name='Cancel dentist appointment on personal calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='cancel my dentist appointment on my personal calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel dentist appointment on cal_primary',
                    'details': {
                        'eventId': 'event_00045',
                        'calendarId': 'cal_primary',
                    },
                },
            ),
        ],
        required_outputs=['cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Single-event cancel on the primary calendar; no clarification needed.',
    ),
    Scenario(
        id='calendar.reschedule_team_sync_tuesday_to_thursday',
        name='Reschedule weekly team sync from Tuesday to Thursday',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction="Move my weekly 'Team Sync' meeting from Tuesday 10\u202fam to Thursday 11\u202fam UTC, keeping the 2‑hour duration.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move event_00030 from Tue 10:00 to Thu 11:00 UTC, keep 2h duration',
                    'details': {
                        'eventId': 'event_00030',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-10T11:00:00Z',
                        'end': '2026-05-10T13:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Team Sync', 'Thursday', '2'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='yes — keep it on my primary calendar and retain the same attendees.',
            applies_when='agent asks which calendar or whether to keep attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Rescheduling a recurring‑type event; tests correct identification and time shift.',
    ),
    Scenario(
        id='calendar.propose_brainstorm_slots_next_week',
        name='Propose three 30‑minute brainstorming slots next week',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Propose three 30‑minute slots for a brainstorming session sometime between May\u202f13 and May\u202f17, within my preferred working hours.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'find three 30‑minute open slots between 2026-05-13 and 2026-05-17',
                    'durationMinutes': 30,
                    'slotCount': 3,
                    'windowStart': '2026-05-13T09:00:00Z',
                    'windowEnd': '2026-05-17T18:00:00Z',
                },
            ),
        ],
        required_outputs=['slot', '30'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='30 minutes each, no attendees needed — just for me.',
            applies_when='agent asks for duration or attendees',
        ),
        world_seed=2026,
        max_turns=6,
        description='Availability search without modifying the calendar.',
    ),
    Scenario(
        id='calendar.check_availability_friday_13_14',
        name='Check availability Friday 13‑14\u202fUTC',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Am I free this Friday from 13:00 to 14:00 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-13T13:00 to 14:00 UTC',
                    'startAt': '2026-05-13T13:00:00Z',
                    'endAt': '2026-05-13T14:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Simple availability query for a single hour.',
    ),
    Scenario(
        id='calendar.delete_lunch_sarah_family',
        name='Delete tentative Lunch with Sarah on family calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Delete that tentative lunch with Sarah on my family calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel tentative lunch with Sarah on cal_family',
                    'details': {
                        'eventId': 'event_00055',
                        'calendarId': 'cal_family',
                    },
                },
            ),
        ],
        required_outputs=['cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Deletion of a tentative event on a non‑primary calendar.',
    ),
    Scenario(
        id='calendar.create_all_day_conference_day1',
        name='Create all‑day Conference Day\u202f1 event',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction='Add an all‑day event called "Conference Day 1" on May\u202f20 to my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create all‑day Conference Day 1 on 2026-05-20 UTC',
                    'title': 'Conference Day 1',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-20T00:00:00Z',
                        'end': '2026-05-21T00:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Conference', 'May 20'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='primary calendar, all‑day, no attendees.',
            applies_when='agent asks which calendar or whether to set time',
        ),
        world_seed=2026,
        max_turns=8,
        description='Testing all‑day event creation.',
    ),
    Scenario(
        id='calendar.move_gym_event_earlier',
        name='Move Gym event 07:00‑08:00',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Shift my Gym workout (event_00070) to start at 07:00 UTC instead of 06:00, keeping the same duration, on my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move event_00070 to 07:00‑08:00 UTC',
                    'details': {
                        'eventId': 'event_00070',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-10T07:00:00Z',
                        'end': '2026-05-10T08:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Gym', '07:00'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='yes — keep it on my primary calendar.',
            applies_when='agent asks which calendar',
        ),
        world_seed=2026,
        max_turns=8,
        description='Rescheduling a single-instance workout event.',
    ),
    Scenario(
        id='calendar.create_focus_reading_tomorrow',
        name='Create reading focus block tomorrow evening',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Schedule a 1‑hour focus block called "Reading" for tomorrow from 18:00 to 19:00 UTC on my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create focus block Reading on 2026-05-11 18:00‑19:00 UTC',
                    'title': 'Reading',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-11T18:00:00Z',
                        'end': '2026-05-11T19:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Reading', '18:00'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='primary calendar, no attendees, just a focus block.',
            applies_when='agent asks which calendar or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Focus block creation with explicit times.',
    ),
    Scenario(
        id='calendar.propose_client_call_90min',
        name='Propose three 90‑minute slots for client call',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Propose three 90‑minute slots for a client call between May\u202f15 and May\u202f18, respecting my working hours.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'find three 90‑minute open slots between 2026-05-15 and 2026-05-18',
                    'durationMinutes': 90,
                    'slotCount': 3,
                    'windowStart': '2026-05-15T09:00:00Z',
                    'windowEnd': '2026-05-18T18:00:00Z',
                },
            ),
        ],
        required_outputs=['90', 'client'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='90 minutes each, no specific attendees.',
            applies_when='agent asks for duration or attendees',
        ),
        world_seed=2026,
        max_turns=6,
        description='Availability proposal for a longer meeting.',
    ),
    Scenario(
        id='calendar.check_availability_weekend_sat',
        name='Check weekend availability Saturday 09‑11',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Am I free this Saturday from 09:00 to 11:00 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-15T09:00 to 11:00 UTC',
                    'startAt': '2026-05-15T09:00:00Z',
                    'endAt': '2026-05-15T11:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Weekend availability query.',
    ),
    Scenario(
        id='calendar.cancel_doctor_appointment',
        name='Cancel doctor appointment on primary calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Please cancel the doctor appointment (event_00090) on my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel doctor appointment on cal_primary',
                    'details': {
                        'eventId': 'event_00090',
                        'calendarId': 'cal_primary',
                    },
                },
            ),
        ],
        required_outputs=['cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Straightforward event deletion.',
    ),
    Scenario(
        id='calendar.create_meeting_team_zoom',
        name='Create team meeting with Zoom link',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Schedule a 1‑hour meeting titled "Team Sync" tomorrow at 10\u202fam UTC on my work calendar, with a Zoom link.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create Team Sync with Zoom on 2026-05-11 10:00‑11:00 UTC',
                    'title': 'Team Sync',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-05-11T10:00:00Z',
                        'end': '2026-05-11T11:00:00Z',
                        'location': 'Zoom',
                    },
                },
            ),
        ],
        required_outputs=['Team Sync', 'Zoom'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='work calendar, Zoom link, no other attendees needed.',
            applies_when='agent asks which calendar or location',
        ),
        world_seed=2026,
        max_turns=8,
        description='Event creation with location field.',
    ),
    Scenario(
        id='calendar.reschedule_budget_review_next_day',
        name='Reschedule Budget Review to next day',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Move the 'Budget Review' (event_00100) to the same time slot but on the following day.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move event_00100 to next day same time',
                    'details': {
                        'eventId': 'event_00100',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-11T09:00:00Z',
                        'end': '2026-05-11T10:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Budget Review', 'next day'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='yes — keep it on my primary calendar.',
            applies_when='agent asks which calendar',
        ),
        world_seed=2026,
        max_turns=8,
        description='Simple date shift while preserving time.',
    ),
    Scenario(
        id='calendar.delete_birthday_party_family',
        name='Delete Birthday Party event on family calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Delete the 'Birthday Party' event (event_00110) from my family calendar.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel Birthday Party on cal_family',
                    'details': {
                        'eventId': 'event_00110',
                        'calendarId': 'cal_family',
                    },
                },
            ),
        ],
        required_outputs=['cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Deletion of a personal event on a non‑primary calendar.',
    ),
    Scenario(
        id='calendar.check_availability_may12_15_30',
        name='Check availability May\u202f12 15:00‑30:00',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="Check if I'm free on May\u202f12 from 15:00 to 15:30 UTC.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-12T15:00 to 15:30 UTC',
                    'startAt': '2026-05-12T15:00:00Z',
                    'endAt': '2026-05-12T15:30:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Fine‑grained availability check.',
    ),
    Scenario(
        id='calendar.propose_three_45min_next_five_days',
        name='Propose three 45‑minute slots in next five days',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Give me three 45‑minute time slots sometime in the next five days that fit my usual work hours.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'find three 45‑minute open slots in next five days',
                    'durationMinutes': 45,
                    'slotCount': 3,
                    'windowStart': '2026-05-10T09:00:00Z',
                    'windowEnd': '2026-05-15T18:00:00Z',
                },
            ),
        ],
        required_outputs=['45'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='45 minutes each, within my usual work hours.',
            applies_when='agent asks for duration or work‑hour preferences',
        ),
        world_seed=2026,
        max_turns=6,
        description='Availability proposal spanning multiple days.',
    ),
    Scenario(
        id='calendar.move_interview_event_00115',
        name='Move interview event to later time',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Reschedule the interview (event_00115) from 09:00 to 11:00 UTC on the same day.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'update_event',
                    'intent': 'move event_00115 to 11:00‑12:00 UTC',
                    'details': {
                        'eventId': 'event_00115',
                        'calendarId': 'cal_primary',
                        'start': '2026-05-10T11:00:00Z',
                        'end': '2026-05-10T12:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['interview', '11:00'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='yes — keep it on my primary calendar.',
            applies_when='agent asks which calendar',
        ),
        world_seed=2026,
        max_turns=8,
        description='Single‑instance event time shift.',
    ),
    Scenario(
        id='calendar.cancel_webinar_work',
        name='Cancel Webinar on work calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Cancel the webinar (event_00118) on my work calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'delete_event',
                    'intent': 'cancel webinar on cal_work',
                    'details': {
                        'eventId': 'event_00118',
                        'calendarId': 'cal_work',
                    },
                },
            ),
        ],
        required_outputs=['cancel'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Deletion of a webinar event on the work calendar.',
    ),
    Scenario(
        id='calendar.create_holiday_all_day_may25',
        name='Create all‑day Holiday on May\u202f25',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Add an all‑day "Holiday" event on May\u202f25 to my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create all‑day Holiday on 2026-05-25 UTC',
                    'title': 'Holiday',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-25T00:00:00Z',
                        'end': '2026-05-26T00:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Holiday', 'May 25'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='primary calendar, all‑day, no attendees.',
            applies_when='agent asks which calendar or time details',
        ),
        world_seed=2026,
        max_turns=8,
        description='All‑day event creation for a future date.',
    ),
    Scenario(
        id='calendar.check_availability_may14_16_30',
        name='Check availability May\u202f14 16:00‑16:30',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Am I free on May\u202f14 from 16:00 to 16:30 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-14T16:00 to 16:30 UTC',
                    'startAt': '2026-05-14T16:00:00Z',
                    'endAt': '2026-05-14T16:30:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Mid‑day availability query.',
    ),
    Scenario(
        id='calendar.create_meeting_with_sales_team',
        name='Create Sales Team meeting on work calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Schedule a 1‑hour meeting titled "Sales Team Sync" on Thursday at 09:00 UTC on my work calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create Sales Team Sync on 2026-05-14 09:00‑10:00 UTC',
                    'title': 'Sales Team Sync',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-05-14T09:00:00Z',
                        'end': '2026-05-14T10:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Sales', 'Thursday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='work calendar, no attendees needed.',
            applies_when='agent asks which calendar or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Simple event creation on work calendar.',
    ),
    Scenario(
        id='calendar.check_availability_may13_08_09',
        name='Check availability May\u202f13 08:00‑09:00',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_KAI_STUDENT,
        instruction='Am I free on May\u202f13 from 08:00 to 09:00 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-13T08:00 to 09:00 UTC',
                    'startAt': '2026-05-13T08:00:00Z',
                    'endAt': '2026-05-13T09:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Early‑morning availability check.',
    ),
    Scenario(
        id='calendar.create_focus_block_project_review',
        name='Create focus block for Project Review tomorrow',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Schedule a 2‑hour focus block called "Project Review" for tomorrow from 13:00 to 15:00 UTC on my primary calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create focus block Project Review on 2026-05-11 13:00‑15:00 UTC',
                    'title': 'Project Review',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-11T13:00:00Z',
                        'end': '2026-05-11T15:00:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Project Review', '13:00'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='primary calendar, no attendees, just a focus block.',
            applies_when='agent asks which calendar or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Longer focus block creation.',
    ),
    Scenario(
        id='calendar.propose_three_30min_morning_next_week',
        name='Propose three 30‑minute morning slots next week',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Suggest three 30‑minute morning slots (between 08:00‑12:00) sometime next week for a quick call.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'find three 30‑minute open slots next week morning',
                    'durationMinutes': 30,
                    'slotCount': 3,
                    'windowStart': '2026-05-12T08:00:00Z',
                    'windowEnd': '2026-05-18T12:00:00Z',
                },
            ),
        ],
        required_outputs=['30', 'morning'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='30 minutes each, morning only, no attendees needed.',
            applies_when='agent asks for duration or time‑of‑day preference',
        ),
        world_seed=2026,
        max_turns=6,
        description='Morning availability proposal.',
    ),
    Scenario(
        id='calendar.check_availability_may16_14_15',
        name='Check availability May\u202f16 14:00‑15:00',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Am I free on May\u202f16 from 14:00 to 15:00 UTC?',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'check_availability',
                    'intent': 'is the owner free 2026-05-16T14:00 to 15:00 UTC',
                    'startAt': '2026-05-16T14:00:00Z',
                    'endAt': '2026-05-16T15:00:00Z',
                },
            ),
        ],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=4,
        description='Mid‑afternoon availability query.',
    ),
    Scenario(
        id='calendar.create_meeting_with_marketing_team',
        name='Create Marketing Team meeting on work calendar',
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Schedule a 45‑minute "Marketing Team" meeting on Wednesday at 11:30 UTC on my work calendar.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'create Marketing Team meeting on 2026-05-15 11:30‑12:15 UTC',
                    'title': 'Marketing Team',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-05-15T11:30:00Z',
                        'end': '2026-05-15T12:15:00Z',
                    },
                },
            ),
        ],
        required_outputs=['Marketing', 'Wednesday'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='work calendar, no attendees needed.',
            applies_when='agent asks which calendar or attendees',
        ),
        world_seed=2026,
        max_turns=8,
        description='Event creation with non‑round times.',
    ),

]
