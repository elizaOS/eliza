"""Error types for the Tlon plugin."""


class TlonError(Exception):
    """Base exception for Tlon plugin errors."""

    pass


class ConfigError(TlonError):
    """Configuration error."""

    pass


class AuthenticationError(TlonError):
    """Authentication failed."""

    pass


class ConnectionError(TlonError):
    """Connection to Urbit ship failed."""

    pass


class ClientNotInitializedError(TlonError):
    """Client is not initialized."""

    def __init__(self) -> None:
        super().__init__("Tlon client is not initialized")


class MessageSendError(TlonError):
    """Failed to send a message."""

    def __init__(self, target: str, cause: Exception | None = None) -> None:
        self.target = target
        self.cause = cause
        message = f"Failed to send message to {target}"
        if cause:
            message = f"{message}: {cause}"
        super().__init__(message)


class SubscribeError(TlonError):
    """Subscription failed."""

    pass


class PokeError(TlonError):
    """Poke operation failed."""

    pass


class ScryError(TlonError):
    """Scry operation failed."""

    pass
