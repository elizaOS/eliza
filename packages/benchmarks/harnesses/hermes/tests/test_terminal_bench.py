"""Tests for Hermes Terminal-Bench native tool-call handling."""

from __future__ import annotations

from hermes_adapter.terminal_bench import _extract_command_from_tool_calls


def test_terminal_extracts_native_bash_tool_call() -> None:
    command = _extract_command_from_tool_calls(
        {
            "tool_calls": [
                {
                    "id": "call_1",
                    "name": "bash",
                    "arguments": '{"command":"pytest -q"}',
                }
            ]
        }
    )

    assert command == "pytest -q"


def test_terminal_does_not_accept_text_embedded_command_protocol() -> None:
    command = _extract_command_from_tool_calls(
        {
            "tool_calls": [],
            "text": "<" + "command>pytest -q</" + "command>",
        }
    )

    assert command is None
