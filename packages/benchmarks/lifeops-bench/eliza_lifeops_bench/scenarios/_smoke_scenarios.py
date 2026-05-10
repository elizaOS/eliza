"""Two smoke scenarios used to exercise the runner end-to-end.

These remain in place for back-compat with the existing
``test_smoke_scenarios_load`` scaffold test, which references the IDs
``smoke_static_calendar_01`` and ``smoke_live_mail_01`` directly. They
also satisfy the manifest-name validity check in
``test_scenarios_corpus.py`` by using real action names from
``manifests/actions.manifest.json``.
"""

from __future__ import annotations

from ..types import (
    Action,
    Domain,
    FirstQuestionFallback,
    Persona,
    Scenario,
    ScenarioMode,
)

_PERSONA_ALEX = Persona(
    id="alex",
    name="Alex",
    traits=["concise", "no-nonsense"],
    background="Software engineer who treats the assistant like a CLI.",
    communication_style="terse, lowercase, expects bullet points",
    patience_turns=20,
)

_PERSONA_RIA = Persona(
    id="ria",
    name="Ria",
    traits=["friendly", "explanatory"],
    background="PM who narrates context and asks follow-up questions.",
    communication_style="conversational, polite, gives reasons",
    patience_turns=30,
)


SMOKE_STATIC = Scenario(
    id="smoke_static_calendar_01",
    name="Smoke - schedule a 30-minute focus block tomorrow at 10am",
    domain=Domain.CALENDAR,
    mode=ScenarioMode.STATIC,
    persona=_PERSONA_ALEX,
    instruction="schedule a 30-minute focus block tomorrow at 10am UTC called 'deep work'",
    ground_truth_actions=[
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "create_event",
                "intent": "create deep-work focus block on 2026-05-11 10:00-10:30 UTC",
                "title": "deep work",
                "details": {
                    "calendarId": "cal_primary",
                    "start": "2026-05-11T10:00:00Z",
                    "end": "2026-05-11T10:30:00Z",
                },
            },
        ),
    ],
    required_outputs=["scheduled", "deep work"],
    first_question_fallback=FirstQuestionFallback(
        canned_answer="primary calendar, no attendees, no notification",
        applies_when="agent asks which calendar / attendees / notification settings",
    ),
    world_seed=2026,
    max_turns=8,
    description="Single-shot calendar create. Smoke scenario kept for the scaffold test.",
)


SMOKE_LIVE = Scenario(
    id="smoke_live_mail_01",
    name="Smoke - find unread email from a sender and draft a reply",
    domain=Domain.MAIL,
    mode=ScenarioMode.LIVE,
    persona=_PERSONA_RIA,
    instruction=(
        "find any unread email from uma.wright180@example.test this month and "
        "draft a polite reply confirming I will deliver the report by Friday"
    ),
    ground_truth_actions=[
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "search_inbox",
                "source": "gmail",
                "query": "from:uma.wright180@example.test newer_than:7d",
            },
        ),
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "draft_reply",
                "source": "gmail",
                "messageId": "email_000002",
                "body": "Confirming I will deliver the report by Friday.",
            },
        ),
    ],
    required_outputs=["draft", "Friday"],
    first_question_fallback=None,
    world_seed=2026,
    max_turns=12,
    description="Two-step search + draft. LIVE mode — persona answers follow-ups about tone.",
)


SMOKE_SCENARIOS: list[Scenario] = [SMOKE_STATIC, SMOKE_LIVE]
