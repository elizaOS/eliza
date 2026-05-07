from __future__ import annotations

import json

from scripts.prepare_native_tool_calling_data import (
    native_record_from_eliza,
    source_matrix,
    validate_native_record,
)


def _entry(slug: str = "hermes-fc-v1", normalizer: str = "hermes_fc") -> dict:
    return {
        "slug": slug,
        "repo_id": "example/source",
        "normalizer": normalizer,
        "license": "mit",
        "priority": "core",
        "weight": 1.0,
        "est_size_gb": 0.1,
    }


def test_legacy_task_call_unwraps_to_native_planner_call() -> None:
    expected = {
        "thought": "Need weather data before replying.",
        "actions": [
            {
                "name": "TASK_CALL",
                "params": {
                    "tool": "get_weather",
                    "arguments": {"city": "Los Angeles"},
                },
            }
        ],
        "providers": [],
        "text": "",
        "simple": False,
    }
    record = {
        "roomName": "room",
        "agentId": "agent",
        "memoryEntries": [],
        "currentMessage": {"role": "user", "content": "weather in LA?"},
        "expectedResponse": json.dumps(expected),
        "availableActions": ["REPLY", "TASK_CALL"],
        "metadata": {
            "task_type": "tool_call",
            "source_dataset": "hermes-fc-v1",
            "split": "train",
            "license": "mit",
        },
    }

    native, error = native_record_from_eliza(record, _entry(), decoder=None)

    assert error is None
    assert native is not None
    assert native["stage"] == "planner"
    call = native["output"]["planner"]["toolCalls"][0]
    assert call["name"] == "get_weather"
    assert call["args"] == {"city": "Los Angeles"}
    tool_names = {t["function"]["name"] for t in native["tools"]}
    assert "get_weather" in tool_names
    assert validate_native_record(native) == (True, "")


def test_routing_row_converts_to_message_handler_schema() -> None:
    expected = {
        "name": "agent",
        "reasoning": "The user is asking for scheduling help.",
        "action": "RESPOND",
        "primaryContext": "calendar",
        "secondaryContexts": ["contacts"],
        "evidenceTurnIds": [],
    }
    record = {
        "roomName": "room",
        "agentId": "agent",
        "memoryEntries": [],
        "currentMessage": {"role": "user", "content": "schedule lunch with Sam"},
        "expectedResponse": json.dumps(expected),
        "availableActions": ["RESPOND", "IGNORE", "STOP"],
        "metadata": {
            "task_type": "should_respond",
            "source_dataset": "scambench",
            "split": "validation",
            "license": "mit",
        },
    }

    native, error = native_record_from_eliza(
        record,
        _entry("scambench", "scambench_passthrough"),
        decoder=None,
    )

    assert error is None
    assert native is not None
    assert native["stage"] == "message_handler"
    result = native["output"]["messageHandler"]
    assert result["action"] == "RESPOND"
    assert result["contexts"] == ["calendar", "contacts"]
    assert result["simple"] is False
    assert "evidenceTurnIds" not in result


def test_source_matrix_marks_missing_local_path() -> None:
    rows = source_matrix([
        {
            "slug": "nubilio-trajectories",
            "local_path": "local-corpora/not-present",
            "normalizer": "nubilio_trajectories",
            "license": "proprietary",
            "priority": "core",
            "weight": 3.0,
        }
    ])

    assert rows[0]["raw_status"] == "local_missing"
    assert rows[0]["default_include"] is False
    assert any("local_path is missing" in w for w in rows[0]["weaknesses"])
