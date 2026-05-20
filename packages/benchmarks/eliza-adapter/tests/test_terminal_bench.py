"""Tests for Eliza Terminal-Bench command extraction."""

from eliza_adapter.terminal_bench import _extract_command


def test_extract_command_accepts_single_valid_xml_tag() -> None:
    text = "Use a <command> block.<command>ls -R /app</command>"

    assert _extract_command(text) == "ls -R /app"


def test_extract_command_joins_multiple_xml_tags_in_sequence() -> None:
    text = "<command>pwd</command><command>ls -R /app</command>"

    assert _extract_command(text) == "pwd\nls -R /app"


def test_extract_command_caps_multi_command_bursts() -> None:
    text = "".join(f"<command>cmd{i}</command>" for i in range(5))

    assert _extract_command(text) == "cmd0\ncmd1\ncmd2"


def test_extract_command_accepts_json_cmd_array() -> None:
    text = '{"cmd":["bash","-lc","cat /app/deps/clue.txt"]}'

    assert _extract_command(text) == "cat /app/deps/clue.txt"


def test_extract_command_accepts_json_command_string() -> None:
    text = '{"command":"printf hi > /app/results.txt"}'

    assert _extract_command(text) == "printf hi > /app/results.txt"
