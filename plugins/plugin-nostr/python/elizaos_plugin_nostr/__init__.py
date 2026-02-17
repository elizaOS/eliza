"""
Nostr Plugin for elizaOS

Provides Nostr decentralized messaging integration for elizaOS agents,
supporting encrypted DMs via NIP-04 and profile management.
"""

from .actions import (
    publish_profile_action,
    send_dm_action,
)
from .providers import (
    identity_context_provider,
    sender_context_provider,
)
from .service import NostrService
from .types import (
    DEFAULT_NOSTR_RELAYS,
    MAX_NOSTR_MESSAGE_LENGTH,
    NOSTR_SERVICE_NAME,
    NostrConfigurationError,
    NostrCryptoError,
    NostrDmSendOptions,
    NostrEventTypes,
    NostrMessage,
    NostrPluginError,
    NostrProfile,
    NostrRelayError,
    NostrSendResult,
    NostrSettings,
    get_pubkey_display_name,
    is_valid_pubkey,
    normalize_pubkey,
    pubkey_to_npub,
    split_message_for_nostr,
    validate_private_key,
)


def get_plugin():
    """Get the Nostr plugin definition for elizaOS."""
    return {
        "name": "nostr",
        "description": "Nostr decentralized messaging plugin for elizaOS agents",
        "services": [NostrService],
        "actions": [
            send_dm_action,
            publish_profile_action,
        ],
        "providers": [
            identity_context_provider,
            sender_context_provider,
        ],
        "tests": [],
    }


__all__ = [
    # Types
    "NostrSettings",
    "NostrProfile",
    "NostrMessage",
    "NostrDmSendOptions",
    "NostrSendResult",
    "NostrEventTypes",
    "NostrPluginError",
    "NostrConfigurationError",
    "NostrRelayError",
    "NostrCryptoError",
    "NOSTR_SERVICE_NAME",
    "MAX_NOSTR_MESSAGE_LENGTH",
    "DEFAULT_NOSTR_RELAYS",
    # Utilities
    "is_valid_pubkey",
    "normalize_pubkey",
    "pubkey_to_npub",
    "validate_private_key",
    "get_pubkey_display_name",
    "split_message_for_nostr",
    # Service
    "NostrService",
    # Actions
    "send_dm_action",
    "publish_profile_action",
    # Providers
    "identity_context_provider",
    "sender_context_provider",
    # Plugin
    "get_plugin",
]
