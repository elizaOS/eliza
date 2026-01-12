import pytest

from elizaos_plugin_rss.providers import (
    FeedItemsProvider,
    get_rss_provider_names,
)
from elizaos_plugin_rss.providers.feed_items import ProviderParams


class TestFeedItemsProvider:
    @pytest.fixture
    def provider(self) -> FeedItemsProvider:
        return FeedItemsProvider()

    def test_provider_name(self, provider: FeedItemsProvider) -> None:
        assert provider.name == "FEEDITEMS"

    def test_provider_description(self, provider: FeedItemsProvider) -> None:
        assert "feed" in provider.description.lower()

    def test_provider_position(self, provider: FeedItemsProvider) -> None:
        assert provider.position == 50

    @pytest.mark.asyncio
    async def test_get_empty(self, provider: FeedItemsProvider) -> None:
        params = ProviderParams(
            conversation_id="test-conv",
            agent_id="test-agent",
        )

        result = await provider.get(params)

        assert "itemCount" in result.values
        assert "No RSS feed items" in result.text
        assert result.data["count"] == 0


class TestProviderRegistry:
    def test_get_rss_provider_names(self) -> None:
        names = get_rss_provider_names()
        assert "FEEDITEMS" in names
        assert len(names) == 1
