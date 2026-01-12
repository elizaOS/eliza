from elizaos_plugin_farcaster.client import FarcasterClient
from elizaos_plugin_farcaster.config import FarcasterConfig
from elizaos_plugin_farcaster.error import (
    ApiError,
    ConfigError,
    FarcasterError,
    NetworkError,
    RateLimitError,
    ValidationError,
)
from elizaos_plugin_farcaster.service import FarcasterService
from elizaos_plugin_farcaster.types import (
    Cast,
    CastEmbed,
    CastId,
    EmbedType,
    FarcasterEventType,
    FarcasterMessageType,
    FidRequest,
    LastCast,
    Profile,
)

__version__ = "1.0.0"

PLUGIN_NAME = "farcaster"
PLUGIN_DESCRIPTION = "Farcaster integration for elizaOS agents"

__all__ = [
    # Client
    "FarcasterClient",
    # Config
    "FarcasterConfig",
    # Service
    "FarcasterService",
    # Errors
    "FarcasterError",
    "ApiError",
    "ConfigError",
    "NetworkError",
    "RateLimitError",
    "ValidationError",
    # Types
    "Cast",
    "CastEmbed",
    "CastId",
    "EmbedType",
    "FarcasterEventType",
    "FarcasterMessageType",
    "FidRequest",
    "LastCast",
    "Profile",
    "PLUGIN_NAME",
    "PLUGIN_DESCRIPTION",
]
