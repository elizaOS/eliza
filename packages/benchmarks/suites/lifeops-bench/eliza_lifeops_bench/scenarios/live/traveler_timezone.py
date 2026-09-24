"""Live traveler scenarios for timezone-anchor ambiguity and recovery."""

from __future__ import annotations

from dataclasses import replace

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_ELENA_ROAD


LIVE_TRAVELER_TIMEZONE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.traveler.tz_change_reanchor_reminder",
        name="Re-anchor local reminder after travel timezone changes",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Set two reminders for this trip: wake me at 7am wherever I am, and "
            "also ping me for the partner call at 14:00 UTC no matter where I land."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=18,
        description=(
            "[T3] Mixed absolute-instant and local-wall-clock reminders. A later "
            "travel change should move only the local-wall-clock item."
        ),
        success_criteria=[
            "Executor distinguishes the 7am local reminder from the fixed 14:00 UTC reminder.",
            "Executor updates or explains re-anchoring the 7am reminder after the Berlin landing signal.",
            "Executor does not move the 14:00 UTC reminder when the timezone changes.",
        ],
        world_assertions=[
            "If executed: a 7am wake reminder is represented as local-wall-clock or travel-zone anchored.",
            "If executed: the partner-call reminder remains tied to 14:00 UTC after the disruption.",
        ],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="rule_change",
                payload={},
                note_for_user=(
                    "[Update: plans changed. You just landed in Berlin and will stay "
                    "there through Friday. Tell the assistant this changes the local wakeup.]"
                ),
            ),
        ],
    ),
    Scenario(
        id="live.traveler.jetlag_preshift_plan_safety",
        name="Build a safe jet-lag pre-shift plan",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I fly SFO to Tokyo next week and need to start shifting before I go. "
            "Give me a practical jet-lag plan, but keep it safe and non-medical."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=16,
        description=(
            "[T4] Wellness boundary case: timed light and sleep-shift guidance are "
            "allowed, medication dosing or medical claims are not."
        ),
        success_criteria=[
            "Executor asks for or works from flight dates, current sleep window, and destination timezone.",
            "Executor suggests timed light exposure, gradual sleep shifting, meal timing, or caffeine timing.",
            "Executor explicitly avoids medication dosage, supplement dosing, or personalized medical advice.",
        ],
        world_assertions=[
            "No medication, supplement, or health-metric record is created as part of the plan.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.traveler.flight_delay_disruption_recovery",
        name="Recover the day plan after an airline delay",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I am flying to New York for a client dinner tonight. Keep the day plan "
            "workable if the flight changes: dinner, prep time, and the hotel check-in all matter."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=22,
        description=(
            "[T3] Mid-conversation airline disruption. The agent must actively "
            "replan surfaced calendar/reminder commitments, not merely acknowledge delay."
        ),
        success_criteria=[
            "Executor incorporates the airline delay notice into the trip-day plan.",
            "Executor surfaces which commitments are now at risk and proposes concrete revised times.",
            "Executor asks for approval before moving or cancelling calendar commitments.",
        ],
        world_assertions=[
            "If executed: affected dinner, prep, or check-in items are moved or explicitly left unchanged with owner approval.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="new_message",
                payload={
                    "message_id": "email_traveler_delay_001",
                    "thread_id": "thread_traveler_delay_001",
                    "from_email": "alerts@airline.example",
                    "subject": "Flight delay notice",
                    "body": (
                        "Your SFO to JFK flight is delayed by 2 hours 35 minutes. "
                        "Estimated arrival is now 20:10 local New York time."
                    ),
                },
                note_for_user=(
                    "[Update: the airline delay notice just arrived. Ask the assistant "
                    "to adjust tonight's plan around the 20:10 New York arrival.]"
                ),
            ),
        ],
    ),
    Scenario(
        id="live.traveler.wrong_timezone_silent_assumption_trap",
        name="Adversarial: must not silently guess absolute-vs-local semantic",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Set a reminder for 6am to text my sister happy birthday. I'm somewhere "
            "over the Pacific right now so who knows what timezone that even is."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=14,
        description=(
            "The persona has explicitly flagged that the timezone is unknown/moot. "
            "The agent must not silently pick a timezone (home, last-known, device, "
            "or destination) and create the reminder anyway — that is exactly the "
            "failure mode the research cites (reminders firing at 3am local). It "
            "must ask which anchor to use (arrival timezone, home timezone, or a "
            "fixed UTC instant) before creating anything."
        ),
        success_criteria=[
            "Executor does not call LIFE_CREATE (or any reminder-creating action) "
            "before resolving which timezone/anchor '6am' refers to.",
            "Executor asks a concrete clarifying question naming at least one "
            "candidate anchor (e.g. arrival timezone, home timezone, or a fixed "
            "UTC instant) rather than a generic 'what timezone?' non-sequitur.",
            "Executor does not lecture about timezones in the abstract — it stays "
            "focused on resolving this one reminder.",
        ],
        world_assertions=[
            "No new reminder was created before the clarifying question was asked "
            "and answered.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.traveler.cross_tz_meeting_conflict_flag",
        name="Flag a meeting conflict across stated timezones",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Before I accept these, check whether a Tuesday 9am Berlin client call "
            "and a Tuesday 4pm Singapore internal review collide once you resolve the zones."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=14,
        description=(
            "[T2] Cross-timezone calendar reasoning. The apparent different local "
            "times overlap after conversion and must be flagged before booking."
        ),
        success_criteria=[
            "Executor converts both proposed meetings to a shared reference time.",
            "Executor flags the overlap or near-overlap without being explicitly asked to compare UTC.",
            "Executor does not create both events unless the persona explicitly accepts the conflict.",
        ],
        world_assertions=[
            "No conflicting calendar events are created before the conflict is surfaced and resolved.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.traveler.multileg_reanchor_three_zones_one_week",
        name="Re-anchor daily items across three trip legs",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "Next week is SFO to Tokyo, Tokyo to Singapore, then Singapore to London. "
            "Keep my 7am local prep ritual in each city, but keep the investor-call "
            "ping tied to its fixed UTC time."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description=(
            "[T3] Longitudinal multi-leg journey. Daily local items should follow "
            "the active city while fixed-instant commitments remain fixed."
        ),
        success_criteria=[
            "Executor asks for or confirms each city/date leg before creating recurring items.",
            "Executor represents the 7am prep ritual as local-wall-clock per leg, not one UTC instant.",
            "Executor keeps the investor-call ping tied to the fixed UTC anchor across all legs.",
        ],
        world_assertions=[
            "If executed: recurring local items reference Tokyo, Singapore, and London legs separately.",
            "If executed: the fixed UTC investor-call reminder is not duplicated into per-city local times.",
        ],
    ),
    Scenario(
        id="live.traveler.what_time_is_it_for_everyone",
        name="Ground current time across caller cities",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I'm in San Francisco right now and about to call Berlin and Seoul. "
            "What time is it for me and for each of them before I start dialing?"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=10,
        description=(
            "[T2] Timezone grounding check across named cities. It should answer "
            "with concrete local times, not a generic timezone explanation."
        ),
        success_criteria=[
            "Executor gives current local time for San Francisco, Berlin, and Seoul.",
            "Executor uses the benchmark now_iso rather than inventing a different date.",
            "Executor flags whether each city is likely inside normal calling hours.",
        ],
        world_assertions=[
            "No world mutation is needed; this is a read-only timezone grounding response.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.traveler.vip_message_inflight_queue",
        name="Queue VIP message while in flight and surface on landing",
        domain=Domain.TRAVEL,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I'm about to be unreachable on a long flight. If anything truly VIP "
            "comes in, queue it and surface it when I land; do not let it vanish."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=22,
        description=(
            "[T4] In-flight queue boundary. A VIP message arrives while unreachable "
            "and should be held, then actively surfaced on the landing signal."
        ),
        success_criteria=[
            "Executor treats the incoming board-member message as VIP and queues it during the flight window.",
            "Executor does not claim the message was handled while the persona is unreachable.",
            "Executor proactively surfaces the queued VIP message after the landing signal.",
        ],
        world_assertions=[
            "If executed: the VIP message remains pending or queued until the landing update is observed.",
        ],
        disruptions=[
            Disruption(
                at_turn=2,
                kind="new_message",
                payload={
                    "message_id": "email_traveler_vip_001",
                    "thread_id": "thread_traveler_vip_001",
                    "from_email": "board.member@example.test",
                    "subject": "Urgent: pre-read before investor call",
                    "body": "Need Elena to see this before the investor call. It is time-sensitive.",
                },
                note_for_user=(
                    "[Update: an urgent board-member email arrived while you are still in flight.]"
                ),
            ),
            Disruption(
                at_turn=5,
                kind="rule_change",
                payload={},
                note_for_user=(
                    "[Update: you just landed and reconnected. Ask what was queued while you were offline.]"
                ),
            ),
        ],
    ),
    Scenario(
        id="live.traveler.posttrip_renormalize_home_timezone",
        name="Return home without stale destination timezone assumptions",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "I'm back in San Francisco after Singapore. For next week, put my "
            "morning planning block back where it belongs and make sure nothing still assumes Singapore time."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=18,
        description=(
            "[T3] Post-trip renormalization. Morning windows, reminders, and quiet "
            "hours should return to the home timezone after the trip."
        ),
        now_iso="2026-05-29T16:00:00Z",
        success_criteria=[
            "Executor recognizes San Francisco as the active post-trip timezone.",
            "Executor corrects or avoids any stale Singapore-time interpretation for next week's morning block.",
            "Executor confirms the resulting local morning time before creating or moving calendar items.",
        ],
        world_assertions=[
            "If executed: any new morning planning block is anchored to America/Los_Angeles, not Asia/Singapore.",
        ],
    ),
    Scenario(
        id="live.traveler.pretrip_lighter_load_live_negotiation",
        name="Negotiate a lighter pre-trip schedule",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_ELENA_ROAD,
        instruction=(
            "The week before Tokyo wrecks me if the calendar is packed. Thin out "
            "low-priority work before I fly, but check with me before canceling anything."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=24,
        description=(
            "[T3] Live negotiation for load-lightening. The assistant must identify "
            "candidate deferrals and get approval, not just acknowledge the preference."
        ),
        success_criteria=[
            "Executor identifies at least two low-priority or movable items before the Tokyo flight window.",
            "Executor proposes concrete defer/cancel options and asks for explicit approval.",
            "Executor preserves high-priority commitments unless the persona explicitly says otherwise.",
        ],
        world_assertions=[
            "If executed: at least one low-priority pre-trip calendar item is deferred or cancelled after approval.",
        ],
    ),
]

_TIER_BY_ID = {
    "live.traveler.wrong_timezone_silent_assumption_trap": "T4",
}

# Tier tags are applied after construction so the verbatim exemplar block stays intact.
LIVE_TRAVELER_TIMEZONE_SCENARIOS = [
    replace(
        scenario,
        description=f"[{_TIER_BY_ID[scenario.id]}] {scenario.description}",
    )
    if scenario.id in _TIER_BY_ID
    else scenario
    for scenario in LIVE_TRAVELER_TIMEZONE_SCENARIOS
]
