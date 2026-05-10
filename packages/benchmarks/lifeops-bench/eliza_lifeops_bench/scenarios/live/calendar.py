"""Live calendar scenarios.

LIVE mode complements Wave 2A's STATIC calendar suite: the persona reveals
constraints turn-by-turn, the executor proposes options, the persona accepts
or refines, and the judge scores satisfaction in spirit. No scripted ground
truth — these tests judgment, not exact verbs.
"""

from __future__ import annotations

from ...types import Domain, Scenario, ScenarioMode
from .._personas import PERSONA_RIA_PM, PERSONA_SAM_FOUNDER

LIVE_CALENDAR_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.calendar.find_focus_block_tomorrow",
        name="Find me a 1-hour focus block tomorrow",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_RIA_PM,
        instruction=(
            "I have three meetings on my work calendar tomorrow. Find me a "
            "1-hour focus block somewhere in the day, ideally before lunch, "
            "and put it on my work calendar. I'll reveal constraints "
            "(no early mornings, lunch is at 12:30) only if asked or after "
            "the first proposal."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Open-ended slot-finding. Persona pushes back if the agent picks "
            "before 9am or right at lunch."
        ),
        success_criteria=[
            "Executor proposes at least one concrete 1-hour window on 2026-05-11.",
            "Executor either creates the focus event on cal_work after persona accepts, OR explicitly confirms the slot for the persona to add manually.",
            "The accepted slot is between 09:00 and 12:30 local time (no early mornings, no lunch overlap).",
        ],
        world_assertions=[
            "If executor created the event: a new calendar_event on cal_work for 2026-05-11 between 09:00 and 12:30 with title containing 'focus' or 'deep work'.",
        ],
    ),
    Scenario(
        id="live.calendar.reschedule_around_new_meeting",
        name="Reschedule something to make room for a new ask",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "A vendor wants to meet me Thursday at 2pm UTC for an hour. My "
            "calendar already has something there — figure out what's "
            "movable, propose a swap, and lock it in. I'll only mention I "
            "care about my standing roadmap sync if the agent asks what's "
            "non-negotiable."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Conflict resolution. Persona reveals the 'roadmap sync is "
            "sacred' constraint mid-conversation."
        ),
        success_criteria=[
            "Executor identifies the conflicting event(s) at Thursday 14:00 UTC.",
            "Executor proposes a specific resolution (move existing event OR decline vendor) before mutating anything.",
            "Executor does NOT silently overwrite the standing roadmap sync.",
        ],
        world_assertions=[
            "Either: a new calendar_event for the vendor meeting on 2026-05-14 14:00-15:00 UTC AND any moved event has new bounds the persona accepted; OR: no calendar mutation if the persona declined.",
        ],
    ),
]
