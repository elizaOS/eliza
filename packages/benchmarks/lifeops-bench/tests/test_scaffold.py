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
        evaluator_provider="cerebras",
        judge_provider="anthropic",
        timestamp="2026-05-10T00:00:00Z",
        seeds=1,
    )
    assert result.seeds == 1
    assert result.evaluator_provider == "cerebras"
    assert result.judge_provider == "anthropic"


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


def test_cli_evaluator_detection_covers_semantic_static_and_live_filters() -> None:
    from eliza_lifeops_bench.__main__ import _needs_evaluator
    from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID
    from eliza_lifeops_bench.types import Domain, ScenarioMode

    static = SCENARIOS_BY_ID["smoke_static_calendar_01"]
    live = SCENARIOS_BY_ID["smoke_live_mail_01"]

    assert (
        _needs_evaluator(
            [static, live],
            domain=None,
            mode=None,
            static_grading_mode="semantic",
        )
        is True
    )
    assert (
        _needs_evaluator(
            [static, live],
            domain=Domain.CALENDAR,
            mode=ScenarioMode.STATIC,
            static_grading_mode="semantic",
        )
        is True
    )
    assert (
        _needs_evaluator(
            [static, live],
            domain=Domain.MAIL,
            mode=ScenarioMode.LIVE,
            static_grading_mode="offline_conformance",
        )
        is True
    )
    assert (
        _needs_evaluator(
            [static, live],
            domain=Domain.CALENDAR,
            mode=ScenarioMode.STATIC,
            static_grading_mode="offline_conformance",
        )
        is False
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
        evaluator_provider="cerebras",
        judge_provider="anthropic",
        concurrency=2,
        seeds=1,
        max_cost_usd=0.01,
        per_scenario_timeout_s=5,
    )
    assert runner.concurrency == 2
    assert runner.seeds == 1
    assert len(runner.scenarios) == len(ALL_SCENARIOS)
    assert runner.evaluator_model == "gemma-4-31b"
    assert runner.judge_model == "claude-opus-4-7"
    assert runner.evaluator_provider == "cerebras"
    assert runner.judge_provider == "anthropic"


def test_runner_builds_openai_compatible_tool_manifest() -> None:
    import re

    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import build_tool_manifest

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    tools = build_tool_manifest(world)
    tool_names = [tool["function"]["name"] for tool in tools]

    assert "CALENDAR" in tool_names
    assert "CALENDAR_SOURCES" in tool_names
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

    calendar_tool = next(
        tool for tool in tools if tool["function"]["name"] == "CALENDAR"
    )
    calendar_params = calendar_tool["function"]["parameters"]
    assert "startAt" in calendar_params["properties"]
    assert "endAt" in calendar_params["properties"]
    assert calendar_params["required"] == ["subaction"]
    assert calendar_params["properties"]["subaction"]["enum"] == [
        "create_event",
        "update_event",
        "delete_event",
        "propose_times",
        "search_events",
        "check_availability",
        "next_event",
        "update_preferences",
    ]
    source_tool = next(
        tool for tool in tools if tool["function"]["name"] == "CALENDAR_SOURCES"
    )
    source_params = source_tool["function"]["parameters"]
    assert source_params["required"] == ["operation"]
    assert source_params["properties"]["operation"]["enum"] == [
        "list",
        "select",
        "deselect",
        "connect",
        "reconnect",
    ]
    assert {
        "provider",
        "grantId",
        "connectorAccountId",
        "calendarId",
        "expectedVersion",
    }.issubset(source_params["properties"])


