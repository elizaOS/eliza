"""
Signal messaging integration plugin for elizaOS agents.

This plugin provides end-to-end encrypted messaging capabilities via Signal protocol.
"""

from elizaos_plugin_signal.types import (
    SignalAttachment,
    SignalContact,
    SignalEventTypes,
    SignalGroup,
    SignalGroupMember,
    SignalMessage,
    SignalMessageSendOptions,
    SignalQuote,
    SignalReactionInfo,
    SignalSettings,
    SignalApiError,
    SignalClientNotAvailableError,
    SignalConfigurationError,
    SignalPluginError,
    SignalServiceNotInitializedError,
    get_signal_contact_display_name,
    is_valid_e164,
    is_valid_group_id,
    is_valid_uuid,
    normalize_e164,
    MAX_SIGNAL_MESSAGE_LENGTH,
    MAX_SIGNAL_ATTACHMENT_SIZE,
    SIGNAL_SERVICE_NAME,
)
from elizaos_plugin_signal.service import SignalService
from elizaos_plugin_signal.actions import (
    send_message_action,
    send_reaction_action,
    list_contacts_action,
    list_groups_action,
)
from elizaos_plugin_signal.providers import (
    conversation_state_provider,
)

__all__ = [
    # Service
    "SignalService",
    # Types
    "SignalAttachment",
    "SignalContact",
    "SignalEventTypes",
    "SignalGroup",
    "SignalGroupMember",
    "SignalMessage",
    "SignalMessageSendOptions",
    "SignalQuote",
    "SignalReactionInfo",
    "SignalSettings",
    # Errors
    "SignalApiError",
    "SignalClientNotAvailableError",
    "SignalConfigurationError",
    "SignalPluginError",
    "SignalServiceNotInitializedError",
    # Utilities
    "get_signal_contact_display_name",
    "is_valid_e164",
    "is_valid_group_id",
    "is_valid_uuid",
    "normalize_e164",
    # Constants
    "MAX_SIGNAL_MESSAGE_LENGTH",
    "MAX_SIGNAL_ATTACHMENT_SIZE",
    "SIGNAL_SERVICE_NAME",
    # Actions
    "send_message_action",
    "send_reaction_action",
    "list_contacts_action",
    "list_groups_action",
    # Providers
    "conversation_state_provider",
]

# Plugin metadata
PLUGIN_NAME = "signal"
PLUGIN_DESCRIPTION = "Signal messaging integration plugin for elizaOS with end-to-end encryption"
PLUGIN_VERSION = "2.0.0-alpha"


def get_plugin():
    """Return the plugin definition for elizaOS registration."""
    return {
        "name": PLUGIN_NAME,
        "description": PLUGIN_DESCRIPTION,
        "version": PLUGIN_VERSION,
        "services": [SignalService],
        "actions": [
            send_message_action,
            send_reaction_action,
            list_contacts_action,
            list_groups_action,
        ],
        "providers": [
            conversation_state_provider,
        ],
    }
