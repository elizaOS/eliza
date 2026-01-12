import pytest

from elizaos_plugin_roblox.providers import (
    GameStateProvider,
    get_roblox_provider_names,
)
from elizaos_plugin_roblox.providers.game_state import ProviderParams


class TestGameStateProvider:
    @pytest.fixture
    def provider(self) -> GameStateProvider:
        return GameStateProvider()

    def test_provider_name(self, provider: GameStateProvider) -> None:
        assert provider.name == "roblox-game-state"

    def test_provider_description(self, provider: GameStateProvider) -> None:
        assert "Roblox" in provider.description

    def test_provider_position(self, provider: GameStateProvider) -> None:
        assert provider.position == 50

    @pytest.mark.asyncio
    async def test_get_disconnected(self, provider: GameStateProvider) -> None:
        params = ProviderParams(
            conversation_id="test-conv",
            agent_id="test-agent",
        )

        result = await provider.get(params)

        assert "universeId" in result.values
        assert "not connected" in result.text.lower()
        assert result.data["connected"] is False


class TestProviderRegistry:
    def test_get_roblox_provider_names(self) -> None:
        names = get_roblox_provider_names()
        assert "roblox-game-state" in names
        assert len(names) == 1
