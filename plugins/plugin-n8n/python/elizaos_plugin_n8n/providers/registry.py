from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    text: str
    data: dict | None = None


class PluginRegistryProvider:
    name = "plugin_registry"
    description = "Provides information about all created plugins in the session"

    async def get(self, context: ProviderContext) -> ProviderResult:
        registry = context.state.get("pluginRegistry", [])

        if not registry:
            return ProviderResult(
                text="No plugins have been created in this session",
                data={"plugins": [], "count": 0},
            )

        plugin_list = [p.get("name") for p in registry if p.get("name")]

        return ProviderResult(
            text=f"Created plugins in this session: {', '.join(plugin_list)}",
            data={
                "plugins": plugin_list,
                "count": len(plugin_list),
            },
        )


plugin_registry_provider = PluginRegistryProvider()
