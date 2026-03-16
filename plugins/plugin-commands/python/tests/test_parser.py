"""Tests for the command parser module."""

from __future__ import annotations

from elizaos_plugin_commands.parser import (
    extract_command_args,
    is_command,
    normalize_command_name,
    parse_command,
)


# ── is_command ────────────────────────────────────────────────────────────


class TestIsCommand:
    def test_slash_prefix(self) -> None:
        assert is_command("/help")
        assert is_command("/status")
        assert is_command("/stop now")
        assert is_command("/models")
        assert is_command("/commands")

    def test_bang_prefix(self) -> None:
        assert is_command("!help")
        assert is_command("!stop")
        assert is_command("!bash ls -la")

    def test_negative_cases(self) -> None:
        assert not is_command("hello world")
        assert not is_command("")
        assert not is_command("   ")
        assert not is_command("just some text")
        assert not is_command("123")
        assert not is_command("/ no_good")

    def test_leading_whitespace(self) -> None:
        assert is_command("  /help")
        assert is_command("\t/status")


# ── parse_command ─────────────────────────────────────────────────────────


class TestParseCommand:
    def test_simple_command(self) -> None:
        parsed = parse_command("/help")
        assert parsed is not None
        assert parsed.name == "help"
        assert parsed.args == []
        assert parsed.raw_text == "/help"

    def test_command_with_args(self) -> None:
        parsed = parse_command("/model gpt-4 fast")
        assert parsed is not None
        assert parsed.name == "model"
        assert parsed.args == ["gpt-4", "fast"]

    def test_colon_separator(self) -> None:
        parsed = parse_command("/think:high")
        assert parsed is not None
        assert parsed.name == "think"
        assert parsed.args == ["high"]

    def test_bang_prefix(self) -> None:
        parsed = parse_command("!stop")
        assert parsed is not None
        assert parsed.name == "stop"
        assert parsed.args == []

    def test_returns_none_for_text(self) -> None:
        assert parse_command("hello") is None
        assert parse_command("") is None
        assert parse_command("   ") is None

    def test_quoted_args(self) -> None:
        parsed = parse_command('/bash "echo hello world" --verbose')
        assert parsed is not None
        assert parsed.name == "bash"
        assert parsed.args == ["echo hello world", "--verbose"]

    def test_preserves_raw_text(self) -> None:
        parsed = parse_command("  /help  ")
        assert parsed is not None
        assert parsed.raw_text == "/help"


# ── normalize_command_name ────────────────────────────────────────────────


class TestNormalize:
    def test_lowercase(self) -> None:
        assert normalize_command_name("Help") == "help"
        assert normalize_command_name("STOP") == "stop"

    def test_hyphens_to_underscores(self) -> None:
        assert normalize_command_name("MY-CMD") == "my_cmd"
        assert normalize_command_name("commands-list") == "commands_list"

    def test_trim(self) -> None:
        assert normalize_command_name("  Status  ") == "status"


# ── extract_command_args ──────────────────────────────────────────────────


class TestExtractArgs:
    def test_empty(self) -> None:
        assert extract_command_args("") == []
        assert extract_command_args("   ") == []

    def test_simple_args(self) -> None:
        assert extract_command_args("arg1 arg2 arg3") == ["arg1", "arg2", "arg3"]

    def test_quoted_args(self) -> None:
        args = extract_command_args('"hello world" simple \'another quoted\'')
        assert args == ["hello world", "simple", "another quoted"]

    def test_mixed_quotes(self) -> None:
        args = extract_command_args('first "second arg" third')
        assert args == ["first", "second arg", "third"]
