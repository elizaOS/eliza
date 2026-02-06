"""
Type definitions for the Nostr plugin.
"""

import re
from dataclasses import dataclass, field
from enum import Enum

import bech32

# Constants
MAX_NOSTR_MESSAGE_LENGTH = 4000
NOSTR_SERVICE_NAME = "nostr"
DEFAULT_NOSTR_RELAYS = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.nostr.band",
]


class NostrEventTypes(str, Enum):
    """Event types emitted by the Nostr plugin."""

    MESSAGE_RECEIVED = "NOSTR_MESSAGE_RECEIVED"
    MESSAGE_SENT = "NOSTR_MESSAGE_SENT"
    RELAY_CONNECTED = "NOSTR_RELAY_CONNECTED"
    RELAY_DISCONNECTED = "NOSTR_RELAY_DISCONNECTED"
    PROFILE_PUBLISHED = "NOSTR_PROFILE_PUBLISHED"
    CONNECTION_READY = "NOSTR_CONNECTION_READY"


@dataclass
class NostrProfile:
    """Nostr profile data (kind:0)."""

    name: str | None = None
    display_name: str | None = None
    about: str | None = None
    picture: str | None = None
    banner: str | None = None
    nip05: str | None = None
    lud16: str | None = None
    website: str | None = None


@dataclass
class NostrSettings:
    """Configuration settings for the Nostr plugin."""

    private_key: str = ""
    public_key: str = ""
    relays: list[str] = field(default_factory=lambda: DEFAULT_NOSTR_RELAYS.copy())
    dm_policy: str = "pairing"  # open, pairing, allowlist, disabled
    allow_from: list[str] = field(default_factory=list)
    profile: NostrProfile | None = None
    enabled: bool = True


@dataclass
class NostrMessage:
    """Nostr event (kind:4 for DMs)."""

    id: str
    pubkey: str
    content: str
    created_at: int
    kind: int
    tags: list[list[str]]
    sig: str


@dataclass
class NostrDmSendOptions:
    """Options for sending a DM."""

    to_pubkey: str
    text: str


@dataclass
class NostrSendResult:
    """Result from sending a DM."""

    success: bool
    event_id: str | None = None
    relays: list[str] = field(default_factory=list)
    error: str | None = None


# Custom exception classes


class NostrPluginError(Exception):
    """Base error class for Nostr plugin errors."""

    def __init__(self, message: str, code: str, cause: Exception | None = None):
        super().__init__(message)
        self.code = code
        self.cause = cause


class NostrConfigurationError(NostrPluginError):
    """Configuration error."""

    def __init__(
        self, message: str, setting: str | None = None, cause: Exception | None = None
    ):
        super().__init__(message, "CONFIGURATION_ERROR", cause)
        self.setting = setting


class NostrRelayError(NostrPluginError):
    """Relay error."""

    def __init__(
        self, message: str, relay: str | None = None, cause: Exception | None = None
    ):
        super().__init__(message, "RELAY_ERROR", cause)
        self.relay = relay


class NostrCryptoError(NostrPluginError):
    """Cryptography error."""

    def __init__(self, message: str, cause: Exception | None = None):
        super().__init__(message, "CRYPTO_ERROR", cause)


# Utility functions


def is_valid_pubkey(input_str: str) -> bool:
    """Check if a string is a valid Nostr pubkey (hex or npub)."""
    if not isinstance(input_str, str):
        return False

    trimmed = input_str.strip()

    # npub format
    if trimmed.startswith("npub1"):
        try:
            hrp, data = bech32.bech32_decode(trimmed)
            return hrp == "npub" and data is not None
        except Exception:
            return False

    # Hex format
    return bool(re.match(r"^[0-9a-fA-F]{64}$", trimmed))


def normalize_pubkey(input_str: str) -> str:
    """Normalize a pubkey to hex format (accepts npub or hex)."""
    trimmed = input_str.strip()

    # npub format - decode to hex
    if trimmed.startswith("npub1"):
        hrp, data = bech32.bech32_decode(trimmed)
        if hrp != "npub" or data is None:
            raise NostrCryptoError("Invalid npub key")
        converted = bech32.convertbits(data, 5, 8, False)
        if converted is None:
            raise NostrCryptoError("Invalid npub key")
        return bytes(converted).hex()

    # Already hex - validate and return lowercase
    if not re.match(r"^[0-9a-fA-F]{64}$", trimmed):
        raise NostrCryptoError("Pubkey must be 64 hex characters or npub format")
    return trimmed.lower()


def pubkey_to_npub(hex_pubkey: str) -> str:
    """Convert a hex pubkey to npub format."""
    normalized = normalize_pubkey(hex_pubkey)
    data = bytes.fromhex(normalized)
    converted = bech32.convertbits(list(data), 8, 5, True)
    if converted is None:
        raise NostrCryptoError("Failed to convert pubkey to npub")
    return bech32.bech32_encode("npub", converted)


def validate_private_key(key: str) -> bytes:
    """Validate and normalize a private key (accepts hex or nsec format)."""
    trimmed = key.strip()

    # Handle nsec (bech32) format
    if trimmed.startswith("nsec1"):
        hrp, data = bech32.bech32_decode(trimmed)
        if hrp != "nsec" or data is None:
            raise NostrCryptoError("Invalid nsec key: wrong type")
        converted = bech32.convertbits(data, 5, 8, False)
        if converted is None:
            raise NostrCryptoError("Invalid nsec key")
        return bytes(converted)

    # Handle hex format
    if not re.match(r"^[0-9a-fA-F]{64}$", trimmed):
        raise NostrCryptoError("Private key must be 64 hex characters or nsec bech32 format")

    return bytes.fromhex(trimmed)


def get_pubkey_display_name(pubkey: str) -> str:
    """Get display name for a pubkey."""
    normalized = normalize_pubkey(pubkey)
    return f"{normalized[:8]}...{normalized[-8:]}"


def split_message_for_nostr(
    text: str, max_length: int = MAX_NOSTR_MESSAGE_LENGTH
) -> list[str]:
    """Split long text into chunks for Nostr."""
    if len(text) <= max_length:
        return [text]

    chunks: list[str] = []
    remaining = text

    while remaining:
        if len(remaining) <= max_length:
            chunks.append(remaining)
            break

        # Find a good break point
        break_point = max_length
        newline_index = remaining.rfind("\n", 0, max_length)
        if newline_index > max_length * 0.5:
            break_point = newline_index + 1
        else:
            space_index = remaining.rfind(" ", 0, max_length)
            if space_index > max_length * 0.5:
                break_point = space_index + 1

        chunks.append(remaining[:break_point].rstrip())
        remaining = remaining[break_point:].lstrip()

    return chunks
