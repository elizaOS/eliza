from __future__ import annotations

import pytest

from elizaos.runtime import AgentRuntime
from elizaos.types import Character, CharacterSettings


def make_character(**overrides: object) -> Character:
    return Character(
        name="NativeFeaturesTest",
        bio=["Native features test character"],
        **overrides,
    )


@pytest.mark.asyncio
async def test_native_runtime_features_register_by_default() -> None:
    runtime = AgentRuntime(character=make_character(), plugins=[])

    await runtime.initialize()

    plugin_names = {plugin.name for plugin in runtime.plugins}
    assert {"basic_capabilities", "knowledge", "relationships", "trajectories"} <= plugin_names

    assert runtime.is_knowledge_enabled() is True
    assert runtime.is_relationships_enabled() is True
    assert runtime.is_trajectories_enabled() is True

    relationships_service = runtime.get_service("relationships")
    assert relationships_service is not None
    assert runtime.get_service("relationships") is relationships_service

    trajectories_service = runtime.get_service("trajectories")
    assert trajectories_service is not None
    assert runtime.get_service("trajectories") is trajectories_service

    assert runtime.get_service("follow_up") is not None


@pytest.mark.asyncio
async def test_native_runtime_features_honor_constructor_disable_flags() -> None:
    runtime = AgentRuntime(
        character=make_character(),
        plugins=[],
        enable_knowledge=False,
        enable_relationships=False,
        enable_trajectories=False,
    )

    await runtime.initialize()

    plugin_names = {plugin.name for plugin in runtime.plugins}
    assert "knowledge" not in plugin_names
    assert "relationships" not in plugin_names
    assert "trajectories" not in plugin_names

    assert runtime.is_knowledge_enabled() is False
    assert runtime.is_relationships_enabled() is False
    assert runtime.is_trajectories_enabled() is False

    assert runtime.get_service("relationships") is None
    assert runtime.get_service("follow_up") is None
    assert runtime.get_service("trajectories") is None


@pytest.mark.asyncio
async def test_native_runtime_features_honor_character_settings_flags() -> None:
    runtime = AgentRuntime(
        character=make_character(
            settings=CharacterSettings(
                enable_knowledge=False,
                enable_relationships=False,
                enable_trajectories=False,
            )
        ),
        plugins=[],
    )

    await runtime.initialize()

    assert runtime.is_knowledge_enabled() is False
    assert runtime.is_relationships_enabled() is False
    assert runtime.is_trajectories_enabled() is False


@pytest.mark.asyncio
async def test_native_runtime_features_can_toggle_after_initialize() -> None:
    runtime = AgentRuntime(
        character=make_character(),
        plugins=[],
        enable_knowledge=False,
        enable_relationships=False,
        enable_trajectories=False,
    )

    await runtime.initialize()

    await runtime.enable_relationships()
    assert runtime.is_relationships_enabled() is True
    assert runtime.get_service("relationships") is not None
    assert "relationships" in {plugin.name for plugin in runtime.plugins}

    await runtime.enable_trajectories()
    assert runtime.is_trajectories_enabled() is True
    assert runtime.get_service("trajectories") is not None

    await runtime.disable_relationships()
    assert runtime.is_relationships_enabled() is False
    assert runtime.get_service("relationships") is None
    assert runtime.get_service("follow_up") is None
    assert "relationships" not in {plugin.name for plugin in runtime.plugins}
