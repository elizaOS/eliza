"""Programmatic builder for the issue #12186 persona scenario packs.

This module mirrors the proven ``scenarios/expanded/__init__.py`` builder
(``AreaSpec`` × families × variants → deterministic ``Scenario`` objects) but
specializes it to the five target persona axes from issue #12186:

- ADHD / executive dysfunction        (``ari_adhd``)
- irregular-sleep / night-owl         (``noa_nightowl``)
- high-travel / timezone              (``tao_travel``)
- high-comms-overwhelm                (``cam_comms``)
- overwhelmed / depressed / low-energy (``del_low``)
- co-parenting logistics              (``jordan_coparent`` planned)

Each persona pack is **30 STATIC + 18 LIVE = 48** base scenarios
(6 static families × 5 variants + 3 live families × 6 variants), for a total
of **240** new base scenarios across the five personas.

Difficulty (issue #12186 plan section E.2) is encoded structurally, not by
making prompts longer:

1. **Flexible-scheduling correctness.** Persona axes that reject fixed
   wall-clock time (ADHD time-blindness, night-owl variable wake, low-energy
   "not at the same time") get ground-truth actions whose trigger is
   ``during_window`` or ``relative_to_anchor`` — so a rigid ``once``/``cron``
   answer loses action-score.
2. **Extraction from context.** LIVE ``success_criteria`` assert the agent
   pulled a fact out of the message (a wake time from a sleep complaint, a
   timezone from a travel mention, a contact from a forwarded thread) rather
   than asking for it or hallucinating it.
3. **Proactive / no-reply.** LIVE families carry ``disruptions`` (reminder_due
   / new_message) where the correct behavior is a graded, non-shaming
   follow-up or suppression when the user is already active.
4. **Adversarial / edge.** Quiet-hours collisions, DST/timezone shifts,
   "don't nag me" boundaries, RSD-sensitive framing — asserted by the LIVE
   judge rubric.
5. **Multi-domain / multi-turn.** Static families chain calendar + reminders +
   messages + health; LIVE families raise ``max_turns`` and use disruptions.

Every STATIC ``ground_truth_actions`` uses only manifest action names and only
``*_id``s that resolve in ``data/snapshots/medium_seed_2026.json``. LIVE
scenarios leave ground-truth empty and rely on ``success_criteria`` +
``world_assertions`` + the judge (per the corpus LIVE invariants).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from ...types import (
    Action,
    Disruption,
    Domain,
    ExpectedWorldMutation,
    FirstQuestionFallback,
    Persona,
    Scenario,
    ScenarioMode,
)
from .._personas import (
    PERSONA_ARI_ADHD,
    PERSONA_CAM_COMMS,
    PERSONA_DEL_LOW,
    PERSONA_JORDAN_COPARENT,
    PERSONA_NOA_NIGHTOWL,
    PERSONA_TAO_TRAVEL,
)

# --- Snapshot vocabulary -----------------------------------------------------
# Only ids that resolve in data/snapshots/medium_seed_2026.json. Fabricated ids
# fail tests/test_scenarios_corpus.py::test_referenced_world_ids_exist_in_snapshot.
LIST_PERSONAL = "list_personal"
CAL_PRIMARY = "cal_primary"
CAL_WORK = "cal_work"
CONTACT_A = "contact_00003"
CONTACT_B = "contact_00007"
CONTACT_C = "contact_00009"


def _iso(day_offset: int, hour: int, minute: int = 0) -> str:
    """ISO timestamp anchored at the snapshot 'now' (2026-05-10T12:00:00Z)."""
    base = datetime(2026, 5, 10, hour, minute, tzinfo=timezone.utc)
    return (base + timedelta(days=day_offset)).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Ground-truth action helpers. These wrap the exact action shapes the runner
# executes (validated by the expanded pack), so PerfectAgent replays them to
# score 1.0 and WrongAgent's unrelated actions score 0.0 via the triviality
# guard.
# ---------------------------------------------------------------------------


def _scheduled_task(
    *,
    slug: str,
    variant: int,
    prompt: str,
    trigger: dict[str, Any],
    kind: str = "reminder",
    priority: str = "medium",
    subject: dict[str, str] | None = None,
    escalation: dict[str, Any] | None = None,
    completion_check: dict[str, Any] | None = None,
    should_fire: dict[str, Any] | None = None,
) -> Action:
    """A SCHEDULED_TASK_CREATE with an explicit, persona-appropriate trigger.

    The trigger dict is passed through verbatim so that a flexible
    ``during_window`` / ``relative_to_anchor`` ground truth is what the agent
    must reproduce — a fixed ``once``/``cron`` answer mismatches the kwargs and
    loses action-score.
    """
    kwargs: dict[str, Any] = {
        "subaction": "create",
        "kind": kind,
        "promptInstructions": prompt,
        "trigger": trigger,
        "priority": priority,
        "ownerVisible": True,
        "source": "user_chat",
        "respectsGlobalPause": priority != "high",
        "metadata": {"personaPack": slug, "variant": variant},
    }
    if subject:
        kwargs["subject"] = subject
    if escalation:
        kwargs["escalation"] = escalation
    if completion_check:
        kwargs["completionCheck"] = completion_check
    if should_fire:
        kwargs["shouldFire"] = should_fire
    return Action(name="SCHEDULED_TASK_CREATE", kwargs=kwargs)


def _calendar_create(
    title: str, *, day: int, hour: int, calendar_id: str = CAL_PRIMARY
) -> Action:
    return Action(
        name="CALENDAR",
        kwargs={
            "subaction": "create_event",
            "title": title,
            "details": {
                "calendarId": calendar_id,
                "start": _iso(day, hour, 0),
                "end": _iso(day, hour + 1, 0),
            },
        },
    )


def _message_send(
    *, source: str, target: str, body: str, target_kind: str = "contact"
) -> Action:
    return Action(
        name="MESSAGE",
        kwargs={
            "operation": "send",
            "source": source,
            "targetKind": target_kind,
            "target": target,
            "message": body,
        },
    )


def _message_draft_reply(*, body: str, message_id: str = "email_000002") -> Action:
    return Action(
        name="MESSAGE",
        kwargs={
            "operation": "draft_reply",
            "source": "gmail",
            "messageId": message_id,
            "body": body,
        },
    )


def _message_triage(*, source: str = "gmail") -> Action:
    return Action(
        name="MESSAGE",
        kwargs={"operation": "triage", "source": source},
    )


def _entity_log(*, entity_id: str, notes: str) -> Action:
    return Action(
        name="ENTITY",
        kwargs={"subaction": "log_interaction", "entityId": entity_id, "notes": notes},
    )


def _health_by_metric(metric: str, days: int = 7) -> Action:
    return Action(
        name="HEALTH",
        kwargs={"subaction": "by_metric", "metric": metric, "days": days},
    )


# Persona-tuned trigger factories -------------------------------------------


def _during_window(window_key: str) -> dict[str, Any]:
    """Flexible daily trigger that resolves bounds from owner facts — the
    'do X daily but not at the same time' primitive."""
    return {"kind": "during_window", "windowKey": window_key}


def _anchor(anchor_key: str, offset_minutes: int) -> dict[str, Any]:
    """Rhythm-relative trigger — fires relative to observed wake/bedtime."""
    return {"kind": "relative_to_anchor", "anchorKey": anchor_key, "offsetMinutes": offset_minutes}


def _cron_owner_local(expression: str) -> dict[str, Any]:
    """Fixed recurrence in the owner's local zone (owner_local sentinel)."""
    return {"kind": "cron", "expression": expression, "tz": "owner_local"}


