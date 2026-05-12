"""Scaffold smoke tests — confirm the package imports and core types instantiate."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


def test_package_imports() -> None:
    import eliza_lifeops_bench

    assert hasattr(eliza_lifeops_bench, "LifeOpsBenchRunner")
    assert hasattr(eliza_lifeops_bench, "Scenario")
    assert hasattr(eliza_lifeops_bench, "BenchmarkResult")


def test_core_types_instantiate() -> None:
    from eliza_lifeops_bench import (
        Action,
        BenchmarkResult,
        Domain,
        FirstQuestionFallback,
        MessageTurn,
        Persona,
        Scenario,
        ScenarioMode,
    )

    action = Action(name="calendar.create_event", kwargs={"title": "test"})
    assert action.name == "calendar.create_event"
    assert action.kwargs["title"] == "test"

    fallback = FirstQuestionFallback(
        canned_answer="primary",
        applies_when="agent asks for calendar",
    )

    persona = Persona(
        id="p1",
        name="Tester",
        traits=["concise"],
        background="bg",
        communication_style="terse",
    )

    scenario = Scenario(
        id="s1",
        name="test",
        domain=Domain.CALENDAR,
        mode=ScenarioMode.STATIC,
        persona=persona,
        instruction="do thing",
        ground_truth_actions=[action],
        required_outputs=["done"],
        first_question_fallback=fallback,
        world_seed=42,
    )
    assert scenario.id == "s1"
    assert scenario.mode is ScenarioMode.STATIC

    turn = MessageTurn(role="assistant", content="ok")
    assert turn.role == "assistant"

    result = BenchmarkResult(
        scenarios=[],
        pass_at_1=0.0,
        pass_at_k=0.0,
        mean_score_per_domain={},
        total_cost_usd=0.0,
        total_latency_ms=0,
        model_name="gpt-oss-120b",
        judge_model_name="claude-opus-4-7",
        timestamp="2026-05-10T00:00:00Z",
        seeds=1,
    )
    assert result.seeds == 1


def test_smoke_scenarios_load() -> None:
    from eliza_lifeops_bench.scenarios import (
        ALL_SCENARIOS,
        SCENARIOS_BY_DOMAIN,
        SCENARIOS_BY_ID,
    )
    from eliza_lifeops_bench.types import Domain, ScenarioMode

    assert len(ALL_SCENARIOS) >= 2
    assert "smoke_static_calendar_01" in SCENARIOS_BY_ID
    assert "smoke_live_mail_01" in SCENARIOS_BY_ID

    static = SCENARIOS_BY_ID["smoke_static_calendar_01"]
    live = SCENARIOS_BY_ID["smoke_live_mail_01"]
    assert static.mode is ScenarioMode.STATIC
    assert live.mode is ScenarioMode.LIVE
    assert static.first_question_fallback is not None

    assert Domain.CALENDAR in SCENARIOS_BY_DOMAIN
    assert Domain.MAIL in SCENARIOS_BY_DOMAIN


def test_cli_live_evaluator_detection_respects_filters() -> None:
    from eliza_lifeops_bench.__main__ import _needs_live_evaluator
    from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID
    from eliza_lifeops_bench.types import Domain, ScenarioMode

    static = SCENARIOS_BY_ID["smoke_static_calendar_01"]
    live = SCENARIOS_BY_ID["smoke_live_mail_01"]

    assert _needs_live_evaluator([static, live], domain=None, mode=None) is True
    assert (
        _needs_live_evaluator(
            [static, live], domain=Domain.CALENDAR, mode=ScenarioMode.STATIC
        )
        is False
    )
    assert (
        _needs_live_evaluator(
            [static, live], domain=Domain.MAIL, mode=ScenarioMode.LIVE
        )
        is True
    )


def test_runner_instantiates_with_noop_agent_fn() -> None:
    from eliza_lifeops_bench import LifeOpsBenchRunner, MessageTurn
    from eliza_lifeops_bench.scenarios import ALL_SCENARIOS

    noop_agent_fn = AsyncMock(return_value=MessageTurn(role="assistant", content=""))

    def world_factory(seed: int) -> object:
        raise NotImplementedError("LifeWorld stub — not invoked by this test")

    runner = LifeOpsBenchRunner(
        agent_fn=noop_agent_fn,
        world_factory=world_factory,  # type: ignore[arg-type]
        scenarios=ALL_SCENARIOS,
        concurrency=2,
        seeds=1,
        max_cost_usd=0.01,
        per_scenario_timeout_s=5,
    )
    assert runner.concurrency == 2
    assert runner.seeds == 1
    assert len(runner.scenarios) == len(ALL_SCENARIOS)
    assert runner.evaluator_model == "gpt-oss-120b"
    assert runner.judge_model == "claude-opus-4-7"


def test_runner_builds_openai_compatible_tool_manifest() -> None:
    import re

    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import build_tool_manifest

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    tools = build_tool_manifest(world)
    tool_names = [tool["function"]["name"] for tool in tools]

    assert "CALENDAR" in tool_names
    assert "MESSAGE" in tool_names
    assert "SCHEDULED_TASK_CREATE" in tool_names
    assert "CALENDAR.create" not in tool_names
    assert len(tools) >= 20

    name_re = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
    for tool in tools:
        function = tool["function"]
        assert name_re.fullmatch(function["name"])
        assert function["description"]
        assert function["parameters"]["type"] == "object"


def test_executor_accepts_promoted_calendar_alias_without_subaction() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR_CREATE_EVENT",
            kwargs={
                "title": "deep work",
                "start_time": "2026-05-12T10:00:00Z",
                "duration_minutes": 30,
            },
        ),
        world,
    )

    assert result["title"] == "deep work"
    assert any(event.title == "deep work" for event in world.calendar_events.values())
    repeated = _execute_action(
        Action(
            name="CALENDAR_CREATE_EVENT",
            kwargs={
                "title": "deep work",
                "start_time": "2026-05-12T10:00:00Z",
                "duration_minutes": 30,
            },
        ),
        world,
    )
    assert repeated["id"] == result["id"]
    assert repeated["idempotent"] is True


def test_executor_resolves_calendar_update_alias_by_title() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    target = world.calendar_events["event_00040"]
    result = _execute_action(
        Action(
            name="CALENDAR_UPDATE_EVENT",
            kwargs={
                "event_name": target.title,
                "new_start": "2026-05-11T15:00:00Z",
                "duration_hours": 2,
            },
        ),
        world,
    )

    assert result["id"] == target.id
    assert result["start"] == "2026-05-11T15:00:00Z"
    assert result["end"] == "2026-05-11T17:00:00Z"


def test_executor_resolves_calendar_update_alias_by_title_and_date_hint() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR_UPDATE_EVENT",
            kwargs={
                "event_name": "Sync: the migration plan",
                "date": "2026-05-12T00:00:00Z",
                "new_start": "2026-05-12T16:00:00Z",
                "duration_minutes": 45,
            },
        ),
        world,
    )

    assert result["id"] == "event_00092"
    assert result["start"] == "2026-05-12T16:00:00Z"
    assert result["end"] == "2026-05-12T16:45:00Z"


def test_executor_resolves_calendar_update_alias_by_fuzzy_title_and_date_hint() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR_UPDATE_EVENT",
            kwargs={
                "event_name": "roadmap",
                "date": "2026-05-10T00:00:00Z",
                "new_start": "2026-05-10T15:00:00Z",
                "duration_hours": 2,
            },
        ),
        world,
    )

    assert result["id"] == "event_00040"
    assert result["start"] == "2026-05-10T15:00:00Z"
    assert result["end"] == "2026-05-10T17:00:00Z"


def test_executor_resolves_calendar_update_when_event_id_is_title() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "update_event",
                "eventId": "Sync: the roadmap",
                "newStart": "2026-05-10T15:00:00Z",
                "newEnd": "2026-05-10T17:00:00Z",
            },
        ),
        world,
    )

    assert result["id"] == "event_00040"
    assert result["start"] == "2026-05-10T15:00:00Z"
    assert result["end"] == "2026-05-10T17:00:00Z"


def test_executor_resolves_calendar_update_with_updates_object() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR_UPDATE_EVENT",
            kwargs={
                "event_id": "event_00040",
                "updates": {
                    "start": "2026-05-10T15:00:00Z",
                    "end": "2026-05-10T17:00:00Z",
                },
            },
        ),
        world,
    )

    assert result["id"] == "event_00040"
    assert result["start"] == "2026-05-10T15:00:00Z"
    assert result["end"] == "2026-05-10T17:00:00Z"


def test_executor_calendar_search_returns_matching_events() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "search_events",
                "query": "roadmap",
                "date": "2026-05-10",
            },
        ),
        world,
    )

    assert result["ok"] is True
    assert [event["id"] for event in result["events"]] == ["event_00040"]


def test_executor_treats_reply_as_terminal_noop() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(Action(name="REPLY", kwargs={"text": "done"}), world)

    assert result == {"ok": True, "noop": True, "reply": {"text": "done"}}


def test_executor_accepts_calendar_delete_alias_with_id() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    target = next(event for event in world.calendar_events.values() if event.status != "cancelled")
    result = _execute_action(
        Action(name="CALENDAR_DELETE_EVENT", kwargs={"id": target.id}),
        world,
    )

    assert result == {"id": target.id, "status": "cancelled"}
    missing = _execute_action(
        Action(name="CALENDAR_DELETE_EVENT", kwargs={"id": "evt_12345"}),
        world,
    )
    assert missing == {
        "ok": False,
        "noop": True,
        "missing_id": "evt_12345",
        "subaction": "delete_event",
    }


@pytest.mark.asyncio
async def test_runner_threads_tool_manifest_to_agent_fn() -> None:
    from eliza_lifeops_bench import LifeOpsBenchRunner, MessageTurn
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID

    captured_tool_names: list[str] = []
    captured_user_content: list[str] = []

    async def capture_agent_fn(history: list[MessageTurn], tools: list[dict]) -> MessageTurn:
        captured_user_content.append(history[0].content)
        captured_tool_names.extend(tool["function"]["name"] for tool in tools)
        return MessageTurn(role="assistant", content="done")

    runner = LifeOpsBenchRunner(
        agent_fn=capture_agent_fn,
        world_factory=_build_world_factory(),
        scenarios=[SCENARIOS_BY_ID["smoke_static_calendar_01"]],
        concurrency=1,
        seeds=1,
        max_cost_usd=0.01,
    )
    await runner.run_one(SCENARIOS_BY_ID["smoke_static_calendar_01"], 2026)

    assert "CALENDAR" in captured_tool_names
    assert all("." not in name for name in captured_tool_names)
    assert captured_user_content
    assert "Current benchmark time: 2026-05-10T12:00:00Z" in captured_user_content[0]
    assert "Interpret relative dates against this timestamp" in captured_user_content[0]


def test_pass_at_k_formula() -> None:
    from eliza_lifeops_bench.scorer import pass_at_k

    assert pass_at_k(c=0, n=10, k=1) == 0.0
    assert pass_at_k(c=10, n=10, k=1) == 1.0
    # 5 correct of 10, k=1 → 50% chance one sample is correct
    assert pass_at_k(c=5, n=10, k=1) == pytest.approx(0.5)
    # 1 correct of 10, k=10 → certain to include it
    assert pass_at_k(c=1, n=10, k=10) == 1.0


def test_compare_actions_partial_credit() -> None:
    from eliza_lifeops_bench.scorer import compare_actions
    from eliza_lifeops_bench.types import Action

    gt = [Action(name="calendar.create_event", kwargs={"title": "x", "duration": 30})]
    exact = [Action(name="calendar.create_event", kwargs={"title": "x", "duration": 30})]
    arg_mismatch = [Action(name="calendar.create_event", kwargs={"title": "y"})]
    wrong_name = [Action(name="mail.send", kwargs={})]

    assert compare_actions(exact, gt) == 1.0
    assert compare_actions(arg_mismatch, gt) == 0.5
    assert compare_actions(wrong_name, gt) == 0.0
    assert compare_actions([], []) == 1.0
    assert compare_actions([Action(name="foo", kwargs={})], []) == 0.0
