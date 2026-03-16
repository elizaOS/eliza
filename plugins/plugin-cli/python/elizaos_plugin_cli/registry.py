"""CLI command registry.

Provides command registration and management for the CLI plugin.
"""

from __future__ import annotations

import logging
from typing import Iterator

from elizaos_plugin_cli.types import CliCommand

logger = logging.getLogger(__name__)


class CliRegistry:
    """Central registry for CLI commands.

    Commands are stored by their primary name and can be looked up by name
    or alias.

    Example::

        registry = CliRegistry()
        cmd = CliCommand(name="run", description="Run the agent", handler_name="handle_run")
        registry.register_command(cmd)
        assert registry.has_command("run")
    """

    def __init__(self) -> None:
        self._commands: dict[str, CliCommand] = {}

    def register_command(self, cmd: CliCommand) -> CliCommand | None:
        """Register a command.

        If a command with the same name already exists, it is replaced and
        the old command is returned.
        """
        logger.debug("Registering CLI command: %s", cmd.name)
        old = self._commands.get(cmd.name)
        self._commands[cmd.name] = cmd
        return old

    def unregister_command(self, name: str) -> CliCommand | None:
        """Unregister a command by its primary name.

        Returns the removed command if found, otherwise ``None``.
        """
        return self._commands.pop(name, None)

    def get_command(self, name: str) -> CliCommand | None:
        """Get a command by its primary name."""
        return self._commands.get(name)

    def find_command(self, name: str) -> CliCommand | None:
        """Find a command by name or any of its aliases."""
        # Direct lookup (fast path).
        if name in self._commands:
            return self._commands[name]
        # Fall back to alias scan.
        for cmd in self._commands.values():
            if cmd.matches(name):
                return cmd
        return None

    def list_commands(self) -> list[CliCommand]:
        """List all registered commands, sorted by priority then name."""
        return sorted(
            self._commands.values(),
            key=lambda c: (c.priority, c.name),
        )

    def has_command(self, name: str) -> bool:
        """Check if a command with the given primary name is registered."""
        return name in self._commands

    def __len__(self) -> int:
        """Return the number of registered commands."""
        return len(self._commands)

    def __bool__(self) -> bool:
        """Return True if the registry has any commands."""
        return bool(self._commands)

    def __iter__(self) -> Iterator[CliCommand]:
        """Iterate over all commands (unsorted)."""
        return iter(self._commands.values())

    def __contains__(self, name: str) -> bool:
        """Support ``'name' in registry`` syntax."""
        return self.has_command(name)

    def clear(self) -> None:
        """Remove all commands."""
        self._commands.clear()

    def command_names(self) -> list[str]:
        """Get all primary command names, sorted alphabetically."""
        return sorted(self._commands.keys())
