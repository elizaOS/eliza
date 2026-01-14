from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    text: str
    data: dict | None = None


class PluginCreationCapabilitiesProvider:
    name = "plugin_creation_capabilities"
    description = "Provides information about plugin creation capabilities"

    async def get(self, context: ProviderContext) -> ProviderResult:
        has_api_key = context.state.get("hasApiKey", False)

        if not has_api_key:
            return ProviderResult(
                text="Plugin creation is available but requires ANTHROPIC_API_KEY for AI-powered code generation",
                data={
                    "serviceAvailable": True,
                    "aiEnabled": False,
                },
            )

        return ProviderResult(
            text="Plugin creation service is fully operational",
            data={
                "serviceAvailable": True,
                "aiEnabled": True,
                "supportedComponents": ["actions", "providers", "services", "evaluators"],
                "maxIterations": 5,
            },
        )


plugin_creation_capabilities_provider = PluginCreationCapabilitiesProvider()
