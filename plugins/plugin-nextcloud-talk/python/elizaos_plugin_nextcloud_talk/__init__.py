"""Nextcloud Talk plugin for elizaOS."""

from elizaos_plugin_nextcloud_talk.config import NextcloudTalkConfig
from elizaos_plugin_nextcloud_talk.service import NextcloudTalkService
from elizaos_plugin_nextcloud_talk.types import (
    NextcloudTalkEventType,
    NextcloudTalkRoomType,
    NextcloudTalkInboundMessage,
    NextcloudTalkSendResult,
    NextcloudTalkRoom,
    NextcloudTalkUser,
)
from elizaos_plugin_nextcloud_talk.error import (
    NextcloudTalkError,
    ConfigError,
    ServiceNotInitializedError,
    AuthenticationError,
    SignatureVerificationError,
    RoomNotAllowedError,
    MessageSendError,
    ApiError,
)
from elizaos_plugin_nextcloud_talk.client import (
    verify_signature,
    generate_signature,
    send_message,
    send_reaction,
)
from elizaos_plugin_nextcloud_talk.actions import (
    SEND_MESSAGE_ACTION,
    SendMessageResult,
    handle_send_message,
)
from elizaos_plugin_nextcloud_talk.providers import (
    CHAT_STATE_PROVIDER,
    ChatStateResult,
    get_chat_state,
)

__version__ = "2.0.0"
PLUGIN_NAME = "nextcloud-talk"
PLUGIN_DESCRIPTION = "Nextcloud Talk bot integration for elizaOS agents"

__all__ = [
    "NextcloudTalkConfig",
    "NextcloudTalkService",
    "NextcloudTalkEventType",
    "NextcloudTalkRoomType",
    "NextcloudTalkInboundMessage",
    "NextcloudTalkSendResult",
    "NextcloudTalkRoom",
    "NextcloudTalkUser",
    "NextcloudTalkError",
    "ConfigError",
    "ServiceNotInitializedError",
    "AuthenticationError",
    "SignatureVerificationError",
    "RoomNotAllowedError",
    "MessageSendError",
    "ApiError",
    "verify_signature",
    "generate_signature",
    "send_message",
    "send_reaction",
    "SEND_MESSAGE_ACTION",
    "SendMessageResult",
    "handle_send_message",
    "CHAT_STATE_PROVIDER",
    "ChatStateResult",
    "get_chat_state",
]
