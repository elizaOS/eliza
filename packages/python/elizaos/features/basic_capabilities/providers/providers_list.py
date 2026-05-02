from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.prompt_compression import get_prompt_provider_description
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_providers_list(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    selection_hints = [
        "images, attachments, or visual content -> ATTACHMENTS",
        "specific people or agents -> ENTITIES",
        "connections between people -> RELATIONSHIPS",
        "factual lookup -> FACTS",
        "world or environment context -> WORLD",
    ]
    provider_info: list[dict[str, str | bool]] = []

    for provider in runtime.providers:
        provider_info.append(
            {
                "name": provider.name,
                "description": get_prompt_provider_description(provider, runtime),
                "dynamic": getattr(provider, "dynamic", True),
            }
        )

    if not provider_info:
        return ProviderResult(
            text="# Available Providers\nproviders[0]:\n- none",
            values={"providerCount": 0},
            data={"providers": []},
        )

    formatted_providers = "\n".join(f"- {p['name']}: {p['description']}" for p in provider_info)
    formatted_hints = "\n".join(f"- {hint}" for hint in selection_hints)
    text = (
        f"# Available Providers\nproviders[{len(provider_info)}]:\n{formatted_providers}\n"
        f"provider_hints[{len(selection_hints)}]:\n{formatted_hints}"
    )

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


providers_list_provider = Provider(
    name="PROVIDERS",
    description="Available context providers",
    get=get_providers_list,
    dynamic=False,
)
