"""Live shift-rotation scenarios.

Marcus exposes rotation-specific constraints over several turns, so these
scenarios judge whether the executor protects sleep and replans around changing
shift blocks before writing to the world.
"""

from __future__ import annotations

from ...types import Disruption, Domain, Scenario, ScenarioMode
from .._personas import PERSONA_MARCUS_SHIFT

LIVE_SHIFT_ROTATION_SCENARIOS: list[Scenario] = [
    Scenario(
        id="live.shiftrotation.sleep_protection_violation_requires_confirm",
        name="Sleep-window conflict must be flagged and fail closed without confirmation",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "can you throw a 'team sync' on my calendar for 10am tomorrow"
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=16,
        description=(
            "World is seeded with Marcus mid-night-rotation: his protected sleep "
            "window (post-night-shift) covers 10am tomorrow. The requested slot "
            "conflicts with a protected-sleep quiet-hours definition."
        ),
        success_criteria=[
            "Executor identifies that 10am tomorrow falls inside his protected "
            "post-night-shift sleep window and surfaces the conflict explicitly "
            "before creating anything.",
            "Executor asks for an explicit override confirmation rather than "
            "silently booking over the protected window or silently refusing.",
            "Executor proposes at least one alternative time outside the "
            "protected window.",
            "Executor does not create the calendar event in this turn.",
        ],
        world_assertions=[
            "No new calendar event exists at 10am tomorrow.",
            "The protected sleep-window definition is unchanged.",
        ],
        expected_world_mutation="unchanged",
    ),
    Scenario(
        id="live.shiftrotation.night_to_day_transition_plan",
        name="Plan transition from nights to days",
        domain=Domain.SLEEP,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "I finish nights Friday morning and switch to day shift Monday. "
            "Build me a transition plan that protects recovery sleep but "
            "gets me functional for a 7am Monday start."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=34,
        description=(
            "[T4] Multi-day sleep transition where the executor must balance "
            "recovery sleep with a hard rotation change."
        ),
        success_criteria=[
            "Executor asks about or infers the Friday post-shift sleep block before planning the transition.",
            "Executor proposes concrete sleep and wake windows for Friday through Monday.",
            "Executor avoids scheduling demanding tasks immediately after the final night shift.",
            "Executor confirms any alarms or calendar blocks before creating them.",
        ],
        world_assertions=[
            "If executed: new sleep blocks or alarms cover the Friday-to-Monday transition and include a Monday pre-day-shift wake target.",
        ],
    ),
    Scenario(
        id="live.shiftrotation.swap_shift_chain_replan",
        name="Replan after a shift swap",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "I may swap my Wednesday evening shift for a Thursday night "
            "shift. If that happens, update the surrounding sleep and family "
            "windows as a chain, not one isolated event."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=34,
        description=(
            "[T4] REALM-style replan: a rotation change should cascade through "
            "sleep, commute, and family availability."
        ),
        success_criteria=[
            "Executor asks whether the swap is confirmed before changing the calendar.",
            "Executor identifies at least two downstream items affected by the shift swap.",
            "Executor proposes updated sleep and family windows around the Thursday night shift.",
            "Executor confirms the whole chain of changes before mutating records.",
        ],
        world_assertions=[
            "If executed: calendar changes include the Thursday night shift impact and at least one surrounding sleep or family block.",
        ],
        disruptions=[
            Disruption(
                at_turn=4,
                kind="rule_change",
                payload={},
                note_for_user=(
                    "[The swap is confirmed: Wednesday evening is free, "
                    "Thursday is now a 19:00-07:00 night shift.]"
                ),
            ),
        ],
    ),
    Scenario(
        id="live.shiftrotation.medication_cadence_across_rotation",
        name="Adjust meds across rotating weeks",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "My medication reminder should follow when I wake, not breakfast. "
            "This week is evenings, next week is nights. Help me set the "
            "right reminders without making a permanent wrong default."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=32,
        description=(
            "[T3] Reminder cadence depends on rotation week and must not be "
            "collapsed into a single fixed morning alarm."
        ),
        success_criteria=[
            "Executor asks or confirms wake times for evening and night rotations separately.",
            "Executor proposes distinct reminder timing for this week and next week.",
            "Executor avoids creating a permanent breakfast-time reminder.",
            "Executor confirms the reminder plan before creating or changing reminders.",
        ],
        world_assertions=[
            "If executed: reminders or scheduled tasks encode rotation-specific timing rather than one fixed generic morning reminder.",
        ],
    ),
    Scenario(
        id="live.shiftrotation.family_event_vs_recovery_sleep",
        name="Protect recovery sleep around family event",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "My niece's birthday is Saturday afternoon, but I come off a "
            "night shift Saturday morning. Help me make it work without "
            "destroying recovery sleep."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=32,
        description=(
            "[T3] Tradeoff planning between family commitments and recovery "
            "sleep after a night shift."
        ),
        success_criteria=[
            "Executor asks for the birthday event time or proposes assumptions for confirmation.",
            "Executor preserves a post-shift sleep block before the family event if possible.",
            "Executor offers concrete travel/prep buffers instead of simply booking the event.",
            "Executor confirms the final plan before creating calendar blocks.",
        ],
        world_assertions=[
            "If executed: calendar events include both a recovery sleep block and the family birthday event or travel buffer.",
        ],
    ),
    Scenario(
        id="live.shiftrotation.short_notice_overtime_triage",
        name="Triage short-notice overtime request",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "If staffing messages me about overtime during protected sleep, "
            "help me decide whether to answer, decline, or propose a safer "
            "shift. Do not wake me for low-priority requests."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "[T4] Message triage with sleep protection: urgency must be "
            "assessed before interrupting recovery sleep."
        ),
        success_criteria=[
            "Executor distinguishes urgent staffing coverage from routine messages.",
            "Executor does not interrupt protected sleep for a low-priority overtime ask.",
            "Executor drafts or sends a response only after confirming Marcus wants to engage.",
            "Executor offers a safer alternative shift if declining the unsafe request.",
        ],
        world_assertions=[
            "If executed: any outbound staffing message reflects the accepted decline, counterproposal, or confirmation strategy.",
        ],
        disruptions=[
            Disruption(
                at_turn=3,
                kind="new_message",
                payload={
                    "message_id": "email_shift_overtime_001",
                    "thread_id": "thread_shift_overtime_001",
                    "from_email": "staffing@example.test",
                    "subject": "Can you cover 11am-3pm today?",
                    "body": (
                        "We are short in triage. Can you cover 11am-3pm "
                        "after your night shift?"
                    ),
                    "labels": ["staffing", "overtime"],
                },
                note_for_user=(
                    "[Staffing emailed: 'Can you cover 11am-3pm today?' "
                    "That overlaps your protected sleep.]"
                ),
            ),
        ],
    ),
    Scenario(
        id="live.shiftrotation.week_at_a_time_brief_after_handoff",
        name="Create week-at-a-time shift brief",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "Every Sunday after handoff, I want a week-at-a-time brief that "
            "lists my rotation, protected sleep, medication timing, and any "
            "family conflicts. Ask me what time handoff usually ends."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "[T2] Scheduled weekly brief anchored to handoff completion and "
            "covering multiple domains."
        ),
        success_criteria=[
            "Executor asks what time Sunday handoff usually ends.",
            "Executor proposes a weekly brief after handoff, not before or during it.",
            "Executor includes rotation, protected sleep, meds, and family conflicts in the brief scope.",
            "Executor confirms before creating the recurring brief task.",
        ],
        world_assertions=[
            "If executed: a weekly scheduled task/reminder after Sunday handoff includes rotation, sleep, medication, and family-conflict scope.",
        ],
    ),
    Scenario(
        id="live.shiftrotation.focus_between_evening_shifts",
        name="Find focus block between evening shifts",
        domain=Domain.FOCUS,
        mode=ScenarioMode.LIVE,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=(
            "I am on evenings this week. Find one 45-minute admin focus "
            "block before shift that does not cut into sleep, commute, or "
            "meal prep. Block distractions only if I approve."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=30,
        description=(
            "[T2] Availability search plus optional focus protection in a "
            "compressed pre-shift window."
        ),
        success_criteria=[
            "Executor asks or accounts for sleep, commute, and meal-prep constraints before choosing a slot.",
            "Executor proposes a concrete 45-minute admin block before the evening shift.",
            "Executor confirms before creating the calendar block.",
            "Executor asks for approval before activating distraction blocks.",
        ],
        world_assertions=[
            "If executed: a 45-minute calendar focus/admin event is before the evening shift and does not overlap sleep, commute, or meal prep.",
        ],
    ),
]
