from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto


class TargetType(Enum):
    """The kind of chat target."""

    PHONE = auto()
    EMAIL = auto()
    GROUP_ID = auto()


@dataclass(frozen=True)
class MessageTarget:
    """Target for a Blooio message — phone (E.164), email, or group ID."""

    type: TargetType
    value: str

    @property
    def chat_id(self) -> str:
        """Return the raw chat identifier string."""
        return self.value

    # -- convenience constructors ------------------------------------------------

    @classmethod
    def phone(cls, number: str) -> MessageTarget:
        return cls(type=TargetType.PHONE, value=number)

    @classmethod
    def email(cls, address: str) -> MessageTarget:
        return cls(type=TargetType.EMAIL, value=address)

    @classmethod
    def group_id(cls, gid: str) -> MessageTarget:
        return cls(type=TargetType.GROUP_ID, value=gid)

    @classmethod
    def from_str(cls, s: str) -> MessageTarget | None:
        """Parse a string into a ``MessageTarget`` based on its format."""
        from elizaos_plugin_blooio.utils import (
            validate_email,
            validate_group_id,
            validate_phone,
        )

        if validate_phone(s):
            return cls.phone(s)
        if validate_email(s):
            return cls.email(s)
        if validate_group_id(s):
            return cls.group_id(s)
        return None


@dataclass(frozen=True)
class BlooioConfig:
    """Configuration for the Blooio service."""

    api_key: str
    api_base_url: str
    webhook_secret: str | None = None
    webhook_port: int = 3001


@dataclass(frozen=True)
class BlooioMessage:
    """A Blooio message (outbound or inbound)."""

    target: MessageTarget
    text: str
    attachments: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BlooioResponse:
    """Response from the Blooio API after sending a message."""

    success: bool
    message_id: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class ConversationEntry:
    """A single entry in a conversation history."""

    role: str
    text: str
    timestamp: int
    chat_id: str


@dataclass(frozen=True)
class WebhookEvent:
    """An incoming webhook event from Blooio."""

    event_type: str
    chat_id: str
    message: str | None = None
    timestamp: int = 0
    signature: str | None = None


class BlooioError(Exception):
    """Errors raised by the Blooio plugin."""

    def __init__(
        self,
        message: str,
        status_code: int | None = None,
        details: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.details = details


@dataclass(frozen=True)
class ActionResult:
    """Result of an action handler invocation."""

    success: bool
    text: str
    data: dict | None = None
    error: str | None = None


@dataclass(frozen=True)
class ProviderResult:
    """Result of a provider's ``get`` call."""

    values: dict
    text: str
    data: dict
