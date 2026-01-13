"""
Discord actions for elizaOS.

Actions define what the agent can do on Discord.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from elizaos_plugin_discord.actions.add_reaction import AddReactionAction
from elizaos_plugin_discord.actions.chat_with_attachments import ChatWithAttachmentsAction
from elizaos_plugin_discord.actions.create_poll import CreatePollAction
from elizaos_plugin_discord.actions.download_media import DownloadMediaAction
from elizaos_plugin_discord.actions.get_user_info import GetUserInfoAction
from elizaos_plugin_discord.actions.join_channel import JoinChannelAction
from elizaos_plugin_discord.actions.leave_channel import LeaveChannelAction
from elizaos_plugin_discord.actions.list_channels import ListChannelsAction
from elizaos_plugin_discord.actions.pin_message import PinMessageAction
from elizaos_plugin_discord.actions.react_to_message import ReactToMessageAction
from elizaos_plugin_discord.actions.read_channel import ReadChannelAction
from elizaos_plugin_discord.actions.search_messages import SearchMessagesAction
from elizaos_plugin_discord.actions.send_dm import SendDmAction
from elizaos_plugin_discord.actions.send_message import SendMessageAction
from elizaos_plugin_discord.actions.server_info import ServerInfoAction
from elizaos_plugin_discord.actions.summarize_conversation import SummarizeConversationAction
from elizaos_plugin_discord.actions.transcribe_media import TranscribeMediaAction
from elizaos_plugin_discord.actions.unpin_message import UnpinMessageAction

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
    def success_result(cls, response: str, data: dict[str, Any] | None = None) -> "ActionResult":
        """Create a successful result."""
        return cls(success=True, response=response, data=data)

    @classmethod
    def failure_result(cls, message: str) -> "ActionResult":
        """Create a failed result."""
        return cls(success=False, response=message)


class DiscordAction(Protocol):
    """Base class for Discord actions.

    Actions define what the agent can do on Discord. Each action must implement:
    - name: Unique action identifier
    - description: Human-readable description for the LLM
    - validate: Check if the action can be executed
    - handler: Execute the action
    """

    @property
    def name(self) -> str:
        """Action name (unique identifier)."""
        ...

    @property
    def description(self) -> str:
        """Action description for the LLM."""
        ...

    @property
    def similes(self) -> list[str]:
        """Similar names/aliases for this action."""
        return []

    async def validate(self, context: ActionContext) -> bool:
        """Validate the action can be executed.

        Args:
            context: The action context.

        Returns:
            True if the action can be executed, False otherwise.
        """
        ...

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
        ChatWithAttachmentsAction(),
        CreatePollAction(),
        DownloadMediaAction(),
        GetUserInfoAction(),
        JoinChannelAction(),
        LeaveChannelAction(),
        ListChannelsAction(),
        PinMessageAction(),
        ReactToMessageAction(),
        ReadChannelAction(),
        SearchMessagesAction(),
        ServerInfoAction(),
        SummarizeConversationAction(),
        TranscribeMediaAction(),
        UnpinMessageAction(),
    ]


__all__ = [
    "ActionContext",
    "ActionResult",
    "DiscordAction",
    "SendMessageAction",
    "SendDmAction",
    "AddReactionAction",
    "ChatWithAttachmentsAction",
    "CreatePollAction",
    "DownloadMediaAction",
    "GetUserInfoAction",
    "JoinChannelAction",
    "LeaveChannelAction",
    "ListChannelsAction",
    "PinMessageAction",
    "ReactToMessageAction",
    "ReadChannelAction",
    "SearchMessagesAction",
    "ServerInfoAction",
    "SummarizeConversationAction",
    "TranscribeMediaAction",
    "UnpinMessageAction",
    "get_all_actions",
]
