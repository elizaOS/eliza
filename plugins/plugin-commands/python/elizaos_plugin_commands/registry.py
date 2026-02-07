"""Command registry - stores and looks up command definitions."""

from __future__ import annotations

from elizaos_plugin_commands.types import CommandCategory, CommandDefinition


class CommandRegistry:
    """Thread-safe command registry that stores command definitions and supports
    lookup by name or alias.
    """

    def __init__(self) -> None:
        self._commands: list[CommandDefinition] = []
        self._alias_map: dict[str, int] = {}

    # ── Mutation ──────────────────────────────────────────────────────

    def register(self, definition: CommandDefinition) -> None:
        """Register a command definition.  Replaces any existing command with
        the same name and rebuilds the alias index."""
        norm = definition.name.lower()
        self._commands = [c for c in self._commands if c.name.lower() != norm]
        self._commands.append(definition)
        self._rebuild_alias_map()

    def unregister(self, name: str) -> bool:
        """Unregister a command by name. Returns ``True`` if removed."""
        norm = name.lower()
        before = len(self._commands)
        self._commands = [c for c in self._commands if c.name.lower() != norm]
        removed = len(self._commands) < before
        if removed:
            self._rebuild_alias_map()
        return removed

    # ── Lookup ────────────────────────────────────────────────────────

    def lookup(self, name: str) -> CommandDefinition | None:
        """Look up a command by name or alias."""
        norm = name.lower()
        idx = self._alias_map.get(norm)
        if idx is not None and idx < len(self._commands):
            return self._commands[idx]
        return None

    def list_all(self) -> list[CommandDefinition]:
        """Return all registered commands (including hidden ones)."""
        return list(self._commands)

    def list_by_category(self, category: CommandCategory) -> list[CommandDefinition]:
        """Return commands matching a specific category."""
        return [c for c in self._commands if c.category == category]

    def get_help_text(self) -> str:
        """Build a formatted help text string of all non-hidden commands."""
        lines = ["**Available Commands:**", ""]

        categories = [
            CommandCategory.GENERAL,
            CommandCategory.ADMIN,
            CommandCategory.DEBUG,
            CommandCategory.CUSTOM,
        ]

        for cat in categories:
            cmds = [c for c in self._commands if c.category == cat and not c.hidden]
            if not cmds:
                continue
            lines.append(f"**{cat}:**")
            for cmd in cmds:
                alias_str = f" ({', '.join(cmd.aliases)})" if cmd.aliases else ""
                lines.append(f"  /{cmd.name}{alias_str} - {cmd.description}")
            lines.append("")

        return "\n".join(lines)

    def __len__(self) -> int:
        return len(self._commands)

    def __bool__(self) -> bool:
        return len(self._commands) > 0

    # ── Private ───────────────────────────────────────────────────────

    def _rebuild_alias_map(self) -> None:
        self._alias_map = {}
        for idx, cmd in enumerate(self._commands):
            key = cmd.name.lower()
            if key not in self._alias_map:
                self._alias_map[key] = idx
            for alias in cmd.aliases:
                alias_key = alias.lower()
                if alias_key not in self._alias_map:
                    self._alias_map[alias_key] = idx


def default_registry() -> CommandRegistry:
    """Create a registry pre-populated with the five built-in commands."""
    reg = CommandRegistry()

    reg.register(CommandDefinition(
        name="help",
        description="Show available commands and their descriptions",
        category=CommandCategory.GENERAL,
        usage="/help",
        aliases=["h", "?"],
    ))

    reg.register(CommandDefinition(
        name="status",
        description="Show current session status",
        category=CommandCategory.GENERAL,
        usage="/status",
        aliases=["s"],
    ))

    reg.register(CommandDefinition(
        name="stop",
        description="Stop current operation",
        category=CommandCategory.GENERAL,
        usage="/stop",
        aliases=["abort", "cancel"],
    ))

    reg.register(CommandDefinition(
        name="models",
        description="List available AI models",
        category=CommandCategory.GENERAL,
        usage="/models",
    ))

    reg.register(CommandDefinition(
        name="commands",
        description="List all registered commands",
        category=CommandCategory.GENERAL,
        usage="/commands",
        aliases=["cmds"],
    ))

    return reg
