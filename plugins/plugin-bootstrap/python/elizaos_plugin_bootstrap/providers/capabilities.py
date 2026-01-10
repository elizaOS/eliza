"""
Capabilities Provider - Lists agent capabilities.

This provider returns a list of capabilities the agent has,
including available models, services, and features.
"""

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
    """
    Get agent capabilities.

    Returns information about what the agent can do, including
    available models, services, and configured features.
    """
    capabilities: dict[str, list[str] | bool] = {
        "models": [],
        "services": [],
        "features": [],
    }

    # Check available models
    model_types = ["TEXT_LARGE", "TEXT_SMALL", "TEXT_EMBEDDING", "IMAGE", "AUDIO"]
    available_models: list[str] = []
    for model_type in model_types:
        if runtime.has_model(model_type):
            available_models.append(model_type)
    capabilities["models"] = available_models

    # Check available services
    service_names: list[str] = []
    for service in runtime.services:
        if hasattr(service, "name"):
            service_names.append(service.name)
    capabilities["services"] = service_names

    # Check features based on settings
    features: list[str] = []
    if runtime.get_setting("ENABLE_VOICE"):
        features.append("voice")
    if runtime.get_setting("ENABLE_VISION"):
        features.append("vision")
    if runtime.get_setting("ENABLE_MEMORY"):
        features.append("long_term_memory")
    capabilities["features"] = features

    # Format text output
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


# Create the provider instance
capabilities_provider = Provider(
    name="CAPABILITIES",
    description="Agent capabilities including models, services, and features",
    get=get_capabilities,
    dynamic=False,
)


