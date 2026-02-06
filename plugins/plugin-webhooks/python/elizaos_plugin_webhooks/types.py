"""Type definitions for the webhooks plugin.

Mirrors the TypeScript HookMapping interface and related types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional


@dataclass
class HookMatch:
    """Match criteria for a hook mapping."""

    path: Optional[str] = None
    source: Optional[str] = None


@dataclass
class HookMapping:
    """Configuration for how a webhook payload is mapped to an action.

    Attributes:
        match: Criteria to match incoming webhooks (by path or source).
        action: Whether to trigger a 'wake' or 'agent' action.
        wake_mode: Timing for the heartbeat wake ('now' or 'next-heartbeat').
        name: Display name for the hook.
        session_key: Template string for deriving a session key (supports ``{{placeholders}}``).
        message_template: Template for the agent message body.
        text_template: Template for wake text (falls back to message_template).
        deliver: Whether to deliver the agent response to a channel.
        channel: Target channel identifier (e.g. 'discord', 'last').
        to: Specific channel/room target (e.g. 'channel:123456789').
        model: Override model for the agent turn.
        thinking: Thinking mode configuration.
        timeout_seconds: Max seconds for the agent turn.
        allow_unsafe_external_content: If True, skip sanitisation of external content.
    """

    match: Optional[HookMatch] = None
    action: Optional[Literal["wake", "agent"]] = None
    wake_mode: Optional[Literal["now", "next-heartbeat"]] = None
    name: Optional[str] = None
    session_key: Optional[str] = None
    message_template: Optional[str] = None
    text_template: Optional[str] = None
    deliver: Optional[bool] = None
    channel: Optional[str] = None
    to: Optional[str] = None
    model: Optional[str] = None
    thinking: Optional[str] = None
    timeout_seconds: Optional[int] = None
    allow_unsafe_external_content: Optional[bool] = None


@dataclass
class HooksConfig:
    """Resolved hooks configuration from character settings."""

    token: str
    mappings: list[HookMapping] = field(default_factory=list)
    presets: list[str] = field(default_factory=list)


@dataclass
class AppliedMapping:
    """Result of applying a mapping to a webhook payload."""

    action: Literal["wake", "agent"]
    text: Optional[str] = None
    message: Optional[str] = None
    name: Optional[str] = None
    session_key: Optional[str] = None
    wake_mode: Literal["now", "next-heartbeat"] = "now"
    deliver: Optional[bool] = None
    channel: Optional[str] = None
    to: Optional[str] = None
    model: Optional[str] = None
    thinking: Optional[str] = None
    timeout_seconds: Optional[int] = None


# Type alias for JSON-like payload dicts
Payload = dict[str, Any]
