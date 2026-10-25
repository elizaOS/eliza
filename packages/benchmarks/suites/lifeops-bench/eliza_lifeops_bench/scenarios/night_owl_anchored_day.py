"""Night-owl anchored-day scenarios."""

from __future__ import annotations

from ..types import Action, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from ._personas import PERSONA_NOOR_NIGHT


def _definition(title: str, details: dict[str, object]) -> Action:
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
    description: str,
    fallback: FirstQuestionFallback | None = None,
    max_turns: int = 6,
) -> Scenario:
    return Scenario(
        id=scenario_id,
        name=name,
        domain=domain,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NOOR_NIGHT,
        instruction=instruction,
        ground_truth_actions=actions,
        required_outputs=outputs,
        first_question_fallback=fallback,
        world_seed=2026,
        max_turns=max_turns,
        description=description,
    )


NIGHT_OWL_ANCHORED_DAY_SCENARIOS: list[Scenario] = [
    _scenario(
        "nightowl.anchored.wake_relative_deploy_ping",
        "Wake-relative deploy reminder",
        Domain.REMINDERS,
        "an hour after i'm up, ping me about the deploy. not 9am. i mean after i'm actually awake.",
        [
            _definition(
                "Deploy check",
                {"anchor": "wake_confirmation", "offsetMinutes": 60, "cadence": "daily"},
            ),
        ],
        ["deploy", "awake"],
        "[T1] Wake-relative reminder with no wall clock. The action should encode an anchor/offset.",
        FirstQuestionFallback(
            canned_answer="Every workday, one hour after I say I'm up. No fixed clock time.",
            applies_when="agent asks for a fixed clock time or cadence",
        ),
    ),
    Scenario(
        id="nightowl.anchored.wake_relative_morning_brief",
        name="Anchor the morning brief to wake confirmation, not a clock time",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=PERSONA_NOOR_NIGHT,
        instruction=(
            "ok new rule. i don't want a 'morning' brief at some random hour while i'm "
            "still asleep. give it to me the first time i tell you i'm up, whenever "
            "that is. don't guess a time."
        ),
        ground_truth_actions=[
            Action(
                name="LIFE_CREATE",
                kwargs={
                    "subaction": "create",
                    "details": {
                        "kind": "reminder",
                        "title": "Morning brief",
                        "anchor": "wake_confirmation",
                        "cadence": "daily",
                    },
                },
            ),
        ],
        required_outputs=["wake", "brief"],
        first_question_fallback=FirstQuestionFallback(
            canned_answer=(
                "Yes — anchor it to whenever I tell you I'm up, every day, no fixed "
                "clock time. Don't default to 9am or anything like that."
            ),
            applies_when=(
                "agent asks what time to fire the morning brief, or proposes a default "
                "clock time such as 9am"
            ),
        ),
        world_seed=2026,
        max_turns=6,
        description=(
            "Tests wake-anchored (not wall-clock) cadence capture. Scoring: the "
            "created definition must reference a wake/anchor concept, not a fixed "
            "minute-of-day; agent must not silently assume a default morning hour."
        ),
    ),
    _scenario(
        "nightowl.anchored.decent_hour_definition",
        "Capture Noor's decent-hour definition",
        Domain.SLEEP,
        "if i say a decent hour, for me that means after noon and before 2am. please remember that.",
        [
            _definition(
                "Noor decent-hour preference",
                {"policy": "local_day_window", "earliestLocal": "12:00", "latestLocal": "02:00"},
            ),
        ],
        ["noon", "2"],
        "[T1] Duration/window preference capture for a night-owl day boundary.",
        FirstQuestionFallback(
            canned_answer="Yes, after noon and before 2am, daily.",
            applies_when="agent asks whether this should be a standing preference",
        ),
    ),
    _scenario(
        "nightowl.anchored.sleep_protection_quiet_window",
        "Protect Noor's sleep window",
        Domain.SLEEP,
        "quiet hours are 4am to 11:30. every day. don't schedule fake morning stuff in there.",
        [
            _definition(
                "Noor quiet hours",
                {"policy": "quiet_hours", "startLocal": "04:00", "endLocal": "11:30", "cadence": "daily"},
            ),
        ],
        ["4", "11:30"],
        "[T1] Sleep-protection window creation for a delayed sleep phase.",
        None,
    ),
    _scenario(
        "nightowl.anchored.correct_assumed_9am_default",
        "Correct a 9am morning default",
        Domain.REMINDERS,
        "wait no. when i said morning, i meant my morning, around noon. never 9am unless i say 9am.",
        [
            _definition(
                "No 9am morning default",
                {"policy": "morning_anchor_override", "anchor": "wake_confirmation", "defaultAfterLocal": "12:00"},
            ),
        ],
        ["noon", "9am"],
        "[T2] Correction of a default assumption; future morning semantics should move to Noor's anchor.",
        FirstQuestionFallback(
            canned_answer="Use wake/noon as the anchor, not 9am.",
            applies_when="agent asks whether to replace the prior morning default",
        ),
    ),
    _scenario(
        "nightowl.anchored.morning_brief_first_hour_after_wake",
        "Morning brief means first hour after wake",
        Domain.REMINDERS,
        "morning brief = first hour after i wake up. if i wake at 12:20, that's still morning for this.",
        [
            _definition(
                "Morning brief first hour after wake",
                {"anchor": "wake_confirmation", "windowAfterMinutes": 60, "cadence": "daily"},
            ),
        ],
        ["wake", "12:20"],
        "[T2] Re-defines morning as an anchor-relative first-hour window.",
        None,
    ),
    _scenario(
        "nightowl.anchored.ambiguous_morning_uses_anchor",
        "Ambiguous morning resolves via Noor's anchor",
        Domain.REMINDERS,
        "remind me tomorrow morning to check the build. you know what morning means for me.",
        [
            _definition(
                "Check the build",
                {"anchor": "wake_confirmation", "offsetMinutes": 0, "dueDay": "tomorrow"},
            ),
        ],
        ["build", "morning"],
        "[T2] Ambiguous 'morning' should resolve to Noor's stored wake anchor, not a hardcoded clock.",
        FirstQuestionFallback(
            canned_answer="Use my wake anchor for tomorrow morning, not a fixed time.",
            applies_when="agent asks what morning means or proposes a fixed default",
        ),
    ),
    _scenario(
        "nightowl.anchored.dedup_wake_anchored_reminders",
        "Deduplicate overlapping wake-anchored reminders",
        Domain.REMINDERS,
        "when i'm up remind me vitamins. also once i'm awake ping vitamins. same thing, don't make two.",
        [
            _definition(
                "Take vitamins",
                {"anchor": "wake_confirmation", "cadence": "daily", "dedupeKey": "vitamins-after-wake"},
            ),
        ],
        ["vitamins"],
        "[T2] Two phrasings for the same wake-anchored habit should collapse to one definition.",
        None,
    ),
    _scenario(
        "nightowl.anchored.local_wake_pattern_capture",
        "Capture local wake pattern without timezone overfitting",
        Domain.SLEEP,
        "i don't travel. if i say after i wake up, just use my local wake pattern. example: usually 11:30ish, but don't make it absolute.",
        [
            _definition(
                "Noor local wake pattern",
                {"policy": "observed_wake_anchor", "exampleLocal": "11:30", "timezoneSemantic": "local_pattern"},
            ),
        ],
        ["11:30", "wake"],
        "[T2] Local pattern capture stays anchor-relative even when an example clock time is given.",
        None,
    ),
    _scenario(
        "nightowl.anchored.multi_day_quiet_hours_consistency",
        "Quiet hours persist every day",
        Domain.SLEEP,
        "that 4-to-11:30 thing, keep it every day, not just today. i will rage if tuesday is suddenly 9am-normal.",
        [
            _definition(
                "Daily quiet hours 04:00-11:30",
                {"policy": "quiet_hours", "startLocal": "04:00", "endLocal": "11:30", "cadence": "daily"},
            ),
        ],
        ["every day", "11:30"],
        "[T2] Multi-day consistency for quiet hours and morning semantics.",
        None,
    ),
]