def test_calendar_source_executor_exposes_planning_without_fake_connection() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    listed = _execute_action(
        Action(name="CALENDAR_SOURCES", kwargs={"operation": "list"}),
        world,
    )

    assert listed["simulatedOnly"] is True
    assert listed["providerReceipt"] is None
    assert listed["snapshot"]["state"] == "complete"
    assert {source["key"]["provider"] for source in listed["snapshot"]["sources"]} == {
        "apple_calendar",
        "google",
    }

    oauth = _execute_action(
        Action(
            name="CALENDAR_SOURCES",
            kwargs={"operation": "connect", "provider": "google"},
        ),
        world,
    )
    assert oauth == {
        "operation": "connect",
        "connection": {
            "state": "authorization_required",
            "provider": "google",
            "connected": False,
            "handoff": "external_oauth_required",
        },
        "ok": False,
        "simulatedOnly": True,
        "providerReceipt": None,
    }

    source = listed["snapshot"]["sources"][0]
    refused_write = _execute_action(
        Action(
            name="CALENDAR_SOURCES",
            kwargs={
                "operation": "deselect",
                **source["key"],
                "expectedVersion": source["selectionVersion"],
            },
        ),
        world,
    )
    assert refused_write["ok"] is False
    assert refused_write["changed"] is False
    assert refused_write["error"] == "external_source_selection_required"


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


def test_executor_calendar_update_persists_non_time_fields() -> None:
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
                    "newTitle": "Roadmap and launch review",
                    "newLocation": "Room 8",
                    "attendees": ["alex@example.test"],
                },
            },
        ),
        world,
    )

    event = world.calendar_events[result["id"]]
    assert event.title == "Roadmap and launch review"
    assert event.location == "Room 8"
    assert event.attendees == ["alex@example.test"]


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


def test_executor_treats_reply_as_explicit_effectless_terminal() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(Action(name="REPLY", kwargs={"text": "done"}), world)

    assert result == {
        "ok": True,
        "effect": "none",
        "terminal": True,
        "reply": {"text": "done"},
    }


def test_executor_accepts_calendar_delete_alias_with_id() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    target = next(
        event for event in world.calendar_events.values() if event.status != "cancelled"
    )
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
        "noEffect": True,
        "missing_id": "evt_12345",
        "subaction": "delete_event",
    }


def test_executor_resolves_calendar_delete_by_title_when_and_calendar() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "delete_event",
                "calendar": "family",
                "title": "launch checklist sync",
                "when": "next Thursday",
            },
        ),
        world,
    )

    assert result == {"id": "event_00052", "status": "cancelled"}


def test_executor_rejects_unbounded_calendar_availability() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")

    with pytest.raises(KeyError, match="requires startAt/endAt"):
        _execute_action(
            Action(name="CALENDAR", kwargs={"subaction": "check_availability"}),
            world,
        )


def test_executor_accepts_calendar_action_alias_and_camelcase_duration() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    created = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "action": "create_event",
                "title": "review packet",
                "startAt": "2026-05-12T18:00:00Z",
                "durationMinutes": 90,
            },
        ),
        world,
    )
    event = world.calendar_events[created["id"]]
    assert event.end == "2026-05-12T19:30:00Z"

    updated = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "action": "update_event",
                "title": "review packet",
                "startAt": "2026-05-13T18:00:00Z",
                "durationMinutes": 45,
            },
        ),
        world,
    )
    assert updated["id"] == created["id"]
    assert updated["end"] == "2026-05-13T18:45:00Z"


def test_executor_accepts_message_draft_manage_and_room_aliases() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    draft = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "draft_reply",
                "source": "gmail",
                "inReplyToId": "email_000000",
                "replyText": "I will review this today.",
            },
        ),
        world,
    )
    assert draft["folder"] == "drafts"

    archived = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "manage",
                "manage_operation": "archive",
                "id": "email_000001",
            },
        ),
        world,
    )
    assert archived["folder"] == "archive"

    sent = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "operation": "send",
                "source": "slack",
                "targetKind": "channel",
                "channelId": "lifeops-bench",
                "text": "Posted.",
            },
        ),
        world,
    )
    assert sent["conversation_id"] == "lifeops-bench"


