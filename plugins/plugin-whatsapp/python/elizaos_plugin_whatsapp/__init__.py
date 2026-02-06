"""
WhatsApp Cloud API plugin for ElizaOS.

This plugin provides WhatsApp integration via Meta's Cloud API.
"""

from elizaos_plugin_whatsapp.actions import send_message_action
from elizaos_plugin_whatsapp.client import WhatsAppClient
from elizaos_plugin_whatsapp.config import WhatsAppConfig, get_config_from_env
from elizaos_plugin_whatsapp.providers import chat_state_provider
from elizaos_plugin_whatsapp.service import WhatsAppService
from elizaos_plugin_whatsapp.types import (
    IncomingMessage,
    MessageContent,
    MessageType,
    WhatsAppChatState,
    WhatsAppMessage,
    WhatsAppMessageResponse,
    WhatsAppWebhookEvent,
)

__all__ = [
    "WhatsAppClient",
    "WhatsAppConfig",
    "get_config_from_env",
    "WhatsAppService",
    "IncomingMessage",
    "MessageContent",
    "MessageType",
    "WhatsAppChatState",
    "WhatsAppMessage",
    "WhatsAppMessageResponse",
    "WhatsAppWebhookEvent",
    "send_message_action",
    "chat_state_provider",
]

WHATSAPP_SERVICE_NAME = "whatsapp"


def create_plugin():
    """Creates the WhatsApp plugin with all components."""
    from elizaos.types import Plugin

    return Plugin(
        name=WHATSAPP_SERVICE_NAME,
        description="WhatsApp Cloud API plugin for ElizaOS agents",
        services=[WhatsAppService],
        actions=[send_message_action],
        providers=[chat_state_provider],
    )
