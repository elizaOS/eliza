from elizaos_plugin_mattermost.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_mattermost.client import (
    MattermostClient,
    create_mattermost_client,
)
from elizaos_plugin_mattermost.config import MattermostConfig
from elizaos_plugin_mattermost.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_mattermost.service import MattermostService
from elizaos_plugin_mattermost.types import (
    MattermostChannel,
    MattermostChannelType,
    MattermostContent,
    MattermostEntityPayload,
    MattermostEventType,
    MattermostFileInfo,
    MattermostMessagePayload,
    MattermostPost,
    MattermostReactionPayload,
    MattermostTeam,
    MattermostUser,
    MattermostWorldPayload,
)

__all__ = [
    "MattermostConfig",
    "MattermostClient",
    "create_mattermost_client",
    "MattermostChannel",
    "MattermostChannelType",
    "MattermostContent",
    "MattermostEntityPayload",
    "MattermostEventType",
    "MattermostFileInfo",
    "MattermostMessagePayload",
    "MattermostPost",
    "MattermostReactionPayload",
    "MattermostTeam",
    "MattermostUser",
    "MattermostWorldPayload",
    "MattermostService",
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]

__version__ = "2.0.0"
PLUGIN_NAME = "mattermost"
PLUGIN_DESCRIPTION = "Mattermost bot integration for elizaOS agents"