def test_executor_accepts_message_subaction_alias() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "subaction": "read_with_contact",
                "source": "signal",
                "contact": "contact_00001",
            },
        ),
        world,
    )

    assert result["ok"] is True
    assert result["effect"] == "none"
    assert result["operation"] == "MESSAGE/read_with_contact"
    assert result["source"] == "signal"
    assert result["matchedContactIds"] == ["contact_00001"]
    assert result["messages"] == []


def test_executor_persists_contact_priority_and_relationship_updates() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    priority = _execute_action(
        Action(
            name="ENTITY",
            kwargs={
                "subaction": "update",
                "name": "Priya Anand",
                "priorityFlag": "vip_breakthrough",
                "notes": "Board member.",
            },
        ),
        world,
    )
    priority_contact = world.contacts[priority["id"]]
    assert priority["created"] is True
    assert priority_contact.priority_flag == "vip_breakthrough"
    assert priority_contact.notes == "Board member."

    relationship = _execute_action(
        Action(
            name="ENTITY",
            kwargs={
                "subaction": "set_relationship",
                "fromEntityId": "self",
                "toEntityId": "person-h1-mia",
                "relationshipType": "family_of",
                "evidence": "family logistics",
                "metadata": {"confidence": "high"},
            },
        ),
        world,
    )
    relationship_contact = world.contacts[relationship["id"]]
    assert relationship["created"] is True
    assert relationship_contact.relationship == "family"
    assert relationship_contact.relationship_type == "family_of"
    assert relationship_contact.relationship_evidence == "family logistics"
    assert relationship_contact.relationship_metadata == {"confidence": "high"}


def test_message_manage_operation_inferred_from_manage_operation() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    archived = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "source": "gmail",
                "manageOperation": "archive",
                "messageId": "email_000001",
            },
        ),
        world,
    )

    assert archived["folder"] == "archive"
    assert world.emails["email_000001"].folder == "archive"


@pytest.mark.parametrize(
    "field",
    ["manageOperation", "manage_operation", "mailOperation", "mail_operation"],
)
def test_message_manage_operation_inferred_from_operation_aliases(field: str) -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    archived = _execute_action(
        Action(
            name="MESSAGE",
            kwargs={
                "source": "gmail",
                field: "archive",
                "messageId": "email_000001",
            },
        ),
        world,
    )

    assert archived["folder"] == "archive"
    assert world.emails["email_000001"].folder == "archive"


@pytest.mark.parametrize("action_name", ["ARCHIVE_EMAIL_THREAD", "ARCHIVE_THREAD"])
def test_archive_thread_alias_matches_message_manage_archive(action_name: str) -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    archived = _execute_action(
        Action(
            name=action_name,
            kwargs={"threadId": "thread_00001"},
        ),
        world,
    )

    assert archived["thread_id"] == "thread_00001"
    assert {"email_000000", "email_000001"}.issubset(set(archived["archived_ids"]))
    assert world.emails["email_000000"].folder == "archive"
    assert world.emails["email_000001"].folder == "archive"


def test_calendar_check_availability_accepts_time_min_max() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    result = _execute_action(
        Action(
            name="CALENDAR",
            kwargs={
                "subaction": "check_availability",
                "timeMin": "2026-05-14T09:00:00Z",
                "timeMax": "2026-05-14T10:00:00Z",
            },
        ),
        world,
    )

    assert result["subaction"] == "check_availability"
    assert result["ok"] is True


def test_executor_accepts_reminder_aliases() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    created = _execute_action(
        Action(
            name="REMINDER.create",
            kwargs={
                "id": "reminder_alias_test",
                "listId": "list_personal",
                "title": "alias test",
                "dueAt": "2026-05-11T09:00:00Z",
            },
        ),
        world,
    )
    assert created["id"] == "reminder_alias_test"

    completed = _execute_action(
        Action(name="REMINDER.complete", kwargs={"target": "reminder_alias_test"}),
        world,
    )
    assert completed["id"] == "reminder_alias_test"

    life_created = _execute_action(
        Action(
            name="LIFE_CREATE",
            kwargs={
                "subaction": "create",
                "kind": "reminder",
                "title": "top level life reminder",
                "listId": "list_personal",
                "dueAt": "2026-05-12T09:00:00Z",
            },
        ),
        world,
    )
    assert world.reminders[life_created["id"]].due_at == "2026-05-12T09:00:00Z"


