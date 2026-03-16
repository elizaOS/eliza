from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    text: str
    data: dict | None = None


class PluginRegistryProvider:
    name = "n8n_plugin_registry"
    description = "Provides information about all created plugins in the session and checks if a specific plugin exists"

    async def get(self, context: ProviderContext) -> ProviderResult:
        registry = context.state.get("pluginRegistry", [])

        # If a specific plugin name is being checked, do an exists check
        check_name = context.state.get("checkPluginName")
        if check_name:
            exists = any(p.get("name") == check_name for p in registry)
            return ProviderResult(
                text=f"Plugin '{check_name}' {'already exists' if exists else 'does not exist'} in the registry",
                data={
                    "pluginName": check_name,
                    "exists": exists,
                },
            )

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
