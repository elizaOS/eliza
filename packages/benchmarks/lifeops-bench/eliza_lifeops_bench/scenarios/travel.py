"""Travel-domain scenarios.

Covers flight search (BOOK_TRAVEL stub), trip-window calendar holds,
out-of-office blocks, and itinerary sharing. Booking flows are
approval-gated by design — every booking action emits an offer that the
user must explicitly approve before it lands.
"""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import (
    PERSONA_LIN_OPS,
    PERSONA_NORA_CONSULTANT,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
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
    ),
]