def test_executor_models_scheduled_tasks_as_first_class_state() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    created = _execute_action(
        Action(
            name="SCHEDULED_TASKS_CREATE",
            kwargs={
                "taskId": "task_alias_test",
                "kind": "reminder",
                "promptInstructions": "Wind down",
                "trigger": {"atIso": "2026-05-10T22:00:00Z"},
                "subject": {"kind": "self", "id": "me"},
                "pipeline": {"onComplete": ["task_followup"]},
            },
        ),
        world,
    )
    assert created["id"] == "task_alias_test"
    task = world.scheduled_tasks["task_alias_test"]
    assert task.prompt_instructions == "Wind down"
    assert task.subject == {"kind": "self", "id": "me"}
    assert task.pipeline == {"onComplete": ["task_followup"]}

    updated = _execute_action(
        Action(
            name="SCHEDULED_TASK_UPDATE",
            kwargs={"taskId": "task_alias_test", "updates": {"priority": "high"}},
        ),
        world,
    )
    assert updated == {"id": "task_alias_test", "state": "active"}
    assert world.scheduled_tasks["task_alias_test"].priority == "high"

    snoozed = _execute_action(
        Action(
            name="SCHEDULED_TASKS_SNOOZE",
            kwargs={"taskId": "task_alias_test", "minutes": 30},
        ),
        world,
    )
    assert snoozed["state"] == "snoozed"
    assert snoozed["trigger"]["atIso"] == "2026-05-10T22:30:00Z"


def test_executor_rejects_mutation_of_missing_scheduled_task() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import _execute_action
    from eliza_lifeops_bench.types import Action

    world = _build_world_factory()(2026, "2026-05-10T12:00:00Z")
    with pytest.raises(KeyError, match="target does not exist"):
        _execute_action(
            Action(
                name="SCHEDULED_TASKS_COMPLETE",
                kwargs={"taskId": "task_unseeded"},
            ),
            world,
        )
    assert "task_unseeded" not in world.scheduled_tasks


def test_corpus_scheduled_task_mutations_target_existing_state() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import (
        _execute_action,
        _normalize_action,
        _scheduled_task_id,
    )
    from eliza_lifeops_bench.scenarios import CORE_SCENARIOS

    direct_mutations = {
        "SCHEDULED_TASK_UPDATE",
        "SCHEDULED_TASK_SNOOZE",
        "SCHEDULED_TASKS_ACKNOWLEDGE",
        "SCHEDULED_TASKS_CANCEL",
        "SCHEDULED_TASKS_COMPLETE",
        "SCHEDULED_TASKS_DISMISS",
        "SCHEDULED_TASKS_REOPEN",
        "SCHEDULED_TASKS_SKIP",
    }
    umbrella_mutations = {
        "update",
        "snooze",
        "acknowledge",
        "cancel",
        "complete",
        "dismiss",
        "reopen",
        "skip",
    }
    world_factory = _build_world_factory()
    checked: list[tuple[str, str]] = []
    all_create_receipt_ids: set[str] = set()

    for scenario in CORE_SCENARIOS:
        actions = [
            _normalize_action(action) for action in scenario.ground_truth_actions
        ]
        if not any(
            action.name in direct_mutations
            or (
                action.name == "SCHEDULED_TASKS"
                and action.kwargs.get("operation") in umbrella_mutations
            )
            for action in actions
        ):
            continue

        world = world_factory(scenario.world_seed, scenario.now_iso)
        initial_task_ids = set(world.scheduled_tasks)
        create_receipt_ids: set[str] = set()
        for action in actions:
            is_create = action.name == "SCHEDULED_TASK_CREATE" or (
                action.name == "SCHEDULED_TASKS"
                and action.kwargs.get("operation") == "create"
            )
            if is_create:
                assert (
                    _scheduled_task_id(action.kwargs) is None
                ), f"{scenario.id} seeds a server-owned scheduled-task id"
                receipt = _execute_action(action, world)
                create_receipt_ids.add(receipt["id"])
                all_create_receipt_ids.add(receipt["id"])
                continue

            is_mutation = action.name in direct_mutations or (
                action.name == "SCHEDULED_TASKS"
                and action.kwargs.get("operation") in umbrella_mutations
            )
            if is_mutation:
                task_id = _scheduled_task_id(action.kwargs)
                assert (
                    task_id in world.scheduled_tasks
                ), f"{scenario.id} mutates missing scheduled task {task_id!r}"
                assert (
                    task_id in initial_task_ids or task_id in create_receipt_ids
                ), f"{scenario.id} mutation id {task_id!r} has no source receipt"
                checked.append((scenario.id, task_id))
            _execute_action(action, world)

    assert checked
    assert all_create_receipt_ids


