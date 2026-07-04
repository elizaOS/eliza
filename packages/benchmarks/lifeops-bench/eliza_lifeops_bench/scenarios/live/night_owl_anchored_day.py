"""Live night-owl anchored-day scenarios."""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_NOOR_NIGHT


def _live(
    scenario_id: str,
    name: str,
    domain: Domain,
    instruction: str,
    description: str,
    success_criteria: list[str],
    world_assertions: list[str],
    max_turns: int = 18,
    disruptions: list[Disruption] | None = None,
    expected_world_mutation: str = "auto",
) -> Scenario:
    return Scenario(
        id=scenario_id,
        name=name,
        domain=domain,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_NOOR_NIGHT,
        instruction=instruction,
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=max_turns,
        description=description,
        success_criteria=success_criteria,
        world_assertions=world_assertions,
        disruptions=disruptions or [],
        expected_world_mutation=expected_world_mutation,  # type: ignore[arg-type]
    )


LIVE_NIGHT_OWL_ANCHORED_DAY_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.nightowl.wake_confirmation_fires_brief",
        name="Wake confirmation immediately triggers the anchored morning brief",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_NOOR_NIGHT,
        instruction=(
            "hey. just woke up. what's on deck"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=16,
        description=(
            "The morning-brief definition was seeded earlier as wake_confirmation-"
            "anchored. This message IS the anchor event and must fire the brief "
            "content in this same turn, not defer it."
        ),
        success_criteria=[
            "Executor treats 'just woke up' as the wake-confirmation anchor event "
            "and returns the day's brief content in this turn.",
            "Executor does not ask what time it is or reference a wall-clock hour "
            "as the reason for firing.",
            "Executor does not scold or comment on the lateness of her wake time.",
        ],
        world_assertions=[
            "The wake-anchored morning-brief definition's last-fired marker advances "
            "to this turn's timestamp.",
        ],
        expected_world_mutation="changed",
    ),
    _live(
        "live.nightowl.observed_wake_drift_adaptation",
        "Observed wake drift updates anchor estimate",
        Domain.SLEEP,
        "i woke at 12:10 monday, 12:45 yesterday, 1:05 today. don't keep acting like i'm still 11:30.",
        "[T3] Wake-time observations drift across a simulated week; the anchor estimate should adapt.",
        [
            "Executor treats the reported wake times as observations that update the wake anchor.",
            "Executor does not keep using the stale 11:30 estimate without noting the shift.",
            "Executor avoids judgment about the later wake times.",
        ],
        [
            "Observed wake baseline moves later or records a new baseline candidate.",
        ],
        expected_world_mutation="changed",
    ),
    _live(
        "live.nightowl.disruption_does_not_interrupt_anchor_capture",
        "Disruption is parked while anchored routine capture finishes",
        Domain.REMINDERS,
        "set up vitamins after wake and a brief after wake. if anything else comes in, park it until this is done.",
        "[T3] A new-message disruption arrives mid-capture; the agent must finish the anchor routine first.",
        [
            "Executor completes or clearly previews the wake-anchored routine capture before handling the interruption.",
            "Executor parks the disruption instead of losing it.",
            "Executor keeps both vitamins and brief anchor-relative, not fixed-time.",
        ],
        [
            "The anchored routine definitions are not dropped when the new message arrives.",
        ],
        disruptions=[
            Disruption(
                at_turn=2,
                kind="new_message",
                payload={
                    "message_id": "chat_noor_disrupt_001",
                    "thread_id": "conv_0003",
                    "from_email": "team@example.test",
                    "subject": "Build question",
                    "body": "Can you check the build when you have a second?",
                },
                note_for_user="A team message arrived while you're setting up the routine.",
            ),
        ],
        expected_world_mutation="changed",
    ),
    _live(
        "live.nightowl.end_of_her_evening_nudge",
        "End-of-evening nudge follows Noor's day boundary",
        Domain.REMINDERS,
        "if i haven't stretched by my evening, nudge me. my evening is before sleep, not midnight.",
        "[T2] End-of-evening is relative to Noor's wake/sleep cycle, not calendar midnight.",
        [
            "Executor asks for or uses Noor's evening/sleep anchor rather than midnight.",
            "Executor creates or previews a flexible nudge before her sleep window.",
            "Executor does not describe 5pm as the default evening without evidence.",
        ],
        [
            "The stretch nudge is anchored to Noor's evening/pre-sleep window.",
        ],
        expected_world_mutation="changed",
    ),
    _live(
        "live.nightowl.contradiction_reconciles_anchor",
        "Earlier sleep this week updates rather than duplicates anchor",
        Domain.SLEEP,
        "actually i've been sleeping earlier this week, don't assume 11:30 anymore. update that, don't layer another rule.",
        "[T2] Contradiction reconciliation: update the anchor baseline instead of creating conflicting rules.",
        [
            "Executor treats the new sleep timing as an update to prior assumptions.",
            "Executor avoids layering a second conflicting quiet-hours rule.",
            "Executor confirms the updated anchor in Noor's dry, practical register.",
        ],
        [
            "Only one active wake/sleep anchor policy remains after the update.",
        ],
        expected_world_mutation="changed",
    ),
    _live(
        "live.nightowl.reject_wall_clock_repair",
        "Wall-clock proposal rejection is repaired to anchor-relative",
        Domain.REMINDERS,
        "you suggested 9am for the build check. no. after i'm up. fix it.",
        "[T4] Rejection trap: a mistaken wall-clock proposal must be repaired to anchor-relative semantics.",
        [
            "Executor acknowledges the correction without defensiveness.",
            "Executor changes the final definition to after-wake anchor semantics.",
            "Executor does not preserve the 9am wall-clock time.",
        ],
        [
            "The final build-check definition is anchor-relative and contains no 9am due time.",
        ],
        expected_world_mutation="changed",
    ),
]
