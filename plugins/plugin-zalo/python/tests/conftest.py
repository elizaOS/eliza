"""Shared fixtures for plugin-zalo Python tests."""

import pytest

from elizaos_plugin_zalo.config import ZaloConfig
from elizaos_plugin_zalo.types import (
    ZaloChat,
    ZaloMessage,
    ZaloOAInfo,
    ZaloUser,
)


@pytest.fixture()
def minimal_config() -> ZaloConfig:
    """A minimal valid ZaloConfig with polling mode (no webhook URL required)."""
    return ZaloConfig(
        app_id="test-app-id",
        secret_key="test-secret-key",
        access_token="test-access-token",
        use_polling=True,
    )


@pytest.fixture()
def webhook_config() -> ZaloConfig:
    """A ZaloConfig in webhook mode."""
    return ZaloConfig(
        app_id="test-app-id",
        secret_key="test-secret-key",
        access_token="test-access-token",
        webhook_url="https://example.com",
        webhook_path="/zalo/webhook",
        webhook_port=3000,
        use_polling=False,
    )


@pytest.fixture()
def sample_user() -> ZaloUser:
    return ZaloUser(id="user-123", name="Test User")


@pytest.fixture()
def sample_chat() -> ZaloChat:
    return ZaloChat(id="chat-123", chat_type="PRIVATE")


@pytest.fixture()
def sample_message(sample_user: ZaloUser, sample_chat: ZaloChat) -> ZaloMessage:
    return ZaloMessage(
        message_id="msg-001",
        **{"from": sample_user},
        chat=sample_chat,
        date=1700000000,
        text="Hello from test",
    )


@pytest.fixture()
def sample_oa_info() -> ZaloOAInfo:
    return ZaloOAInfo(oa_id="oa-123", name="Test OA", description="Test")
