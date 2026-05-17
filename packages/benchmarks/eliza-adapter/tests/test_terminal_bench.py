"""Tests for Eliza Terminal-Bench command extraction."""

from eliza_adapter.terminal_bench import _extract_command


def test_extract_command_uses_last_valid_xml_tag() -> None:
    text = "Use a <command> block.<command>ls -R /app</command>"

    assert _extract_command(text) == "ls -R /app"


def test_extract_command_accepts_json_cmd_array() -> None:
    text = '{"cmd":["bash","-lc","cat /app/deps/clue.txt"]}'

    assert _extract_command(text) == "cat /app/deps/clue.txt"


def test_extract_command_accepts_json_command_string() -> None:
    text = '{"command":"printf hi > /app/results.txt"}'

    assert _extract_command(text) == "printf hi > /app/results.txt"
