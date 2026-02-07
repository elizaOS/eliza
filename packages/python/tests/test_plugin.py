import pytest

from elizaos.plugin import (
    PluginLoadError,
    resolve_plugin_dependencies,
)
from elizaos.types import Plugin


class TestResolveDependencies:
    def test_no_dependencies(self) -> None:
        plugins = [
            Plugin(name="plugin-a", description="Plugin A"),
            Plugin(name="plugin-b", description="Plugin B"),
        ]
        result = resolve_plugin_dependencies(plugins)
        assert len(result) == 2

    def test_simple_dependency(self) -> None:
        plugins = [
            Plugin(
                name="plugin-b",
                description="Plugin B",
                dependencies=["plugin-a"],
            ),
            Plugin(name="plugin-a", description="Plugin A"),
        ]
        result = resolve_plugin_dependencies(plugins)
        assert result[0].name == "plugin-a"
        assert result[1].name == "plugin-b"

    def test_chain_dependency(self) -> None:
        plugins = [
            Plugin(
                name="plugin-c",
                description="Plugin C",
                dependencies=["plugin-b"],
            ),
            Plugin(
                name="plugin-b",
                description="Plugin B",
                dependencies=["plugin-a"],
            ),
            Plugin(name="plugin-a", description="Plugin A"),
        ]
        result = resolve_plugin_dependencies(plugins)
        names = [p.name for p in result]
        assert names.index("plugin-a") < names.index("plugin-b")
        assert names.index("plugin-b") < names.index("plugin-c")

    def test_circular_dependency(self) -> None:
        plugins = [
            Plugin(
                name="plugin-a",
                description="Plugin A",
                dependencies=["plugin-b"],
            ),
            Plugin(
                name="plugin-b",
                description="Plugin B",
                dependencies=["plugin-a"],
            ),
        ]
        with pytest.raises(PluginLoadError, match="Circular dependency"):
            resolve_plugin_dependencies(plugins)

    def test_missing_dependency_handled(self) -> None:
        plugins = [
            Plugin(
                name="plugin-a",
                description="Plugin A",
                dependencies=["external-plugin"],
            ),
        ]
        result = resolve_plugin_dependencies(plugins)
        assert len(result) == 1

    def test_multiple_dependencies(self) -> None:
        plugins = [
            Plugin(
                name="plugin-c",
                description="Plugin C",
                dependencies=["plugin-a", "plugin-b"],
            ),
            Plugin(name="plugin-a", description="Plugin A"),
            Plugin(name="plugin-b", description="Plugin B"),
        ]
        result = resolve_plugin_dependencies(plugins)
        names = [p.name for p in result]
        assert names.index("plugin-a") < names.index("plugin-c")
        assert names.index("plugin-b") < names.index("plugin-c")

    def test_diamond_dependency(self) -> None:
        plugins = [
            Plugin(name="plugin-a", description="Plugin A"),
            Plugin(
                name="plugin-b",
                description="Plugin B",
                dependencies=["plugin-a"],
            ),
            Plugin(
                name="plugin-c",
                description="Plugin C",
                dependencies=["plugin-a"],
            ),
            Plugin(
                name="plugin-d",
                description="Plugin D",
                dependencies=["plugin-b", "plugin-c"],
            ),
        ]
        result = resolve_plugin_dependencies(plugins)
        names = [p.name for p in result]
        assert names.index("plugin-a") < names.index("plugin-b")
        assert names.index("plugin-a") < names.index("plugin-c")
        assert names.index("plugin-b") < names.index("plugin-d")
        assert names.index("plugin-c") < names.index("plugin-d")
