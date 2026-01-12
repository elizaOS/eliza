from __future__ import annotations

from typing import TYPE_CHECKING

from elizaos.types import Provider, ProviderResult

if TYPE_CHECKING:
    from elizaos.types import IAgentRuntime, Memory, State


async def get_capabilities(
    runtime: IAgentRuntime,
    message: Memory,
    state: State | None = None,
) -> ProviderResult:
    model_types = ["TEXT_LARGE", "TEXT_SMALL", "TEXT_EMBEDDING", "IMAGE", "AUDIO"]
    available_models = [mt for mt in model_types if runtime.has_model(mt)]
    service_names = [s.name for s in runtime.services if hasattr(s, "name")]

    features: list[str] = []
    if runtime.get_setting("ENABLE_VOICE"):
        features.append("voice")
    if runtime.get_setting("ENABLE_VISION"):
        features.append("vision")
    if runtime.get_setting("ENABLE_MEMORY"):
        features.append("long_term_memory")

    capabilities: dict[str, list[str] | bool] = {
        "models": available_models,
        "services": service_names,
        "features": features,
    }

    text_parts: list[str] = ["# Agent Capabilities"]

    if available_models:
        text_parts.append(f"Models: {', '.join(available_models)}")

    if service_names:
        text_parts.append(f"Services: {', '.join(service_names)}")

    if features:
        text_parts.append(f"Features: {', '.join(features)}")

    return ProviderResult(
        text="\n".join(text_parts),
        values={
            "modelCount": len(available_models),
            "serviceCount": len(service_names),
            "hasVoice": "voice" in features,
            "hasVision": "vision" in features,
        },
        data=capabilities,
    )


capabilities_provider = Provider(
    name="CAPABILITIES",
    description="Agent capabilities including models, services, and features",
    get=get_capabilities,
    dynamic=False,
)
