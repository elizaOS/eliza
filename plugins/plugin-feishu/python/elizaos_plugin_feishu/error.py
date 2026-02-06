class FeishuError(Exception):
    """Base exception for Feishu plugin errors."""

    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ConfigError(FeishuError):
    """Configuration error."""

    pass


class BotNotInitializedError(FeishuError):
    """Error when bot is not initialized."""

    def __init__(self) -> None:
        super().__init__("Feishu bot is not initialized. Please provide FEISHU_APP_ID and FEISHU_APP_SECRET.")


class AuthenticationError(FeishuError):
    """Authentication failed error."""

    def __init__(self, message: str = "Authentication failed") -> None:
        super().__init__(message)


class AuthorizationError(FeishuError):
    """Authorization/permission error."""

    def __init__(self, chat_id: str) -> None:
        super().__init__(f"Chat {chat_id} is not authorized to interact with the bot")
        self.chat_id = chat_id


class MessageSendError(FeishuError):
    """Error when sending a message fails."""

    def __init__(self, chat_id: str | int, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to send message to chat {chat_id}", cause)
        self.chat_id = chat_id


class RateLimitError(FeishuError):
    """Rate limit exceeded error."""

    def __init__(self, retry_after: int = 0) -> None:
        super().__init__(f"Rate limited, retry after {retry_after} seconds")
        self.retry_after = retry_after


class ApiError(FeishuError):
    """Generic API error."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"Feishu API error ({code}): {message}")
        self.code = code
