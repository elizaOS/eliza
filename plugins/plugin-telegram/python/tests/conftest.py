"""Pytest configuration and fixtures for Telegram plugin tests."""

import sys
from unittest.mock import MagicMock

import pytest

# Mock the telegram module before any imports
# This is necessary because the telegram library is an optional runtime dependency
# but tests should be able to run without it installed


class MockBot:
    """Mock Telegram Bot class."""

    async def send_message(
        self,
        chat_id: int | str,
        text: str,
        reply_markup: object = None,
    ) -> MagicMock:
        msg = MagicMock()
        msg.message_id = 12345
        return msg


class MockUpdate:
    """Mock Telegram Update class."""

    message: MagicMock | None = None


class MockApplication:
    """Mock Telegram Application class."""

    bot: MockBot

    def __init__(self) -> None:
        self.bot = MockBot()
        self.updater = MagicMock()
        self._handlers: list[object] = []

    def add_handler(self, handler: object) -> None:
        self._handlers.append(handler)

    async def initialize(self) -> None:
        pass

    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        pass

    async def shutdown(self) -> None:
        pass


class MockApplicationBuilder:
    """Mock Application builder."""

    def __init__(self) -> None:
        self._token: str | None = None
        self._base_url: str | None = None

    def token(self, token: str) -> "MockApplicationBuilder":
        self._token = token
        return self

    def base_url(self, url: str) -> "MockApplicationBuilder":
        self._base_url = url
        return self

    def build(self) -> MockApplication:
        return MockApplication()


class MockApplicationClass:
    """Mock Application class with builder method."""

    @staticmethod
    def builder() -> MockApplicationBuilder:
        return MockApplicationBuilder()


class MockCommandHandler:
    """Mock CommandHandler class."""

    def __init__(self, command: str, callback: object) -> None:
        self.command = command
        self.callback = callback


class MockMessageHandler:
    """Mock MessageHandler class."""

    def __init__(self, filters: object, callback: object) -> None:
        self.filters = filters
        self.callback = callback


class MockFilters:
    """Mock filters module."""

    TEXT = MagicMock()
    COMMAND = MagicMock()

    def __and__(self, other: object) -> MagicMock:
        return MagicMock()

    def __invert__(self) -> MagicMock:
        return MagicMock()


class MockInlineKeyboardButton:
    """Mock InlineKeyboardButton class."""

    def __init__(self, text: str, url: str | None = None) -> None:
        self.text = text
        self.url = url


class MockInlineKeyboardMarkup:
    """Mock InlineKeyboardMarkup class."""

    def __init__(self, keyboard: list[list[MockInlineKeyboardButton]]) -> None:
        self.keyboard = keyboard


# Create mock telegram module
mock_telegram = MagicMock()
mock_telegram.Bot = MockBot
mock_telegram.Update = MockUpdate
mock_telegram.InlineKeyboardButton = MockInlineKeyboardButton
mock_telegram.InlineKeyboardMarkup = MockInlineKeyboardMarkup

# Create mock telegram.ext module
mock_telegram_ext = MagicMock()
mock_telegram_ext.Application = MockApplicationClass
mock_telegram_ext.CommandHandler = MockCommandHandler
mock_telegram_ext.MessageHandler = MockMessageHandler
mock_telegram_ext.filters = MockFilters()

# Install mocks before any test imports
sys.modules["telegram"] = mock_telegram
sys.modules["telegram.ext"] = mock_telegram_ext


@pytest.fixture
def mock_bot() -> MockBot:
    """Provide a mock Telegram bot instance."""
    return MockBot()


@pytest.fixture
def mock_update() -> MockUpdate:
    """Provide a mock Telegram update instance."""
    return MockUpdate()


@pytest.fixture
def telegram_config() -> dict[str, str | list[str]]:
    """Provide a test configuration for Telegram service."""
    return {
        "bot_token": "test-token-12345",
        "api_root": "https://api.telegram.org",
        "allowed_chat_ids": ["123", "-456"],
    }
