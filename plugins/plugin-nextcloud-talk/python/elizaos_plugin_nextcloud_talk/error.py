class NextcloudTalkError(Exception):
    """Base exception for Nextcloud Talk plugin errors."""

    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class ConfigError(NextcloudTalkError):
    """Configuration error."""

    pass


class ServiceNotInitializedError(NextcloudTalkError):
    """Service not initialized error."""

    def __init__(self) -> None:
        super().__init__(
            "Nextcloud Talk service is not initialized. Please provide NEXTCLOUD_URL and NEXTCLOUD_BOT_SECRET."
        )


class AuthenticationError(NextcloudTalkError):
    """Authentication failed error."""

    def __init__(self, message: str = "Authentication failed - check bot secret") -> None:
        super().__init__(message)


class SignatureVerificationError(NextcloudTalkError):
    """HMAC signature verification failed."""

    def __init__(self) -> None:
        super().__init__("Signature verification failed")


class RoomNotAllowedError(NextcloudTalkError):
    """Room not in allowlist error."""

    def __init__(self, room_token: str) -> None:
        super().__init__(f"Room {room_token} is not in the allowlist")
        self.room_token = room_token


class MessageSendError(NextcloudTalkError):
    """Failed to send message error."""

    def __init__(self, room_token: str, cause: Exception | None = None) -> None:
        super().__init__(f"Failed to send message to room {room_token}", cause)
        self.room_token = room_token


class ApiError(NextcloudTalkError):
    """Nextcloud Talk API error."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"API error ({status_code}): {message}")
        self.status_code = status_code
