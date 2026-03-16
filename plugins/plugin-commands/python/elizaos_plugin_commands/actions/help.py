"""Help command action."""

from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_commands.actions.common import Message, get_text
from elizaos_plugin_commands.parser import parse_command
from elizaos_plugin_commands.registry import CommandRegistry
from elizaos_plugin_commands.types import CommandResult


@dataclass
class HelpCommandAction:
    """HELP_COMMAND - returns formatted help text from registry."""

    @property
    def name(self) -> str:
        return "HELP_COMMAND"

    @property
    def similes(self) -> list[str]:
        return ["/help", "/h", "/?"]

    @property
    def description(self) -> str:
        return (
            "Show available commands and their descriptions. "
            "Only activates for /help, /h, or /? slash commands."
        )

    async def validate(self, message: Message, _state: dict[str, object]) -> bool:
        text = get_text(message)
        parsed = parse_command(text)
        if parsed is None:
            return False
        return parsed.name in ("help", "h")

    async def handler(
        self,
        message: Message,
        state: dict[str, object],
        registry: CommandRegistry | None = None,
    ) -> CommandResult:
        if registry is None:
            return CommandResult.error("Command registry is not available.")

        help_text = registry.get_help_text()
        visible = [c for c in registry.list_all() if not c.hidden]
        return CommandResult.ok(help_text, data={"commandCount": len(visible)})

    @property
    def examples(self) -> list[dict[str, str]]:
        return [
            {
                "user_message": "/help",
                "agent_response": "**Available Commands:**\n\n**General:**\n  /help (h, ?) - Show available commands...",
            },
            {
                "user_message": "/?",
                "agent_response": "**Available Commands:**\n\n**General:**\n  /help (h, ?) - Show available commands...",
            },
        ]
