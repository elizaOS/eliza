"""Status command action."""

from __future__ import annotations

from dataclasses import dataclass

from elizaos_plugin_commands.actions.common import Message, get_field, get_text
from elizaos_plugin_commands.parser import parse_command
from elizaos_plugin_commands.registry import CommandRegistry
from elizaos_plugin_commands.types import CommandResult


@dataclass
class StatusCommandAction:
    """STATUS_COMMAND - returns runtime status info."""

    @property
    def name(self) -> str:
        return "STATUS_COMMAND"

    @property
    def similes(self) -> list[str]:
        return ["/status", "/s"]

    @property
    def description(self) -> str:
        return (
            "Show current session status. "
            "Only activates for /status or /s slash commands."
        )

    async def validate(self, message: Message, _state: dict[str, object]) -> bool:
        text = get_text(message)
        parsed = parse_command(text)
        if parsed is None:
            return False
        return parsed.name in ("status", "s")

    async def handler(
        self,
        message: Message,
        state: dict[str, object],
        registry: CommandRegistry | None = None,
    ) -> CommandResult:
        agent_id = get_field(message, "agent_id")
        room_id = get_field(message, "room_id")

        lines = [
            "**Session Status:**",
            "",
            f"**Agent:** {agent_id}",
            f"**Room:** {room_id}",
            "",
            "**Status:** Active",
        ]
        text = "\n".join(lines)

        return CommandResult.ok(
            text,
            data={"agent_id": agent_id, "room_id": room_id, "status": "active"},
        )

    @property
    def examples(self) -> list[dict[str, str]]:
        return [
            {
                "user_message": "/status",
                "agent_response": "**Session Status:**\n\n**Agent:** eliza\n**Room:** room-456\n\n**Status:** Active",
            },
        ]
