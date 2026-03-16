"""
BlueBubbles iMessage bridge plugin for elizaOS.

This plugin provides iMessage integration via the BlueBubbles macOS app and REST API.
"""

from elizaos_plugin_bluebubbles.actions import send_message_action
from elizaos_plugin_bluebubbles.client import BlueBubblesClient
from elizaos_plugin_bluebubbles.config import BlueBubblesConfig, get_config_from_env
from elizaos_plugin_bluebubbles.providers import chat_state_provider
from elizaos_plugin_bluebubbles.service import BlueBubblesService
from elizaos_plugin_bluebubbles.types import (
    BlueBubblesAttachment,
    BlueBubblesChat,
    BlueBubblesChatState,
    BlueBubblesHandle,
    BlueBubblesMessage,
    BlueBubblesProbeResult,
    BlueBubblesServerInfo,
    DmPolicy,
    GroupPolicy,
    SendMessageOptions,
    SendMessageResult,
)

__all__ = [
    # Client
    "BlueBubblesClient",
    # Config
    "BlueBubblesConfig",
    "get_config_from_env",
    # Service
    "BlueBubblesService",
    # Types
    "BlueBubblesAttachment",
    "BlueBubblesChat",
    "BlueBubblesChatState",
    "BlueBubblesHandle",
    "BlueBubblesMessage",
    "BlueBubblesProbeResult",
    "BlueBubblesServerInfo",
    "DmPolicy",
    "GroupPolicy",
    "SendMessageOptions",
    "SendMessageResult",
    # Actions
    "send_message_action",
    # Providers
    "chat_state_provider",
]

BLUEBUBBLES_SERVICE_NAME = "bluebubbles"


def create_plugin():
    """Creates the BlueBubbles plugin with all components."""
    from elizaos.types import Plugin

    return Plugin(
        name=BLUEBUBBLES_SERVICE_NAME,
        description="BlueBubbles iMessage bridge plugin for elizaOS agents",
        services=[BlueBubblesService],
        actions=[send_message_action],
        providers=[chat_state_provider],
    )
