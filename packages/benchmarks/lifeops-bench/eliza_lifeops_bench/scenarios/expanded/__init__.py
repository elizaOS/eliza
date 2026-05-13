"""Expanded LifeOpsBench scenario packs.

This module broadens LifeOpsBench beyond the original mostly single-action
static corpus. It adds 10 capability areas, each with 10 primary scenario
families and two similar-but-different variants per family.

Coverage gaps intentionally surfaced by these scenarios:
- true heartbeat/time-advance execution is not modeled; the benchmark can
  express scheduled-task records and reminder disruptions, but cannot tick a
  real ScheduledTaskRunner through a day/week.
- LifeWorld folds `SCHEDULED_TASK_CREATE` into reminders, so escalation,
  output, subject, global-pause, and pipeline semantics are scored through
  action structure and final prose rather than independent state entities.
- connector auth/status, remote sessions, owner facts, handoff, memory,
  budget/account state, document portals, approvals, and focus-block sessions
  do not have first-class LifeWorld entities yet.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from ...types import Action, Disruption, Domain, FirstQuestionFallback, Scenario, ScenarioMode
from .._personas import (
    PERSONA_ALEX_ENG,
    PERSONA_DEV_FREELANCER,
    PERSONA_KAI_STUDENT,
    PERSONA_LIN_OPS,
    PERSONA_MAYA_PARENT,
    PERSONA_NORA_CONSULTANT,
    PERSONA_OWEN_RETIREE,
    PERSONA_RIA_PM,
    PERSONA_SAM_FOUNDER,
    PERSONA_TARA_NIGHT,
)


@dataclass(frozen=True)
class AreaSpec:
    slug: str
    label: str
    domain: Domain
    persona: Any
    topics: tuple[str, ...]
    output_terms: tuple[str, str]
    missing_semantics: str


_VARIANTS: tuple[tuple[str, str], ...] = (
    ("primary", "Run the default version with normal urgency."),
    ("variant_a", "Shift the same workflow one day later and use the quieter route."),
    ("variant_b", "Make the same workflow span a week and include the fallback path."),
)

_AREA_SPECS: tuple[AreaSpec, ...] = (
    AreaSpec(
        slug="temporal_triggers",
        label="Temporal triggers and heartbeat simulation",
        domain=Domain.REMINDERS,
        persona=PERSONA_RIA_PM,
        topics=(
            "morning heartbeat after wake confirmation",
            "bedtime recap relative to target bedtime",
            "interval medication checks through the afternoon",
            "manual check-in after a quiet six-hour window",
            "after-task follow-up when a blocker is completed",
            "DST-safe local morning reminder",
            "week-long daily operations digest",
            "missed wake anchor soft recovery",
            "event-triggered reminder from an inbound message",
            "time-zone shift after travel",
        ),
        output_terms=("heartbeat", "trigger"),
        missing_semantics="No benchmark action currently advances a real scheduler clock or invokes heartbeat ticks.",
    ),
    AreaSpec(
        slug="cross_domain_day_week",
        label="Cross-domain full-day and full-week orchestration",
        domain=Domain.CALENDAR,
        persona=PERSONA_SAM_FOUNDER,
        topics=(
            "workday plan with calendar, draft, reminder, and focus block",
            "launch-week brief across Gmail, Slack, and calendar",
            "sleep-protected meeting bundle before travel",
            "daily digest with unsent drafts and tomorrow follow-up",
            "client visit with prep block and group message",
            "weekly operating review with recurring reminders",
            "missed meeting repair and apology draft",
            "city visit that clears calendar and pauses distractions",
            "decision deadline with email draft and escalation",
            "deep-work day with family logistics preserved",
        ),
        output_terms=("plan", "follow-up"),
        missing_semantics="Pipeline/onComplete chains are expressed structurally but not executed as child ScheduledTasks in LifeWorld.",
    ),
    AreaSpec(
        slug="escalation_push_remote",
        label="Escalation, push, and remote-session recovery",
        domain=Domain.REMINDERS,
        persona=PERSONA_LIN_OPS,
        topics=(
            "meeting reminder ladder across app, SMS, and call",
            "cancellation-fee warning with high-priority output",
            "remote help request when browser automation stalls",
            "snooze that resets an escalation ladder",
            "deadline output that falls back from Discord to SMS",
            "mobile push for airport departure",
            "approval reminder that escalates after silence",
            "stuck portal upload requiring owner intervention",
            "urgent medication reminder across devices",
            "late-night travel disruption alert",
        ),
        output_terms=("escalate", "fallback"),
        missing_semantics="PushNotification and RemoteSession are product services, not benchmark action/state entities.",
    ),
    AreaSpec(
        slug="connector_degradation",
        label="Connector degradation and permission recovery",
        domain=Domain.MESSAGES,
        persona=PERSONA_ALEX_ENG,
        topics=(
            "Gmail reconnect prompt while preserving draft",
            "Discord outage fallback to SMS",
            "Signal queued outbound after reconnect",
            "Telegram code-required flow with in-app follow-up",
            "iMessage degraded send path with draft instead of send",
            "Google Calendar token expired during reschedule",
            "WhatsApp group unavailable during family update",
            "Drive permission missing for document reminder",
            "website-block permission request before blocking",
            "cross-channel search with partial connector failure",
        ),
        output_terms=("reconnect", "degraded"),
        missing_semantics="Connector auth/status transitions are not first-class LifeWorld mutations.",
    ),
    AreaSpec(
        slug="identity_followup",
        label="Identity merge and relationship follow-up repair",
        domain=Domain.CONTACTS,
        persona=PERSONA_RIA_PM,
        topics=(
            "same person across Gmail and Telegram",
            "handle rename while a watcher exists",
            "cadence-bearing relationship check-in",
            "follow-up if no reply by tomorrow",
            "log interaction before drafting outreach",
            "merge duplicate contact before scheduling",
            "relationship digest for overdue replies",
            "canonical person search across channels",
            "new vendor identity with email and phone",
            "repair missed commitment with apology draft",
        ),
        output_terms=("identity", "follow-up"),
        missing_semantics="RelationshipStore and merge-engine effects are modeled as ENTITY plus scheduled-task metadata only.",
    ),
    AreaSpec(
        slug="health_sleep_circadian",
        label="Health, sleep, circadian, and screen-time adaptation",
        domain=Domain.HEALTH,
        persona=PERSONA_TARA_NIGHT,
        topics=(
            "under-five-hour sleep softens morning habits",
            "wake anchor missing by late morning",
            "bedtime target changes on weekends",
            "sleep recap after detected wake",
            "workout log followed by recovery reminder",
            "late-night screen-time block",
            "nap detection with gentle follow-up",
            "HRV drop triggers lighter schedule",
            "medication reminder tied to meals",
            "sleep regularity weekly recap",
        ),
        output_terms=("sleep", "health"),
        missing_semantics="Health connector sync and circadian anchor resolution are not executable benchmark actions.",
    ),
    AreaSpec(
        slug="focus_blockers",
        label="Focus sessions, app blockers, and website blockers",
        domain=Domain.FOCUS,
        persona=PERSONA_KAI_STUDENT,
        topics=(
            "deep-work block with social sites blocked",
            "permission-before-block for harsh mode",
            "release with reason after emergency",
            "focus auto-snooze during protected time",
            "weekend exception for entertainment sites",
            "exam week browser block schedule",
            "mobile app block plus calendar hold",
            "late-night doomscroll intervention",
            "status check before unblocking",
            "group notification before focus session",
        ),
        output_terms=("focus", "block"),
        missing_semantics="BLOCK actions are no-op in LifeWorld until a FocusBlock entity exists.",
    ),
    AreaSpec(
        slug="finance_subscriptions",
        label="Finance, recurring charges, and subscription operations",
        domain=Domain.FINANCE,
        persona=PERSONA_DEV_FREELANCER,
        topics=(
            "cancel unused streaming subscription after confirmation",
            "weekly budget report with follow-up reminder",
            "duplicate travel-charge audit",
            "trial ending warning before renewal",
            "family entertainment subscriptions digest",
            "recurring charges plus cash-flow reminder",
            "do-not-cancel paused subscription",
            "health spending and pharmacy recap",
            "client reimbursement transaction search",
            "subscription downgrade approval",
        ),
        output_terms=("budget", "subscription"),
        missing_semantics="Budget/account aggregates are read-only; only subscription cancellation mutates state.",
    ),
    AreaSpec(
        slug="travel_docs_approvals",
        label="Travel, documents, portals, and approvals",
        domain=Domain.TRAVEL,
        persona=PERSONA_NORA_CONSULTANT,
        topics=(
            "book flight after approval and block calendar",
            "airport transfer reminder and itinerary share",
            "signature deadline before appointment",
            "speaker portal deck upload reminder",
            "weather disruption requiring rebook proposal",
            "hotel check-in plus family calendar block",
            "passport problem repair workflow",
            "event asset deadline with approval draft",
            "travel-day brief with links and buffers",
            "multi-city trip preference reuse",
        ),
        output_terms=("approval", "itinerary"),
        missing_semantics="Document portals, approvals, and real travel booking state are represented as tasks/messages only.",
    ),
    AreaSpec(
        slug="multilocale_settings_privacy",
        label="Multilingual settings, privacy, handoff, and memory",
        domain=Domain.MESSAGES,
        persona=PERSONA_OWEN_RETIREE,
        topics=(
            "Spanish-English reminder creation",
            "locale switch between turns",
            "global pause except urgent medication",
            "privacy revocation for a document watcher",
            "group chat handoff and explicit resume",
            "memory recall without leaking private context",
            "owner timezone preference change",
            "REST-like overview request",
            "suspected but unconfirmed task capture",
            "do-not-store sensitive health note",
        ),
        output_terms=("privacy", "settings"),
        missing_semantics="OwnerFactStore, GlobalPauseStore, HandoffStore, MemoryStore, and REST actions are not modeled directly.",
    ),
)


def _iso(day_offset: int, hour: int, minute: int = 0) -> str:
    base = datetime(2026, 5, 10, hour, minute, tzinfo=timezone.utc)
    return (base + timedelta(days=day_offset)).isoformat().replace("+00:00", "Z")


def _task(
    *,
    area: AreaSpec,
    case_slug: str,
    variant: int,
    prompt: str,
    kind: str = "reminder",
    trigger_kind: str = "once",
    priority: str = "medium",
    subject: dict[str, str] | None = None,
    output: dict[str, Any] | None = None,
    pipeline: dict[str, Any] | None = None,
) -> Action:
    day = variant + 1
    trigger: dict[str, Any] = {"kind": trigger_kind, "atIso": _iso(day, 9 + variant)}
    if trigger_kind == "cron":
        trigger.update({"cron": "0 9 * * 1-5", "tz": "America/Los_Angeles"})
    elif trigger_kind == "interval":
        trigger.update({"everyMinutes": 90, "window": {"start": "13:00", "end": "18:00"}})
    elif trigger_kind == "relative_to_anchor":
        trigger.update({"anchorKey": "wake.confirmed", "offsetMinutes": 30})
    elif trigger_kind == "during_window":
        trigger.update({"window": {"start": "09:00", "end": "17:00"}, "tz": "America/Los_Angeles"})
    elif trigger_kind == "event":
        trigger.update({"eventKind": "lifeops.message.received"})
    elif trigger_kind == "manual":
        trigger.pop("atIso", None)
    elif trigger_kind == "after_task":
        trigger.update({"taskId": f"task_{area.slug}_{case_slug}_{variant}_parent"})

    kwargs: dict[str, Any] = {
        "kind": kind,
        "promptInstructions": prompt,
        "trigger": trigger,
        "priority": priority,
        "ownerVisible": True,
        "source": "user_chat",
        "respectsGlobalPause": priority != "high",
        "metadata": {
            "expandedArea": area.slug,
            "case": case_slug,
            "variant": _VARIANTS[variant][0],
            "missingSemantics": area.missing_semantics,
        },
    }
    if subject:
        kwargs["subject"] = subject
    if output:
        kwargs["output"] = output
    if pipeline:
        kwargs["pipeline"] = pipeline
    if area.slug in {"escalation_push_remote", "connector_degradation"}:
        kwargs["escalation"] = {
            "ladderKey": "expanded.multi_channel",
            "steps": [
                {"afterMinutes": 0, "channelKey": "in_app"},
                {"afterMinutes": 10, "channelKey": "sms"},
                {"afterMinutes": 20, "channelKey": "voice"},
            ],
        }
    return Action(name="SCHEDULED_TASK_CREATE", kwargs=kwargs)


def _calendar_create(title: str, variant: int, *, calendar_id: str = "cal_work") -> Action:
    return Action(
        name="CALENDAR",
        kwargs={
            "subaction": "create_event",
            "title": title,
            "details": {
                "calendarId": calendar_id,
                "start": _iso(variant + 1, 14, 0),
                "end": _iso(variant + 1, 15, 0),
                "description": "Expanded LifeOpsBench orchestration event.",
            },
        },
    )


def _message(
    *,
    operation: str = "send",
    source: str = "gmail",
    body: str,
    variant: int,
    target: str = "contact_00003",
) -> Action:
    if operation == "draft_reply":
        return Action(
            name="MESSAGE",
            kwargs={
                "operation": "draft_reply",
                "source": "gmail",
                "messageId": "email_000002",
                "body": body,
            },
        )
    if operation == "search_inbox":
        return Action(
            name="MESSAGE",
            kwargs={
                "operation": "search_inbox",
                "source": "gmail",
                "query": body,
                "since": "2026-05-01",
                "until": "2026-05-10",
            },
        )
    if source == "gmail":
        return Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "gmail",
                "target": f"ops-{variant}@example.test",
                "subject": "LifeOps follow-up",
                "body": body,
            },
        )
    return Action(
        name="MESSAGE",
        kwargs={
            "operation": "send",
            "source": source,
            "targetKind": "contact",
            "target": target,
            "message": body,
        },
    )


def _static_actions(
    area: AreaSpec,
    case_slug: str,
    topic: str,
    variant: int,
    family_index: int,
) -> list[Action]:
    title = f"{area.label}: {topic}"
    prompt = f"{topic}; {_VARIANTS[variant][1]}"
    trigger_cycle = (
        "once",
        "cron",
        "interval",
        "relative_to_anchor",
        "during_window",
        "event",
        "manual",
        "after_task",
    )
    stable_seed = hashlib.sha1(f"{area.slug}:{case_slug}".encode("utf-8")).digest()
    trigger_kind = trigger_cycle[(stable_seed[0] + variant) % len(trigger_cycle)]

    if area.slug == "temporal_triggers":
        return [
            _task(area=area, case_slug=case_slug, variant=variant, prompt=prompt, trigger_kind=trigger_kind),
            _task(
                area=area,
                case_slug=f"{case_slug}_child",
                variant=variant,
                prompt=f"Follow up after {topic}",
                kind="followup",
                trigger_kind="after_task",
                priority="low",
                pipeline={"onComplete": [f"task_{area.slug}_{case_slug}_recap"]},
            ),
            Action(name="SCHEDULED_TASK_UPDATE", kwargs={"taskId": f"task_{area.slug}_{case_slug}_{variant}", "updates": {"priority": "medium"}}),
            Action(name="SCHEDULED_TASK_SNOOZE", kwargs={"taskId": f"task_{area.slug}_{case_slug}_{variant}", "minutes": 30}),
        ]
    if area.slug == "cross_domain_day_week":
        return [
            _calendar_create(title, variant),
            _message(operation="draft_reply", body=f"Draft confirmation for {topic}.", variant=variant),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Remind before {topic}", trigger_kind="relative_to_anchor"),
            Action(name="BLOCK", kwargs={"subaction": "block", "hostnames": ["x.com", "youtube.com"], "durationMinutes": 90}),
        ]
    if area.slug == "escalation_push_remote":
        return [
            _task(area=area, case_slug=case_slug, variant=variant, prompt=prompt, trigger_kind="once", priority="high", output={"destination": "channel", "target": "sms:owner"}),
            _message(source="sms", body=f"Escalation fallback for {topic}.", variant=variant),
            Action(name="SCHEDULED_TASK_UPDATE", kwargs={"taskId": f"task_{area.slug}_{case_slug}_{variant}", "updates": {"escalationCursor": 1}}),
        ]
    if area.slug == "connector_degradation":
        trigger_kinds = ("event", "manual", "once")
        priorities = ("high", "medium", "low")
        return [
            _message(operation="search_inbox", body=f"{topic} reconnect degraded", variant=variant),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Reconnect or degrade gracefully for {topic}", priority=priorities[variant], trigger_kind=trigger_kinds[variant]),
            _message(operation="draft_reply", body=f"Draft while connector is degraded: {topic}.", variant=variant),
            _message(source="sms", body=f"Fallback route for {topic}.", variant=variant),
        ]
    if area.slug == "identity_followup":
        return [
            Action(name="ENTITY", kwargs={"subaction": "set_identity", "entityId": "contact_00003", "platform": "telegram", "handle": f"@expanded_{case_slug}_{variant}"}),
            Action(name="ENTITY", kwargs={"subaction": "log_interaction", "entityId": "contact_00003", "notes": f"Logged interaction for {topic}."}),
            Action(name="MESSAGE", kwargs={"operation": "read_with_contact", "source": "signal", "contact": "contact_00003", "limit": 8}),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Follow up with canonical contact about {topic}", kind="followup", subject={"kind": "entity", "id": "contact_00003"}),
        ]
    if area.slug == "health_sleep_circadian":
        return [
            Action(name="HEALTH", kwargs={"subaction": "by_metric", "metric": "sleep_hours", "days": 7}),
            Action(name="LIFE_CREATE", kwargs={"subaction": "create", "title": f"Health log {case_slug}", "details": {"kind": "health_metric", "metric": "sleep_hours", "value": 4.8 + variant, "occurredAtIso": _iso(0, 7)}}),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=prompt, kind="recap", trigger_kind="relative_to_anchor", subject={"kind": "self", "id": "self"}),
            Action(name="LIFE_UPDATE", kwargs={"subaction": "update", "target": f"health-routine-{case_slug}", "updates": {"priority": "low"}}),
        ]
    if area.slug == "focus_blockers":
        block_targets = (
            {"hostnames": ["x.com", "reddit.com"], "packageNames": ["com.apple.MobileSafari"]},
            {"hostnames": ["youtube.com", "tiktok.com"], "packageNames": ["com.apple.AppStore"]},
            {"hostnames": ["news.ycombinator.com", "discord.com"], "packageNames": ["com.apple.MobileSMS"]},
        )[variant]
        if family_index == 0:
            return [
                Action(name="BLOCK_REQUEST_PERMISSION", kwargs={"subaction": "request_permission", **block_targets, "reason": topic, "confirmationRequired": True}),
                _calendar_create(f"Protected focus: {topic}", variant),
                Action(name="BLOCK_BLOCK", kwargs={"subaction": "block", **block_targets, "durationMinutes": 90 + variant * 30, "confirmed": True}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Check whether focus block held: {topic}", trigger_kind="after_task"),
            ]
        if family_index == 1:
            return [
                Action(name="BLOCK_REQUEST_PERMISSION", kwargs={"subaction": "request_permission", **block_targets, "mode": "harsh", "noBypass": True, "reason": topic}),
                Action(name="BLOCK_BLOCK", kwargs={"subaction": "block", **block_targets, "durationMinutes": 120, "mode": "harsh", "confirmed": True}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Confirm harsh-mode block is still appropriate: {topic}", trigger_kind="during_window"),
            ]
        if family_index == 2:
            return [
                Action(name="BLOCK_STATUS", kwargs={"subaction": "status", "ruleId": f"focus_{case_slug}_{variant}"}),
                Action(name="BLOCK_RELEASE", kwargs={"subaction": "release", "ruleId": f"focus_{case_slug}_{variant}", "reason": "emergency override", "confirmed": True}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Log release reason and restart later: {topic}", trigger_kind="after_task"),
            ]
        if family_index == 3:
            return [
                Action(name="BLOCK_STATUS", kwargs={"subaction": "status", "scope": "active_focus"}),
                Action(name="LIFE_SNOOZE", kwargs={"subaction": "snooze", "target": "reminder_00005", "minutes": 30 + 15 * variant}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Auto-snooze noncritical reminders during focus: {topic}", trigger_kind="during_window"),
            ]
        if family_index == 4:
            return [
                Action(name="BLOCK_BLOCK", kwargs={"subaction": "block", **block_targets, "schedule": {"weekdays": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00"}, "exceptions": [{"weekday": 6, "window": "evening"}]}),
                Action(name="BLOCK_LIST_ACTIVE", kwargs={"subaction": "list_active", "includeScheduled": True}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Review weekend exception for {topic}", trigger_kind="cron"),
            ]
        return [
            _calendar_create(f"Exam focus: {topic}", variant),
            Action(name="BLOCK_BLOCK", kwargs={"subaction": "block", **block_targets, "durationMinutes": 180, "policy": "until_task_complete", "confirmed": True}),
            Action(name="MESSAGE", kwargs={"operation": "send", "source": "telegram", "targetKind": "group", "roomId": "conv_0006", "message": f"Focus block started for {topic}."}),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"End-of-session focus recap: {topic}", trigger_kind="after_task"),
        ]
    if area.slug == "finance_subscriptions":
        services = ("Netflix", "Spotify", "Disney+")
        service = services[variant]
        if family_index == 0:
            return [
                Action(name="MONEY_SUBSCRIPTION_STATUS", kwargs={"subaction": "subscription_status", "serviceName": service}),
                Action(name="MONEY_SUBSCRIPTION_CANCEL", kwargs={"subaction": "cancel", "serviceName": service, "confirmed": True, "candidateId": f"cancel_{case_slug}_{variant}"}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Check cancellation status for {service}", trigger_kind="once"),
            ]
        if family_index == 1:
            group_bys = ("category", "merchant", "account")
            trigger_kinds = ("cron", "manual", "once")
            return [
                Action(name="MONEY_DASHBOARD", kwargs={"subaction": "dashboard", "windowDays": 7 + 7 * variant}),
                Action(name="MONEY_SPENDING_SUMMARY", kwargs={"subaction": "spending_summary", "windowDays": 7 + 7 * variant, "groupBy": group_bys[variant]}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Send weekly budget report: {topic}", trigger_kind=trigger_kinds[variant]),
            ]
        if family_index == 2:
            return [
                Action(name="MONEY_LIST_TRANSACTIONS", kwargs={"subaction": "list_transactions", "merchantContains": ("Delta", "United", "Lyft")[variant], "windowDays": 120, "onlyDebits": True}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Follow up on possible duplicate charge: {topic}", trigger_kind="once", priority="high"),
            ]
        if family_index == 3:
            return [
                Action(name="MONEY_SUBSCRIPTION_STATUS", kwargs={"subaction": "subscription_status", "serviceName": ("Apple iCloud", "YouTube Premium", "Github Pro")[variant]}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Warn before trial or renewal: {topic}", trigger_kind="once", priority="high"),
                _message(operation="draft_reply", body=f"Draft renewal decision note for {topic}.", variant=variant),
            ]
        if family_index == 4:
            categories = ("entertainment", "travel", "utilities")
            windows = (180, 120, 365)
            return [
                Action(name="MONEY_SUBSCRIPTION_AUDIT", kwargs={"subaction": "audit", "queryWindowDays": windows[variant], "category": categories[variant]}),
                Action(name="MONEY_RECURRING_CHARGES", kwargs={"subaction": "recurring_charges", "windowDays": windows[variant]}),
                _message(source=("imessage", "sms", "gmail")[variant], body=f"Subscription digest for {topic}: {categories[variant]}.", variant=variant),
            ]
        if variant == 0:
            return [
                Action(name="MONEY_RECURRING_CHARGES", kwargs={"subaction": "recurring_charges", "windowDays": 180}),
                Action(name="MONEY_DASHBOARD", kwargs={"subaction": "dashboard", "windowDays": 30}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Cash-flow reminder and budget follow-up: {topic}", trigger_kind="cron"),
            ]
        if variant == 1:
            return [
                Action(name="MONEY_LIST_TRANSACTIONS", kwargs={"subaction": "list_transactions", "merchantContains": "Spotify", "windowDays": 180, "onlyDebits": True}),
                Action(name="MONEY_RECURRING_CHARGES", kwargs={"subaction": "recurring_charges", "windowDays": 180}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Scan recurring debits and flag duplicates: {topic}", trigger_kind="once"),
            ]
        return [
            Action(name="MONEY_SUBSCRIPTION_AUDIT", kwargs={"subaction": "audit", "queryWindowDays": 365}),
            Action(name="MONEY_RECURRING_CHARGES", kwargs={"subaction": "recurring_charges", "windowDays": 365}),
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Long-horizon recurring-charge review: {topic}", trigger_kind="interval"),
        ]
    if area.slug == "travel_docs_approvals":
        if family_index == 0:
            return [
                Action(name="BOOK_TRAVEL", kwargs={"origin": "SFO", "destination": "JFK", "departureDate": "2026-05-15", "returnDate": "2026-05-18", "passengers": 1, "calendarSync": True, "approval": {"required": True, "queue": "owner"}}),
                _calendar_create(f"Travel hold: {topic}", variant, calendar_id="cal_primary"),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Approval request for flight booking: {topic}", kind="approval", trigger_kind="manual", priority="high", output={"destination": "channel", "target": "in_app:owner"}),
            ]
        if family_index == 1:
            return [
                _calendar_create(f"Airport transfer buffer: {topic}", variant, calendar_id="cal_primary"),
                Action(name="LIFE_CREATE", kwargs={"subaction": "create", "title": f"Airport transfer: {topic}", "details": {"kind": "reminder", "listId": "list_personal", "due": _iso(variant + 1, 9)}}),
                _message(source="imessage", body=f"Itinerary and transfer details for {topic}.", variant=variant),
            ]
        if family_index == 2:
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Request signature before appointment: {topic}", kind="approval", trigger_kind="once", priority="high", output={"destination": "channel", "target": "email:owner"}, pipeline={"documentRequest": {"type": "signature", "documentId": f"doc_{case_slug}_{variant}", "deadline": _iso(variant + 1, 17), "signatureUrl": "https://portal.example.test/sign"}}),
                _message(operation="draft_reply", body=f"Draft signature reminder for {topic}.", variant=variant),
            ]
        if family_index == 3:
            trigger_kinds = ("once", "manual", "event")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Track portal upload deadline: {topic}", kind="watcher", trigger_kind=trigger_kinds[variant], priority="high", output={"destination": "channel", "target": "in_app:owner"}, pipeline={"portal": {"portalUrl": "https://portal.example.test/upload", "assetUri": f"drive://assets/{case_slug}.pdf", "blockedResume": True}}),
                _message(operation="draft_reply", body=f"Ask owner for missing portal asset for {topic}.", variant=variant),
            ]
        if family_index == 4:
            departure_dates = ("2026-05-15", "2026-05-16", "2026-05-17")
            return_dates = ("2026-05-18", "2026-05-19", "2026-05-20")
            reasons = ("weather", "strike", "timing")
            return [
                Action(name="BOOK_TRAVEL", kwargs={"origin": "SFO", "destination": "JFK", "departureDate": departure_dates[variant], "returnDate": return_dates[variant], "rebookReason": reasons[variant], "approval": {"required": True}}),
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Propose rebook options and ask before changing: {topic}", kind="approval", trigger_kind="event", priority="high"),
                _message(source="sms", body=f"Weather rebook proposal for {topic}.", variant=variant),
            ]
        return [
            Action(name="BOOK_TRAVEL", kwargs={"destination": ("NYC", "BOS", "CHI")[variant], "hotelCheckIn": ("2026-05-15", "2026-05-16", "2026-05-17")[variant], "approval": {"required": True}}),
            _calendar_create(f"Family trip block: {topic}", variant, calendar_id="cal_family"),
            Action(name="LIFE_CREATE", kwargs={"subaction": "create", "title": f"Hotel check-in: {topic}", "details": {"kind": "reminder", "listId": "list_personal", "due": _iso(variant + 2, 15)}}),
            _message(source="imessage", body=f"Hotel and family calendar update for {topic}.", variant=variant),
        ]
    if area.slug == "multilocale_settings_privacy":
        if family_index == 0:
            trigger_kinds = ("once", "manual", "event")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Recuérdame to call mom at 8pm: {topic}", trigger_kind=trigger_kinds[variant], subject={"kind": "self", "id": "self"}),
                _message(source="telegram", body=f"Recordatorio creado en modo bilingüe for {topic}.", variant=variant, target="contact_00009"),
            ]
        if family_index == 1:
            trigger_kinds = ("manual", "once", "event")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Switch locale from English to Japanese and keep timezone America/Los_Angeles: {topic}", trigger_kind=trigger_kinds[variant], subject={"kind": "self", "id": "self"}, output={"destination": "channel", "target": "in_app:owner", "locale": "ja-JP"}),
                Action(name="SCHEDULED_TASK_UPDATE", kwargs={"taskId": f"task_{area.slug}_{case_slug}_{variant}", "updates": {"metadata": {"localeSequence": ["en-US", "ja-JP"], "ownerFact": {"timezone": "America/Los_Angeles"}}}}),
            ]
        if family_index == 2:
            trigger_kinds = ("once", "manual", "event")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Urgent medication while global pause is on: {topic}", trigger_kind=trigger_kinds[variant], priority="high", subject={"kind": "self", "id": "self"}, output={"destination": "channel", "target": "sms:owner"}),
                Action(name="LIFE_SKIP", kwargs={"subaction": "skip", "target": f"paused-nonurgent-{case_slug}", "reason": "global_pause"}),
            ]
        if family_index == 3:
            trigger_kinds = ("manual", "event", "once")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Document watcher with privacy revocation: {topic}", kind="watcher", trigger_kind=trigger_kinds[variant], subject={"kind": "document", "id": f"doc_{case_slug}_{variant}"}, pipeline={"privacy": {"scope": "explicit_only", "revoked": True, "auditReason": "owner_revoked_access"}}),
                Action(name="LIFE_SKIP", kwargs={"subaction": "skip", "target": f"private-occurrence-{case_slug}", "reason": "privacy_revoked"}),
                Action(name="SCHEDULED_TASK_UPDATE", kwargs={"taskId": f"task_{area.slug}_{case_slug}_{variant}", "updates": {"state": "skipped", "privacyRevoked": True}}),
            ]
        if family_index == 4:
            trigger_kinds = ("event", "manual", "once")
            return [
                _task(area=area, case_slug=case_slug, variant=variant, prompt=f"Group chat handoff active until explicit resume: {topic}", trigger_kind=trigger_kinds[variant], subject={"kind": "thread", "id": "conv_0006"}, output={"destination": "channel", "target": "slack:conv_0006"}),
                _message(source="slack", body=f"I'll let you take it from here for {topic}.", variant=variant, target="contact_00009"),
                _message(source="slack", body=f"Explicit resume acknowledged for {topic}.", variant=variant, target="contact_00009"),
            ]
        return [
            _task(area=area, case_slug=case_slug, variant=variant, prompt=f"REST-like overview and memory-safe recall: {topic}", trigger_kind=("manual", "event", "once")[variant], subject={"kind": "self", "id": "self"}, pipeline={"memory": {"storeAllowed": False, "recallAllowed": True}, "rest": {"method": "GET", "path": "/api/lifeops/overview", "redactPrivate": True}}),
            Action(name="ENTITY", kwargs={"subaction": "log_interaction", "entityId": "contact_00009", "notes": f"Memory-safe/no-store note for {topic}.", "storeAllowed": False}),
            _message(source="telegram", body=f"Privacy-safe overview returned for {topic}.", variant=variant, target="contact_00009"),
        ]
    raise AssertionError(f"unhandled area {area.slug}")


def _fallback(area: AreaSpec, topic: str, family_index: int) -> FirstQuestionFallback | None:
    if family_index >= 4:
        return None
    area_answers = {
        "focus_blockers": "Block the distracting sites and apps listed, confirm harsh mode before enabling it, and require a release reason.",
        "finance_subscriptions": "Use all accounts. Do not cancel anything unless I explicitly confirm; otherwise summarize and create the follow-up.",
        "travel_docs_approvals": "Use one passenger, economy unless I say otherwise, sync holds to the primary calendar, and ask approval before booking or sending.",
        "multilocale_settings_privacy": "Use my current timezone, keep private details explicit-only, and do not store sensitive health notes.",
    }
    return FirstQuestionFallback(
        canned_answer=area_answers.get(
            area.slug,
            (
                "Use the primary account, keep it owner-visible, and yes, create "
                f"the follow-up for {topic}."
            ),
        ),
        applies_when="agent asks which account, channel, calendar, or whether to create the follow-up",
    )


def _live_disruption(area: AreaSpec, case_slug: str, topic: str, variant: int) -> Disruption:
    if area.slug in {"cross_domain_day_week", "connector_degradation", "identity_followup", "travel_docs_approvals", "multilocale_settings_privacy"}:
        return Disruption(
            at_turn=2 + variant,
            kind="new_message",
            payload={
                "message_id": f"email_exp_{area.slug}_{case_slug}_{variant}",
                "thread_id": f"thread_exp_{area.slug}_{case_slug}_{variant}",
                "from_email": f"{area.slug}@example.test",
                "subject": f"Update: {topic}",
                "body": f"New information arrived for {topic}; adjust the plan.",
            },
            note_for_user=f"New inbound arrived about {topic}; please account for it.",
        )
    if area.slug in {"temporal_triggers", "escalation_push_remote", "health_sleep_circadian", "focus_blockers", "finance_subscriptions"}:
        return Disruption(
            at_turn=2 + variant,
            kind="reminder_due",
            payload={
                "reminder_id": f"reminder_exp_{area.slug}_{case_slug}_{variant}",
                "list_id": "list_personal",
                "title": f"Due now: {topic}",
                "due_at": _iso(variant, 16),
                "priority": "high",
            },
            note_for_user=f"A reminder just became due for {topic}.",
        )
    return Disruption(
        at_turn=2 + variant,
        kind="rule_change",
        payload={"note": f"Rule changed for {topic}."},
        note_for_user=f"The rule changed for {topic}.",
    )


def _scenario(area: AreaSpec, family_index: int, variant: int) -> Scenario:
    topic = area.topics[family_index]
    variant_slug, variant_note = _VARIANTS[variant]
    case_slug = topic.lower().replace(" ", "_").replace("/", "_").replace("-", "_")[:48]
    is_live = family_index >= 6
    name = f"{area.label}: {topic} ({variant_slug})"
    instruction = (
        f"{topic}. {variant_note} Make this production-grade: handle missing "
        "context, preserve approvals, and leave a clear final confirmation."
    )
    if is_live:
        return Scenario(
            id=f"live.expanded.{area.slug}.{family_index + 1:02d}.{variant_slug}",
            name=name,
            domain=area.domain,
            mode=ScenarioMode.LIVE,
            persona=area.persona,
            instruction=instruction,
            ground_truth_actions=[],
            required_outputs=[],
            first_question_fallback=None,
            world_seed=2026,
            max_turns=14 + variant,
            description=f"Expanded live {area.label} scenario. Gap note: {area.missing_semantics}",
            success_criteria=[
                f"The assistant handles {topic} without relying on a single-shot keyword shortcut.",
                "The assistant asks for approval before external or destructive consequences.",
                f"The final answer mentions {area.output_terms[0]} and {area.output_terms[1]} or clearly explains the degraded path.",
            ],
            world_assertions=[
                "Any created or updated world entity is consistent with the accepted user decision.",
                "No unsupported connector or store mutation is silently claimed as completed.",
            ],
            disruptions=[_live_disruption(area, case_slug, topic, variant)],
        )
    return Scenario(
        id=f"expanded.{area.slug}.{family_index + 1:02d}.{variant_slug}",
        name=name,
        domain=area.domain,
        mode=ScenarioMode.STATIC,
        persona=area.persona,
        instruction=instruction,
        ground_truth_actions=_static_actions(
            area,
            case_slug,
            topic,
            variant,
            family_index,
        ),
        required_outputs=[area.output_terms[0], area.output_terms[1]],
        first_question_fallback=_fallback(area, topic, family_index),
        world_seed=2026,
        max_turns=10 + variant,
        description=f"Expanded static {area.label} scenario. Gap note: {area.missing_semantics}",
    )


def _build_area(area: AreaSpec) -> list[Scenario]:
    return [
        _scenario(area, family_index, variant)
        for family_index in range(10)
        for variant in range(3)
    ]


TEMPORAL_TRIGGER_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[0])
CROSS_DOMAIN_DAY_WEEK_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[1])
ESCALATION_PUSH_REMOTE_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[2])
CONNECTOR_DEGRADATION_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[3])
IDENTITY_FOLLOWUP_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[4])
HEALTH_SLEEP_CIRCADIAN_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[5])
FOCUS_BLOCKERS_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[6])
FINANCE_SUBSCRIPTIONS_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[7])
TRAVEL_DOCS_APPROVALS_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[8])
MULTILOCALE_SETTINGS_PRIVACY_EXPANDED_SCENARIOS = _build_area(_AREA_SPECS[9])

EXPANDED_SCENARIOS: list[Scenario] = [
    *TEMPORAL_TRIGGER_EXPANDED_SCENARIOS,
    *CROSS_DOMAIN_DAY_WEEK_EXPANDED_SCENARIOS,
    *ESCALATION_PUSH_REMOTE_EXPANDED_SCENARIOS,
    *CONNECTOR_DEGRADATION_EXPANDED_SCENARIOS,
    *IDENTITY_FOLLOWUP_EXPANDED_SCENARIOS,
    *HEALTH_SLEEP_CIRCADIAN_EXPANDED_SCENARIOS,
    *FOCUS_BLOCKERS_EXPANDED_SCENARIOS,
    *FINANCE_SUBSCRIPTIONS_EXPANDED_SCENARIOS,
    *TRAVEL_DOCS_APPROVALS_EXPANDED_SCENARIOS,
    *MULTILOCALE_SETTINGS_PRIVACY_EXPANDED_SCENARIOS,
]

EXPANDED_AREA_GAPS: dict[str, str] = {
    area.slug: area.missing_semantics for area in _AREA_SPECS
}

__all__ = [
    "CONNECTOR_DEGRADATION_EXPANDED_SCENARIOS",
    "CROSS_DOMAIN_DAY_WEEK_EXPANDED_SCENARIOS",
    "ESCALATION_PUSH_REMOTE_EXPANDED_SCENARIOS",
    "EXPANDED_AREA_GAPS",
    "EXPANDED_SCENARIOS",
    "FINANCE_SUBSCRIPTIONS_EXPANDED_SCENARIOS",
    "FOCUS_BLOCKERS_EXPANDED_SCENARIOS",
    "HEALTH_SLEEP_CIRCADIAN_EXPANDED_SCENARIOS",
    "IDENTITY_FOLLOWUP_EXPANDED_SCENARIOS",
    "MULTILOCALE_SETTINGS_PRIVACY_EXPANDED_SCENARIOS",
    "TEMPORAL_TRIGGER_EXPANDED_SCENARIOS",
    "TRAVEL_DOCS_APPROVALS_EXPANDED_SCENARIOS",
]
