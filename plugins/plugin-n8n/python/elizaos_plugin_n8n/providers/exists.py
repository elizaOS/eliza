from dataclasses import dataclass


@dataclass
class ProviderContext:
    state: dict


@dataclass
class ProviderResult:
    text: str
    data: dict | None = None


class PluginExistsProvider:
    name = "plugin_exists"
    description = "Checks if a specific plugin has already been created"

    async def get(self, context: ProviderContext) -> ProviderResult:
        plugin_name = context.state.get("checkPluginName")
        registry = context.state.get("pluginRegistry", [])

        if not plugin_name:
            return ProviderResult(
                text="No plugin name specified to check",
            )

        exists = any(p.get("name") == plugin_name for p in registry)

        return ProviderResult(
            text=f"Plugin '{plugin_name}' {'already exists' if exists else 'does not exist'} in the registry",
            data={
                "pluginName": plugin_name,
                "exists": exists,
            },
        )


plugin_exists_provider = PluginExistsProvider()


class PluginExistsCheckProvider(PluginExistsProvider):
    """TS-parity alias provider (name: `plugin_exists_check`)."""

    name = "plugin_exists_check"


plugin_exists_check_provider = PluginExistsCheckProvider()
