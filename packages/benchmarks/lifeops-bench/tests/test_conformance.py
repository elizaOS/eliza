"""Adapter conformance test — the rubric invariant for LifeOpsBench.

PerfectAgent must score 1.0 on every scenario whose ground-truth actions
the executor supports. WrongAgent (in either mode) must score 0.0.

If PerfectAgent ever fails, the bug is in the executor / comparator /
PerfectAgent — fix it; don't loosen the rubric. If WrongAgent ever scores
above 0, the rubric is too lenient — tighten it.

Coverage:
- Iterates `ALL_SCENARIOS` from the registry. Skips (with a clear reason)
  any scenario that references actions not in `supported_actions()`.
- Augments with a small inline corpus of executor-targeted scenarios so
  the invariant has real coverage even when the registry is dominated by
  in-flight Wave 2A scenarios.
"""

from __future__ import annotations

import asyncio
from typing import Iterable

import pytest

from eliza_lifeops_bench.agents import PerfectAgent, WrongAgent
from eliza_lifeops_bench.lifeworld import EntityKind, LifeWorld
from eliza_lifeops_bench.lifeworld.entities import (
    Calendar,
    CalendarEvent,
    Contact,
    Conversation,
    EmailMessage,
    EmailThread,
    Reminder,
    ReminderList,
)
from eliza_lifeops_bench.runner import LifeOpsBenchRunner, supported_actions
from eliza_lifeops_bench.scenarios import ALL_SCENARIOS
from eliza_lifeops_bench.types import (
    Action,
    Domain,
    FirstQuestionFallback,
    Persona,
    Scenario,
    ScenarioMode,
)


NOW_ISO = "2026-05-10T12:00:00Z"


# ---------------------------------------------------------------------------
# Fixture worlds + scenarios that exercise the executor end-to-end.
# ---------------------------------------------------------------------------


_PERSONA = Persona(
    id="conformance",
    name="Conformance",
    traits=["scripted"],
    background="conformance test fixture",
    communication_style="terse",
)


def _seed_world_for_conformance(seed: int, now_iso: str) -> LifeWorld:
    """Build a deterministic world with the entities the conformance scenarios reference."""
    world = LifeWorld(seed=seed, now_iso=now_iso)
    world.add(
        EntityKind.CALENDAR,
        Calendar(
            id="cal_main",
            name="Main",
            color="#000",
            owner="me@example.test",
            source="google",
            is_primary=True,
        ),
    )
    world.add(
        EntityKind.CALENDAR_EVENT,
        CalendarEvent(
            id="ev_existing",
            calendar_id="cal_main",
            title="Standup",
            description="",
            location=None,
            start="2026-05-10T09:00:00Z",
            end="2026-05-10T09:30:00Z",
        ),
    )
    world.add(
        EntityKind.CONTACT,
        Contact(
            id="ct_boss",
            display_name="The Boss",
            given_name="The",
            family_name="Boss",
            primary_email="boss@example.test",
        ),
    )
    world.add(
        EntityKind.EMAIL_THREAD,
        EmailThread(
            id="th_existing",
            subject="report",
            message_ids=["em_existing"],
            participants=["boss@example.test", "me@example.test"],
            last_activity_at=now_iso,
        ),
    )
    world.add(
        EntityKind.EMAIL,
        EmailMessage(
            id="em_existing",
            thread_id="th_existing",
            folder="inbox",
            from_email="boss@example.test",
            to_emails=["me@example.test"],
            cc_emails=[],
            subject="report",
            body_plain="status?",
            sent_at=now_iso,
            received_at=now_iso,
            is_read=False,
        ),
    )
    world.add(
        EntityKind.CONVERSATION,
        Conversation(
            id="cv_friend",
            channel="imessage",
            participants=["+15551111111", "+15552222222"],
            title=None,
            last_activity_at=now_iso,
            is_group=False,
        ),
    )
    world.add(
        EntityKind.REMINDER_LIST,
        ReminderList(id="rl_main", name="Inbox"),
    )
    world.add(
        EntityKind.REMINDER,
        Reminder(id="rm_existing", list_id="rl_main", title="ship the thing"),
    )
    return world


