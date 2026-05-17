"""Tests for plan response parsing."""

from __future__ import annotations

from benchmarks.realm.plugin.actions import _parse_plan_json


def test_parse_plan_response_pure_json() -> None:
    response = (
        '[{"action":"a","description":"step 1","parameters":{"step":1}},'
        '{"action":"b","description":"step 2","parameters":{"flag":true,"items":["x","y"]}}]'
    )
    actions = _parse_plan_json(response, ["a", "b", "c"])
    assert [a["action"] for a in actions] == ["a", "b"]
    assert actions[0]["parameters"]["step"] == 1
    assert actions[1]["parameters"]["flag"] is True
    assert actions[1]["parameters"]["items"] == ["x", "y"]


def test_parse_plan_response_code_fence() -> None:
    response = """```json
[
  {"action": "a", "description": "step 1", "parameters": {}}
]
```"""
    actions = _parse_plan_json(response, ["a", "b", "c"])
    assert len(actions) == 1
    assert actions[0]["action"] == "a"


def test_parse_plan_response_embedded_json() -> None:
    response = (
        "Here is the plan:\n"
        "[{\"action\":\"a\",\"description\":\"step\",\"parameters\":{\"k\":\"v\"}}]\n"
        "End."
    )
    actions = _parse_plan_json(response, ["a", "b", "c"])
    assert len(actions) == 1
    assert actions[0]["parameters"]["k"] == "v"


def test_parse_plan_response_invalid_json_returns_empty() -> None:
    actions = _parse_plan_json("not json", ["a", "b", "c"])
    assert actions == []
