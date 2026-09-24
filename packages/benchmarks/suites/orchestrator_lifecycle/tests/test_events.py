"""Tests for typed lifecycle-event extraction from bridge responses."""

from __future__ import annotations

import json

import pytest

from benchmarks.orchestrator_lifecycle.events import extract_lifecycle_events


def test_leaf_action_names_map_to_events() -> None:
    assert extract_lifecycle_events(["CANCEL_TASK"]) == ["cancel"]
    assert extract_lifecycle_events(["PAUSE_TASK"]) == ["pause"]
    assert extract_lifecycle_events(["RESUME_TASK"]) == ["resume"]
    assert extract_lifecycle_events(["SPAWN_AGENT"]) == ["spawn"]
    assert extract_lifecycle_events(["LIST_AGENTS"]) == ["status_query"]
    assert extract_lifecycle_events(["TASK_SHARE"]) == ["share"]
    assert extract_lifecycle_events(["SEND_TO_AGENT"]) == ["send"]


def test_pattern_c_tasks_action_uses_operation_params() -> None:
    # The runtime's TASKS parent action carries the operation in params.
    assert extract_lifecycle_events(["TASKS"], {"action": "cancel"}) == ["cancel"]
    assert extract_lifecycle_events(["TASKS"], {"op": "create"}) == ["spawn"]
    assert extract_lifecycle_events(
        ["TASKS"], {"action": "control", "operation": "pause"}
    ) == ["pause"]
    # The real runtime control param is `controlAction` (action=control).
    assert extract_lifecycle_events(
        ["TASKS"], {"action": "control", "controlAction": "pause"}
    ) == ["pause"]
    assert extract_lifecycle_events(
        ["TASKS"], {"action": "control", "controlAction": "resume"}
    ) == ["resume"]
    # Nested per-action param dicts (BENCHMARK_ACTIONS style) are scanned too.
    assert extract_lifecycle_events(
        [], {"BENCHMARK_ACTIONS": [{"action": "resume"}, {"action": "send"}]}
    ) == ["resume", "send"]


def test_tasks_tool_calls_preserve_multiple_sequential_lifecycle_events() -> None:
    params = {
        "tool_calls": [
            {
                "id": "call-1",
                "name": "TASKS",
                "arguments": '{"action":"spawn_agent","task":"fix tests"}',
            },
            {
                "id": "call-2",
                "name": "TASKS",
                "arguments": {"action": "list_agents"},
            },
        ]
    }

    assert extract_lifecycle_events(["TASKS", "TASKS"], params) == [
        "spawn",
        "status_query",
    ]


def test_malformed_serialized_tool_arguments_fail_loudly() -> None:
    with pytest.raises(json.JSONDecodeError):
        extract_lifecycle_events(
            ["TASKS"],
            {"tool_calls": [{"name": "TASKS", "arguments": "{"}]},
        )


def test_unmapped_names_and_prose_produce_no_events() -> None:
    assert extract_lifecycle_events(["REPLY"]) == []
    assert extract_lifecycle_events(["REPLY", "IGNORE"], {"text": "cancelled"}) == []
    assert extract_lifecycle_events([], {"note": "I paused and cancelled it"}) == []


def test_trajectory_snapshot_params_are_ignored() -> None:
    # The bridge attaches the full prior trajectory to params; events from
    # earlier turns must not leak into the current turn.
    params = {
        "_eliza_trajectory_snapshot": {
            "steps": [{"actions": ["CANCEL_TASK"], "params": {"action": "cancel"}}]
        },
        "eliza_metadata": {"action": "pause"},
        "usage": {"action": "resume"},
    }
    assert extract_lifecycle_events(["REPLY"], params) == []


def test_events_deduplicate_and_preserve_order() -> None:
    events = extract_lifecycle_events(
        ["CANCEL_TASK", "STOP_TASK"], {"action": "cancel", "op": "history"}
    )
    assert events == ["cancel", "status_query"]