CONFORMANCE_SCENARIOS: list[Scenario] = [
    Scenario(
        id="conformance_calendar_reschedule",
        name="reschedule a calendar event",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="move standup to 10am",
        ground_truth_actions=[
            Action(
                name="CALENDAR.reschedule",
                kwargs={
                    "event_id": "ev_existing",
                    "start": "2026-05-10T10:00:00Z",
                    "end": "2026-05-10T10:30:00Z",
                },
            ),
        ],
        required_outputs=["rescheduled"],
        first_question_fallback=None,
        world_seed=101,
        max_turns=4,
    ),
    Scenario(
        id="conformance_calendar_create",
        name="create a calendar event",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="schedule deep work tomorrow",
        ground_truth_actions=[
            Action(
                name="CALENDAR.create",
                kwargs={
                    "event_id": "ev_new",
                    "calendar_id": "cal_main",
                    "title": "deep work",
                    "start": "2026-05-11T10:00:00Z",
                    "end": "2026-05-11T10:30:00Z",
                },
            ),
        ],
        required_outputs=["scheduled", "deep work"],
        first_question_fallback=None,
        world_seed=102,
        max_turns=4,
    ),
    Scenario(
        id="conformance_calendar_cancel",
        name="cancel a meeting",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="cancel standup",
        ground_truth_actions=[
            Action(name="CALENDAR.cancel", kwargs={"event_id": "ev_existing"}),
        ],
        required_outputs=["cancelled"],
        first_question_fallback=None,
        world_seed=103,
        max_turns=4,
    ),
    Scenario(
        id="conformance_mail_send",
        name="send an email reply",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="reply confirming Friday delivery",
        ground_truth_actions=[
            Action(
                name="MAIL.send",
                kwargs={
                    "message_id": "em_reply",
                    "thread_id": "th_existing",
                    "from_email": "me@example.test",
                    "to_emails": ["boss@example.test"],
                    "subject": "Re: report",
                    "body_plain": "Will deliver by Friday.",
                },
            ),
        ],
        required_outputs=["Friday"],
        first_question_fallback=None,
        world_seed=104,
        max_turns=4,
    ),
    Scenario(
        id="conformance_mail_archive",
        name="archive an email",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="archive that report email",
        ground_truth_actions=[
            Action(name="MAIL.archive", kwargs={"message_id": "em_existing"}),
        ],
        required_outputs=["archived"],
        first_question_fallback=None,
        world_seed=105,
        max_turns=4,
    ),
    Scenario(
        id="conformance_mail_mark_read",
        name="mark email as read",
        domain=Domain.MAIL,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="mark the boss email as read",
        ground_truth_actions=[
            Action(name="MAIL.mark_read", kwargs={"message_id": "em_existing"}),
        ],
        required_outputs=["read"],
        first_question_fallback=None,
        world_seed=106,
        max_turns=4,
    ),
    Scenario(
        id="conformance_message_send",
        name="send a chat message",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="text my friend hi",
        ground_truth_actions=[
            Action(
                name="MESSAGE.send",
                kwargs={
                    "message_id": "cm_new",
                    "conversation_id": "cv_friend",
                    "from_handle": "+15551111111",
                    "to_handles": ["+15552222222"],
                    "text": "hi",
                },
            ),
        ],
        required_outputs=["sent"],
        first_question_fallback=None,
        world_seed=107,
        max_turns=4,
    ),
    Scenario(
        id="conformance_promoted_message_send",
        name="send a chat message via promoted action",
        domain=Domain.MESSAGES,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="text Alice hi",
        ground_truth_actions=[
            Action(
                name="MESSAGE_SEND",
                kwargs={
                    "source": "imessage",
                    "target": "Alice",
                    "message": "hi",
                },
            ),
        ],
        required_outputs=["sent"],
        first_question_fallback=None,
        world_seed=112,
        max_turns=4,
    ),
    Scenario(
        id="conformance_contacts_add",
        name="add a contact",
        domain=Domain.CONTACTS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="add John Doe to my contacts",
        ground_truth_actions=[
            Action(
                name="CONTACTS.add",
                kwargs={
                    "id": "ct_new_john",
                    "display_name": "John Doe",
                    "given_name": "John",
                    "family_name": "Doe",
                    "primary_email": "john@example.test",
                },
            ),
        ],
        required_outputs=["added"],
        first_question_fallback=None,
        world_seed=108,
        max_turns=4,
    ),
    Scenario(
        id="conformance_reminder_create",
        name="create a reminder",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="remind me to call mom",
        ground_truth_actions=[
            Action(
                name="REMINDER.create",
                kwargs={
                    "reminder_id": "rm_call_mom",
                    "list_id": "rl_main",
                    "title": "call mom",
                },
            ),
        ],
        required_outputs=["reminder", "call mom"],
        first_question_fallback=None,
        world_seed=109,
        max_turns=4,
    ),
    Scenario(
        id="conformance_reminder_complete",
        name="complete a reminder",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="mark ship-the-thing as done",
        ground_truth_actions=[
            Action(
                name="REMINDER.complete", kwargs={"reminder_id": "rm_existing"}
            ),
        ],
        required_outputs=["completed"],
        first_question_fallback=None,
        world_seed=110,
        max_turns=4,
    ),
    Scenario(
        id="conformance_multi_action",
        name="complete a reminder and reply",
        domain=Domain.REMINDERS,
        mode=ScenarioMode.STATIC,
        persona=_PERSONA,
        instruction="finish that task and let the boss know",
        ground_truth_actions=[
            Action(
                name="REMINDER.complete", kwargs={"reminder_id": "rm_existing"}
            ),
            Action(
                name="MAIL.send",
                kwargs={
                    "message_id": "em_done",
                    "thread_id": "th_existing",
                    "from_email": "me@example.test",
                    "to_emails": ["boss@example.test"],
                    "subject": "Re: report",
                    "body_plain": "Done.",
                },
            ),
        ],
        required_outputs=["completed", "Done"],
        first_question_fallback=None,
        world_seed=111,
        max_turns=6,
    ),
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _scenarios_to_test() -> list[Scenario]:
    """All conformance + every executor-supported STATIC registry scenario.

    LIVE scenarios are excluded: they intentionally have no ground-truth
    actions (the LLM judge replaces scripted scoring), so they would always
    look "supported" to this filter and break the suite — and the conformance
    rubric (PerfectAgent must score 1.0, WrongAgent must score 0.0) is only
    well-defined for scripted scenarios.
    """
    supported = supported_actions()
    extra: list[Scenario] = []
    for s in ALL_SCENARIOS:
        if s.mode is not ScenarioMode.STATIC:
            continue
        gt_names = {a.name for a in s.ground_truth_actions}
        if gt_names.issubset(supported):
            extra.append(s)
    return CONFORMANCE_SCENARIOS + extra


def _skipped_registry_scenarios() -> list[tuple[str, set[str]]]:
    """Registry scenarios that the executor can't fully support, with the offending names."""
    supported = supported_actions()
    skipped: list[tuple[str, set[str]]] = []
    for s in ALL_SCENARIOS:
        gt_names = {a.name for a in s.ground_truth_actions}
        unsupported = gt_names - supported
        if unsupported:
            skipped.append((s.id, unsupported))
    return skipped


def _world_factory_for(scenario: Scenario):
    """Pick the world factory matching a scenario's `world_seed`.

    Wave 2A scenarios reference the medium snapshot (seed=2026, ids like
    `event_00040`, `email_000002`, `contact_00001`). Tiny snapshot is
    seed=42. Anything else is an inline conformance fixture (`ev_existing`,
    `ct_boss`, etc.) so we fall back to `_seed_world_for_conformance`.
    """
    if scenario.world_seed in {2026, 42}:
        from eliza_lifeops_bench.lifeworld.snapshots import (
            SNAPSHOT_SPECS,
            build_world_for,
        )

        spec_name = "medium_seed_2026" if scenario.world_seed == 2026 else "tiny_seed_42"
        spec = next(s for s in SNAPSHOT_SPECS if s.name == spec_name)

        def _factory(_seed: int, _now_iso: str):
            return build_world_for(spec)

        return _factory
    return _seed_world_for_conformance


def _run_scenario_sync(
    scenario: Scenario,
    agent_factory,
) -> float:
    """Build a fresh runner + agent, drive the scenario, return the score."""

    async def _run() -> float:
        agent = agent_factory(scenario)

        async def agent_fn(history, tools):
            return await agent(history, tools)

        runner = LifeOpsBenchRunner(
            agent_fn=agent_fn,
            world_factory=_world_factory_for(scenario),
            scenarios=[scenario],
            concurrency=1,
            seeds=1,
            max_cost_usd=10.0,
            per_scenario_timeout_s=15,
        )
        result = await runner.run_one(scenario, scenario.world_seed)
        return result.total_score

    return asyncio.run(_run())


def _diagnose(scenario: Scenario, score: float) -> str:
    """Build a diagnostic when PerfectAgent doesn't reach 1.0."""

    async def _detail() -> str:
        agent = PerfectAgent(scenario)

        async def agent_fn(history, tools):
            return await agent(history, tools)

        runner = LifeOpsBenchRunner(
            agent_fn=agent_fn,
            world_factory=_world_factory_for(scenario),
            scenarios=[scenario],
            concurrency=1,
            seeds=1,
            max_cost_usd=10.0,
            per_scenario_timeout_s=15,
        )
        result = await runner.run_one(scenario, scenario.world_seed)
        emitted = [a for t in result.turns for a in t.agent_actions]
        emitted_summary = [
            (a.name, sorted(a.kwargs.keys())) for a in emitted
        ]
        gt_summary = [
            (a.name, sorted(a.kwargs.keys()))
            for a in scenario.ground_truth_actions
        ]
        substring_misses = [
            req
            for req, hit in zip(scenario.required_outputs, result.output_substring_matches)
            if not hit
        ]
        return (
            f"scenario={scenario.id} score={result.total_score:.3f}\n"
            f"  state_match={result.state_hash_match}\n"
            f"  terminated={result.terminated_reason} error={result.error}\n"
            f"  emitted={emitted_summary}\n"
            f"  ground_truth={gt_summary}\n"
            f"  missing_required_substrings={substring_misses}\n"
        )

    return asyncio.run(_detail())


# ---------------------------------------------------------------------------
# The actual conformance assertions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "scenario",
    _scenarios_to_test(),
    ids=lambda s: s.id,
)
def test_perfect_agent_scores_one(scenario: Scenario) -> None:
    """PerfectAgent must score exactly 1.0 on every supported scenario."""
    score = _run_scenario_sync(scenario, PerfectAgent)
    if score < 0.999:
        pytest.fail(_diagnose(scenario, score))
    assert score == pytest.approx(1.0, abs=1e-6)


