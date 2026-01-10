"""
Providers Provider - Lists available providers.

This provider returns a list of all registered providers
that supply context to the agent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_providers_list(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    """
    Get available providers.

    Returns a list of providers registered with the runtime
    that supply context to agent prompts.
    """
    provider_info: list[dict[str, str | bool]] = []

    for provider in runtime.providers:
        provider_info.append(
            {
                "name": provider.name,
                "description": getattr(provider, "description", "No description"),
                "dynamic": getattr(provider, "dynamic", True),
            }
        )

    if not provider_info:
        return ProviderResult(
            text="No providers available.",
            values={
                "providerCount": 0,
            },
            data={
                "providers": [],
            },
        )

    formatted_providers = "\n".join(f"- {p['name']}: {p['description']}" for p in provider_info)

    text = f"# Available Providers\n{formatted_providers}"

    return ProviderResult(
        text=text,
        values={
            "providerCount": len(provider_info),
            "providerNames": [p["name"] for p in provider_info],
        },
        data={
            "providers": provider_info,
        },
    )


# Create the provider instance
providers_list_provider = Provider(
    name="PROVIDERS",
    description="Available context providers",
    get=get_providers_list,
    dynamic=False,
)
