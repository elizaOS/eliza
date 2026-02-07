"""Error types for the Scratchpad Plugin."""


class ScratchpadError(Exception):
    """Base error for all scratchpad operations."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class NotFoundError(ScratchpadError):
    """Raised when a scratchpad entry is not found."""

    pass


class ValidationError(ScratchpadError):
    """Raised when input validation fails."""

    pass


class FileSizeError(ScratchpadError):
    """Raised when content exceeds maximum file size."""

    pass


class ConfigError(ScratchpadError):
    """Raised when configuration is invalid."""

    pass


class IOError(ScratchpadError):
    """Raised when a file I/O operation fails."""

    pass
