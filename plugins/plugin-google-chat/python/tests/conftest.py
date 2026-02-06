import pytest

from elizaos_plugin_google_chat.types import (
    GoogleChatSettings,
    GoogleChatSpace,
    GoogleChatUser,
)


@pytest.fixture
def mock_settings():
    """Provides a mock Google Chat settings object."""
    return GoogleChatSettings(
        service_account='{"type": "service_account", "project_id": "test"}',
        audience_type="app-url",
        audience="https://test.example.com",
        webhook_path="/googlechat",
        spaces=["spaces/AAAA"],
        require_mention=True,
        enabled=True,
    )


@pytest.fixture
def mock_space():
    """Provides a mock Google Chat space."""
    return GoogleChatSpace(
        name="spaces/ABC123",
        display_name="Engineering Team",
        type="SPACE",
        single_user_bot_dm=False,
        threaded=False,
    )


@pytest.fixture
def mock_dm_space():
    """Provides a mock Google Chat DM space."""
    return GoogleChatSpace(
        name="spaces/DM456",
        display_name=None,
        type="DM",
        single_user_bot_dm=True,
        threaded=False,
    )


@pytest.fixture
def mock_user():
    """Provides a mock Google Chat user."""
    return GoogleChatUser(
        name="users/USER123",
        display_name="Jane Doe",
        email="jane@example.com",
        type="HUMAN",
    )


@pytest.fixture
def mock_bot_user():
    """Provides a mock Google Chat bot user."""
    return GoogleChatUser(
        name="users/BOT456",
        display_name="Test Bot",
        type="BOT",
    )
