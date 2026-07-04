"""Frequent-traveler timezone semantics scenarios."""

from __future__ import annotations

from dataclasses import replace

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_ELENA_ROAD


def _reminder_action(title: str, details: dict[str, object]) -> Action:
    return Action(
        name="LIFE_CREATE",
        kwargs={
            "subaction": "create",
            "kind": "definition",
            "title": title,
            "details": {"kind": "reminder", "listId": "list_personal", **details},
        },
    )


TRAVELER_TIMEZONE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="traveler.explicit_absolute_instant_call_reminder",
        name="Fixed instant call reminder survives timezone changes",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I have a board call at 16:00 UTC next Tuesday. Wake me for that call "
            "no matter what timezone I land in."
        ),
        ground_truth_actions=[
            _reminder_action(
                "Board call",
                {"due": "2026-05-12T16:00:00Z", "timezoneSemantic": "absolute_instant"},
            ),
        ],
        required_outputs=["UTC", "board"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=5,
        description=(
            "[T1] Absolute-instant reminder. The due time is the UTC instant, not a "
            "local wall-clock 16:00 that follows the traveler."
        ),
    ),
    Scenario(
        id="traveler.local_wall_clock_wake_reminder",
        name="Local wall-clock wake reminder follows current city",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "For this trip, wake me at 7am wherever I am. I do not want it firing "
            "at the old city's 7am."
        ),
        ground_truth_actions=[
            _reminder_action(
                "Wake up",
                {
                    "cadence": "daily",
                    "timeOfDay": "07:00",
                    "timezoneSemantic": "local_wall_clock",
                    "anchor": "current_travel_timezone",
                },
            ),
        ],
        required_outputs=["7", "wherever"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, local 7am in whatever city I am in that morning.",
            applies_when="agent asks whether 7am should follow the current local timezone",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T1] Local-wall-clock reminder. It must not collapse to one fixed UTC "
            "instant because the user explicitly wants it to follow location."
        ),
    ),
    Scenario(
        id="traveler.ambiguous_9am_tuesday_no_zone",
        name="Ambiguous '9am Tuesday' reminder must clarify timezone before creating",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Remind me 9am Tuesday to call the Seoul office before their day ends."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "kind": "definition",
                    "title": "Call the Seoul office",
                    "details": {
                        "kind": "reminder",
                        "due": "2026-05-12T09:00:00+09:00",
                        "listId": "list_personal",
                    },
                },
            ),
        ],
        required_outputs=["seoul", "tuesday"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "I'll be in Seoul myself by then, so just use Seoul time (KST) for "
                "the 9am."
            ),
            applies_when=(
                "agent asks which timezone '9am Tuesday' refers to before creating "
                "the reminder"
            ),
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Genuinely ambiguous instant: no timezone stated and the persona is "
            "known to travel. Scoring requires the agent to ask (or use the "
            "first-question fallback) rather than silently assume home timezone, "
            "device timezone, or destination timezone."
        ),
    ),
    Scenario(
        id="traveler.reanchor_on_travel_owner_fact",
        name="Capture Singapore stay as timezone owner fact, not a task",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I land in Singapore Thursday and I'll be there through the 22nd, so "
            "anything that says morning should mean Singapore morning for that stretch."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "name": "Elena Vasquez",
                    "notes": (
                        "Owner timezone fact: Singapore from 2026-05-14 through "
                        "2026-05-22; morning anchors should resolve to Singapore local time."
                    ),
                    "storeAllowed": True,
                },
            ),
        ],
        required_outputs=["Singapore", "22"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer="Yes, save it as travel context. Do not make a reminder.",
            applies_when="agent asks whether to save this as context or create a reminder",
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Re-anchor-on-owner-fact capture. The user supplies future travel "
            "context; creating a reminder would be the wrong behavior."
        ),
    ),
    Scenario(
        id="traveler.pretrip_lighter_task_load",
        name="Pre-trip lighter load preference is a policy",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "The week before Tokyo, go easy on me. Fewer deep-work blocks and no "
            "admin pileups the night before I fly."
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "name": "Elena Vasquez",
                    "notes": (
                        "Travel scheduling preference: lighten task load during the "
                        "week before Tokyo; avoid deep-work overload and "
                        "night-before-flight admin."
                    ),
                    "storeAllowed": True,
                },
            ),
        ],
        required_outputs=["Tokyo", "easy"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T3] Captures a recurring travel-load preference rather than a one-off "
            "task. The structural record should survive future trip planning."
        ),
    ),
    Scenario(
        id="traveler.flag_meeting_in_biological_night",
        name="Flag meeting that lands in biological night",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Put a prep call on Tuesday at 6pm Singapore time with the Seoul team. "
            "My home clock is still San Francisco this week."
        ),
        ground_truth_actions=[
            Action(
                name="CALENDAR",
                kwargs={
                    "subaction": "create_event",
                    "title": "Prep call with Seoul team",
                    "details": {
                        "start": "2026-05-12T18:00:00+08:00",
                        "end": "2026-05-12T18:30:00+08:00",
                        "timeZone": "Asia/Singapore",
                        "calendarId": "cal_work",
                        "description": "Flag: 03:00 San Francisco body-time check required.",
                    },
                },
            ),
        ],
        required_outputs=["Singapore", "3am"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T4] Calendar creation with an unprompted biological-night sanity flag "
            "once the stated meeting zone is compared with the home clock."
        ),
    ),
    Scenario(
        id="traveler.messy_multiday_itinerary_capture",
        name="Capture a messy SFO-NRT-SIN-SFO itinerary",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Travel dump: SFO to Narita around May 13, Tokyo two nights, then "
            "Singapore the 16th through 22nd, then back to SFO. Can you hold that as "
            "the trip window so reminders stop being dumb?"
        ),
        ground_truth_actions=[
            Action(
                name="BOOK_TRAVEL",
                kwargs={
                    "origin": "SFO",
                    "destination": "NRT",
                    "departureDate": "2026-05-13",
                    "returnDate": "2026-05-22",
                    "passengers": 1,
                    "intent": "capture multi-city itinerary SFO-NRT-SIN-SFO",
                    "calendarSync": True,
                },
            ),
        ],
        required_outputs=["SFO", "Singapore"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "Yes, just capture the trip window for now: SFO to Tokyo, then "
                "Singapore, then home to SFO on the 22nd."
            ),
            applies_when="agent asks whether to book travel or just capture the itinerary",
        ),
        world_seed=2026,
        max_turns=7,
        description=(
            "[T1] Messy itinerary capture. The key is preserving city/date windows "
            "for later timezone behavior, not buying a ticket."
        ),
    ),
    Scenario(
        id="traveler.timezone_history_log",
        name="Record and recall timezone history for the month",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Can you log that this month I was Pacific time through the 10th, Tokyo "
            "the 13th to 15th, Singapore the 16th to 22nd, then Pacific again?"
        ),
        ground_truth_actions=[
            Action(
                name="ENTITY",
                kwargs={
                    "subaction": "log_interaction",
                    "name": "Elena Vasquez",
                    "notes": (
                        "Timezone history May 2026: America/Los_Angeles through 10; "
                        "Asia/Tokyo May 13-15; Asia/Singapore May 16-22; "
                        "America/Los_Angeles after return."
                    ),
                    "storeAllowed": True,
                },
            ),
        ],
        required_outputs=["Pacific", "Tokyo", "Singapore"],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=6,
        description=(
            "[T2] Timezone-history owner fact capture for later recall and "
            "schedule interpretation."
        ),
    ),
]

_TIER_BY_ID = {
    "traveler.ambiguous_9am_tuesday_no_zone": "T2",
}

# Tier tags are applied after construction so the verbatim exemplar block stays intact.
TRAVELER_TIMEZONE_SCENARIOS = [
    replace(
        scenario,
        description=f"[{_TIER_BY_ID[scenario.id]}] {scenario.description}",
    )
    if scenario.id in _TIER_BY_ID
    else scenario
    for scenario in TRAVELER_TIMEZONE_SCENARIOS
]
