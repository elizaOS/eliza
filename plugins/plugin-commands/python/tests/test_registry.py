"""Tests for the command registry module."""

from __future__ import annotations

from elizaos_plugin_commands.registry import CommandRegistry, default_registry
from elizaos_plugin_commands.types import CommandCategory, CommandDefinition


class TestCommandRegistry:
    def test_new_is_empty(self) -> None:
        reg = CommandRegistry()
        assert len(reg) == 0
        assert not reg

    def test_register_and_lookup(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="ping", description="Pong!"))
        assert len(reg) == 1
        cmd = reg.lookup("ping")
        assert cmd is not None
        assert cmd.name == "ping"
        assert cmd.description == "Pong!"

    def test_lookup_by_alias(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(
            name="help", description="Show help", aliases=["h", "?"],
        ))
        assert reg.lookup("help") is not None
        assert reg.lookup("h") is not None
        assert reg.lookup("?") is not None
        assert reg.lookup("h").name == "help"  # type: ignore[union-attr]

    def test_lookup_case_insensitive(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="help", description="Show help"))
        assert reg.lookup("HELP") is not None
        assert reg.lookup("Help") is not None

    def test_lookup_nonexistent(self) -> None:
        reg = CommandRegistry()
        assert reg.lookup("nope") is None

    def test_unregister(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="temp", description="Temporary"))
        assert reg.unregister("temp")
        assert reg.lookup("temp") is None
        assert not reg.unregister("temp")

    def test_unregister_clears_aliases(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(
            name="test", description="Test cmd", aliases=["t"],
        ))
        assert reg.lookup("t") is not None
        reg.unregister("test")
        assert reg.lookup("t") is None

    def test_replace_existing(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="cmd", description="Version 1"))
        reg.register(CommandDefinition(name="cmd", description="Version 2"))
        assert len(reg) == 1
        assert reg.lookup("cmd").description == "Version 2"  # type: ignore[union-attr]

    def test_list_all(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="a", description="A"))
        reg.register(CommandDefinition(name="b", description="B"))
        reg.register(CommandDefinition(name="c", description="C"))
        assert len(reg.list_all()) == 3

    def test_list_by_category(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(
            name="a", description="A", category=CommandCategory.GENERAL,
        ))
        reg.register(CommandDefinition(
            name="b", description="B", category=CommandCategory.ADMIN,
        ))
        reg.register(CommandDefinition(
            name="c", description="C", category=CommandCategory.GENERAL,
        ))

        general = reg.list_by_category(CommandCategory.GENERAL)
        assert len(general) == 2
        admin = reg.list_by_category(CommandCategory.ADMIN)
        assert len(admin) == 1
        debug = reg.list_by_category(CommandCategory.DEBUG)
        assert len(debug) == 0

    def test_help_text_contains_commands(self) -> None:
        reg = default_registry()
        help_text = reg.get_help_text()
        assert "**Available Commands:**" in help_text
        assert "/help" in help_text
        assert "/status" in help_text
        assert "/stop" in help_text
        assert "/models" in help_text
        assert "/commands" in help_text

    def test_help_text_hides_hidden(self) -> None:
        reg = CommandRegistry()
        reg.register(CommandDefinition(name="visible", description="I'm visible"))
        reg.register(CommandDefinition(name="secret", description="I'm hidden", hidden=True))
        help_text = reg.get_help_text()
        assert "visible" in help_text
        assert "secret" not in help_text


class TestDefaultRegistry:
    def test_has_five_commands(self) -> None:
        reg = default_registry()
        assert len(reg) == 5

    def test_built_in_commands(self) -> None:
        reg = default_registry()
        assert reg.lookup("help") is not None
        assert reg.lookup("status") is not None
        assert reg.lookup("stop") is not None
        assert reg.lookup("models") is not None
        assert reg.lookup("commands") is not None

    def test_built_in_aliases(self) -> None:
        reg = default_registry()
        assert reg.lookup("h") is not None
        assert reg.lookup("s") is not None
        assert reg.lookup("abort") is not None
        assert reg.lookup("cancel") is not None
        assert reg.lookup("cmds") is not None
        assert reg.lookup("?") is not None
