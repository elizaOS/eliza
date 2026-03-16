import pytest

from elizaos_plugin_instagram.providers.user_state import (
    ProviderContext,
    UserStateProvider,
)


class TestUserStateProvider:
    @pytest.fixture
    def provider(self) -> UserStateProvider:
        return UserStateProvider()

    @pytest.mark.asyncio
    async def test_name(self, provider: UserStateProvider) -> None:
        assert provider.name == "instagram_user_state"

    @pytest.mark.asyncio
    async def test_get_dm_context(self, provider: UserStateProvider) -> None:
        context = ProviderContext(
            user_id=12345,
            thread_id="thread-1",
            media_id=None,
            room_id="room-uuid",
        )
        result = await provider.get(context)

        assert result["user_id"] == 12345
        assert result["thread_id"] == "thread-1"
        assert result["is_dm"] is True
        assert result["is_comment"] is False

    @pytest.mark.asyncio
    async def test_get_comment_context(self, provider: UserStateProvider) -> None:
        context = ProviderContext(
            user_id=12345,
            thread_id=None,
            media_id=67890,
            room_id="room-uuid",
        )
        result = await provider.get(context)

        assert result["user_id"] == 12345
        assert result["media_id"] == 67890
        assert result["is_dm"] is False
        assert result["is_comment"] is True

    @pytest.mark.asyncio
    async def test_get_empty_context(self, provider: UserStateProvider) -> None:
        context = ProviderContext(
            user_id=None,
            thread_id=None,
            media_id=None,
            room_id=None,
        )
        result = await provider.get(context)

        assert result["user_id"] is None
        assert result["thread_id"] is None
        assert result["is_dm"] is False
        assert result["is_comment"] is False
