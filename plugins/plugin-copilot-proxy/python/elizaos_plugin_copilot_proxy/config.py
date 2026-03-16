"""Configuration for the Copilot Proxy plugin."""

from __future__ import annotations

import os
import re

from pydantic import BaseModel, Field, field_validator

# Default values
DEFAULT_BASE_URL = "http://localhost:3000/v1"
DEFAULT_SMALL_MODEL = "gpt-5-mini"
DEFAULT_LARGE_MODEL = "gpt-5.1"
DEFAULT_TIMEOUT_SECONDS = 120
DEFAULT_MAX_TOKENS = 8192
DEFAULT_CONTEXT_WINDOW = 128000

# Available models
AVAILABLE_MODELS = [
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5-mini",
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "claude-haiku-4.5",
    "gemini-3-pro",
    "gemini-3-flash",
    "grok-code-fast-1",
]


def normalize_base_url(url: str) -> str:
    """Normalize a base URL to ensure it has the correct format."""
    trimmed = url.strip()
    if not trimmed:
        return DEFAULT_BASE_URL

    # Remove trailing slashes
    normalized = trimmed.rstrip("/")

    # Ensure /v1 suffix
    if not normalized.endswith("/v1"):
        normalized = f"{normalized}/v1"

    return normalized


class CopilotProxyConfig(BaseModel):
    """Configuration for the Copilot Proxy client."""

    base_url: str = Field(
        default=DEFAULT_BASE_URL,
        description="Base URL for the Copilot Proxy server",
    )
    small_model: str = Field(
        default=DEFAULT_SMALL_MODEL,
        description="Small model for fast completions",
    )
    large_model: str = Field(
        default=DEFAULT_LARGE_MODEL,
        description="Large model for capable completions",
    )
    enabled: bool = Field(
        default=True,
        description="Whether the plugin is enabled",
    )
    timeout_seconds: int = Field(
        default=DEFAULT_TIMEOUT_SECONDS,
        ge=1,
        description="Request timeout in seconds",
    )
    max_tokens: int = Field(
        default=DEFAULT_MAX_TOKENS,
        ge=1,
        description="Maximum tokens for completions",
    )
    context_window: int = Field(
        default=DEFAULT_CONTEXT_WINDOW,
        ge=1,
        description="Context window size",
    )

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, v: str) -> str:
        """Validate and normalize the base URL."""
        return normalize_base_url(v)

    @classmethod
    def from_env(cls) -> CopilotProxyConfig:
        """Create configuration from environment variables."""
        base_url = os.environ.get("COPILOT_PROXY_BASE_URL", DEFAULT_BASE_URL)
        small_model = os.environ.get("COPILOT_PROXY_SMALL_MODEL", DEFAULT_SMALL_MODEL)
        large_model = os.environ.get("COPILOT_PROXY_LARGE_MODEL", DEFAULT_LARGE_MODEL)

        enabled_str = os.environ.get("COPILOT_PROXY_ENABLED", "true")
        enabled = enabled_str.lower() != "false"

        timeout_str = os.environ.get("COPILOT_PROXY_TIMEOUT_SECONDS")
        timeout_seconds = DEFAULT_TIMEOUT_SECONDS
        if timeout_str:
            try:
                timeout_seconds = int(timeout_str)
            except ValueError:
                pass

        max_tokens_str = os.environ.get("COPILOT_PROXY_MAX_TOKENS")
        max_tokens = DEFAULT_MAX_TOKENS
        if max_tokens_str:
            try:
                max_tokens = int(max_tokens_str)
            except ValueError:
                pass

        context_window_str = os.environ.get("COPILOT_PROXY_CONTEXT_WINDOW")
        context_window = DEFAULT_CONTEXT_WINDOW
        if context_window_str:
            try:
                context_window = int(context_window_str)
            except ValueError:
                pass

        return cls(
            base_url=base_url,
            small_model=small_model,
            large_model=large_model,
            enabled=enabled,
            timeout_seconds=timeout_seconds,
            max_tokens=max_tokens,
            context_window=context_window,
        )
