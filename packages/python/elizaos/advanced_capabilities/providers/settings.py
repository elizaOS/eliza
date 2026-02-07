from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.bootstrap.providers.agent_settings import SENSITIVE_KEY_PATTERNS
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_settings_context(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    _ = message, state

    all_settings = runtime.get_all_settings()

    safe_settings: dict[str, str] = {}
    for key, value in all_settings.items():
        if not any(pattern in key.lower() for pattern in SENSITIVE_KEY_PATTERNS):
            safe_settings[key] = str(value)

    lines: list[str] = []
    if safe_settings:
        lines.append("## Current Configuration")
        for key, value in safe_settings.items():
            display_value = value if len(value) <= 50 else value[:50] + "..."
            lines.append(f"- {key}: {display_value}")

    context_text = "\n".join(lines) if lines else ""

    return ProviderResult(
        text=context_text,
        values={
            "settings": context_text,
            "settingsCount": len(safe_settings),
            "hasSettings": len(safe_settings) > 0,
        },
        data={"settings": safe_settings},
    )


settings_provider = Provider(
    name="SETTINGS",
    description="Current settings for the agent/server (filtered for security)",
    get=get_settings_context,
    dynamic=True,
)
