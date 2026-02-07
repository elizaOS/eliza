"""elizaOS Blooio Plugin — messaging via the Blooio platform."""

from elizaos_plugin_blooio.actions import SendMessageAction
from elizaos_plugin_blooio.constants import (
    DEFAULT_API_BASE_URL,
    DEFAULT_WEBHOOK_PORT,
    MAX_CONVERSATION_HISTORY,
    SERVICE_NAME,
    WEBHOOK_PATH_EVENTS,
)
from elizaos_plugin_blooio.providers import ConversationHistoryProvider
from elizaos_plugin_blooio.service import BlooioService
from elizaos_plugin_blooio.types import (
    ActionResult,
    BlooioConfig,
    BlooioError,
    BlooioMessage,
    BlooioResponse,
    ConversationEntry,
    MessageTarget,
    ProviderResult,
    TargetType,
    WebhookEvent,
)
from elizaos_plugin_blooio.utils import (
    extract_urls,
    validate_chat_id,
    validate_email,
    validate_group_id,
    validate_phone,
    verify_webhook_signature,
)

__version__ = "1.0.0"

PLUGIN_NAME = "blooio"
PLUGIN_DESCRIPTION = "Blooio plugin for iMessage/SMS messaging integration"

__all__ = [
    # Types
    "ActionResult",
    "BlooioConfig",
    "BlooioError",
    "BlooioMessage",
    "BlooioResponse",
    "ConversationEntry",
    "MessageTarget",
    "ProviderResult",
    "TargetType",
    "WebhookEvent",
    # Service
    "BlooioService",
    # Actions
    "SendMessageAction",
    # Providers
    "ConversationHistoryProvider",
    # Utils
    "validate_chat_id",
    "validate_phone",
    "validate_email",
    "validate_group_id",
    "verify_webhook_signature",
    "extract_urls",
    # Constants
    "SERVICE_NAME",
    "DEFAULT_API_BASE_URL",
    "DEFAULT_WEBHOOK_PORT",
    "WEBHOOK_PATH_EVENTS",
    "MAX_CONVERSATION_HISTORY",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
