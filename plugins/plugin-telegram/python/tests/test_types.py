"""Tests for Telegram types."""

from elizaos_plugin_telegram.types import (
    Button,
    ButtonKind,
    TelegramChannelType,
    TelegramChat,
    TelegramContent,
    TelegramEventType,
    TelegramMessagePayload,
    TelegramUser,
)


class TestButton:
    """Tests for Button."""

    def test_url_button(self) -> None:
        """Test URL button creation."""
        button = Button(kind=ButtonKind.URL, text="Visit", url="https://example.com")

        assert button.kind == ButtonKind.URL
        assert button.text == "Visit"
        assert button.url == "https://example.com"

    def test_login_button(self) -> None:
        """Test login button creation."""
        button = Button(kind=ButtonKind.LOGIN, text="Login", url="https://auth.example.com")

        assert button.kind == ButtonKind.LOGIN


class TestTelegramContent:
    """Tests for TelegramContent."""

    def test_text_only(self) -> None:
        """Test content with text only."""
        content = TelegramContent(text="Hello world")

        assert content.text == "Hello world"
        assert content.buttons == []

    def test_with_buttons(self) -> None:
        """Test content with buttons."""
        buttons = [
            Button(kind=ButtonKind.URL, text="Link", url="https://example.com"),
        ]
        content = TelegramContent(text="Click below", buttons=buttons)

        assert content.text == "Click below"
        assert len(content.buttons) == 1


class TestTelegramEventType:
    """Tests for TelegramEventType."""

    def test_event_types(self) -> None:
        """Test event type values."""
        assert TelegramEventType.MESSAGE_RECEIVED == "TELEGRAM_MESSAGE_RECEIVED"
        assert TelegramEventType.MESSAGE_SENT == "TELEGRAM_MESSAGE_SENT"
        assert TelegramEventType.WORLD_JOINED == "TELEGRAM_WORLD_JOINED"


class TestTelegramChannelType:
    """Tests for TelegramChannelType."""

    def test_channel_types(self) -> None:
        """Test channel type values."""
        assert TelegramChannelType.PRIVATE == "private"
        assert TelegramChannelType.GROUP == "group"
        assert TelegramChannelType.SUPERGROUP == "supergroup"
        assert TelegramChannelType.CHANNEL == "channel"


class TestTelegramUser:
    """Tests for TelegramUser."""

    def test_user_creation(self) -> None:
        """Test user creation."""
        user = TelegramUser(
            id=12345,
            username="testuser",
            first_name="Test",
            last_name="User",
        )

        assert user.id == 12345
        assert user.username == "testuser"
        assert user.first_name == "Test"
        assert user.last_name == "User"
        assert not user.is_bot

    def test_user_minimal(self) -> None:
        """Test user with minimal fields."""
        user = TelegramUser(id=12345)

        assert user.id == 12345
        assert user.username is None
        assert user.first_name is None


class TestTelegramChat:
    """Tests for TelegramChat."""

    def test_private_chat(self) -> None:
        """Test private chat creation."""
        chat = TelegramChat(
            id=12345,
            type=TelegramChannelType.PRIVATE,
            first_name="John",
        )

        assert chat.id == 12345
        assert chat.type == TelegramChannelType.PRIVATE
        assert chat.title is None
        assert chat.first_name == "John"

    def test_group_chat(self) -> None:
        """Test group chat creation."""
        chat = TelegramChat(
            id=-100123,
            type=TelegramChannelType.GROUP,
            title="Test Group",
        )

        assert chat.id == -100123
        assert chat.type == TelegramChannelType.GROUP
        assert chat.title == "Test Group"

    def test_forum_supergroup(self) -> None:
        """Test forum-enabled supergroup."""
        chat = TelegramChat(
            id=-100456,
            type=TelegramChannelType.SUPERGROUP,
            title="Forum Group",
            is_forum=True,
        )

        assert chat.is_forum


class TestTelegramMessagePayload:
    """Tests for TelegramMessagePayload."""

    def test_message_payload(self) -> None:
        """Test message payload creation."""
        chat = TelegramChat(id=12345, type=TelegramChannelType.PRIVATE)
        user = TelegramUser(id=67890, username="sender")

        payload = TelegramMessagePayload(
            message_id=1,
            chat=chat,
            from_user=user,
            text="Hello",
            date=1704067200,
        )

        assert payload.message_id == 1
        assert payload.chat.id == 12345
        assert payload.from_user is not None
        assert payload.from_user.username == "sender"
        assert payload.text == "Hello"

    def test_message_with_thread(self) -> None:
        """Test message in forum thread."""
        chat = TelegramChat(
            id=-100123,
            type=TelegramChannelType.SUPERGROUP,
            is_forum=True,
        )

        payload = TelegramMessagePayload(
            message_id=5,
            chat=chat,
            text="Thread message",
            date=1704067200,
            thread_id=42,
        )

        assert payload.thread_id == 42
