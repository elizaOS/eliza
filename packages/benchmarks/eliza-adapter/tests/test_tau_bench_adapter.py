"""Contract tests for translating Eliza benchmark responses into tau-bench actions."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from eliza_adapter.tau_bench import (
    _eliza_reply_aliases_from_response,
    _message_to_action,
)
from elizaos_tau_bench.types import RESPOND_ACTION_FIELD_NAME, RESPOND_ACTION_NAME


def _tool_message(
    name: str, arguments: dict[str, object], content: str = ""
) -> dict[str, object]:
    return {
        "content": content,
        "tool_calls": [
            {
                "function": {
                    "name": name,
                    "arguments": json.dumps(arguments),
                }
            }
        ],
    }


def test_respond_text_alias_is_normalized_to_upstream_content_contract() -> None:
    action = _message_to_action(
        _tool_message(RESPOND_ACTION_NAME, {"text": "The exchange is complete."})
    )

    assert action.name == RESPOND_ACTION_NAME
    assert action.kwargs == {RESPOND_ACTION_FIELD_NAME: "The exchange is complete."}


def test_respond_prefers_official_content_field_over_bridge_alias() -> None:
    action = _message_to_action(
        _tool_message(
            RESPOND_ACTION_NAME,
            {"content": "Official reply", "text": "Bridge reply"},
            content="Visible reply",
        )
    )

    assert action.kwargs == {RESPOND_ACTION_FIELD_NAME: "Official reply"}


def test_respond_uses_visible_message_when_tool_arguments_have_no_reply() -> None:
    action = _message_to_action(
        _tool_message(RESPOND_ACTION_NAME, {}, content="Visible reply")
    )

    assert action.kwargs == {RESPOND_ACTION_FIELD_NAME: "Visible reply"}


def test_eliza_send_message_capture_is_normalized_to_respond() -> None:
    action = _message_to_action(
        _tool_message(
            "send_message",
            {"text": "The exchange is complete."},
            content="The exchange is complete.",
        ),
        eliza_reply_aliases=frozenset({"send_message"}),
    )

    assert action.name == RESPOND_ACTION_NAME
    assert action.kwargs == {RESPOND_ACTION_FIELD_NAME: "The exchange is complete."}


def test_unproven_send_message_is_not_rewritten() -> None:
    action = _message_to_action(
        _tool_message("send_message", {"text": "Use the real tool."})
    )

    assert action.name == "send_message"
    assert action.kwargs == {"text": "Use the real tool."}


def test_allowed_send_message_tool_wins_over_eliza_reply_alias() -> None:
    action = _message_to_action(
        _tool_message("send_message", {"text": "Use the real tool."}),
        allowed_tool_names=frozenset({"send_message"}),
        eliza_reply_aliases=frozenset({"send_message"}),
    )

    assert action.name == "send_message"


def test_reply_alias_requires_benchmark_action_provenance() -> None:
    proven = SimpleNamespace(
        params={
            "BENCHMARK_ACTION": {
                "tool_name": "send_message",
                "operation": "REPLY",
                "arguments": {"text": "Complete."},
            }
        }
    )
    unrelated = SimpleNamespace(
        params={
            "BENCHMARK_ACTION": {
                "tool_name": "send_message",
                "operation": "TYPE",
                "command": "type_text",
            }
        }
    )

    assert _eliza_reply_aliases_from_response(proven) == frozenset({"send_message"})
    assert _eliza_reply_aliases_from_response(unrelated) == frozenset()


def test_non_respond_tool_arguments_are_preserved() -> None:
    action = _message_to_action(_tool_message("get_order_details", {"order_id": "1"}))

    assert action.name == "get_order_details"
    assert action.kwargs == {"order_id": "1"}


@pytest.mark.parametrize(
    "message",
    [
        _tool_message(RESPOND_ACTION_NAME, {}),
        {"content": ""},
    ],
)
def test_empty_assistant_reply_fails_before_tau_environment_step(
    message: dict[str, object],
) -> None:
    with pytest.raises(ValueError, match="requires non-empty content"):
        _message_to_action(message)
