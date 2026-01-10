"""
elizaOS Roblox Plugin - Python Implementation.

Provides full Roblox integration for elizaOS agents, enabling
game communication via the Roblox Open Cloud API.

Example:
    >>> from elizaos_plugin_roblox import RobloxClient, RobloxConfig
    >>> config = RobloxConfig.from_env()
    >>> client = RobloxClient(config)
    >>> await client.send_message("Hello from Eliza!")
"""

from elizaos_plugin_roblox.client import RobloxClient
from elizaos_plugin_roblox.config import RobloxConfig
from elizaos_plugin_roblox.error import (
    ApiError,
    ConfigError,
    NetworkError,
    RateLimitError,
    RobloxError,
    ValidationError,
)
from elizaos_plugin_roblox.service import RobloxService
from elizaos_plugin_roblox.types import (
    DataStoreEntry,
    MessagingServiceMessage,
    RobloxEventType,
    RobloxExperienceInfo,
    RobloxGameAction,
    RobloxGameMessage,
    RobloxPlayerSession,
    RobloxResponse,
    RobloxServerInfo,
    RobloxUser,
)

__version__ = "2.0.0"

# Plugin metadata
PLUGIN_NAME = "roblox"
PLUGIN_DESCRIPTION = "Roblox integration for elizaOS agents"
ROBLOX_SERVICE_NAME = "roblox"
ROBLOX_SOURCE = "roblox"

__all__ = [
    # Client
    "RobloxClient",
    # Config
    "RobloxConfig",
    # Service
    "RobloxService",
    # Errors
    "RobloxError",
    "ApiError",
    "ConfigError",
    "NetworkError",
    "RateLimitError",
    "ValidationError",
    # Types
    "DataStoreEntry",
    "MessagingServiceMessage",
    "RobloxEventType",
    "RobloxExperienceInfo",
    "RobloxGameAction",
    "RobloxGameMessage",
    "RobloxPlayerSession",
    "RobloxResponse",
    "RobloxServerInfo",
    "RobloxUser",
    # Metadata
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
    "ROBLOX_SERVICE_NAME",
    "ROBLOX_SOURCE",
]

