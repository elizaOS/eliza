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
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
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

]
