"""Live travel scenarios."""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_NORA_CONSULTANT, PERSONA_SAM_FOUNDER

LIVE_TRAVEL_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.travel.plan_nyc_trip_end_to_end",
        name="Plan a 3-day NYC trip end-to-end",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_NORA_CONSULTANT,
        instruction=(
            "I have a client meeting in New York on 2026-05-15 at 2pm "
            "EDT. Plan the trip: search flights from SFO, propose hotel "
            "options near midtown, block my work calendar for the trip "
            "window, and remind me to leave for the airport. I'll "
            "approve each step before you commit anything."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Multi-step orchestration across travel, calendar, reminders. "
            "Persona is formal and demands per-step approval."
        ),
        success_criteria=[
            "Executor proposes flight options BEFORE creating any calendar block.",
            "Executor proposes hotel options or explicitly defers them.",
            "Executor either creates the calendar OOO block + airport-leave reminder after persona approval, OR has the explicit approval lines in the transcript.",
        ],
        world_assertions=[
            "If executed: a new calendar_event on cal_work covering 2026-05-15 to 2026-05-18 (OOO or trip block).",
            "If executed: a new reminder for the airport transfer on 2026-05-15 morning.",
        ],
    ),
    Scenario(
        id="live.travel.flight_cancelled_replan",
        name="Replan after flight cancellation",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_SAM_FOUNDER,
        instruction=(
            "Just landed at SFO and my connection got cancelled. Help me "
            "rebook to JFK for tomorrow morning, push back tomorrow's "
            "9am roadmap sync to Wednesday, and let my partner know I "
            "won't be home tonight."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "Crisis-mode three-domain composition: travel + calendar + "
            "messages. Disruption fires mid-flow with a new SOS."
        ),
        success_criteria=[
            "Executor proposes a replacement flight option for tomorrow morning.",
            "Executor moves or proposes moving the 9am roadmap sync.",
            "Executor sends or drafts a message to the partner.",
            "Executor does not silently move the roadmap sync without surfacing the new time.",
        ],
        world_assertions=[
            "If executed: the morning 9am event on 2026-05-11 is moved to a 2026-05-13 slot OR cancelled.",
            "If executed: a new chat_message in the partner conversation referencing the disruption.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="rule_change",
                payload={},
                note_for_user=(
                    "[Update: the airline just texted that the only "
                    "alternative tomorrow morning is the 6:45am — anything "
                    "later is fully booked. Tell the agent to factor this in.]"
                ),
            ),
        ],
    ),
]
