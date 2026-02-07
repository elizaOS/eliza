import pytest


@pytest.fixture
def mock_config():
    """Provides a mock Feishu configuration."""
    from elizaos_plugin_feishu import FeishuConfig

    return FeishuConfig(
        app_id="cli_test123",
        app_secret="test_secret_123",
        domain="feishu",
        allowed_chats=[],
    )


@pytest.fixture
def mock_user():
    """Provides a mock Feishu user."""
    from elizaos_plugin_feishu import FeishuUser

    return FeishuUser(
        open_id="ou_test123",
        union_id="on_test456",
        user_id="user_789",
        name="Test User",
        is_bot=False,
    )


@pytest.fixture
def mock_chat():
    """Provides a mock Feishu chat."""
    from elizaos_plugin_feishu import FeishuChat, FeishuChatType

    return FeishuChat(
        chat_id="oc_test123",
        chat_type=FeishuChatType.GROUP,
        name="Test Group",
    )