# Escalation step field name and shape follow the real
# `escalationStepSchema` (plugin-scheduling/src/scheduled-task/schema.ts):
# `{ delayMinutes, channelKey, intensity? }`. Ladder shape mirrors
# plugin-personal-assistant/src/default-packs/escalation-ladders.ts.

# Soft, non-shaming escalation ladder for low-energy / RSD-sensitive personas.
_SOFT_LADDER: dict[str, Any] = {
    "ladderKey": "persona.soft_only",
    "steps": [
        {"delayMinutes": 0, "channelKey": "in_app", "intensity": "soft"},
        {"delayMinutes": 180, "channelKey": "in_app", "intensity": "soft"},
    ],
}

# Anti-habituation channel-rotating ladder for ADHD (novelty-seeking brains
# habituate to static cues; rotate channel + suppress when already active).
_ROTATING_LADDER: dict[str, Any] = {
    "ladderKey": "persona.rotating",
    "steps": [
        {"delayMinutes": 0, "channelKey": "in_app", "intensity": "soft"},
        {"delayMinutes": 20, "channelKey": "push", "intensity": "normal"},
        {"delayMinutes": 60, "channelKey": "imessage", "intensity": "normal"},
    ],
}


def _gates(*gates: dict[str, Any], compose: str | None = None) -> dict[str, Any]:
    """Build a `ScheduledTaskShouldFire` per the real
    `scheduledTaskShouldFireSchema`: `{ compose?, gates: [{ kind, params? }] }`.
    Gate-specific parameters live under `params`, never top-level.
    """
    should_fire: dict[str, Any] = {"gates": list(gates)}
    if compose is not None:
        should_fire["compose"] = compose
    return should_fire


def _gate(kind: str, **params: Any) -> dict[str, Any]:
    """A single gate entry `{ kind, params? }` (params only when non-empty).

    Param names match the production gate-registry / health packs:
    - `no_recent_user_message_in` → `{ minutes }`
    - `circadian_state_in`        → `{ states: [...] }`
    - `during_window` (gate)      → `{ windows: [...] }`
    - `quiet_hours` / `during_travel` → no params
    """
    entry: dict[str, Any] = {"kind": kind}
    if params:
        entry["params"] = params
    return entry


# Suppress when the user has been active recently (reads ActivitySignalBus) —
# the "don't nag me when I'm already engaged" gate. Wrapped gates shape with
# gate params under `params` per the real ScheduledTaskShouldFire.
_ACTIVE_SUPPRESS: dict[str, Any] = _gates(
    _gate("no_recent_user_message_in", minutes=45)
)


# ---------------------------------------------------------------------------
# Family + persona specs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FamilySpec:
    """One scenario family. ``builder`` maps a variant index → ground-truth
    actions (STATIC) or is ignored (LIVE, where success_criteria drive it)."""

    slug: str
    topic: str
    domain: Domain
    output_terms: tuple[str, str]
    # STATIC: builds ground_truth_actions for a variant index.
    builder: Callable[[int], list[Action]] | None = None
    fallback: FirstQuestionFallback | None = None
    # LIVE-only fields (builder is None for live families).
    success_criteria: tuple[str, ...] = ()
    world_assertions: tuple[str, ...] = ()
    disruption: Callable[[int], Disruption] | None = None
    max_turns_base: int = 12
    # LIVE scoring: suppression / defer families expect the world to end
    # UNCHANGED, so leave this "unchanged" (not the auto-inferred "changed",
    # which would invert the score and penalize a correctly-suppressing agent).
    expected_world_mutation: ExpectedWorldMutation = "auto"


@dataclass(frozen=True)
class PersonaAreaSpec:
    slug: str
    persona: Persona
    static_families: tuple[FamilySpec, ...]  # 6 families × 5 variants = 30 static
    live_families: tuple[FamilySpec, ...]  # 3 families × 6 variants = 18 live


_STATIC_VARIANTS = 5
_LIVE_VARIANTS = 6


