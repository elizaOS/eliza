from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.generated.spec_helpers import require_provider_spec
from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State

# Get text content from centralized specs
_spec = require_provider_spec("PROVIDERS")


async def get_providers_list(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
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
            values={"providerCount": 0},
            data={"providers": []},
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


providers_list_provider = Provider(
    name=_spec["name"],
    description=_spec["description"],
    get=get_providers_list,
    dynamic=_spec.get("dynamic", False),
)
