"""Shared fixtures for plugin-zalouser Python tests."""

import pytest

from elizaos_plugin_zalouser.config import ZaloUserConfig
from elizaos_plugin_zalouser.types import (
    ZaloChat,
    ZaloFriend,
    ZaloGroup,
    ZaloMessage,
    ZaloUser,
    ZaloUserChatType,
    ZaloUserInfo,
)


@pytest.fixture()
def default_config() -> ZaloUserConfig:
    """A default ZaloUserConfig."""
    return ZaloUserConfig()


@pytest.fixture()
def sample_user() -> ZaloUser:
    return ZaloUser(id="user-123", displayName="Test User")


@pytest.fixture()
def sample_chat() -> ZaloChat:
    return ZaloChat(
        threadId="thread-123",
        type=ZaloUserChatType.PRIVATE,
        isGroup=False,
    )


@pytest.fixture()
def sample_group_chat() -> ZaloChat:
    return ZaloChat(
        threadId="group-456",
        type=ZaloUserChatType.GROUP,
        name="Test Group",
        memberCount=5,
        isGroup=True,
    )


@pytest.fixture()
def sample_friend() -> ZaloFriend:
    return ZaloFriend(userId="f-1", displayName="Friend A")


@pytest.fixture()
def sample_group() -> ZaloGroup:
    return ZaloGroup(groupId="g-1", name="Group A", memberCount=10)


@pytest.fixture()
def sample_message(sample_chat: ZaloChat) -> ZaloMessage:
    return ZaloMessage(
        threadId="thread-123",
        type=0,
        content="Hello",
        timestamp=1700000000,
    )


@pytest.fixture()
def sample_user_info() -> ZaloUserInfo:
    return ZaloUserInfo(userId="u-1", displayName="Alice")
