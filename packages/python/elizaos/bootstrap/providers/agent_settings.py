"""
Agent Settings Provider - Provides agent configuration settings.

This provider supplies the agent's current settings and configuration,
filtered to exclude sensitive information like API keys.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


# Keys that should never be exposed
SENSITIVE_KEY_PATTERNS = (
    "key",
    "secret",
    "password",
    "token",
    "credential",
    "auth",
    "private",
)


async def get_agent_settings_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get the agent's current settings.

    Returns only safe settings, filtering out sensitive information.
    """
    all_settings = runtime.get_all_settings()

    # Filter out sensitive settings
    safe_settings: dict[str, str] = {}
    for key, value in all_settings.items():
        key_lower = key.lower()
        is_sensitive = any(pattern in key_lower for pattern in SENSITIVE_KEY_PATTERNS)
        if not is_sensitive:
            safe_settings[key] = str(value)

    sections: list[str] = []
    if safe_settings:
        sections.append("# Agent Settings")
        for key, value in safe_settings.items():
            # Truncate long values
            display_value = value if len(value) <= 50 else value[:50] + "..."
            sections.append(f"- {key}: {display_value}")

    context_text = "\n".join(sections) if sections else ""

    return ProviderResult(
        text=context_text,
        values={
            "settingsCount": len(safe_settings),
            "hasSettings": len(safe_settings) > 0,
        },
        data={
            "settings": safe_settings,
        },
    )


# Create the provider instance
agent_settings_provider = Provider(
    name="AGENT_SETTINGS",
    description="Provides the agent's current configuration settings (filtered for security)",
    get=get_agent_settings_context,
    dynamic=True,
)
