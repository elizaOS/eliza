"""Regression tests for ``parse_openclaw_tool_calls``.

OpenClaw's gpt-oss-120b output sometimes emits an opening ``<tool_call>``
followed by a JSON body but no closing tag (occasionally with trailing
prose appended). The parser must recover these via a brace-balanced
fallback so the action is not silently dropped to ``[]``.
"""

from __future__ import annotations

from openclaw_adapter.client import parse_openclaw_tool_calls


def test_well_formed_single_tool_call() -> None:
    text = (
        'prefix prose.<tool_call>{"tool": "MESSAGE", "args": {"q": "hi"}}'
        "</tool_call>"
    )
    leading, calls = parse_openclaw_tool_calls(text)
    assert leading == "prefix prose."
    assert len(calls) == 1
    assert calls[0]["name"] == "MESSAGE"
    assert calls[0]["arguments"] == {"q": "hi"}
    assert calls[0]["id"] == "call_openclaw_0"


def test_well_formed_multiple_tool_calls() -> None:
    text = (
        'p1.<tool_call>{"tool": "A", "args": {"x": 1}}</tool_call>'
        ' middle <tool_call>{"tool": "B", "args": {"y": 2}}</tool_call>'
    )
    leading, calls = parse_openclaw_tool_calls(text)
    assert leading == "p1."
    assert [c["name"] for c in calls] == ["A", "B"]
    assert calls[0]["arguments"] == {"x": 1}
    assert calls[1]["arguments"] == {"y": 2}


def test_unclosed_tool_call_at_end_of_text() -> None:
    """The original W1-3 failing pattern: opener + JSON + no closer."""
    text = (
        "We need to call MESSAGE.<tool_call>"
        '{"tool": "MESSAGE", "args": {"operation": "search_inbox",'
        ' "query": "from:approvals@example.test"}}'
    )
    leading, calls = parse_openclaw_tool_calls(text)
    assert leading == "We need to call MESSAGE."
    assert len(calls) == 1
    assert calls[0]["name"] == "MESSAGE"
    assert calls[0]["arguments"]["operation"] == "search_inbox"
    assert calls[0]["arguments"]["query"] == "from:approvals@example.test"


def test_unclosed_tool_call_with_trailing_prose() -> None:
    """The exact production failure: opener + JSON + prose, never closes."""
    text = (
        'We will search inbox.<tool_call>{"tool": "MESSAGE", "args":'
        ' {"operation": "search_inbox", "source": "gmail",'
        ' "query": "subject:\\"Quarterly Review\\""}}'
        "The task is complete. The thread with subject Quarterly Review"
        " has been archived."
    )
    leading, calls = parse_openclaw_tool_calls(text)
    assert leading == "We will search inbox."
    assert len(calls) == 1
    assert calls[0]["name"] == "MESSAGE"
    assert calls[0]["arguments"]["operation"] == "search_inbox"
    assert calls[0]["arguments"]["query"] == 'subject:"Quarterly Review"'


def test_malformed_json_inside_tool_call_returns_empty() -> None:
    """An opener with non-JSON garbage must not crash; return empty list."""
    text = "<tool_call>{not json at all"
    leading, calls = parse_openclaw_tool_calls(text)
    assert calls == []
    assert leading == ""


def test_nested_json_objects_brace_balancing() -> None:
    """Nested ``{...}`` inside args must not terminate the slice prematurely."""
    text = (
        '<tool_call>{"tool": "PLAN", "args": {"steps":'
        ' [{"id": 1, "meta": {"k": "v"}}, {"id": 2}]}}'
        " trailing prose"
    )
    _, calls = parse_openclaw_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["name"] == "PLAN"
    assert calls[0]["arguments"]["steps"][0]["meta"] == {"k": "v"}


def test_string_with_escaped_quotes_inside_body() -> None:
    """``\\"`` inside a JSON string must not toggle string-mode tracking."""
    text = (
        '<tool_call>{"tool": "ECHO", "args": {"msg":'
        ' "she said \\"hi\\" and {left}"}}'
    )
    _, calls = parse_openclaw_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["arguments"]["msg"] == 'she said "hi" and {left}'


def test_no_tool_call_text_only_returns_empty() -> None:
    text = "Just a plain message with no tool call markers."
    leading, calls = parse_openclaw_tool_calls(text)
    assert leading == text
    assert calls == []


def test_opener_with_no_json_body_returns_empty() -> None:
    """``<tool_call>`` followed by no ``{`` body must not blow up."""
    text = "thinking<tool_call> "
    leading, calls = parse_openclaw_tool_calls(text)
    assert calls == []
    assert leading == "thinking"


def test_unclosed_tool_call_with_invalid_name_dropped() -> None:
    """Recovered unclosed payload missing ``tool``/``name`` is dropped."""
    text = '<tool_call>{"args": {"x": 1}}trailing'
    _, calls = parse_openclaw_tool_calls(text)
    assert calls == []


def test_closed_block_preferred_over_unclosed_fallback() -> None:
    """If Pass 1 finds anything, Pass 2 must not also fire."""
    text = (
        'p.<tool_call>{"tool": "GOOD", "args": {"a": 1}}</tool_call>'
        ' tail <tool_call>{"tool": "ALSO_UNCLOSED"'
    )
    _, calls = parse_openclaw_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["name"] == "GOOD"


def test_arguments_accepts_arguments_alias() -> None:
    """Some emitters use ``arguments`` instead of ``args``."""
    text = (
        '<tool_call>{"name": "X", "arguments": {"k": "v"}}'
        "more text"
    )
    _, calls = parse_openclaw_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["name"] == "X"
    assert calls[0]["arguments"] == {"k": "v"}
