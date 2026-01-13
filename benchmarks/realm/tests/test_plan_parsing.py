"""
Tests for plan response parsing.

The parsing logic is now in the plugin actions module.
"""

import pytest

from benchmarks.realm.plugin.actions import _parse_plan_json
from benchmarks.realm.types import REALMCategory, REALMTask


def _make_task() -> REALMTask:
    return REALMTask(
        id="t-1",
        name="Test",
        description="Test task",
        goal="Do the thing",
        category=REALMCategory.SEQUENTIAL,
        requirements=[],
        constraints={},
        expected_outcome="done",
        available_tools=["a", "b", "c"],
        timeout_ms=1000,
        max_steps=3,
        difficulty="easy",
        metadata={},
    )


def test_parse_plan_response_pure_json() -> None:
    task = _make_task()

    response = (
        '[{"action":"a","description":"step 1","parameters":{"step":1}},'
        '{"action":"b","description":"step 2","parameters":{"flag":true,"items":["x","y"]}}]'
    )
    actions = _parse_plan_json(response, task.available_tools)
    assert [a["action"] for a in actions] == ["a", "b"]
    assert actions[0]["parameters"]["step"] == 1
    assert actions[1]["parameters"]["flag"] is True
    assert actions[1]["parameters"]["items"] == ["x", "y"]


def test_parse_plan_response_code_fence() -> None:
    task = _make_task()

    response = """```json
[
  {"action": "a", "description": "step 1", "parameters": {}}
]
```"""
    actions = _parse_plan_json(response, task.available_tools)
    assert len(actions) == 1
    assert actions[0]["action"] == "a"


def test_parse_plan_response_embedded_json() -> None:
    task = _make_task()

    response = (
        "Here is the plan:\n"
        "[{\"action\":\"a\",\"description\":\"step\",\"parameters\":{\"k\":\"v\"}}]\n"
        "End."
    )
    actions = _parse_plan_json(response, task.available_tools)
    assert len(actions) == 1
    assert actions[0]["parameters"]["k"] == "v"


def test_parse_plan_response_invalid_json_returns_empty() -> None:
    task = _make_task()

    actions = _parse_plan_json("not json", task.available_tools)
    assert actions == []
