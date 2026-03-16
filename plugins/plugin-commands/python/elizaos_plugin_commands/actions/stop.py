"""Stop command action."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from elizaos_plugin_commands.actions.common import Message, get_field, get_text
from elizaos_plugin_commands.parser import parse_command
from elizaos_plugin_commands.registry import CommandRegistry
from elizaos_plugin_commands.types import CommandResult

logger = logging.getLogger(__name__)


@dataclass
class StopCommandAction:
    """STOP_COMMAND - signals stop."""

    @property
    def name(self) -> str:
        return "STOP_COMMAND"

    @property
    def similes(self) -> list[str]:
        return ["/stop", "/abort", "/cancel"]

    @property
    def description(self) -> str:
        return (
            "Stop current operation or abort running tasks. "
            "Triggered by /stop, /abort, or /cancel."
        )

    async def validate(self, message: Message, _state: dict[str, object]) -> bool:
        text = get_text(message)
        parsed = parse_command(text)
        if parsed is None:
            return False
        return parsed.name in ("stop", "abort", "cancel")

    async def handler(
        self,
        message: Message,
        state: dict[str, object],
        registry: CommandRegistry | None = None,
    ) -> CommandResult:
        room_id = get_field(message, "room_id")
        entity_id = get_field(message, "entity_id")

        logger.info("Stop command received: room=%s, entity=%s", room_id, entity_id)

        reply = "Stop requested. Current operations will be cancelled."
        return CommandResult.ok(
            reply, data={"command": "stop", "room_id": room_id}
        )

    @property
    def examples(self) -> list[dict[str, str]]:
        return [
            {
                "user_message": "/stop",
                "agent_response": "Stop requested. Current operations will be cancelled.",
            },
            {
                "user_message": "/abort",
                "agent_response": "Stop requested. Current operations will be cancelled.",
            },
        ]
