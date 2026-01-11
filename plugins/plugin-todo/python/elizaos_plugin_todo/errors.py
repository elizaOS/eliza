"""
Error types for the Todo Plugin.
"""


class TodoError(Exception):
    """Base exception for todo plugin errors."""

    def __init__(self, message: str) -> None:
        """Initialize the error with a message."""
        super().__init__(message)
        self.message = message


class ValidationError(TodoError):
    """Raised when input validation fails."""

    pass


class NotFoundError(TodoError):
    """Raised when a todo is not found."""

    pass


class DatabaseError(TodoError):
    """Raised when a database operation fails."""

    pass


class ConfigError(TodoError):
    """Raised when configuration is invalid."""

    pass


class ReminderError(TodoError):
    """Raised when reminder operations fail."""

    pass


class NotificationError(TodoError):
    """Raised when notification operations fail."""

    pass





