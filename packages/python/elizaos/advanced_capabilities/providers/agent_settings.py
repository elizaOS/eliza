from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


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
    all_settings = runtime.get_all_settings()

    safe_settings: dict[str, str] = {}
    for key, value in all_settings.items():
        if not any(pattern in key.lower() for pattern in SENSITIVE_KEY_PATTERNS):
            safe_settings[key] = str(value)

    sections: list[str] = []
    if safe_settings:
        sections.append("# Agent Settings")
        for key, value in safe_settings.items():
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


agent_settings_provider = Provider(
    name="AGENT_SETTINGS",
    description="Provides the agent's current configuration settings (filtered for security)",
    get=get_agent_settings_context,
    dynamic=True,
)
