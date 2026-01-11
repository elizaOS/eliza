"""
Discord actions for elizaOS.

Actions define what the agent can do on Discord.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from elizaos_plugin_discord.actions.add_reaction import AddReactionAction
from elizaos_plugin_discord.actions.send_dm import SendDmAction
from elizaos_plugin_discord.actions.send_message import SendMessageAction

if TYPE_CHECKING:
    from elizaos_plugin_discord.service import DiscordService


@dataclass(frozen=True)
class ActionContext:
    """Context provided to actions.

    Attributes:
        message: The incoming message data with 'source' and 'content' fields.
        channel_id: The Discord channel ID (snowflake).
        guild_id: The Discord guild ID (snowflake) or None for DMs.
        user_id: The Discord user ID (snowflake) who triggered the action.
        state: Additional state data.
    """

    message: dict[str, Any]
    channel_id: str
    guild_id: str | None
    user_id: str
    state: dict[str, Any] = field(default_factory=dict)


@dataclass
class ActionResult:
    """Result of executing an action.

    Attributes:
        success: Whether the action succeeded.
        response: Human-readable response message.
        data: Additional result data.
    """

    success: bool
    response: str | None = None
    data: dict[str, Any] | None = None

    @classmethod
    def success_result(
        cls, response: str, data: dict[str, Any] | None = None
    ) -> "ActionResult":
        """Create a successful result."""
        return cls(success=True, response=response, data=data)

    @classmethod
    def failure_result(cls, message: str) -> "ActionResult":
        """Create a failed result."""
        return cls(success=False, response=message)


class DiscordAction(ABC):
    """Base class for Discord actions.

    Actions define what the agent can do on Discord. Each action must implement:
    - name: Unique action identifier
    - description: Human-readable description for the LLM
    - validate: Check if the action can be executed
    - handler: Execute the action
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Action name (unique identifier)."""
        ...

    @property
    @abstractmethod
    def description(self) -> str:
        """Action description for the LLM."""
        ...

    @property
    def similes(self) -> list[str]:
        """Similar names/aliases for this action."""
        return []

    @abstractmethod
    async def validate(self, context: ActionContext) -> bool:
        """Validate the action can be executed.

        Args:
            context: The action context.

        Returns:
            True if the action can be executed, False otherwise.
        """
        ...

    @abstractmethod
    async def handler(
        self,
        context: ActionContext,
        service: "DiscordService",
    ) -> ActionResult:
        """Execute the action.

        Args:
            context: The action context.
            service: The Discord service instance.

        Returns:
            The action result.
        """
        ...


def get_all_actions() -> list[DiscordAction]:
    """Get all available Discord actions.

    Returns:
        List of all action instances.
    """
    return [
        SendMessageAction(),
        SendDmAction(),
        AddReactionAction(),
    ]


__all__ = [
    "ActionContext",
    "ActionResult",
    "DiscordAction",
    "SendMessageAction",
    "SendDmAction",
    "AddReactionAction",
    "get_all_actions",
]
