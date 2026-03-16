from elizaos_plugin_instagram.actions import PostCommentAction, SendDmAction
from elizaos_plugin_instagram.config import InstagramConfig
from elizaos_plugin_instagram.error import (
    AuthenticationError,
    ConfigError,
    InstagramError,
    MediaUploadError,
    MessageSendError,
    RateLimitError,
)
from elizaos_plugin_instagram.providers import UserStateProvider
from elizaos_plugin_instagram.service import InstagramService
from elizaos_plugin_instagram.types import (
    InstagramEventType,
    InstagramMedia,
    InstagramMediaType,
    InstagramMessage,
    InstagramUser,
)

__all__ = [
    "SendDmAction",
    "PostCommentAction",
    "UserStateProvider",
    "InstagramConfig",
    "InstagramError",
    "AuthenticationError",
    "ConfigError",
    "MediaUploadError",
    "MessageSendError",
    "RateLimitError",
    "InstagramEventType",
    "InstagramMedia",
    "InstagramMediaType",
    "InstagramMessage",
    "InstagramUser",
    "InstagramService",
]

__version__ = "1.0.0"
PLUGIN_NAME = "instagram"
PLUGIN_DESCRIPTION = "Instagram integration for elizaOS agents"
