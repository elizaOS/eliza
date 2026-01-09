"""Tests for plugin utilities."""

import pytest

from elizaos.plugin import (
    PluginLoadError,
    resolve_plugin_dependencies,
)
from elizaos.types import Plugin


class TestResolveDependencies:
    """Tests for plugin dependency resolution."""

    def test_no_dependencies(self) -> None:
        """Test resolving plugins with no dependencies."""
        plugins = [
            Plugin(name="plugin-a", description="Plugin A"),
            Plugin(name="plugin-b", description="Plugin B"),
        ]
        result = resolve_plugin_dependencies(plugins)
        assert len(result) == 2

    def test_simple_dependency(self) -> None:
        """Test resolving simple dependency."""
        plugins = [
            Plugin(
                name="plugin-b",
                description="Plugin B",
                dependencies=["plugin-a"],
            ),
            Plugin(name="plugin-a", description="Plugin A"),
        ]
        result = resolve_plugin_dependencies(plugins)
        # plugin-a should come before plugin-b
        assert result[0].name == "plugin-a"
        assert result[1].name == "plugin-b"

    def test_chain_dependency(self) -> None:
        """Test resolving chain of dependencies."""
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
        # a -> b -> c
        assert names.index("plugin-a") < names.index("plugin-b")
        assert names.index("plugin-b") < names.index("plugin-c")

    def test_circular_dependency(self) -> None:
        """Test that circular dependencies raise an error."""
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
        """Test that missing external dependencies don't cause issues."""
        plugins = [
            Plugin(
                name="plugin-a",
                description="Plugin A",
                dependencies=["external-plugin"],  # Not in list
            ),
        ]
        # Should not raise - external dependencies are assumed available
        result = resolve_plugin_dependencies(plugins)
        assert len(result) == 1

    def test_multiple_dependencies(self) -> None:
        """Test plugin with multiple dependencies."""
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
        # Both a and b should come before c
        assert names.index("plugin-a") < names.index("plugin-c")
        assert names.index("plugin-b") < names.index("plugin-c")

    def test_diamond_dependency(self) -> None:
        """Test diamond-shaped dependency graph."""
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
        # a before b and c, b and c before d
        assert names.index("plugin-a") < names.index("plugin-b")
        assert names.index("plugin-a") < names.index("plugin-c")
        assert names.index("plugin-b") < names.index("plugin-d")
        assert names.index("plugin-c") < names.index("plugin-d")

