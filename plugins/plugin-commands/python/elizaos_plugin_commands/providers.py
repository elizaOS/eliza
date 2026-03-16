"""Command registry provider."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from elizaos_plugin_commands.actions.common import Message, get_text
from elizaos_plugin_commands.parser import is_command
from elizaos_plugin_commands.registry import CommandRegistry


@dataclass(frozen=True)
class ProviderResult:
    """Result returned from a provider's ``get`` method."""

    values: dict[str, Any]
    text: str
    data: dict[str, Any]


class CommandRegistryProvider:
    """Provider that exposes available commands to the LLM context.

    When the message looks like a command, injects the full command list.
    For normal messages, returns a minimal stub to reduce prompt noise.
    """

    @property
    def name(self) -> str:
        return "COMMAND_REGISTRY"

    @property
    def description(self) -> str:
        return "Available chat commands and their descriptions"

    @property
    def position(self) -> int:
        return 50

    async def get(
        self,
        message: Message,
        _state: dict[str, object],
        registry: CommandRegistry | None = None,
    ) -> ProviderResult:
        text = get_text(message)
        is_cmd = is_command(text)

        if registry is None:
            return ProviderResult(
                values={"commandCount": 0, "isCommand": is_cmd},
                text="",
                data={"isCommand": is_cmd},
            )

        commands = registry.list_all()
        count = len(commands)

        if is_cmd:
            command_lines = [
                f"- /{c.name}: {c.description}"
                for c in commands
                if not c.hidden
            ]
            full_text = (
                "The user sent a slash command. Available commands:\n"
                + "\n".join(command_lines)
                + "\n\nIMPORTANT: This is a slash command — respond by executing "
                "the matching command action, not with conversational text."
            )
            return ProviderResult(
                values={"commandCount": count, "isCommand": True},
                text=full_text,
                data={
                    "isCommand": True,
                    "commands": [
                        {
                            "name": c.name,
                            "description": c.description,
                            "category": c.category.value,
                        }
                        for c in commands
                    ],
                },
            )

        return ProviderResult(
            values={"commandCount": count, "isCommand": False},
            text="",
            data={"isCommand": False},
        )