@pytest.mark.asyncio
async def test_runner_threads_tool_manifest_to_agent_fn() -> None:
    from eliza_lifeops_bench import LifeOpsBenchRunner, MessageTurn
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID

    captured_tool_names: list[str] = []
    captured_user_content: list[str] = []

    async def capture_agent_fn(
        history: list[MessageTurn], tools: list[dict]
    ) -> MessageTurn:
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
        static_grading_mode="offline_conformance",
    )
    await runner.run_one(SCENARIOS_BY_ID["smoke_static_calendar_01"], 2026)

    assert "CALENDAR" in captured_tool_names
    assert all("." not in name for name in captured_tool_names)
    assert captured_user_content
    assert "Current benchmark time: 2026-05-10T12:00:00Z" in captured_user_content[0]
    assert "Sunday, 2026-05-10" in captured_user_content[0]
    assert "Interpret relative dates against this timestamp" in captured_user_content[0]
    assert "Thursday=2026-05-14" in captured_user_content[0]


def test_calendar_thursday_smoke_date_is_explicitly_anchored() -> None:
    from eliza_lifeops_bench.__main__ import _build_world_factory
    from eliza_lifeops_bench.runner import (
        _initial_user_content,
        _parse_calendar_date_hint,
        build_tool_manifest,
    )
    from eliza_lifeops_bench.scenarios import SCENARIOS_BY_ID

    scenario = SCENARIOS_BY_ID["calendar.check_availability_thursday_morning"]
    world = _build_world_factory()(scenario.world_seed, scenario.now_iso)

    assert _parse_calendar_date_hint("thursday", scenario.now_iso).isoformat() == (
        "2026-05-14"
    )

    prompt = _initial_user_content(scenario)
    assert "Current benchmark time: 2026-05-10T12:00:00Z" in prompt
    assert "Thursday=2026-05-14" in prompt

    calendar_tools = {
        tool["function"]["name"]: tool["function"]
        for tool in build_tool_manifest(world)
        if tool["function"]["name"].startswith("CALENDAR")
    }
    for name in ("CALENDAR", "CALENDAR_CHECK_AVAILABILITY"):
        description = calendar_tools[name]["description"]
        assert "bare 'Thursday' resolves to 2026-05-14" in description
        start_at = calendar_tools[name]["parameters"]["properties"]["startAt"]
        assert "bare 'Thursday' resolves to 2026-05-14" in start_at["description"]


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
    exact = [
        Action(name="calendar.create_event", kwargs={"title": "x", "duration": 30})
    ]
    arg_mismatch = [Action(name="calendar.create_event", kwargs={"title": "y"})]
    wrong_name = [Action(name="mail.send", kwargs={})]

    assert compare_actions(exact, gt) == 1.0
    assert compare_actions(arg_mismatch, gt) == 0.5
    assert compare_actions(wrong_name, gt) == 0.0
    assert compare_actions([], []) == 1.0
    assert compare_actions([Action(name="foo", kwargs={})], []) == 0.0
