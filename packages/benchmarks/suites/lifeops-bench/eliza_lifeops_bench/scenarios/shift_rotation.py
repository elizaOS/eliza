"""Rotating-shift nurse scheduling scenarios."""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_MARCUS_SHIFT


def _life(title: str, details: dict[str, object]) -> Action:
    return Action(
        name="LIFE_CREATE",
        kwargs={
            "subaction": "create",
            "kind": "definition",
            "title": title,
            "details": {"kind": "reminder", "listId": "list_personal", **details},
        },
    )


def _scenario(
    scenario_id: str,
    name: str,
    domain: Domain,
    instruction: str,
    actions: list[Action],
    outputs: list[str],
    fallback: FirstQuestionFallback | None,
    description: str,
    max_turns: int = 6,
) -> Scenario:
    return Scenario(
        id=scenario_id,
        name=name,
        domain=domain,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_MARCUS_SHIFT,
        instruction=instruction,
        ground_truth_actions=actions,
        required_outputs=outputs,
        first_question_fallback=fallback,
        world_seed=2026,
        max_turns=max_turns,
        description=description,
    )


SHIFT_ROTATION_SCENARIOS: list[Scenario] = [
    _scenario(
        "shiftrotation.capture_nights_starting_monday",
        "Capture night shift pattern starting Monday",
        Domain.CALENDAR,
        "I'm on nights starting Monday. Move planning assumptions to that week.",
        [
            Action(
                name="CALENDAR",
                kwargs={
                    "action": "update_preferences",
                    "intent": "night shift starting Monday",
                    "timeZone": "America/New_York",
                    "blackoutWindows": [{"anchor": "post_night_shift_sleep"}],
                },
            ),
        ],
        ["nights", "Monday"],
        FirstQuestionFallback(
            canned_answer="Yes, nights all week starting Monday, assume 7p-7a.",
            applies_when="agent asks what the night shift hours are",
        ),
        "[T1] Shift-pattern capture from a plain statement.",
    ),
    _scenario(
        "shiftrotation.protect_post_shift_sleep_window",
        "Protect post-shift sleep window",
        Domain.SLEEP,
        "After nights, protect 8am to 2pm as sleep. No pings, no meetings unless I override.",
        [
            _life(
                "Protected post-night-shift sleep",
                {
                    "policy": "quiet_hours",
                    "anchor": "post_night_shift",
                    "startLocal": "08:00",
                    "endLocal": "14:00",
                    "requiresOverride": True,
                },
            ),
        ],
        ["8am", "2pm"],
        None,
        "[T1] Protected sleep quiet-window definition after night shifts.",
    ),
    _scenario(
        "shiftrotation.normalize_d_e_n_week_pattern",
        "Normalize D/E/N rotation pattern",
        Domain.CALENDAR,
        "Next rotation is D D E E N N off. Use that for the week so I don't re-enter every day.",
        [
            Action(
                name="CALENDAR",
                kwargs={
                    "action": "update_preferences",
                    "intent": "normalize D D E E N N off shift rotation",
                    "details": {
                        "description": "Shift sequence: day, day, evening, evening, night, night, off.",
                    },
                },
            ),
        ],
        ["D D", "N N"],
        FirstQuestionFallback(
            canned_answer="Start Monday and repeat that exact D D E E N N off order.",
            applies_when="agent asks when the rotation sequence begins",
        ),
        "[T1] Week-at-a-glance shift normalization.",
    ),
    _scenario(
        "shiftrotation.reanchor_recurring_reminders_new_shift",
        "Re-anchor recurring reminders to new shift",
        Domain.REMINDERS,
        "Same reminders, just move them to my new hours. I'm on evenings this week.",
        [
            _life(
                "Re-anchor recurring reminders to evening shift",
                {
                    "policy": "reanchor_existing",
                    "anchor": "evening_shift",
                    "appliesTo": "recurring_reminders",
                },
            ),
        ],
        ["evenings", "same reminders"],
        FirstQuestionFallback(
            canned_answer="Yes, keep the same reminders; move them relative to evening shift.",
            applies_when="agent asks whether to create new reminders or re-anchor existing ones",
        ),
        "[T2] Shift change should re-anchor existing recurring reminders, not duplicate them.",
    ),
    _scenario(
        "shiftrotation.tomorrow_resolves_against_shift_boundary",
        "Tomorrow resolves against shift boundary",
        Domain.REMINDERS,
        "Remind me tomorrow after shift to call payroll. I'm on nights, so tomorrow means after I get off.",
        [
            _life(
                "Call payroll after night shift",
                {
                    "anchor": "post_night_shift",
                    "dueDaySemantic": "shift_boundary_tomorrow",
                    "title": "Call payroll",
                },
            ),
        ],
        ["payroll", "after shift"],
        None,
        "[T2] 'Tomorrow' resolves against the night-shift boundary, not midnight.",
    ),
    _scenario(
        "shiftrotation.quiet_hours_move_with_rotation",
        "Quiet hours move with rotation",
        Domain.SLEEP,
        "Sleep block should move with the rotation. Days, evenings, nights — protect the after-shift sleep each time.",
        [
            _life(
                "Rotation-aware protected sleep",
                {
                    "policy": "moving_quiet_hours",
                    "anchor": "after_current_shift",
                    "rotations": ["day", "evening", "night"],
                },
            ),
        ],
        ["rotation", "sleep"],
        FirstQuestionFallback(
            canned_answer="Yes, protect sleep after whichever shift I'm on that week.",
            applies_when="agent asks whether the quiet hours should be fixed or move with each shift",
        ),
        "[T2] Moving quiet-hours policy across shift rotations.",
    ),
    _scenario(
        "shiftrotation.forward_rotation_transition_leniency",
        "Lenient planning after forward rotation",
        Domain.CALENDAR,
        "When I rotate from days to evenings, don't stack errands right after the first evening shift.",
        [
            Action(
                name="CALENDAR",
                kwargs={
                    "action": "update_preferences",
                    "intent": "avoid stacking errands after first evening shift transition",
                    "details": {"description": "Forward-rotation transition leniency"},
                },
            ),
        ],
        ["evening", "errands"],
        None,
        "[T2] Forward-rotation-aware scheduling should avoid overload on transition day.",
    ),
    _scenario(
        "shiftrotation.dedup_habit_survives_shift_change",
        "Dedup habit definition across shift change",
        Domain.REMINDERS,
        "Keep the hydration reminder, just line it up with nights now. Don't make a second hydration thing.",
        [
            _life(
                "Hydration reminder",
                {
                    "policy": "reanchor_existing",
                    "dedupeKey": "hydration",
                    "anchor": "night_shift",
                },
            ),
        ],
        ["hydration", "nights"],
        None,
        "[T2] Existing habit survives a shift change without duplicate creation.",
    ),
]
