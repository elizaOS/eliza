"""Error types for the Zalo User plugin."""


class ZaloUserError(Exception):
    """Base error for Zalo User plugin."""

    pass


class ZcaNotInstalledError(ZaloUserError):
    """zca-cli is not installed."""

    def __init__(self) -> None:
        super().__init__("zca-cli not found in PATH. Install it with: npm install -g zca-cli")


class NotAuthenticatedError(ZaloUserError):
    """Not authenticated with Zalo."""

    def __init__(self, profile: str | None = None) -> None:
        msg = "Not authenticated"
        if profile:
            msg += f" for profile '{profile}'"
        msg += ". Run 'zca auth login' to authenticate."
        super().__init__(msg)


class InvalidConfigError(ZaloUserError):
    """Invalid configuration."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Invalid configuration: {message}")


class AlreadyRunningError(ZaloUserError):
    """Service is already running."""

    def __init__(self) -> None:
        super().__init__("Service is already running")


class NotRunningError(ZaloUserError):
    """Service is not running."""

    def __init__(self) -> None:
        super().__init__("Service is not running")


class ClientNotInitializedError(ZaloUserError):
    """Client not initialized."""

    def __init__(self) -> None:
        super().__init__("Client not initialized")


class ConnectionError(ZaloUserError):
    """Connection failed."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Connection failed: {message}")


class CommandError(ZaloUserError):
    """Command execution failed."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Command failed: {message}")


class TimeoutError(ZaloUserError):
    """Command timed out."""

    def __init__(self, timeout_ms: int) -> None:
        super().__init__(f"Command timed out after {timeout_ms}ms")


class ApiError(ZaloUserError):
    """API error from Zalo."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Zalo API error: {message}")


class SendError(ZaloUserError):
    """Failed to send message."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Failed to send message: {message}")


class ChatNotFoundError(ZaloUserError):
    """Chat/thread not found."""

    def __init__(self, thread_id: str) -> None:
        super().__init__(f"Chat not found: {thread_id}")


class UserNotFoundError(ZaloUserError):
    """User not found."""

    def __init__(self, user_id: str) -> None:
        super().__init__(f"User not found: {user_id}")


class InvalidArgumentError(ZaloUserError):
    """Invalid argument provided."""

    def __init__(self, message: str) -> None:
        super().__init__(f"Invalid argument: {message}")
