import pytest

from elizaos_plugin_rss.actions import (
    GetFeedAction,
    ListFeedsAction,
    SubscribeFeedAction,
    UnsubscribeFeedAction,
    get_rss_action_names,
)


class TestGetFeedAction:
    @pytest.fixture
    def action(self) -> GetFeedAction:
        return GetFeedAction()

    def test_action_name(self, action: GetFeedAction) -> None:
        assert action.name == "GET_NEWSFEED"

    def test_action_similes(self, action: GetFeedAction) -> None:
        assert "FETCH_RSS" in action.similes

    @pytest.mark.asyncio
    async def test_validate(self, action: GetFeedAction) -> None:
        assert await action.validate("fetch rss")
        assert await action.validate("any message")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: GetFeedAction) -> None:
        params = {"url": "https://example.com/feed.rss"}
        result = await action.handler(params)

        assert result["action"] == "GET_NEWSFEED"
        assert result["url"] == "https://example.com/feed.rss"
        assert result["status"] == "pending_fetch"

    @pytest.mark.asyncio
    async def test_handler_missing_url(self, action: GetFeedAction) -> None:
        with pytest.raises(ValueError, match="Missing 'url' parameter"):
            await action.handler({})


class TestSubscribeFeedAction:
    @pytest.fixture
    def action(self) -> SubscribeFeedAction:
        return SubscribeFeedAction()

    def test_action_name(self, action: SubscribeFeedAction) -> None:
        assert action.name == "SUBSCRIBE_RSS_FEED"

    @pytest.mark.asyncio
    async def test_validate_subscribe(self, action: SubscribeFeedAction) -> None:
        assert await action.validate("subscribe to rss feed")
        assert await action.validate("add this feed")
        assert not await action.validate("show me feeds")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: SubscribeFeedAction) -> None:
        params = {"url": "https://example.com/feed.rss"}
        result = await action.handler(params)

        assert result["action"] == "SUBSCRIBE_RSS_FEED"
        assert result["status"] == "pending_subscription"


class TestUnsubscribeFeedAction:
    @pytest.fixture
    def action(self) -> UnsubscribeFeedAction:
        return UnsubscribeFeedAction()

    def test_action_name(self, action: UnsubscribeFeedAction) -> None:
        assert action.name == "UNSUBSCRIBE_RSS_FEED"

    @pytest.mark.asyncio
    async def test_validate_unsubscribe(self, action: UnsubscribeFeedAction) -> None:
        assert await action.validate("unsubscribe from rss feed")
        assert await action.validate("remove this feed")
        assert not await action.validate("add this feed")


class TestListFeedsAction:
    @pytest.fixture
    def action(self) -> ListFeedsAction:
        return ListFeedsAction()

    def test_action_name(self, action: ListFeedsAction) -> None:
        assert action.name == "LIST_RSS_FEEDS"

    @pytest.mark.asyncio
    async def test_validate_list(self, action: ListFeedsAction) -> None:
        assert await action.validate("list my rss feeds")
        assert await action.validate("show me my feeds")
        assert await action.validate("what feeds am I subscribed to")

    @pytest.mark.asyncio
    async def test_handler_success(self, action: ListFeedsAction) -> None:
        result = await action.handler({})

        assert result["action"] == "LIST_RSS_FEEDS"
        assert result["status"] == "pending_list"


class TestActionRegistry:
    def test_get_rss_action_names(self) -> None:
        names = get_rss_action_names()
        assert "GET_NEWSFEED" in names
        assert "SUBSCRIBE_RSS_FEED" in names
        assert "UNSUBSCRIBE_RSS_FEED" in names
        assert "LIST_RSS_FEEDS" in names
        assert len(names) == 4
