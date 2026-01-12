class TelegramError(Exception):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ConfigError(TelegramError):
    pass


class BotNotInitializedError(TelegramError):
    def __init__(self) -> None:
        super().__init__("Telegram bot is not initialized. Please provide TELEGRAM_BOT_TOKEN.")


class AuthorizationError(TelegramError):
    def __init__(self, chat_id: str) -> None:
        super().__init__(f"Chat {chat_id} is not authorized to interact with the bot")
        self.chat_id = chat_id


class MessageSendError(TelegramError):
    def __init__(self, chat_id: str | int, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to send message to chat {chat_id}", cause)
        self.chat_id = chat_id
