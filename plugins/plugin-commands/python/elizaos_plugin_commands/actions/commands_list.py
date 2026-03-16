"""Commands list action."""

from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_commands.actions.common import Message, get_text
from elizaos_plugin_commands.parser import parse_command
from elizaos_plugin_commands.registry import CommandRegistry
from elizaos_plugin_commands.types import CommandResult


@dataclass
class CommandsListAction:
    """COMMANDS_LIST_COMMAND - lists all registered commands."""

    @property
    def name(self) -> str:
        return "COMMANDS_LIST_COMMAND"

    @property
    def similes(self) -> list[str]:
        return ["/commands", "/cmds"]

    @property
    def description(self) -> str:
        return (
            "List all registered commands with their aliases. "
            "Only activates for /commands or /cmds."
        )

    async def validate(self, message: Message, _state: dict[str, object]) -> bool:
        text = get_text(message)
        parsed = parse_command(text)
        if parsed is None:
            return False
        return parsed.name in ("commands", "cmds")

    async def handler(
        self,
        message: Message,
        state: dict[str, object],
        registry: CommandRegistry | None = None,
    ) -> CommandResult:
        if registry is None:
            return CommandResult.error("Command registry is not available.")

        all_cmds = registry.list_all()
        count = len(all_cmds)
        lines = [f"**Commands ({count}):**", ""]

        for cmd in all_cmds:
            if cmd.aliases:
                alias_strs = ", ".join(f"/{a}" for a in cmd.aliases)
                aliases = f"/{cmd.name}, {alias_strs}"
            else:
                aliases = f"/{cmd.name}"
            hidden_note = " [hidden]" if cmd.hidden else ""
            lines.append(f"  **{cmd.name}**: {aliases}{hidden_note}")

        text = "\n".join(lines)
        return CommandResult.ok(text, data={"commandCount": count})

    @property
    def examples(self) -> list[dict[str, str]]:
        return [
            {
                "user_message": "/commands",
                "agent_response": "**Commands (5):**\n\n  **help**: /help, /h, /?...\n  **status**: /status, /s...",
            },
        ]
