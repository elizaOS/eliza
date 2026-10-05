"""Tests for tool-call extraction + parameter matching."""

from __future__ import annotations

from elizaos_voiceagentbench.evaluator import (
    score_parameter_match,
    score_tool_selection,
)
from elizaos_voiceagentbench.runner import _extract_tool_calls
from elizaos_voiceagentbench.types import MessageTurn, ToolCallExpectation


def test_extract_lifeops_shape() -> None:
    turn = MessageTurn(
        role="assistant",
        content="",
        tool_calls=[
            {"name": "search", "arguments": {"q": "paris"}},
            {"name": "weather", "kwargs": {"city": "paris"}},
        ],
    )
    calls = _extract_tool_calls(turn)
    assert [c["name"] for c in calls] == ["search", "weather"]
    assert calls[0]["arguments"] == {"q": "paris"}
    assert calls[1]["arguments"] == {"city": "paris"}


def test_extract_openai_shape_with_string_args() -> None:
    turn = MessageTurn(
        role="assistant",
        content="",
        tool_calls=[
            {
                "id": "call_1",
                "function": {"name": "search", "arguments": '{"q":"paris"}'},
            }
        ],
    )
    calls = _extract_tool_calls(turn)
    assert calls == [{"id": "call_1", "name": "search", "arguments": {"q": "paris"}}]


def test_extract_openai_invalid_json_args_becomes_empty() -> None:
    turn = MessageTurn(
        role="assistant",
        content="",
        tool_calls=[{"function": {"name": "x", "arguments": "{not-json"}}],
    )
    calls = _extract_tool_calls(turn)
    assert calls[0]["arguments"] == {}


def test_tool_selection_all_present() -> None:
    expected = [
        ToolCallExpectation(tool_name="a"),
        ToolCallExpectation(tool_name="b"),
    ]
    predicted = [
        {"name": "a", "arguments": {}},
        {"name": "b", "arguments": {}},
    ]
    assert score_tool_selection(expected, predicted) == 1.0


def test_tool_selection_partial() -> None:
    expected = [
        ToolCallExpectation(tool_name="a"),
        ToolCallExpectation(tool_name="b"),
    ]
    predicted = [{"name": "a", "arguments": {}}]
    assert score_tool_selection(expected, predicted) == 0.5


def test_tool_selection_empty_empty() -> None:
    assert score_tool_selection([], []) == 1.0


def test_tool_selection_empty_expected_with_predicted() -> None:
    assert score_tool_selection([], [{"name": "a", "arguments": {}}]) == 0.0


def test_parameter_match_required_exact() -> None:
    expected = [
        ToolCallExpectation(
            tool_name="weather", required_params={"city": "Paris"}
        )
    ]
    predicted = [{"name": "weather", "arguments": {"city": "Paris"}}]
    assert score_parameter_match(expected, predicted, enforce_order=False) == 1.0


def test_parameter_match_substring_case_insensitive() -> None:
    expected = [
        ToolCallExpectation(
            tool_name="weather", substring_params={"when": "tomorrow"}
        )
    ]
    predicted = [
        {"name": "weather", "arguments": {"when": "TOMORROW MORNING"}}
    ]
    assert score_parameter_match(expected, predicted, enforce_order=False) == 1.0


def test_parameter_match_sequential_order_enforced() -> None:
    expected = [
        ToolCallExpectation(tool_name="a", order=0),
        ToolCallExpectation(tool_name="b", order=1),
    ]
    predicted_wrong_order = [
        {"name": "b", "arguments": {}},
        {"name": "a", "arguments": {}},
    ]
    score = score_parameter_match(
        expected, predicted_wrong_order, enforce_order=True
    )
    assert score < 1.0
    score_ok = score_parameter_match(
        expected,
        [
            {"name": "a", "arguments": {}},
            {"name": "b", "arguments": {}},
        ],
        enforce_order=True,
    )
    assert score_ok == 1.0


def test_parameter_match_substring_missing_value() -> None:
    expected = [
        ToolCallExpectation(
            tool_name="x", substring_params={"q": "needle"}
        )
    ]
    predicted = [{"name": "x", "arguments": {}}]
    assert score_parameter_match(expected, predicted, enforce_order=False) == 0.0
