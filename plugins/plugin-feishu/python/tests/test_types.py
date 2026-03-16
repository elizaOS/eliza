import pytest

from elizaos_plugin_feishu import (
    FeishuChat,
    FeishuChatType,
    FeishuContent,
    FeishuEventType,
    FeishuUser,
)


class TestFeishuEventType:
    def test_event_type_values(self):
        """Test event type enum values."""
        assert FeishuEventType.WORLD_JOINED.value == "FEISHU_WORLD_JOINED"
        assert FeishuEventType.WORLD_CONNECTED.value == "FEISHU_WORLD_CONNECTED"
        assert FeishuEventType.MESSAGE_RECEIVED.value == "FEISHU_MESSAGE_RECEIVED"
        assert FeishuEventType.MESSAGE_SENT.value == "FEISHU_MESSAGE_SENT"


class TestFeishuChatType:
    def test_chat_type_values(self):
        """Test chat type enum values."""
        assert FeishuChatType.P2P.value == "p2p"
        assert FeishuChatType.GROUP.value == "group"


class TestFeishuUser:
    def test_user_creation(self):
        """Test creating a Feishu user."""
        user = FeishuUser(
            open_id="ou_test123",
            union_id="on_test456",
            user_id="user_789",
            name="Test User",
            is_bot=False,
        )

        assert user.open_id == "ou_test123"
        assert user.union_id == "on_test456"
        assert user.name == "Test User"
        assert user.is_bot is False

    def test_user_display_name_with_name(self):
        """Test display name when name is set."""
        user = FeishuUser(
            open_id="ou_test123",
            name="Test User",
        )

        assert user.display_name() == "Test User"

    def test_user_display_name_without_name(self):
        """Test display name when name is not set."""
        user = FeishuUser(
            open_id="ou_test123",
        )

        assert user.display_name() == "ou_test123"


class TestFeishuChat:
    def test_chat_creation(self):
        """Test creating a Feishu chat."""
        chat = FeishuChat(
            chat_id="oc_test123",
            chat_type=FeishuChatType.GROUP,
            name="Test Group",
        )

        assert chat.chat_id == "oc_test123"
        assert chat.type == FeishuChatType.GROUP
        assert chat.name == "Test Group"

    def test_chat_display_name_with_name(self):
        """Test display name when name is set."""
        chat = FeishuChat(
            chat_id="oc_test123",
            chat_type=FeishuChatType.GROUP,
            name="Test Group",
        )

        assert chat.display_name() == "Test Group"

    def test_chat_display_name_without_name(self):
        """Test display name when name is not set."""
        chat = FeishuChat(
            chat_id="oc_test123",
            chat_type=FeishuChatType.GROUP,
        )

        assert chat.display_name() == "oc_test123"


class TestFeishuContent:
    def test_text_content(self):
        """Test creating text content."""
        content = FeishuContent(text="Hello, World!")

        assert content.text == "Hello, World!"
        assert content.card is None
        assert content.image_key is None

    def test_card_content(self):
        """Test creating card content."""
        card = {"header": {"title": {"tag": "plain_text", "content": "Title"}}}
        content = FeishuContent(card=card)

        assert content.text is None
        assert content.card == card

    def test_image_content(self):
        """Test creating image content."""
        content = FeishuContent(image_key="img_test123")

        assert content.text is None
        assert content.image_key == "img_test123"
