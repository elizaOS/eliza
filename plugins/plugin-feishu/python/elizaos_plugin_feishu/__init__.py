from elizaos_plugin_feishu.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_feishu.config import FeishuConfig
from elizaos_plugin_feishu.error import (
    AuthenticationError,
    BotNotInitializedError,
    ConfigError,
    FeishuError,
    MessageSendError,
)
from elizaos_plugin_feishu.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)
from elizaos_plugin_feishu.service import FeishuService
from elizaos_plugin_feishu.types import (
    FeishuChat,
    FeishuChatType,
    FeishuContent,
    FeishuEntityPayload,
    FeishuEventType,
    FeishuMessagePayload,
    FeishuReactionPayload,
    FeishuUser,
    FeishuWorldPayload,
)

__all__ = [
    "FeishuConfig",
    "FeishuError",
    "AuthenticationError",
    "BotNotInitializedError",
    "ConfigError",
    "MessageSendError",
    "FeishuChatType",
    "FeishuContent",
    "FeishuChat",
    "FeishuUser",
    "FeishuEntityPayload",
    "FeishuEventType",
    "FeishuMessagePayload",
    "FeishuReactionPayload",
    "FeishuWorldPayload",
    "FeishuService",
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]

__version__ = "2.0.0"
PLUGIN_NAME = "feishu"
PLUGIN_DESCRIPTION = "Feishu/Lark bot integration for elizaOS agents"