@pytest.mark.parametrize(
    "scenario",
    _scenarios_to_test(),
    ids=lambda s: s.id,
)
def test_wrong_agent_garbage_text_scores_zero(scenario: Scenario) -> None:
    """WrongAgent (garbage_text mode) must score exactly 0 on every scenario."""
    score = _run_scenario_sync(
        scenario, lambda s: WrongAgent(scenario=s, mode="garbage_text")
    )
    assert score == pytest.approx(0.0, abs=1e-6), (
        f"garbage_text WrongAgent scored {score:.4f} on {scenario.id} — rubric too lenient"
    )


@pytest.mark.parametrize(
    "scenario",
    _scenarios_to_test(),
    ids=lambda s: s.id,
)
def test_wrong_agent_wrong_action_scores_zero(scenario: Scenario) -> None:
    """WrongAgent (wrong_action mode) must score exactly 0 on every scenario."""
    score = _run_scenario_sync(
        scenario, lambda s: WrongAgent(scenario=s, mode="wrong_action")
    )
    assert score == pytest.approx(0.0, abs=1e-6), (
        f"wrong_action WrongAgent scored {score:.4f} on {scenario.id} — rubric too lenient"
    )


def test_conformance_coverage_table(capsys: pytest.CaptureFixture[str]) -> None:
    """Print a coverage table so the gap between executor + registry is visible."""
    scenarios = _scenarios_to_test()
    skipped = _skipped_registry_scenarios()
    supported = sorted(supported_actions())

    print("\nLifeOpsBench conformance coverage")
    print(f"  supported actions ({len(supported)}): {', '.join(supported)}")
    print(f"  scenarios under conformance: {len(scenarios)}")
    print(f"  inline conformance scenarios: {len(CONFORMANCE_SCENARIOS)}")
    print(f"  registry scenarios included: {len(scenarios) - len(CONFORMANCE_SCENARIOS)}")
    print(f"  registry scenarios skipped:  {len(skipped)}")
    for sid, missing in skipped:
        print(f"    skipped: {sid}  unsupported={sorted(missing)}")

    captured = capsys.readouterr()
    assert "supported actions" in captured.out
    # Sanity: at least the inline conformance scenarios must run.
    assert len(scenarios) >= len(CONFORMANCE_SCENARIOS)