def _new_message_disruption(slug: str) -> Callable[[int], Disruption]:
    def make(variant: int) -> Disruption:
        return Disruption(
            at_turn=2 + (variant % 2),
            kind="new_message",
            payload={
                "message_id": f"email_persona_{slug}_{variant}",
                "thread_id": f"thread_persona_{slug}_{variant}",
                "from_email": f"{slug}@example.test",
                "subject": f"Update for {slug}",
                "body": "New information arrived mid-conversation; account for it.",
            },
            note_for_user="Something new just came in while we were talking.",
        )

    return make


def _reminder_due_disruption(slug: str) -> Callable[[int], Disruption]:
    def make(variant: int) -> Disruption:
        return Disruption(
            at_turn=2 + (variant % 2),
            kind="reminder_due",
            payload={
                "reminder_id": f"reminder_persona_{slug}_{variant}",
                "list_id": LIST_PERSONAL,
                "title": f"Due now for {slug}",
                "due_at": _iso(0, 16),
                "priority": "medium",
            },
            note_for_user="A reminder just became due.",
        )

    return make


# ===========================================================================
# ADHD — ari_adhd
# ===========================================================================

_ARI = PersonaAreaSpec(
    slug="adhd",
    persona=PERSONA_ARI_ADHD,
    static_families=(
        FamilySpec(
            slug="object_permanence_resurface",
            topic="re-surface an overdue reminder that fell out of sight",
            domain=Domain.REMINDERS,
            output_terms=("reminder", "surface"),
            builder=lambda v: [
                # Object-permanence: re-surface the pending item into the flexible
                # morning window, verify completion instead of re-nagging.
                _scheduled_task(
                    slug="adhd.object_permanence",
                    variant=v,
                    prompt="Re-surface the design review I keep forgetting",
                    trigger=_during_window("morning"),
                    kind="checkin",
                    # `reminder` is NOT a valid subject kind (the schema allows
                    # entity/relationship/thread/document/calendar_event/self).
                    # A personal re-surfacing check-in is about the user's own
                    # pending item → subject.kind "self".
                    subject={"kind": "self", "id": "self"},
                    completion_check={"kind": "subject_updated"},
                    should_fire=_ACTIVE_SUPPRESS,
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Surface it in my morning window, and stop once I've actually touched it — don't ping me if I'm already active.",
                applies_when="agent asks when to remind, which item, or whether to keep nagging",
            ),
        ),
        FamilySpec(
            slug="body_double_start_now",
            topic="a gentle body-double start nudge during a work window",
            domain=Domain.REMINDERS,
            output_terms=("start", "focus"),
            builder=lambda v: [
                _scheduled_task(
                    slug="adhd.body_double",
                    variant=v,
                    prompt="Nudge me to just start the report, body-double style",
                    trigger=_during_window("afternoon" if v % 2 else "morning"),
                    kind="checkin",
                    completion_check={"kind": "subject_updated"},
                    escalation=_ROTATING_LADDER,
                ),
                _calendar_create("Focus start block", day=v + 1, hour=15, calendar_id=CAL_WORK),
            ],
        ),
        FamilySpec(
            slug="anti_habituation_reminder",
            topic="a habituation-resistant reminder that rotates channels",
            domain=Domain.REMINDERS,
            output_terms=("reminder", "channel"),
            builder=lambda v: [
                _scheduled_task(
                    slug="adhd.anti_habituation",
                    variant=v,
                    prompt="Remind me to take my meds, but vary it so I don't tune it out",
                    trigger=_anchor("wake.confirmed", 30 + 15 * v),
                    priority="high",
                    escalation=_ROTATING_LADDER,
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Anchor it to when I actually wake up, rotate the channel each time, and keep it high priority so it bypasses quiet hours.",
                applies_when="agent asks about timing, channel, or priority",
            ),
        ),
        FamilySpec(
            slug="flexible_daily_habit",
            topic="a daily habit the user can't do at a fixed time",
            domain=Domain.REMINDERS,
            output_terms=("daily", "flexible"),
            builder=lambda v: [
                # The core "do X daily but struggle to do it at the same time"
                # case — a ScheduledTask reminder on a during_window trigger,
                # NOT a fixed once/cron and NOT a LIFE reminder (which has no
                # trigger field).
                _scheduled_task(
                    slug="adhd.flexible_daily",
                    variant=v,
                    prompt="Daily tidy-up, but I can't do it at the same time each day",
                    trigger=_during_window(
                        ("evening", "morning_or_evening", "afternoon", "morning", "night")[v]
                    ),
                    kind="reminder",
                ),
            ],
        ),
        FamilySpec(
            slug="task_initiation_chain",
            topic="break a stuck task into a low-friction first step",
            domain=Domain.CALENDAR,
            output_terms=("step", "plan"),
            builder=lambda v: [
                _calendar_create("Tiny first step", day=v + 1, hour=10, calendar_id=CAL_WORK),
                _scheduled_task(
                    slug="adhd.task_initiation",
                    variant=v,
                    prompt="Follow up after the first step so I keep going",
                    trigger=_anchor("wake.confirmed", 120),
                    kind="followup",
                    completion_check={"kind": "subject_updated"},
                ),
            ],
        ),
        FamilySpec(
            slug="context_extract_deadline",
            topic="extract a deadline buried in a message and reschedule around it",
            domain=Domain.MESSAGES,
            output_terms=("deadline", "reminder"),
            builder=lambda v: [
                _message_draft_reply(
                    body=f"Confirming I'll have it to you by the deadline (item {v + 1}).",
                ),
                _scheduled_task(
                    slug="adhd.context_deadline",
                    variant=v,
                    prompt="Submit the thing before the extracted deadline",
                    trigger=_during_window(
                        ("morning", "afternoon", "evening", "morning_or_evening", "afternoon")[v]
                    ),
                    kind="reminder",
                    priority="high" if v % 2 else "medium",
                ),
            ],
        ),
    ),
    live_families=(
        FamilySpec(
            slug="rsd_soft_followup",
            topic="a missed task where the follow-up must not read as criticism",
            domain=Domain.REMINDERS,
            output_terms=("follow-up", "gentle"),
            success_criteria=(
                "The assistant follows up about the missed task exactly once with soft, non-shaming framing.",
                "The assistant separates the behavior from the user's self-worth and does not use guilt or 'you failed' language.",
                "The assistant does not pile on additional nags after the single follow-up.",
            ),
            world_assertions=(
                "Any reminder or scheduled task created is owner-visible and low-pressure.",
                "No destructive mutation is made without explicit user confirmation.",
            ),
            disruption=_reminder_due_disruption("adhd_rsd"),
            max_turns_base=14,
        ),
        FamilySpec(
            slug="flexible_schedule_extract",
            topic="user wants a daily reminder but can't commit to a fixed time",
            domain=Domain.REMINDERS,
            output_terms=("daily", "window"),
            success_criteria=(
                "The assistant creates a flexible during-window reminder rather than a single fixed clock time.",
                "The assistant does not invent a specific fixed time the user never gave.",
                "The assistant confirms the reminder recurs daily within the user's chosen window.",
            ),
            world_assertions=(
                "A recurring reminder or scheduled task exists that uses a flexible window trigger, not a fixed once time.",
            ),
            max_turns_base=13,
        ),
        FamilySpec(
            slug="active_suppression",
            topic="the user is already heads-down when a nudge would fire",
            domain=Domain.REMINDERS,
            output_terms=("suppress", "later"),
            success_criteria=(
                "The assistant recognizes the user is already active and suppresses or defers the nudge instead of interrupting.",
                "The assistant does not stack multiple interruptions while the user is engaged.",
            ),
            world_assertions=(
                "No redundant duplicate reminder is created for the same task.",
            ),
            disruption=_new_message_disruption("adhd_active"),
            max_turns_base=12,
            # Correct behavior is to suppress/defer — the world must stay
            # UNCHANGED, so don't let auto-inference expect a changed world.
            expected_world_mutation="unchanged",
        ),
    ),
)


# ===========================================================================
# Night owl — noa_nightowl
# ===========================================================================

_NOA = PersonaAreaSpec(
    slug="night_owl",
    persona=PERSONA_NOA_NIGHTOWL,
    static_families=(
        FamilySpec(
            slug="wake_relative_reminder",
            topic="a reminder anchored to when she actually wakes, not a clock time",
            domain=Domain.REMINDERS,
            output_terms=("wake", "reminder"),
            builder=lambda v: [
                _scheduled_task(
                    slug="night_owl.wake_relative",
                    variant=v,
                    prompt="Remind me to stretch about an hour after I wake up",
                    trigger=_anchor("wake.confirmed", 60 + 15 * v),
                    kind="reminder",
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Anchor it to when I actually wake up, not a fixed hour — my mornings move around.",
                applies_when="agent asks what time to set the reminder",
            ),
        ),
        FamilySpec(
            slug="evening_window_habit",
            topic="an evening habit that floats within her variable evening",
            domain=Domain.REMINDERS,
            output_terms=("evening", "flexible"),
            builder=lambda v: [
                _scheduled_task(
                    slug="night_owl.evening_window",
                    variant=v,
                    prompt="Evening wind-down routine, floating within my evening",
                    trigger=_during_window(
                        ("evening", "night", "morning_or_night", "morning_or_evening", "afternoon")[v]
                    ),
                    kind="reminder",
                    priority="low",
                ),
            ],
        ),
        FamilySpec(
            slug="bedtime_anchor_recap",
            topic="a sleep recap relative to her target bedtime",
            domain=Domain.SLEEP,
            output_terms=("bedtime", "sleep"),
            builder=lambda v: [
                _health_by_metric("sleep_hours", days=7),
                _scheduled_task(
                    slug="night_owl.bedtime_recap",
                    variant=v,
                    prompt="Give me a wind-down recap before my target bedtime",
                    trigger=_anchor("bedtime.target", -30 - 10 * v),
                    kind="recap",
                    subject={"kind": "self", "id": "self"},
                ),
            ],
        ),
        FamilySpec(
            slug="circadian_gate_suppress",
            topic="don't fire a morning cue while she's still asleep",
            domain=Domain.REMINDERS,
            output_terms=("asleep", "defer"),
            builder=lambda v: [
                _scheduled_task(
                    slug="night_owl.circadian_gate",
                    variant=v,
                    prompt="Morning brief, but only once I'm actually awake",
                    trigger=_during_window("morning"),
                    kind="recap",
                    should_fire=_gates(_gate("circadian_state_in", states=["awake"])),
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Only deliver it once I'm awake — don't wake me at a normative morning hour.",
                applies_when="agent asks when to deliver the morning brief",
            ),
        ),
        FamilySpec(
            slug="chronotype_extract",
            topic="infer her chronotype from a sleep complaint and schedule around it",
            domain=Domain.REMINDERS,
            output_terms=("wake", "schedule"),
            builder=lambda v: [
                _health_by_metric("sleep_hours", days=14),
                _scheduled_task(
                    slug="night_owl.chronotype",
                    variant=v,
                    prompt="Nudge me to start work a bit after my real wake time",
                    trigger=_anchor("wake.confirmed", 90),
                    kind="checkin",
                ),
            ],
        ),
        FamilySpec(
            slug="quiet_hours_defer",
            topic="a non-urgent reminder that collides with her sleeping hours",
            domain=Domain.REMINDERS,
            output_terms=("defer", "quiet"),
            builder=lambda v: [
                _scheduled_task(
                    slug="night_owl.quiet_hours",
                    variant=v,
                    prompt="Non-urgent errand reminder, but never during my sleep",
                    trigger=_during_window("afternoon"),
                    priority="low",
                    should_fire=_gates(_gate("quiet_hours")),
                ),
            ],
        ),
    ),
    live_families=(
        FamilySpec(
            slug="wake_extract_no_fixed_time",
            topic="she describes irregular sleep; agent must anchor to wake, not a clock",
            domain=Domain.SLEEP,
            output_terms=("wake", "anchor"),
            success_criteria=(
                "The assistant anchors the reminder to the user's actual wake time rather than a fixed wall-clock hour.",
                "The assistant does not force a normative morning schedule on the user.",
                "The assistant does not hallucinate a specific wake time the user never stated.",
            ),
            world_assertions=(
                "Any reminder created uses a wake-relative or flexible-window trigger, not a fixed once time.",
            ),
            max_turns_base=13,
        ),
        FamilySpec(
            slug="social_jetlag_recap",
            topic="a compassionate sleep-regularity recap without shaming the schedule",
            domain=Domain.SLEEP,
            output_terms=("sleep", "recap"),
            success_criteria=(
                "The assistant summarizes sleep regularity without judging the user for being a night owl.",
                "The assistant calibrates suggestions to the user's chronotype instead of prescribing a standard bedtime.",
            ),
            world_assertions=(
                "No fixed normative bedtime is imposed as a hard schedule change without consent.",
            ),
            disruption=_reminder_due_disruption("night_owl_recap"),
            max_turns_base=14,
        ),
        FamilySpec(
            slug="dst_shift_reanchor",
            topic="a clock change shifts her schedule; reminders must re-anchor",
            domain=Domain.REMINDERS,
            output_terms=("shift", "reminder"),
            success_criteria=(
                "The assistant re-anchors recurring reminders correctly across the clock change instead of leaving them at the wrong time.",
                "The assistant explains the adjustment clearly so the user can trust it.",
            ),
            world_assertions=(
                "Any updated reminder reflects the corrected local time after the shift.",
            ),
            max_turns_base=13,
        ),
    ),
)


# ===========================================================================
# High travel — tao_travel
# ===========================================================================

_TAO = PersonaAreaSpec(
    slug="travel",
    persona=PERSONA_TAO_TRAVEL,
    static_families=(
        FamilySpec(
            slug="timezone_local_reminder",
            topic="a reminder that must fire in his current (owner-local) timezone",
            domain=Domain.REMINDERS,
            output_terms=("timezone", "reminder"),
            builder=lambda v: [
                _scheduled_task(
                    slug="travel.tz_local",
                    variant=v,
                    prompt="Daily check-in in whatever timezone I'm currently in",
                    trigger=_cron_owner_local(f"0 {8 + v} * * *"),
                    kind="checkin",
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Use my current local timezone and keep it following me as I travel — don't pin it to home time.",
                applies_when="agent asks which timezone to use",
            ),
        ),
        FamilySpec(
            slug="landing_reanchor",
            topic="re-anchor commitments to local time on landing",
            domain=Domain.CALENDAR,
            output_terms=("landing", "itinerary"),
            builder=lambda v: [
                _calendar_create("Airport transfer", day=v + 1, hour=9, calendar_id=CAL_PRIMARY),
                _scheduled_task(
                    slug="travel.landing_reanchor",
                    variant=v,
                    prompt="After I land, resurface my first meeting in local time",
                    trigger={"kind": "event", "eventKind": "lifeops.travel.landed"},
                    kind="reminder",
                ),
            ],
        ),
        FamilySpec(
            slug="travel_suppress_reminders",
            topic="suppress non-urgent reminders while he's actively traveling",
            domain=Domain.REMINDERS,
            output_terms=("travel", "defer"),
            builder=lambda v: [
                _scheduled_task(
                    slug="travel.suppress",
                    variant=v,
                    prompt="Hold my routine reminders while I'm on the road",
                    trigger=_during_window("evening"),
                    priority="low",
                    should_fire=_gates(_gate("during_travel")),
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Pause the routine ones while I'm traveling and resume them when I'm back — keep only urgent items.",
                applies_when="agent asks whether to keep reminders active during travel",
            ),
        ),
        FamilySpec(
            slug="itinerary_extract",
            topic="extract flight details from a message and block the calendar",
            domain=Domain.TRAVEL,
            output_terms=("flight", "calendar"),
            builder=lambda v: [
                Action(
                    name="BOOK_TRAVEL",
                    kwargs={
                        "subaction": "hold",
                        "origin": ("SFO", "JFK", "ORD", "SEA", "LAX")[v],
                        "destination": ("NRT", "LHR", "CDG", "SIN", "SYD")[v],
                        "departureDate": _iso(v + 3, 8)[:10],
                        "approval": {"required": True, "queue": "owner"},
                    },
                ),
                _calendar_create("Flight hold", day=v + 3, hour=8, calendar_id=CAL_PRIMARY),
            ],
        ),
        FamilySpec(
            slug="jetlag_lighter_day",
            topic="lighten his schedule the day after a long-haul flight",
            domain=Domain.CALENDAR,
            output_terms=("jet lag", "lighter"),
            builder=lambda v: [
                _scheduled_task(
                    slug="travel.jetlag",
                    variant=v,
                    prompt="Propose a lighter schedule the morning after I land",
                    trigger=_anchor("wake.confirmed", 45),
                    kind="checkin",
                ),
            ],
        ),
        FamilySpec(
            slug="cross_zone_commitment",
            topic="keep a cross-timezone commitment straight for a remote colleague",
            domain=Domain.MESSAGES,
            output_terms=("timezone", "confirm"),
            builder=lambda v: [
                _message_send(
                    source="slack",
                    target=CONTACT_B,
                    body="Confirming our call in your local time; I've converted from my current zone.",
                ),
                _scheduled_task(
                    slug="travel.cross_zone",
                    variant=v,
                    prompt="Remind me before the cross-timezone call in my current local time",
                    trigger=_cron_owner_local("30 15 * * *"),
                    priority="high",
                ),
            ],
        ),
    ),
    live_families=(
        FamilySpec(
            slug="ambiguous_timezone_extract",
            topic="user gives a time without a zone right after mentioning a city",
            domain=Domain.TRAVEL,
            output_terms=("timezone", "confirm"),
            success_criteria=(
                "The assistant resolves the correct timezone from the travel context or asks a single clarifying question rather than guessing silently.",
                "The assistant does not schedule the commitment in the wrong timezone.",
                "The assistant owns the zone arithmetic instead of pushing it onto the user.",
            ),
            world_assertions=(
                "Any created event or reminder reflects the correct resolved local time.",
            ),
            max_turns_base=13,
        ),
        FamilySpec(
            slug="landing_reanchor_live",
            topic="mid-trip timezone shift must re-anchor an existing reminder",
            domain=Domain.REMINDERS,
            output_terms=("re-anchor", "local"),
            success_criteria=(
                "The assistant re-anchors the reminder to the new local timezone after the trip leg changes.",
                "The assistant does not leave the reminder pinned to the departure timezone.",
            ),
            world_assertions=(
                "The updated reminder reflects the destination local time, not the origin.",
            ),
            disruption=_new_message_disruption("travel_landing"),
            max_turns_base=14,
        ),
        FamilySpec(
            slug="dst_boundary_travel",
            topic="a DST boundary during travel changes the correct local time",
            domain=Domain.CALENDAR,
            output_terms=("DST", "adjust"),
            success_criteria=(
                "The assistant accounts for the DST transition when computing the local meeting time.",
                "The assistant flags the DST adjustment so the user can trust the result.",
            ),
            world_assertions=(
                "Any scheduled item reflects the DST-corrected local time.",
            ),
            max_turns_base=13,
        ),
    ),
)


# ===========================================================================
# High comms — cam_comms
# ===========================================================================

_CAM = PersonaAreaSpec(
    slug="high_comms",
    persona=PERSONA_CAM_COMMS,
    static_families=(
        FamilySpec(
            slug="batched_triage",
            topic="batch-triage the inbox into a digest instead of per-message pings",
            domain=Domain.MESSAGES,
            output_terms=("triage", "digest"),
            builder=lambda v: [
                _message_triage(source="gmail"),
                _scheduled_task(
                    slug="high_comms.batched_triage",
                    variant=v,
                    prompt="Give me a triaged inbox digest a few times a day, not per message",
                    trigger={"kind": "interval", "everyMinutes": 180 + 60 * v},
                    kind="recap",
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Batch it into a few digests a day across all my channels — surface only the critical ones, don't ping me per message.",
                applies_when="agent asks how often or which channels to triage",
            ),
        ),
        FamilySpec(
            slug="cross_channel_followup",
            topic="track a dropped follow-up across channels so it isn't lost",
            domain=Domain.CONTACTS,
            output_terms=("follow-up", "thread"),
            builder=lambda v: [
                _entity_log(entity_id=CONTACT_A, notes="Owe them a reply across email and Slack."),
                _scheduled_task(
                    slug="high_comms.cross_channel",
                    variant=v,
                    prompt="Follow up with this contact if I haven't replied by tomorrow",
                    trigger=_during_window("afternoon"),
                    kind="followup",
                    subject={"kind": "entity", "id": CONTACT_A},
                    completion_check={
                        "kind": "user_replied_within",
                        "params": {"lookbackMinutes": 1440},
                    },
                ),
            ],
        ),
        FamilySpec(
            slug="suppress_when_active",
            topic="don't poke him about the inbox while he's already in it",
            domain=Domain.MESSAGES,
            output_terms=("suppress", "active"),
            builder=lambda v: [
                _scheduled_task(
                    slug="high_comms.suppress_active",
                    variant=v,
                    prompt="Nudge me about unread threads, but not while I'm already replying",
                    trigger=_during_window("afternoon"),
                    should_fire=_ACTIVE_SUPPRESS,
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Only nudge me if I've been away from messages for a while — never while I'm mid-reply.",
                applies_when="agent asks when to nudge about unread threads",
            ),
        ),
        FamilySpec(
            slug="critical_extract",
            topic="extract the one critical thread from the noise and draft a reply",
            domain=Domain.MESSAGES,
            output_terms=("critical", "draft"),
            builder=lambda v: [
                _message_triage(source="gmail"),
                _message_draft_reply(
                    body=(
                        "Thanks — confirming the critical item is handled first "
                        f"(priority {v + 1})."
                    ),
                    message_id=("email_000002", "email_000010", "email_000002", "email_000010", "email_000002")[v],
                ),
            ],
        ),
        FamilySpec(
            slug="channel_consolidation",
            topic="consolidate a multi-channel thread into one tracked commitment",
            domain=Domain.CONTACTS,
            output_terms=("consolidate", "commitment"),
            builder=lambda v: [
                _entity_log(entity_id=CONTACT_C, notes="Same commitment discussed on iMessage and email; consolidating."),
                _scheduled_task(
                    slug="high_comms.consolidate",
                    variant=v,
                    prompt="Remind me about the consolidated commitment in the afternoon",
                    trigger=_during_window("afternoon"),
                    kind="followup",
                    subject={"kind": "entity", "id": CONTACT_C},
                ),
            ],
        ),
        FamilySpec(
            slug="digest_recap_daily",
            topic="a once-daily end-of-day recap of what still needs a reply",
            domain=Domain.MESSAGES,
            output_terms=("recap", "reply"),
            builder=lambda v: [
                _scheduled_task(
                    slug="high_comms.daily_recap",
                    variant=v,
                    prompt="End-of-day recap of threads still needing a reply",
                    trigger=_during_window("evening"),
                    kind="recap",
                ),
            ],
        ),
    ),
    live_families=(
        FamilySpec(
            slug="triage_not_relay",
            topic="a flood of messages arrives; the agent must triage, not relay each",
            domain=Domain.MESSAGES,
            output_terms=("triage", "critical"),
            success_criteria=(
                "The assistant surfaces only the critical messages as a batched digest rather than relaying every message.",
                "The assistant does not create a separate interruption per incoming message.",
            ),
            world_assertions=(
                "No redundant per-message reminder is created for routine messages.",
            ),
            disruption=_new_message_disruption("high_comms_flood"),
            max_turns_base=14,
            # Correct behavior triages/digests without spawning per-message
            # world writes — the world should end UNCHANGED.
            expected_world_mutation="unchanged",
        ),
        FamilySpec(
            slug="dropped_commitment_extract",
            topic="a commitment spans two channels; the agent must not drop it",
            domain=Domain.CONTACTS,
            output_terms=("commitment", "follow-up"),
            success_criteria=(
                "The assistant recognizes the commitment referenced across two channels as a single follow-up.",
                "The assistant sets up cross-channel tracking so the commitment is not dropped.",
            ),
            world_assertions=(
                "A single follow-up or scheduled task tracks the commitment; it is not duplicated per channel.",
            ),
            max_turns_base=14,
        ),
        FamilySpec(
            slug="interruption_boundary",
            topic="user asks not to be pinged while heads-down; agent must respect it",
            domain=Domain.MESSAGES,
            output_terms=("later", "batch"),
            success_criteria=(
                "The assistant respects the do-not-interrupt boundary and batches the update for later.",
                "The assistant does not override the boundary for non-urgent messages.",
            ),
            world_assertions=(
                "No immediate interruption is scheduled against the stated boundary.",
            ),
            disruption=_reminder_due_disruption("high_comms_boundary"),
            max_turns_base=13,
            # Correct behavior respects the boundary and batches for later —
            # no immediate world write, so the world should end UNCHANGED.
            expected_world_mutation="unchanged",
        ),
    ),
)


# ===========================================================================
# Overwhelmed / depressed / low-energy — del_low
# ===========================================================================

_DEL = PersonaAreaSpec(
    slug="low_energy",
    persona=PERSONA_DEL_LOW,
    static_families=(
        FamilySpec(
            slug="tiny_next_action",
            topic="a tiny concrete valued next-action with low activation energy",
            domain=Domain.REMINDERS,
            output_terms=("small", "step"),
            builder=lambda v: [
                _scheduled_task(
                    slug="low_energy.tiny_next_action",
                    variant=v,
                    prompt="One small kind thing today, tiny and flexible",
                    trigger=_during_window(
                        ("afternoon", "morning_or_evening", "evening", "morning", "morning_or_night")[v]
                    ),
                    kind="checkin",
                    priority="low",
                    escalation=_SOFT_LADDER,
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Keep it tiny and flexible — sometime in the window is fine, no fixed time, and please don't make it feel like pressure.",
                applies_when="agent asks how big the task should be or when to schedule it",
            ),
        ),
        FamilySpec(
            slug="soft_escalation_only",
            topic="a reminder that must never escalate to urgent or nag",
            domain=Domain.REMINDERS,
            output_terms=("soft", "gentle"),
            builder=lambda v: [
                _scheduled_task(
                    slug="low_energy.soft_escalation",
                    variant=v,
                    prompt="Gently remind me, but never nag or go urgent",
                    trigger=_during_window("afternoon"),
                    priority="low",
                    escalation=_SOFT_LADDER,
                    should_fire=_ACTIVE_SUPPRESS,
                ),
            ],
            fallback=FirstQuestionFallback(
                canned_answer="Soft in-app only, low priority, and back off entirely if I don't respond — no urgent escalation ever.",
                applies_when="agent asks about escalation, priority, or channel",
            ),
        ),
        FamilySpec(
            slug="behavioral_activation",
            topic="a gentle behavioral-activation nudge toward a valued activity",
            domain=Domain.REMINDERS,
            output_terms=("activity", "gentle"),
            builder=lambda v: [
                _scheduled_task(
                    slug="low_energy.behavioral_activation",
                    variant=v,
                    prompt="Nudge me toward a short walk when I have the energy",
                    trigger=_during_window(("morning", "afternoon", "evening", "morning_or_evening", "afternoon")[v]),
                    kind="checkin",
                    priority="low",
                    escalation=_SOFT_LADDER,
                ),
            ],
        ),
        FamilySpec(
            slug="radical_deferral",
            topic="honor a 'not today' by deferring rather than pushing",
            domain=Domain.REMINDERS,
            output_terms=("defer", "later"),
            builder=lambda v: [
                Action(
                    name="LIFE_SNOOZE",
                    kwargs={"subaction": "snooze", "target": "reminder_00005", "minutes": 1440 * (v + 1)},
                ),
                _scheduled_task(
                    slug="low_energy.radical_deferral",
                    variant=v,
                    prompt="Come back to this gently later, no pressure",
                    trigger=_during_window("afternoon"),
                    priority="low",
                    escalation=_SOFT_LADDER,
                ),
            ],
        ),
        FamilySpec(
            slug="no_streak_consistency",
            topic="track consistency without an all-or-nothing streak",
            domain=Domain.REMINDERS,
            output_terms=("consistency", "gentle"),
            builder=lambda v: [
                _scheduled_task(
                    slug="low_energy.no_streak",
                    variant=v,
                    prompt="Check in with myself, consistency not streaks, no pressure",
                    trigger=_during_window(
                        ("evening", "afternoon", "morning", "morning_or_evening", "night")[v]
                    ),
                    kind="checkin",
                    priority="low",
                    escalation=_SOFT_LADDER,
                ),
            ],
        ),
        FamilySpec(
            slug="quiet_hours_respect",
            topic="a low-priority nudge that must defer around low-energy quiet hours",
            domain=Domain.REMINDERS,
            output_terms=("quiet", "defer"),
            builder=lambda v: [
                _scheduled_task(
                    slug="low_energy.quiet_hours",
                    variant=v,
                    prompt="Gentle nudge, but respect my quiet hours completely",
                    trigger=_during_window("afternoon"),
                    priority="low",
                    should_fire=_gates(_gate("quiet_hours")),
                    escalation=_SOFT_LADDER,
                ),
            ],
        ),
    ),
    live_families=(
        FamilySpec(
            slug="no_shame_proactive",
            topic="the user missed several days; the agent must reassure, not guilt",
            domain=Domain.REMINDERS,
            output_terms=("gentle", "reassure"),
            success_criteria=(
                "The assistant offers proactive, self-compassionate reassurance instead of guilt or pressure.",
                "The assistant does not reference a broken streak or use all-or-nothing framing.",
                "The assistant suggests one tiny concrete next action rather than a long list.",
            ),
            world_assertions=(
                "No punishing or streak-based mutation is applied to the user's data.",
            ),
            disruption=_reminder_due_disruption("low_energy_shame"),
            max_turns_base=15,
        ),
        FamilySpec(
            slug="not_today_deferral",
            topic="the user says 'I can't today'; the agent must defer gracefully",
            domain=Domain.REMINDERS,
            output_terms=("defer", "no pressure"),
            success_criteria=(
                "The assistant accepts the 'not today' without pushing and defers the task gently.",
                "The assistant does not escalate or repeat the request after being told no.",
            ),
            world_assertions=(
                "The task is not force-completed and no new pressure task is created; it is left for later.",
            ),
            max_turns_base=14,
            # Correct behavior honors 'not today' by leaving the task be — no
            # forced completion or new task. World should end UNCHANGED.
            expected_world_mutation="unchanged",
        ),
        FamilySpec(
            slug="flexible_low_pressure_daily",
            topic="a valued daily activity with no fixed time and no pressure",
            domain=Domain.REMINDERS,
            output_terms=("flexible", "gentle"),
            success_criteria=(
                "The assistant sets up a flexible during-window daily nudge rather than a rigid fixed-time reminder.",
                "The assistant keeps the framing soft and low-pressure throughout.",
            ),
            world_assertions=(
                "Any recurring reminder uses a flexible window trigger, not a fixed once time.",
            ),
            max_turns_base=13,
        ),
    ),
)


PERSONA_AREA_SPECS: tuple[PersonaAreaSpec, ...] = (_ARI, _NOA, _TAO, _CAM, _DEL)

# Planned relationship/corpus packs (G-K) share the catalog ledger and authoring
# contract before executable scenario builders land. Keep the persona reference
# here so J1 authors use the same benchmark persona id from the start.
RELATIONSHIP_EXPANSION_PERSONAS: tuple[Persona, ...] = (PERSONA_JORDAN_COPARENT,)


# ---------------------------------------------------------------------------
# Scenario assembly
# ---------------------------------------------------------------------------


def _static_scenario(area: PersonaAreaSpec, family: FamilySpec, variant: int) -> Scenario:
    assert family.builder is not None
    variant_slug = f"v{variant + 1}"
    return Scenario(
        id=f"persona.{area.slug}.{family.slug}.{variant_slug}",
        name=f"{area.persona.name} — {family.topic} ({variant_slug})",
        domain=family.domain,
        mode=ScenarioMode.STATIC,
        persona=area.persona,
        instruction=(
            f"{family.topic}. Handle it faithfully for this persona: "
            "extract what you can from context, prefer flexible non-fixed-time "
            "scheduling where the persona needs it, and leave a clear final "
            "confirmation."
        ),
        ground_truth_actions=family.builder(variant),
        required_outputs=[family.output_terms[0], family.output_terms[1]],
        # Clarifier-heavy personas naturally carry a fallback on every variant
        # of families that define one; this keeps ≥45 of the 150 persona static
        # scenarios covered (plan E.1) without sinking the global ≥30% ratio.
        first_question_fallback=family.fallback,
        world_seed=2026,
        max_turns=10 + variant,
        description=(
            f"Persona pack ({area.persona.id}) static scenario: {family.topic}. "
            "Difficulty: flexible-scheduling / extraction / multi-domain."
        ),
    )


def _live_scenario(area: PersonaAreaSpec, family: FamilySpec, variant: int) -> Scenario:
    variant_slug = f"v{variant + 1}"
    disruptions = [family.disruption(variant)] if family.disruption is not None else []
    return Scenario(
        id=f"live.persona.{area.slug}.{family.slug}.{variant_slug}",
        name=f"{area.persona.name} — {family.topic} ({variant_slug})",
        domain=family.domain,
        mode=ScenarioMode.LIVE,
        persona=area.persona,
        instruction=(
            f"{family.topic}. This is a live multi-turn scenario for this "
            "persona: extract facts from context rather than asking for what "
            "you can infer, respect the persona's boundaries, and prove the "
            "outcome — do not rely on a single-shot keyword shortcut."
        ),
        ground_truth_actions=[],
        required_outputs=[],
        first_question_fallback=None,
        world_seed=2026,
        max_turns=family.max_turns_base + variant,
        description=(
            f"Persona pack ({area.persona.id}) live scenario: {family.topic}. "
            "Judged on extraction / proactive / non-shaming behavior."
        ),
        success_criteria=list(family.success_criteria),
        world_assertions=list(family.world_assertions),
        disruptions=disruptions,
        expected_world_mutation=family.expected_world_mutation,
    )


def build_persona_area(area: PersonaAreaSpec) -> list[Scenario]:
    """30 static (6 families × 5 variants) + 18 live (3 families × 6 variants)."""
    if len(area.static_families) != 6:
        raise AssertionError(
            f"{area.slug}: expected 6 static families, got {len(area.static_families)}"
        )
    if len(area.live_families) != 3:
        raise AssertionError(
            f"{area.slug}: expected 3 live families, got {len(area.live_families)}"
        )
    scenarios: list[Scenario] = []
    for family in area.static_families:
        for variant in range(_STATIC_VARIANTS):
            scenarios.append(_static_scenario(area, family, variant))
    for family in area.live_families:
        for variant in range(_LIVE_VARIANTS):
            scenarios.append(_live_scenario(area, family, variant))
    return scenarios
