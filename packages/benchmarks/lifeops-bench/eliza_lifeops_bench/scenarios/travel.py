"""Travel-domain scenarios.

Covers flight search (BOOK_TRAVEL stub), trip-window calendar holds,
out-of-office blocks, and itinerary sharing. Booking flows are
approval-gated by design — every booking action emits an offer that the
user must explicitly approve before it lands.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
)

TRAVEL_SCENARIOS: list[Scenario] = [
    Scenario(
        id="travel.search_flights_sfo_jfk_next_friday",
        name="Search flights SFO -> JFK next Friday",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "Find flights from SFO to JFK departing 2026-05-15 returning "
            "2026-05-18, one passenger, economy preferred."
        ),
        ground_truth_actions=[
            Action(
                name="BOOK_TRAVEL",
                kwargs={
                    "origin": "SFO",
                    "destination": "JFK",
                    "departureDate": "2026-05-15",
                    "returnDate": "2026-05-18",
                    "passengers": [{"type": "adult"}],
                },
            ),
        ],
        required_outputs=["flight"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Just one adult passenger. Economy class.",
            applies_when="agent asks about cabin or passenger count",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Flight search via the BOOK_TRAVEL stub. Returns offers; does NOT "
            "book without approval."
        ),
    ),
    Scenario(
        id="travel.create_trip_window_calendar_block",
        name="Create trip-window calendar block",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction=(
            "Block out my work calendar for the New York trip 2026-05-15 "
            "through 2026-05-18 — mark me unavailable."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "intent": "block New York trip 2026-05-15 to 2026-05-18 as OOO",
                    "title": "OOO — New York trip",
                    "details": {
                        "calendarId": "cal_work",
                        "start": "2026-05-15T00:00:00Z",
                        "end": "2026-05-18T23:59:00Z",
                        "all_day": True,
                    },
                },
            ),
        ],
        required_outputs=["OOO"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="All-day OOO event on the work calendar.",
    ),
    Scenario(
        id="travel.airport_transfer_reminder_morning_of",
        name="Schedule airport transfer reminder",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Remind me on 2026-05-15 at 5am to leave for the airport — uber "
            "to SFO."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Leave for SFO — uber",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-15T05:00:00Z",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["airport"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Personal list, default ringtone.",
            applies_when="agent asks which list",
        ),
        world_seed=2026,
        max_turns=5,
        description="Reminder created off a travel context.",
    ),
    Scenario(
        id="travel.share_itinerary_via_imessage",
        name="Share itinerary via iMessage",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction=(
            "Send my partner Hannah Hill the trip itinerary via iMessage: "
            "'Flying SFO -> JFK Fri 5/15, returning Mon 5/18. Hotel: "
            "MidtownInn.'"
        ),
        ground_truth_actions=[
            Action(
                name="MESSAGE",
                kwargs={
                    "operation": "send",
                    "source": "imessage",
                    "targetKind": "contact",
                    "target": "Hannah Hill",
                    "message": (
                        "Flying SFO -> JFK Fri 5/15, returning Mon 5/18. "
                        "Hotel: MidtownInn."
                    ),
                },
            ),
        ],
        required_outputs=["sent"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description="Cross-domain travel + messages composition.",
    ),    Scenario(
        id='travel.search_flights_nyc_lax_next_week',
        name='Search flights NYC → LAX next week',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Find the cheapest flights from New York (NYC) to Los Angeles (LAX) departing on 2026-05-16 and returning on 2026-05-20 for one adult.',
        ground_truth_actions=[
            Action(
                name='BOOK_TRAVEL',
                kwargs={
                    'origin': 'NYC',
                    'destination': 'LAX',
                    'departureDate': '2026-05-16',
                    'returnDate': '2026-05-20',
                    'passengers': [
                        {
                            'type': 'adult',
                        },
                    ],
                },
            ),
        ],
        required_outputs=['flight', 'NYC', 'LAX'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Just one adult passenger, looking for the cheapest option.',
            applies_when='agent asks about passenger count or cabin class',
        ),
        world_seed=2026,
        max_turns=6,
        description='Simple flight search using BOOK_TRAVEL; verifies handling of date and passenger parameters.',
    ),
    Scenario(
        id='travel.block_work_calendar_trip_nyc',
        name='Block work calendar for NYC trip',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction='Block out my work calendar from 2026-05-15 to 2026-05-18 for the New York business trip, marking me unavailable.',
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'block NYC trip',
                    'title': 'OOO — NYC trip',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-05-15T00:00:00Z',
                        'end': '2026-05-18T23:59:00Z',
                        'all_day': True,
                    },
                },
            ),
        ],
        required_outputs=['OOO', 'NYC'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Use my work calendar (cal_work) for the block.',
            applies_when='agent asks which calendar to block',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates an all‑day out‑of‑office block on the work calendar.',
    ),
    Scenario(
        id='travel.reminder_flight_departure',
        name='Reminder for flight departure',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction='Create a reminder for my flight departing on 2026-05-15 at 07:00 UTC, using my personal reminder list.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Flight departure reminder',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-15T07:00:00Z',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['reminder'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Put it on my personal list (list_personal).',
            applies_when='agent asks which reminder list to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates a reminder for a specific flight departure time.',
    ),
    Scenario(
        id='travel.send_itinerary_to_spouse',
        name='Send itinerary to spouse via iMessage',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Message my husband Alex about the trip: 'Flight NYC → LAX on 5/16, return 5/20. Hotel: Sunset Inn.' Send via iMessage.",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'imessage',
                    'targetKind': 'contact',
                    'target': 'contact_00001',
                    'message': 'Flight NYC → LAX on 5/16, return 5/20. Hotel: Sunset Inn.',
                },
            ),
        ],
        required_outputs=['sent'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Sends a composed itinerary to a specific contact via iMessage.',
    ),
    Scenario(
        id='travel.create_hotel_checkin_reminder',
        name='Reminder for hotel check‑in',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Remind me to check in at the hotel on 2026-05-15 at 15:00 UTC, using my inbox reminder list.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Hotel check‑in reminder',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-15T15:00:00Z',
                        'listId': 'list_inbox',
                    },
                },
            ),
        ],
        required_outputs=['check‑in'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a reminder on the inbox list for hotel check‑in.',
    ),
    Scenario(
        id='travel.block_family_calendar_trip',
        name='Block family calendar for trip',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Mark my family calendar unavailable from 2026-05-15 to 2026-05-18 for a trip, with the title 'Family trip OOO'.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'block family trip',
                    'title': 'Family trip OOO',
                    'details': {
                        'calendarId': 'cal_family',
                        'start': '2026-05-15T00:00:00Z',
                        'end': '2026-05-18T23:59:00Z',
                        'all_day': True,
                    },
                },
            ),
        ],
        required_outputs=['family', 'OOO'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Use the family calendar (cal_family).',
            applies_when='agent asks which calendar to block',
        ),
        world_seed=2026,
        max_turns=5,
        description='Creates an OOO block on the family calendar.',
    ),
    Scenario(
        id='travel.create_trip_window_and_flight_event',
        name='Create trip window and add flight event',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Block my primary calendar from 2026-05-15 to 2026-05-18 for the trip, then add a flight event titled 'Flight NYC → LAX' on 2026-05-16 at 07:00 UTC lasting 4 hours.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'trip window block',
                    'title': 'Trip window',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-15T00:00:00Z',
                        'end': '2026-05-18T23:59:00Z',
                        'all_day': True,
                    },
                },
            ),
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'flight event',
                    'title': 'Flight NYC → LAX',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-16T07:00:00Z',
                        'end': '2026-05-16T11:00:00Z',
                        'all_day': False,
                    },
                },
            ),
        ],
        required_outputs=['NYC', 'LAX', 'Trip window'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=8,
        description='Two calendar actions: a block for the trip window and a specific flight event.',
    ),
    # NOTE: travel.update_flight_departure_time was dropped — referenced an
    # event by title only (no eventId), and no matching event exists in the
    # medium_seed_2026 snapshot. Pure LARP. Restore once a flight-event
    # seeder lands so the title can resolve to a real id.
    Scenario(
        id='travel.set_travel_buffer_preference',
        name='Set travel buffer preference',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_OWEN_RETIREE,
        instruction='Configure my calendar preferences to add a 30‑minute travel buffer before any travel events.',
        ground_truth_actions=[
            Action(
                name='CALENDAR_UPDATE_PREFERENCES',
                kwargs={
                    'subaction': 'update_preferences',
                    'intent': 'set travel buffer',
                    'travelBufferMinutes': 30,
                },
            ),
        ],
        required_outputs=['30'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Updates calendar preferences with a travel buffer.',
    ),
    Scenario(
        id='travel.propose_flight_times_for_meeting',
        name='Propose flight times for meeting',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction='Propose three possible flight times from NYC to Chicago on 2026-05-22 for a 2\u202fpm meeting, each lasting 2\u202fhours.',
        ground_truth_actions=[
            Action(
                name='CALENDAR_PROPOSE_TIMES',
                kwargs={
                    'subaction': 'propose_times',
                    'intent': 'flight proposals',
                    'title': 'NYC → CHI flight options',
                    'durationMinutes': 120,
                    'daysAhead': 0,
                    'slotCount': 3,
                    'windowStart': '2026-05-22T00:00:00Z',
                    'windowEnd': '2026-05-22T23:59:00Z',
                    'timeZone': 'UTC',
                },
            ),
        ],
        required_outputs=['flight', 'options'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=7,
        description='Uses CALENDAR_PROPOSE_TIMES to generate flight slot options.',
    ),
    Scenario(
        id='travel.share_flight_details_via_sms',
        name='Share flight details via SMS',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction="Text my colleague Sam the flight info: 'NYC → LAX dep 5/16 07:00 UTC, arr 5/16 11:00 UTC.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'sms',
                    'targetKind': 'contact',
                    'target': 'contact_00003',
                    'message': 'NYC → LAX dep 5/16 07:00 UTC, arr 5/16 11:00 UTC.',
                },
            ),
        ],
        required_outputs=['sent'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Send it to contact_00003 via SMS.',
            applies_when='agent asks which contact or channel to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Sends a concise flight summary via SMS.',
    ),
    Scenario(
        id='travel.create_trip_reminder_list',
        name='Create trip reminder list entry',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_SAM_FOUNDER,
        instruction='Add a reminder to my work reminder list to pack luggage on 2026-05-14 at 18:00 UTC.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Pack luggage',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-14T18:00:00Z',
                        'listId': 'list_work',
                    },
                },
            ),
        ],
        required_outputs=['luggage'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a reminder on the work list.',
    ),
    Scenario(
        id='travel.schedule_flight_departure_alarm',
        name='Schedule flight departure alarm',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction="Set an alarm for my flight departure on 2026-05-16 at 07:00 UTC, labeling it 'Flight to LAX'.",
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Flight to LAX alarm',
                    'details': {
                        'kind': 'alarm',
                        'due': '2026-05-16T07:00:00Z',
                        'label': 'Flight to LAX',
                    },
                },
            ),
        ],
        required_outputs=['alarm'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates an alarm (treated as a reminder kind) for flight departure.',
    ),
    Scenario(
        id='travel.search_flights_with_flexible_dates',
        name='Search flights with flexible dates',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NORA_CONSULTANT,
        instruction='Find the cheapest round‑trip flights from Boston (BOS) to San Francisco (SFO) departing any day between 2026-05-20 and 2026-05-25 and returning between 2026-05-27 and 2026-06-02, one adult.',
        ground_truth_actions=[
            Action(
                name='BOOK_TRAVEL',
                kwargs={
                    'origin': 'BOS',
                    'destination': 'SFO',
                    'departureDate': '2026-05-20/2026-05-25',
                    'returnDate': '2026-05-27/2026-06-02',
                    'passengers': [
                        {
                            'type': 'adult',
                        },
                    ],
                },
            ),
        ],
        required_outputs=['cheapest'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='One adult, flexible dates as specified.',
            applies_when='agent asks about passenger count or date flexibility',
        ),
        world_seed=2026,
        max_turns=7,
        description='Tests handling of date ranges in flight search.',
    ),
    Scenario(
        id='travel.block_calendar_for_conference',
        name='Block calendar for conference',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Mark my work calendar as busy from 2026-06-01 to 2026-06-04 for the Tech Conference, title it 'Tech Conference'.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'conference block',
                    'title': 'Tech Conference',
                    'details': {
                        'calendarId': 'cal_work',
                        'start': '2026-06-01T00:00:00Z',
                        'end': '2026-06-04T23:59:00Z',
                        'all_day': True,
                    },
                },
            ),
        ],
        required_outputs=['Tech Conference'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a multi‑day busy block for a conference.',
    ),
    Scenario(
        id='travel.send_itinerary_via_whatsapp',
        name='Send itinerary via WhatsApp',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MAYA_PARENT,
        instruction="Message my sister Lily the itinerary: 'Flight NYC → LAX on 5/16, return 5/20. Hotel: Ocean View.' Send via WhatsApp.",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'whatsapp',
                    'targetKind': 'contact',
                    'target': 'contact_00004',
                    'message': 'Flight NYC → LAX on 5/16, return 5/20. Hotel: Ocean View.',
                },
            ),
        ],
        required_outputs=['sent'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Send it to Lily (contact_00004) via WhatsApp.',
            applies_when='agent asks which contact or channel to use',
        ),
        world_seed=2026,
        max_turns=5,
        description='Sends a travel itinerary through WhatsApp.',
    ),
    Scenario(
        id='travel.create_flight_event_with_notes',
        name='Create flight event with notes',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Add a calendar event titled 'Flight NYC → LAX' on my primary calendar for 2026-05-16 07:00‑11:00 UTC, and include the note 'Check-in online 24h before'.",
        ground_truth_actions=[
            Action(
                name='CALENDAR_CREATE_EVENT',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'flight event',
                    'title': 'Flight NYC → LAX',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-16T07:00:00Z',
                        'end': '2026-05-16T11:00:00Z',
                        'all_day': False,
                        'notes': 'Check-in online 24h before',
                    },
                },
            ),
        ],
        required_outputs=['Check-in'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Creates a calendar event with an attached note.',
    ),
    Scenario(
        id='travel.remind_to_check_in_online',
        name='Reminder to check‑in online',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ALEX_ENG,
        instruction='Remind me 24 hours before my flight on 2026-05-16 to check‑in online, using my personal reminder list.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Check‑in online reminder',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-15T07:00:00Z',
                        'listId': 'list_personal',
                    },
                },
            ),
        ],
        required_outputs=['check‑in'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a reminder offset from flight time.',
    ),
    Scenario(
        id='travel.create_trip_window_with_description',
        name='Create trip window with description',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_RIA_PM,
        instruction="Block my primary calendar from 2026-05-15 to 2026-05-18 for the NYC trip, title it 'NYC Trip', and add the description 'Conference and client meetings'.",
        ground_truth_actions=[
            Action(
                name='CALENDAR',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'trip window block',
                    'title': 'NYC Trip',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-15T00:00:00Z',
                        'end': '2026-05-18T23:59:00Z',
                        'all_day': True,
                        'description': 'Conference and client meetings',
                    },
                },
            ),
        ],
        required_outputs=['NYC Trip'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Creates a trip window with a custom description.',
    ),
    Scenario(
        id='travel.send_flight_details_via_slack',
        name='Send flight details via Slack',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_LIN_OPS,
        instruction="Post in the #travel channel: 'Flight NYC → LAX dep 07:00 UTC, arr 11:00 UTC on 5/16.'",
        ground_truth_actions=[
            Action(
                name='MESSAGE',
                kwargs={
                    'operation': 'send',
                    'source': 'slack',
                    'targetKind': 'channel',
                    'target': '#travel',
                    'message': 'Flight NYC → LAX dep 07:00 UTC, arr 11:00 UTC on 5/16.',
                },
            ),
        ],
        required_outputs=['sent'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Posts a flight summary to a Slack channel.',
    ),
    Scenario(
        id='travel.create_flight_event_with_attendees',
        name='Create flight event with attendees',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Add a calendar event titled 'Flight NYC → LAX' on 2026-05-16 07:00‑11:00 UTC on my primary calendar, and invite contacts 00001 and 00002.",
        ground_truth_actions=[
            Action(
                name='CALENDAR_CREATE_EVENT',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'flight event with attendees',
                    'title': 'Flight NYC → LAX',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-16T07:00:00Z',
                        'end': '2026-05-16T11:00:00Z',
                        'all_day': False,
                        'attendees': [
                            'contact_00001',
                            'contact_00002',
                        ],
                    },
                },
            ),
        ],
        required_outputs=['attendees'],
        first_question_fallback=FirstQuestionFallback(
            canned_answer='Invite contact_00001 and contact_00002.',
            applies_when='agent asks which contacts to invite',
        ),
        world_seed=2026,
        max_turns=7,
        description='Creates a calendar event and adds specific contacts as attendees.',
    ),
    # NOTE: travel.update_trip_window_dates was dropped — same LARP issue
    # as travel.update_flight_departure_time (title-only update on an event
    # that doesn't exist in medium_seed_2026).
    Scenario(
        id='travel.create_flight_event_with_location',
        name='Create flight event with location',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_DEV_FREELANCER,
        instruction="Add a calendar event titled 'Flight NYC → LAX' on my primary calendar for 2026-05-16 07:00‑11:00 UTC, and set the location to 'JFK Airport'.",
        ground_truth_actions=[
            Action(
                name='CALENDAR_CREATE_EVENT',
                kwargs={
                    'subaction': 'create_event',
                    'intent': 'flight event with location',
                    'title': 'Flight NYC → LAX',
                    'details': {
                        'calendarId': 'cal_primary',
                        'start': '2026-05-16T07:00:00Z',
                        'end': '2026-05-16T11:00:00Z',
                        'all_day': False,
                        'location': 'JFK Airport',
                    },
                },
            ),
        ],
        required_outputs=['JFK'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description='Creates a calendar event with a location field.',
    ),
    Scenario(
        id='travel.remind_to_check_baggage_allowance',
        name='Reminder to check baggage allowance',
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_TARA_NIGHT,
        instruction='Add a reminder to check my baggage allowance 48 hours before my flight on 2026-05-16, using my inbox reminder list.',
        ground_truth_actions=[
            Action(
                name='LIFE_CREATE',
                kwargs={
                    'subaction': 'create',
                    'kind': 'definition',
                    'title': 'Check baggage allowance',
                    'details': {
                        'kind': 'reminder',
                        'due': '2026-05-14T07:00:00Z',
                        'listId': 'list_inbox',
                    },
                },
            ),
        ],
        required_outputs=['baggage'],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description='Creates a reminder offset by two days before flight.',
    ),

]
