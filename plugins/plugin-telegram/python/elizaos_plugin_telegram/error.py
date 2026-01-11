"""Error definitions for the Telegram plugin."""


class TelegramError(Exception):
    """Base exception for Telegram plugin errors."""

    def __init__(self, message: str, cause: Exception | None = None) -> None:
        """Initialize the error.

        Args:
            message: Error message
            cause: Optional underlying exception
        """
        super().__init__(message)
        self.cause = cause


class ConfigError(TelegramError):
    """Configuration-related error."""

    pass


class BotNotInitializedError(TelegramError):
    """Bot has not been initialized."""

    def __init__(self) -> None:
        """Initialize the error."""
        super().__init__("Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.")


class AuthorizationError(TelegramError):
    """Chat authorization error."""

    def __init__(self, chat_id: str) -> None:
        """Initialize the error.

        Args:
            chat_id: The unauthorized chat ID
        """
        super().__init__(f"Chat {chat_id} is not authorized to interact with the bot")
        self.chat_id = chat_id


class MessageSendError(TelegramError):
    """Error sending a message."""

    def __init__(self, chat_id: str | int, cause: Exception | None = None) -> None:
        """Initialize the error.

        Args:
            chat_id: The target chat ID
            cause: Optional underlying exception
        """
        super().__init__(f"Failed to send message to chat {chat_id}", cause)
        self.chat_id = chat_id
